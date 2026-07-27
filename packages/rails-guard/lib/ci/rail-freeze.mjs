// The rail-freeze gate: the unbypassable commit-time backstop (#140).
//
// The in-session PreToolUse rail hook blocks Edit/Write/MultiEdit to frozen paths, but a
// shell write form it does not recognize (node -e, python, cp, perl -i, …) still lands
// in the PR diff. This gate rejects that PR. It is therefore the enforcement boundary,
// and every read it trusts comes from the BASE ref rather than the PR's working tree —
// otherwise a PR could edit the ticket store to drop its own rails and self-disable the
// gate in the same change.
//
// Exit contract: 0 = nothing frozen was touched · 2 = a rail or trust root was modified
// · 1 = operational error or unverifiable input (fails the CI job).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectoryTicketStore, GitTreeTicketStore, detectTicketStore, storeHash, validateTickets } from '@adlc/tickets';
import { globMatch } from '@adlc/core/tickets';
import { classifyTrustRootAuthorization } from '../trust-root-authorization.mjs';
import { deny, fail } from './errors.mjs';
import { createGit, parseJson, resolveTrustedBase, trackedAt } from './git.mjs';
import { ownersForPaths } from './codeowners.mjs';
import {
  assertAppendOnly,
  baseManifestBytes,
  committedManifestAtHead,
  validateMigrationEvidence,
} from './manifest.mjs';
import { assertArraySuperset, assertExistingSignersUnchanged, rejectNewSigners, stable } from './json-contract.mjs';
import { resolveImmutableTrustRoots } from './trust-roots.mjs';

const RAILS_GUARD_TIMEOUT_MS = 120_000;

// Paths a verified legacy-to-directory migration is allowed to touch. Anything else in
// the same diff means the migration is carrying a payload, and the ceremony is void.
const MIGRATION_ALLOWED_EXACT = new Set([
  '.adlc/tickets.json',
  '.adlc/tickets.archive.json',
  '.adlc/manifest.jsonl',
  '.gitignore',
]);
const MIGRATION_ALLOWED_PREFIXES = ['.adlc/ticket-archive/', '.adlc/tickets/'];

/**
 * Run the rail-freeze gate.
 *
 * @param {object} options
 * @param {string} options.cwd repository root (the PR checkout)
 * @param {string} options.base base REF NAME, e.g. `origin/main`
 * @param {NodeJS.ProcessEnv} options.env
 * @param {string[]} [options.additionalTrustRoots] repo-specific trust roots on top of
 *   the defaults. Safe from the command line because the caller that supplies them is
 *   itself a default trust root — see trust-roots.mjs.
 * @param {'inherit'|'pipe'} [options.stdio] how to wire the rails-guard subprocess
 * @returns {{messages: string[], status: number}}
 * @throws {import('./errors.mjs').GateFail|import('./errors.mjs').GateDeny}
 */
export function runRailFreezeGate({ cwd, base, env, additionalTrustRoots = [], stdio = 'inherit' }) {
  const git = createGit(cwd);
  const messages = [];
  const trustedBase = resolveTrustedBase(git, base);

  const baseHasConfig = trackedAt(git, trustedBase, '.adlc/config.json', `git ls-tree '${base}' config`);
  if (baseHasConfig) validateConfigIntegrity({ git, cwd, base, trustedBase });

  // ---- the trusted rail set -------------------------------------------------------
  let baseSnapshot = null;
  try {
    baseSnapshot = new GitTreeTicketStore({ cwd, revision: trustedBase }).load();
  } catch (error) {
    if (error.code !== 'STORE_NOT_FOUND') {
      fail(`cannot load trusted-base ticket store: ${error.code ?? 'UNEXPECTED'}: ${error.message}`);
    }
    if (baseHasConfig) {
      messages.push(`no ticket store at ${base} — protecting ADLC trust roots only.`);
    } else {
      // Nothing is frozen yet, so the only thing left to check is that this PR is not
      // seeding evidence. Same diff-not-filesystem rule as the main manifest block
      // (#314): an untracked gitignored manifest is in zero commits and does not count.
      if (committedManifestAtHead(git).text.trim()) {
        fail('first bootstrap PR cannot introduce pre-populated .adlc/manifest.jsonl evidence');
      }
      messages.push(`no ticket store at ${base} — nothing was frozen.`);
      return { messages, status: 0 };
    }
  }
  const baseTickets = baseSnapshot?.mutableTickets() ?? [];

  // T36 — rails completion lifecycle. A completed ticket's build-time rails auto-expire,
  // so a merged ticket no longer needs a manual admin rail lift.
  //
  // TRUST ANCHOR: the `completed: true` field on the ticket in the BASE store. This is
  // forge-resistant WITHOUT trusting the manifest — which this gate CANNOT verify (it
  // holds no signing key, and append-only does not stop a two-PR append of a fake
  // completion entry). Instead it reuses the gate's own enforced trust: base ticket
  // contracts cannot change in a PR (below), so only the protected-base admin ceremony
  // can set `completed`, and it is read from BASE, never HEAD, so a builder cannot
  // self-unfreeze in their own PR. FAIL CLOSED: only a strict boolean `true` lifts, and
  // a path frozen by any still-in-flight ticket stays frozen via the union of the rest.
  const rails = [];
  for (const ticket of baseTickets) {
    if (ticket.completed === true) continue;
    for (const rail of ticket.rails ?? []) rails.push(rail);
  }

  // ---- ticket-store integrity, including the migration ceremony ---------------------
  const migration = baseSnapshot
    ? verifyTicketStore({ git, cwd, trustedBase, baseSnapshot, baseTickets })
    : { verified: false, storeHash: null, archiveHash: null };

  // ---- manifest evidence ------------------------------------------------------------
  verifyManifest({ git, trustedBase, base, migration });

  // ---- the frozen set ---------------------------------------------------------------
  const immutableTrustRoots = resolveImmutableTrustRoots({
    additional: additionalTrustRoots,
    verifiedMigration: migration.verified,
    bootstrapped: Boolean(rails.length || baseHasConfig),
  });
  let unique = [...new Set([...rails, ...immutableTrustRoots])];
  if (unique.length === 0) {
    messages.push(`no rails declared at ${base} — nothing frozen.`);
    return { messages, status: 0 };
  }

  if (immutableTrustRoots.length) {
    unique = enforceTrustRoots({ git, env, trustedBase, immutableTrustRoots, unique, rails, messages });
  }

  // ---- render the verdict -----------------------------------------------------------
  const argv = ['--base', trustedBase, ...unique.flatMap((rail) => ['--rails', rail])];
  const bin = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'rails-guard.mjs');
  const result = spawnSync(process.execPath, [bin, ...argv], { cwd, stdio, timeout: RAILS_GUARD_TIMEOUT_MS });
  if (result.error) fail(`could not run rails-guard: ${result.error.message}`);
  if (result.signal) fail(`rails-guard timed out or was killed by ${result.signal}`);
  return { messages, status: typeof result.status === 'number' ? result.status : 1 };
}

/**
 * Config-integrity checks that need no GitHub Actions context.
 *
 * Deliberately NARROWER than the bootstrap step: it does not verify CODEOWNERS coverage,
 * probe the signed runner, or run the first-bootstrap ceremony, because none of those
 * are answerable outside a pull_request event. A non-GitHub CI integration must run the
 * bootstrap step too before treating this as a complete enforcement boundary.
 */
function validateConfigIntegrity({ git, cwd, base, trustedBase }) {
  const shown = git(['show', `${trustedBase}:.adlc/config.json`], 'git show base config');
  if (shown.status !== 0) fail('git show failed for an existing base config file (operational error) — failing closed.');
  const headConfigPath = join(cwd, '.adlc/config.json');
  if (!existsSync(headConfigPath)) {
    fail('missing .adlc/config.json; standalone config-integrity gate cannot verify downgrade safety');
  }
  const trusted = parseJson(shown.stdout, `${base}:.adlc/config.json`);
  const head = parseJson(readFileSync(headConfigPath, 'utf8'), 'head .adlc/config.json');

  if (trusted.acknowledgedNewRailBypass !== true) fail('acknowledgedNewRailBypass must already be set on the base branch');
  if (head.acknowledgedNewRailBypass !== true) fail('missing acknowledgedNewRailBypass: true');
  if (trusted.trustedCodeownersAttested === true && head.trustedCodeownersAttested !== true) {
    fail('trustedCodeownersAttested cannot be removed in a PR');
  }
  if (!['signed', 'unsigned-fallback'].includes(trusted.securityMode)) {
    fail('base .adlc/config.json has an unrecognized securityMode; cannot verify downgrade safety');
  }
  if (!['signed', 'unsigned-fallback'].includes(head.securityMode)) fail('head .adlc/config.json has an unrecognized securityMode');
  if (trusted.securityMode === 'signed' && head.securityMode !== 'signed') {
    fail('cannot downgrade securityMode from signed to unsigned-fallback');
  }
  if (trusted.signedEvidenceRequired === true && head.signedEvidenceRequired !== true) {
    fail('cannot remove signedEvidenceRequired from a base config that requires it');
  }
  if ((head.securityMode === 'signed' || head.signedEvidenceRequired === true)
    && trusted.securityMode !== 'signed' && trusted.signedEvidenceRequired !== true) {
    fail('signed mode upgrade requires a protected-base runner ceremony');
  }
  if (typeof trusted.runnerBinarySha256 === 'string' && head.runnerBinarySha256 !== trusted.runnerBinarySha256) {
    fail('runnerBinarySha256 cannot change in a PR');
  }
  if (trusted.signers && typeof trusted.signers === 'object' && !Array.isArray(trusted.signers)) {
    assertExistingSignersUnchanged(trusted.signers, head.signers);
  }
  if (head.signers !== undefined) rejectNewSigners(trusted.signers ?? {}, head.signers);
  assertArraySuperset('revokedKeys', trusted.revokedKeys, head.revokedKeys);
  assertArraySuperset('securitySensitivePatterns', trusted.securitySensitivePatterns, head.securitySensitivePatterns);
  if (typeof trusted.maxBundleAgeDays === 'number'
    && (typeof head.maxBundleAgeDays !== 'number' || head.maxBundleAgeDays > trusted.maxBundleAgeDays)) {
    fail('maxBundleAgeDays can only decrease or stay the same');
  }
}

/**
 * The HEAD ticket store must either preserve every base ticket contract, or BE a
 * verified legacy-to-directory migration.
 *
 * @returns {{verified: boolean, storeHash: string|null, archiveHash: string|null}}
 */
function verifyTicketStore({ git, cwd, trustedBase, baseSnapshot, baseTickets }) {
  let headSnapshot;
  try {
    headSnapshot = detectTicketStore({ root: cwd }).load();
  } catch (error) {
    if (error.code === 'STORE_NOT_FOUND') deny('base ticket store was removed or renamed at HEAD');
    return fail(`cannot load HEAD ticket store: ${error.code ?? 'UNEXPECTED'}: ${error.message}`);
  }

  const isMigration = baseSnapshot.formatVersion === 0 && headSnapshot.formatVersion === 1;
  if (!isMigration) {
    if (baseSnapshot.formatVersion !== headSnapshot.formatVersion) {
      deny('ticket store backend changed outside the supported legacy-to-directory migration');
    }
    // Name the ACTUAL backend in the denial. A repo on the sharded directory store that
    // is told its ticket "cannot change in .adlc/tickets.json" is being sent to a file it
    // does not have.
    assertBaseTicketContractsPreserved(
      baseTickets,
      headSnapshot.mutableTickets(),
      headSnapshot.formatVersion === 0 ? '.adlc/tickets.json' : 'the .adlc/tickets/ store'
    );
    return { verified: false, storeHash: null, archiveHash: null };
  }

  // A migration may only RESHAPE. The logical content on both sides must hash identically,
  // so the ceremony can never be a cover for editing a ticket.
  if (baseSnapshot.hash !== headSnapshot.hash) deny('legacy-to-directory migration changed logical ticket content');

  const baseHasLegacyArchive = trackedAt(git, trustedBase, '.adlc/tickets.archive.json', 'git ls-tree base legacy archive');
  let baseArchivedTickets = [];
  if (baseHasLegacyArchive) {
    const shown = git(['show', `${trustedBase}:.adlc/tickets.archive.json`], 'git show base legacy archive');
    if (shown.status !== 0) fail('cannot read existing trusted-base legacy archive');
    const parsed = parseJson(shown.stdout, `${trustedBase}:.adlc/tickets.archive.json`);
    if (!parsed || !Array.isArray(parsed.tickets)) fail('base legacy archive has no tickets array');
    try {
      validateTickets(parsed.tickets, { archive: true, validateGraph: false });
    } catch (error) {
      fail(`base legacy archive is invalid: ${error.message}`);
    }
    baseArchivedTickets = parsed.tickets;
  }

  let headArchive;
  try {
    headArchive = new DirectoryTicketStore(join(cwd, '.adlc/ticket-archive'), { archive: true }).load();
  } catch (error) {
    return fail(`cannot load migrated ticket archive: ${error.code ?? 'UNEXPECTED'}: ${error.message}`);
  }
  if (headArchive.hash !== storeHash(baseArchivedTickets)) deny('legacy-to-directory migration changed logical archive content');

  const diff = git(['diff', '--name-only', `${trustedBase}...HEAD`], 'git diff migration shape');
  if (diff.status !== 0) fail('cannot verify migration diff shape');
  const allowed = diff.stdout.trim().split('\n').filter(Boolean).every((path) =>
    MIGRATION_ALLOWED_EXACT.has(path) || MIGRATION_ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix)));
  if (!allowed) deny('legacy-to-directory transition must be a dedicated migration-only diff');

  return { verified: true, storeHash: headSnapshot.hash, archiveHash: headArchive.hash };
}

/**
 * #104/T36 — the ONE change to an existing base ticket a PR may make is adding
 * `completed: true` to a ticket that froze NO rails at base.
 *
 * Rationale: the only effect of `completed` is to expire that ticket's rails, so
 * annotating a RAILS-LESS ticket grants ZERO privilege — nothing to unfreeze — which
 * lets `ticket-prune` tombstone a shipped ticket in an ordinary PR instead of removing
 * it destructively. Strictly bounded: base must have declared no rails and no
 * `completed` field, and head must be EXACTLY base plus `completed: true`. Any other
 * field change, a non-`true` value, or a railed ticket stays denied, so T36's forge
 * resistance is fully intact for anything that could unfreeze a path.
 */
export function isCompletionAnnotationOnly(baseTicket, headTicket) {
  const baseRails = Array.isArray(baseTicket.rails) ? baseTicket.rails : [];
  if (baseRails.length > 0) return false;
  if (Object.prototype.hasOwnProperty.call(baseTicket, 'completed')) return false;
  if (headTicket.completed !== true) return false;
  const { completed, ...headWithoutCompleted } = headTicket;
  return stable(headWithoutCompleted) === stable(baseTicket);
}

function assertBaseTicketContractsPreserved(baseTickets, headTickets, storeLabel) {
  const headById = new Map(headTickets.map((ticket) => [ticket.id, ticket]));
  for (const baseTicket of baseTickets) {
    const headTicket = headById.get(baseTicket.id);
    if (!headTicket) deny(`base ticket ${baseTicket.id} cannot be removed from ${storeLabel} in a PR`);
    if (stable(headTicket) !== stable(baseTicket) && !isCompletionAnnotationOnly(baseTicket, headTicket)) {
      deny(`base ticket ${baseTicket.id} contract cannot change in ${storeLabel} in a PR`);
    }
  }
}

/** Manifest evidence must be append-only once it exists, and un-seeded before it does. */
function verifyManifest({ git, trustedBase, base, migration }) {
  const baseHasManifest = trackedAt(git, trustedBase, '.adlc/manifest.jsonl', `git ls-tree '${base}' manifest`);

  if (baseHasManifest) {
    const head = committedManifestAtHead(git);
    if (!head.present) deny('.adlc/manifest.jsonl exists at base but is absent at HEAD');
    const baseBytes = baseManifestBytes(git, trustedBase);
    assertAppendOnly(head.bytes, baseBytes);
    if (migration.verified) {
      validateMigrationEvidence(baseBytes.toString('utf8'), head.text, migration.storeHash, migration.archiveHash);
    }
    return;
  }

  if (migration.verified) {
    // Read the evidence EXACTLY ONCE and make both the presence and the validation
    // decision on that single snapshot. A two-read pattern (validate one snapshot,
    // presence-check a second) is a TOCTOU fail-open: an empty file skips validation,
    // then a swapped non-empty file satisfies presence with the evidence never checked
    // (#314 round 4). validateMigrationEvidence denies empty evidence, so one read plus
    // one unconditional validation covers both.
    validateMigrationEvidence('', committedManifestAtHead(git).text, migration.storeHash, migration.archiveHash);
    return;
  }

  // Ordinary PR: only a TRACKED manifest ADDED by this diff, carrying evidence, denies.
  if (committedManifestAtHead(git).text.trim()) {
    deny('.adlc/manifest.jsonl cannot be created with evidence in a PR; create it empty during bootstrap or use the protected-base runner ceremony');
  }
}

/**
 * Deny a trust-root change unless the #141 ceremony authorizes it.
 *
 * Returns the rail set with authorized paths LIFTED — otherwise the rails-guard bin
 * below would deny the very change the ceremony just approved. Ticket-declared rails are
 * never lifted; only the specific trust-root paths this PR was authorized to change.
 */
function enforceTrustRoots({ git, env, trustedBase, immutableTrustRoots, unique, rails, messages }) {
  const diff = git(['diff', '--name-status', '-M', `${trustedBase}...HEAD`, '--', ...immutableTrustRoots], 'git diff trust roots');
  if (diff.status !== 0) fail('git diff trust roots failed (operational error) — failing closed.');
  if (!diff.stdout.trim()) return unique;

  const changedTrustRoots = diff.stdout
    .trim()
    .split('\n')
    // Capture EVERY path column, not just the last: a rename row is `R100\t<old>\t<new>`,
    // and the frozen path is the OLD one, so both must be considered for owner lookup and
    // for the lift — otherwise a legitimately authorized rename is denied because only
    // <new> was seen.
    .flatMap((line) => line.split('\t').slice(1).map((part) => part.trim()))
    .filter(Boolean);

  const decision = authorizeTrustRootChange({ git, env, changedPaths: changedTrustRoots, trustedBase });
  if (!decision.authorized) {
    deny(
      'ADLC trust root changed, deleted, or renamed and the change is NOT authorized '
      + `(${decision.reason}). To authorize: apply the "trust-root-change" label and obtain a `
      + 'non-author CODEOWNER approval; otherwise use the protected-base admin path.\n'
      + diff.stdout.trim()
    );
  }

  // A convenience pointer, NOT the authorization record: the approver is derived from the
  // workflow-provided ADLC_PR_REVIEWS and is therefore self-reported and forgeable from
  // the PR branch. The authoritative record is GitHub's own review data plus
  // branch-protection CODEOWNERS review, which is what actually gates the merge.
  messages.push(
    'trust-root change AUTHORIZED via the #141 ceremony.\n'
    + `  ${decision.reason}\n`
    + `  approver (self-reported; authoritative source is GitHub's review record): ${decision.approver}\n`
    + `  changed: ${changedTrustRoots.join(', ')}`
  );
  // Lift by MATCH, not by equality. A trust root may be a GLOB
  // (`packages/rails-guard/lib/ci/**`), while the ceremony authorizes CONCRETE paths from
  // the diff. Exact equality never removed the glob, so an authorized change to a
  // glob-covered trust root was still denied by the rails-guard bin below — the #141
  // escape hatch could not open for the gate's own source.
  //
  // Only entries drawn from immutableTrustRoots are eligible. Filtering `unique` directly
  // by glob match would also lift a TICKET rail that happens to cover an authorized path,
  // and the ceremony authorizes trust-root changes only — never a ticket's rails.
  // A rail a TICKET declared is never lifted, even when it is the same STRING as a trust
  // root. `unique` is a Set, so an identical rail and trust root collapse to one entry, and
  // lifting it would silently unfreeze the ticket's rail too (cross-model review, #363
  // round 3). The ceremony authorizes trust roots; a path a ticket froze stays frozen.
  const ticketRails = new Set(rails);
  const lifted = new Set(
    immutableTrustRoots.filter((root) => !ticketRails.has(root)
      && changedTrustRoots.some((path) => root === path || globMatch(root, path)))
  );
  return unique.filter((rail) => !lifted.has(rail));
}

/**
 * Read the PR authorization context from the GitHub event payload.
 *
 * Returns null when this is not a PR CI context (a local run), so the caller fails closed
 * to the existing deny. Inputs the decision cannot forge from the PR: author and labels
 * come from the event payload; reviews are passed by the workflow as ADLC_PR_REVIEWS (it
 * makes the one `gh api pulls/<n>/reviews` call); owners are parsed from CODEOWNERS at
 * the BASE ref, so a PR cannot add itself as an owner.
 */
export function readPrContext(env) {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) return null;
  // No existsSync pre-check: the read below is already wrapped in a catch that returns
  // null on ANY failure (missing file, EISDIR, permissions), so a set-but-unreadable path
  // fails closed there. A guard here would be exactly redundant with that catch — an
  // unkillable equivalent mutant — so it is deliberately absent.
  let event;
  try {
    event = JSON.parse(readFileSync(eventPath, 'utf8'));
  } catch {
    return null;
  }
  const pr = event.pull_request;
  if (!pr) return null;

  let reviews = [];
  const raw = env.ADLC_PR_REVIEWS;
  if (raw && raw.trim()) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null; // malformed review payload → fail closed (treated as no context)
    }
    if (!Array.isArray(parsed)) return null;
    reviews = parsed.map((review) => ({
      user: review?.user?.login ?? review?.user,
      state: review?.state,
      submittedAt: review?.submitted_at ?? review?.submittedAt,
    }));
  }

  return {
    author: pr.user?.login,
    labels: (Array.isArray(pr.labels) ? pr.labels : []).map((label) => label?.name ?? label),
    reviews,
  };
}

function authorizeTrustRootChange({ git, env, changedPaths, trustedBase }) {
  const context = readPrContext(env);
  if (!context) {
    return {
      authorized: false,
      approver: null,
      reason: 'no PR CI context (labels/reviews unavailable); run in CI on a pull_request or use the protected-base admin path',
    };
  }
  const owners = ownersForPaths(git, trustedBase, changedPaths);
  return classifyTrustRootAuthorization({
    labels: context.labels,
    reviews: context.reviews,
    author: context.author,
    owners,
  });
}

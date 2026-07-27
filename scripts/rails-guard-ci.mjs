#!/usr/bin/env node
// CI rail-freeze backstop. This is the unbypassable commit-time gate the
// in-session PreToolUse rail hook relies on: a Bash write form the hook does not
// recognize (node -e, python, cp, perl -i, …) still lands in the diff, and this
// gate rejects the PR if that diff touches a frozen rail.
//
// The rail set is read from the TRUSTED BASE version of .adlc/tickets.json (via
// `git show <base>:…`), never the PR's working tree — otherwise a PR could edit
// the ticket file to remove rails and self-disable the gate in the same change.
// Once the base is bootstrapped, immutable ADLC trust roots are protected even
// when no ticket rails exist yet. Existing base tickets must remain semantically
// identical by id, while ordinary PRs may add new ticket entries. Manifest
// evidence is append-only after it exists; a non-empty initial manifest cannot
// be seeded by an ordinary PR. Malformed base tickets fail closed.
//
//   node scripts/rails-guard-ci.mjs [base-ref]      (default base: origin/main)
//
// Exit: 0 = no rails at base OR no rail touched · 2 = a rail was modified ·
//       1 = operational error / unverifiable rails (fails the CI job).
//
// WARNING: this standalone script is not a security-complete replacement for
// docs/ci/rails-guard.yml. It performs the rail-glob diff gate plus the
// config-integrity checks that can run without GitHub Actions context, but it
// DOES NOT verify CODEOWNERS self-protection, signed runner-pool probing, or the
// first-bootstrap acknowledgement ceremony. Non-GitHub CI integrations must
// port the YAML bootstrap step before treating this as an enforcement boundary.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DirectoryTicketStore, GitTreeTicketStore, detectTicketStore, storeHash, validateTickets } from '@adlc/tickets';
import { classifyTrustRootAuthorization, codeownersMatch } from '@adlc/rails-guard/lib/trust-root-authorization.mjs';

const base = process.argv[2] || process.env.RAILS_BASE || 'origin/main';
let trustedBase = base;

function fail(msg) {
  console.error(`rails-guard-ci: ${msg}`);
  process.exit(1);
}

function deny(msg) {
  console.error(`rails-guard-ci: ${msg}`);
  process.exit(2);
}

function git(args, label, { raw = false } = {}) {
  // maxBuffer well above Node's 1 MiB default: the append-only manifest is an ever-growing
  // ledger and `git cat-file`/`git show`/`git diff` output can exceed 1 MiB legitimately.
  // The default would ENOBUFS a large-but-valid manifest and fail the gate (#314 round 6).
  // raw:true omits encoding so stdout is a Buffer — the manifest evidence is compared
  // BYTE-for-byte (utf8 decode is non-injective: distinct invalid byte sequences both become
  // U+FFFD, so a decoded-string prefix check could miss a raw-byte rewrite — #314 round 7).
  const result = spawnSync('git', args, { encoding: raw ? 'buffer' : 'utf8', timeout: 60000, maxBuffer: 512 * 1024 * 1024 });
  if (result.error) fail(`${label} failed: ${result.error.message}`);
  if (result.signal) fail(`${label} timed out or was killed by ${result.signal}`);
  return result;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(`cannot parse ${label}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// #141 — trust-root change ceremony (authorized-path recognition).
//
// A change to an immutable trust root is normally denied. It is AUTHORIZED when
// the PR carries the `trust-root-change` label AND a non-author CODEOWNER of the
// changed trust-root paths has an APPROVED review. The pure decision lives in
// @adlc/rails-guard (unit-tested); here we only gather inputs and fail closed.
//
// Inputs the decision cannot forge from the PR: author + labels come from the
// GitHub event payload; reviews are passed by the workflow as ADLC_PR_REVIEWS
// (it makes the one `gh api pulls/<n>/reviews` call); owners are parsed from
// CODEOWNERS at the BASE ref, so a PR cannot add itself as an owner. The
// un-forgeable MERGE gate is GitHub branch protection requiring CODEOWNERS
// review — this check only makes the rails-guard signal green + audited.

// Read the PR authorization context. Returns null when not in a PR CI context
// (a local run) so the caller fails closed to the existing deny.
function readPrContext() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return null; // not a PR CI context → fail closed to the existing deny
  // No existsSync pre-check: readFileSync below is already wrapped in a try/catch
  // that returns null on ANY read error (missing file, EISDIR, permissions), so a
  // set-but-unreadable path fails closed there. An existsSync guard here would be
  // redundant with that catch (identical null result) — and a redundant guard is
  // an unkillable equivalent mutant, so it is deliberately absent.
  let event;
  try {
    event = JSON.parse(readFileSync(eventPath, 'utf8'));
  } catch {
    return null;
  }
  const pr = event.pull_request;
  if (!pr) return null;
  let reviews = [];
  const rawReviews = process.env.ADLC_PR_REVIEWS;
  if (rawReviews && rawReviews.trim()) {
    let parsed;
    try {
      parsed = JSON.parse(rawReviews);
    } catch {
      return null; // malformed review payload → fail closed (treated as no context)
    }
    if (!Array.isArray(parsed)) return null;
    reviews = parsed.map((r) => ({
      user: r?.user?.login ?? r?.user,
      state: r?.state,
      submittedAt: r?.submitted_at ?? r?.submittedAt,
    }));
  }
  return {
    author: pr.user?.login,
    labels: (Array.isArray(pr.labels) ? pr.labels : []).map((l) => l?.name ?? l),
    reviews,
  };
}

// Union of CODEOWNERS logins (without @) whose pattern matches any changed
// trust-root path, read from the BASE ref (never HEAD).
function codeownersOwnersFor(paths, baseRef) {
  const owners = new Set();
  for (const file of ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS']) {
    const shown = git(['show', `${baseRef}:${file}`], `git show ${file}`);
    if (shown.status !== 0) continue; // not present at base
    for (const raw of shown.stdout.split('\n')) {
      const line = raw.replace(/#.*$/, '').trim();
      if (!line) continue;
      const [pattern, ...logins] = line.split(/\s+/);
      if (!logins.length) continue;
      if (paths.some((changed) => codeownersMatch(pattern, changed))) {
        for (const login of logins) owners.add(login.replace(/^@/, ''));
      }
    }
  }
  return [...owners];
}

// Decide whether the trust-root change is authorized by the ceremony.
function authorizeTrustRootChange(changedPaths, baseRef) {
  const ctx = readPrContext();
  if (!ctx) {
    return {
      authorized: false,
      approver: null,
      reason: 'no PR CI context (labels/reviews unavailable); run in CI on a pull_request or use the protected-base admin path',
    };
  }
  const owners = codeownersOwnersFor(changedPaths, baseRef);
  return classifyTrustRootAuthorization({ labels: ctx.labels, reviews: ctx.reviews, author: ctx.author, owners });
}

function manifestLines(text, label) {
  return text.split('\n').filter((line) => line.trim()).map((line, index) => parseJson(line, `${label} line ${index + 1}`));
}

// #314: the committed HEAD content of `.adlc/manifest.jsonl`, or '' when it is NOT tracked
// at HEAD. Whether a PR "creates the manifest" is a DIFF question, not a filesystem one — a
// gitignored, untracked manifest (which every dev who has run the toolkit has locally) is in
// zero commits and must not be read, so the local verdict equals CI's clean checkout.
//
// FAIL CLOSED on a non-regular object: a manifest committed as a SYMLINK (or submodule) must
// not smuggle evidence. `git show` returns a symlink's TARGET STRING, not the target's
// content, so a whitespace-target symlink would slip past `.trim()` while downstream readers
// that follow the link consume forged entries — the old readFileSync check denied this by
// following the link, so preserve that by rejecting any non-`100644 blob` object.
// Returns { present, text }: `present` is whether the manifest is tracked at HEAD, `text`
// its committed content ('' when absent OR empty). This is the SOLE manifest reader — every
// path (creation, first-bootstrap, append-only, AND the migration ceremony) reads through it,
// so there is no working-tree read left to diverge from CI's clean checkout or to follow a
// symlink. The migration ceremony's evidence is a TRACKED file (the migration diff-shape
// allow-list expects `.adlc/manifest.jsonl` in the diff), so committed content is the correct,
// CI-consistent source; reading the working tree there was the legacy artifact (#314 round 5).
//
// FAIL CLOSED on a non-regular object (symlink 120000 / submodule 160000): such a manifest
// must not smuggle evidence. And read the content by the BLOB HASH from the same ls-tree row
// (`git cat-file blob <hash>`), NOT `git show HEAD:path` — `git show` re-resolves the mutable
// HEAD and could bind content to a different tree than the mode check saw (a TOCTOU). The blob
// hash is immutable, so metadata and content provably describe the same object (#314 round 5).
function committedManifestAtHead() {
  // Pin HEAD to ONE immutable commit sha and resolve every lookup against it (#314 round 7).
  // Otherwise the ancestor and leaf checks each re-resolve the mutable `HEAD`; a concurrent
  // ref change between them (tree A with a normal `.adlc`, tree B with a symlinked `.adlc`)
  // would pass the ancestor guard on A while the leaf reads absent on B.
  const rev = git(['rev-parse', 'HEAD'], 'git rev-parse HEAD');
  if (rev.status !== 0) fail('git rev-parse HEAD failed (operational error) — failing closed.');
  const head = rev.stdout.trim();
  // Ancestor guard (#314 round 6): `git ls-tree <head> -- .adlc/manifest.jsonl` does NOT descend
  // a symlinked/submodule `.adlc`, so an ANCESTOR symlink (`.adlc` → some `state/` dir holding
  // a forged manifest) would make the leaf lookup return "absent" while filesystem consumers
  // follow the link and read the pre-populated evidence. Require `.adlc` itself to be a real
  // tree at HEAD before trusting the leaf. Absent `.adlc` (dir not created yet) is fine.
  const adlcDir = git(['ls-tree', head, '--', '.adlc'], 'git ls-tree HEAD .adlc');
  if (adlcDir.status !== 0) fail('git ls-tree failed for the HEAD .adlc directory (operational error) — failing closed.');
  const adlcRow = adlcDir.stdout.trim();
  if (adlcRow && adlcRow.split(/\s+/)[0] !== '040000') {
    deny('.adlc must be a directory, not a symlink or submodule');
  }
  const ls = git(['ls-tree', head, '--', '.adlc/manifest.jsonl'], 'git ls-tree HEAD manifest');
  if (ls.status !== 0) fail('git ls-tree failed for the HEAD manifest (operational error) — failing closed.');
  const row = ls.stdout.trim();
  // No `bytes` on the absent return: the only bytes consumer (the append-only branch) checks
  // `present` first, so an absent manifest's bytes are never read — carrying a Buffer here
  // would just be an unkillable equivalent mutant.
  if (!row) return { present: false, text: '' };
  const [mode, type, hash] = row.split(/\s+/);
  if (type !== 'blob' || mode !== '100644') {
    deny('.adlc/manifest.jsonl must be a regular tracked file, not a symlink or submodule');
  }
  // Read the exact object by its immutable hash, as raw BYTES — the append-only comparison is
  // byte-for-byte (see git() `raw`). `text` is the utf8 view for the semantic checks (trim,
  // JSON parse) that don't need byte fidelity.
  const blob = git(['cat-file', 'blob', hash], 'git cat-file HEAD manifest blob', { raw: true });
  if (blob.status !== 0) fail('git cat-file failed for the HEAD manifest blob (operational error) — failing closed.');
  return { present: true, text: blob.stdout.toString('utf8'), bytes: blob.stdout };
}

function validateMigrationEvidence(baseText, headText, expectedStoreHash, expectedArchiveHash) {
  const baseEntries = manifestLines(baseText, 'base manifest');
  const headEntries = manifestLines(headText, 'HEAD manifest');
  const appended = headEntries.slice(baseEntries.length);
  if (![1, 2].includes(appended.length)) deny('migration must append apply evidence and at most one recovery-complete entry');
  const entry = appended[0];
  if (entry?.gate !== 'ticket-migrate' || entry?.data?.operation !== 'migrate' || entry?.data?.action !== 'apply') {
    deny('migration evidence must be a ticket-migrate/apply entry');
  }
  if (entry.data.bindingScope !== 'store' || entry.data.storeHash !== expectedStoreHash || entry.data.archiveHash !== expectedArchiveHash || typeof entry.data.transactionId !== 'string') {
    deny('migration evidence is not bound to the migrated active/archive hashes and transaction');
  }
  if (appended.length === 2) {
    const recovery = appended[1];
    if (recovery?.gate !== 'ticket-migrate' || recovery?.data?.operation !== 'migrate' || recovery?.data?.action !== 'recover-complete') {
      deny('second migration evidence entry must be ticket-migrate/recover-complete');
    }
    if (recovery.data.transactionId !== entry.data.transactionId
      || recovery.data.bindingScope !== 'store'
      || recovery.data.storeHash !== expectedStoreHash
      || recovery.data.archiveHash !== expectedArchiveHash) {
      deny('migration recovery evidence is not bound to the apply transaction and migrated hashes');
    }
  }
  let previousLine = baseText.split('\n').filter((line) => line.trim()).at(-1) ?? null;
  let previousSeq = baseEntries.length ? baseEntries.at(-1).seq : 0;
  for (const appendedEntry of appended) {
    const expectedPrev = previousLine ? createHash('sha256').update(previousLine).digest('hex') : null;
    if (appendedEntry.prev !== expectedPrev) deny('migration evidence does not extend the manifest hash chain');
    if (appendedEntry.seq !== previousSeq + 1) deny('migration evidence sequence does not extend the manifest');
    previousLine = JSON.stringify(appendedEntry);
    previousSeq = appendedEntry.seq;
  }
}

function signerRoles(entry, key) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    fail(`signer ${key} must remain an object`);
  }
  return new Set((Array.isArray(entry.roles) ? entry.roles : [entry.role]).filter((role) => role !== undefined));
}

function stable(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(stable(item))));
  if (value && typeof value === 'object') {
    return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, JSON.parse(stable(value[key]))])));
  }
  return JSON.stringify(value);
}

function validateTicketsEnvelope(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.tickets)) {
    fail(`${label} .adlc/tickets.json is not in the { "tickets": [...] } shape — failing closed.`);
  }
  const seen = new Set();
  for (const t of value.tickets) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) fail(`a ${label} ticket entry is not an object — failing closed.`);
    if (typeof t.id !== 'string' || !t.id) fail(`a ${label} ticket is missing a string id — failing closed.`);
    if (seen.has(t.id)) fail(`${label} .adlc/tickets.json has duplicate ticket id ${t.id} — failing closed.`);
    seen.add(t.id);
    if (t.rails !== undefined && !Array.isArray(t.rails)) fail(`a ${label} ticket has a non-array "rails" field — failing closed.`);
    for (const r of t.rails ?? []) {
      if (typeof r !== 'string') fail(`a ${label} ticket has a non-string rail entry — failing closed.`);
    }
  }
  return value.tickets;
}

// #104/T36: the ONE change to an existing base ticket a PR may make is adding
// `completed: true` to a ticket that froze NO rails at base. Rationale: the only
// effect of `completed` is to expire that ticket's rails (T36), so annotating a
// RAILS-LESS ticket grants ZERO privilege (nothing to unfreeze) — which lets
// `ticket-prune` tombstone a shipped ticket in an ordinary PR instead of a
// destructive removal. Strictly bounded: base must have declared no rails and no
// `completed` field; head must be EXACTLY base plus `completed: true` (any other
// field/rails change, a non-`true` value, or a railed ticket → not exempt, still
// denied, so T36's forge resistance is fully intact for anything that could
// unfreeze a path).
function isCompletionAnnotationOnly(baseTicket, headTicket) {
  const baseRails = Array.isArray(baseTicket.rails) ? baseTicket.rails : [];
  if (baseRails.length > 0) return false;                                   // railed → could unfreeze → not exempt
  if (Object.prototype.hasOwnProperty.call(baseTicket, 'completed')) return false; // add-only, on a pristine field
  if (headTicket.completed !== true) return false;                          // strict boolean true only
  const { completed, ...headWithoutCompleted } = headTicket;
  return stable(headWithoutCompleted) === stable(baseTicket);               // nothing else changed
}

function assertBaseTicketContractsPreserved(baseTickets, headTickets) {
  const headById = new Map(headTickets.map((ticket) => [ticket.id, ticket]));
  for (const baseTicket of baseTickets) {
    const headTicket = headById.get(baseTicket.id);
    if (!headTicket) deny(`base ticket ${baseTicket.id} cannot be removed from .adlc/tickets.json in a PR`);
    if (stable(headTicket) !== stable(baseTicket) && !isCompletionAnnotationOnly(baseTicket, headTicket)) {
      deny(`base ticket ${baseTicket.id} contract cannot change in .adlc/tickets.json in a PR`);
    }
  }
}

function assertArraySuperset(name, trustedValue, headValue) {
  if (!Array.isArray(trustedValue)) return;
  if (!Array.isArray(headValue)) fail(`${name} must remain an array`);
  const headSet = new Set(headValue.map(stable));
  for (const item of trustedValue) {
    if (!headSet.has(stable(item))) fail(`${name} cannot remove trusted entry ${stable(item)}`);
  }
}

function validateNewSigners(trustedSigners, headSigners) {
  if (headSigners === undefined) return;
  if (!headSigners || typeof headSigners !== 'object' || Array.isArray(headSigners)) fail('signers must be an object or absent');
  const allowedNewRoles = new Set(['builder', 'critic']);
  const allowedNewFields = new Set(['role', 'roles']);
  for (const key of Object.keys(headSigners)) {
    if (trustedSigners && Object.prototype.hasOwnProperty.call(trustedSigners, key)) continue;
    const entry = headSigners[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`new signer ${key} must be an object`);
    for (const field of Object.keys(entry)) {
      if (!allowedNewFields.has(field)) fail(`new signer ${key} has undeclared property ${field}`);
    }
    if (entry.role === undefined && entry.roles === undefined) fail(`new signer ${key} must declare a role or roles field`);
    if (entry.role !== undefined && entry.roles !== undefined) fail(`new signer ${key} must use either role or roles, not both`);
    const roles = Array.isArray(entry.roles) ? entry.roles : [entry.role];
    if (!roles.length || roles.some((role) => typeof role !== 'string' || !allowedNewRoles.has(role))) {
      fail(`new signer ${key} can only use builder or critic roles in this CI path; grant approver roles through the protected-base admin ceremony`);
    }
  }
}

function rejectNewSigners(trustedSigners, headSigners) {
  if (!headSigners || typeof headSigners !== 'object' || Array.isArray(headSigners)) {
    fail('signers must remain an object');
  }
  for (const key of Object.keys(headSigners)) {
    if (!trustedSigners || !Object.prototype.hasOwnProperty.call(trustedSigners, key)) {
      fail(`new signer ${key} requires the protected-base admin ceremony`);
    }
  }
}

function validateConfigIntegrity() {
  if (!baseHasConfig) return;
  const baseConfig = git(['show', `${trustedBase}:.adlc/config.json`], 'git show base config');
  if (baseConfig.status !== 0) {
    fail(`git show failed for an existing base config file (operational error) — failing closed.`);
  }
  if (!existsSync('.adlc/config.json')) {
    fail('missing .adlc/config.json; standalone config-integrity gate cannot verify downgrade safety');
  }
  const trusted = parseJson(baseConfig.stdout, `${base}:.adlc/config.json`);
  const head = parseJson(readFileSync('.adlc/config.json', 'utf8'), 'head .adlc/config.json');
  if (trusted.acknowledgedNewRailBypass !== true) {
    fail('acknowledgedNewRailBypass must already be set on the base branch');
  }
  if (head.acknowledgedNewRailBypass !== true) {
    fail('missing acknowledgedNewRailBypass: true');
  }
  if (trusted.trustedCodeownersAttested === true && head.trustedCodeownersAttested !== true) {
    fail('trustedCodeownersAttested cannot be removed in a PR');
  }
  if (!['signed', 'unsigned-fallback'].includes(trusted.securityMode)) {
    fail('base .adlc/config.json has an unrecognized securityMode; cannot verify downgrade safety');
  }
  if (!['signed', 'unsigned-fallback'].includes(head.securityMode)) {
    fail('head .adlc/config.json has an unrecognized securityMode');
  }
  if (trusted.securityMode === 'signed' && head.securityMode !== 'signed') {
    fail('cannot downgrade securityMode from signed to unsigned-fallback');
  }
  if (trusted.signedEvidenceRequired === true && head.signedEvidenceRequired !== true) {
    fail('cannot remove signedEvidenceRequired from a base config that requires it');
  }
  if ((head.securityMode === 'signed' || head.signedEvidenceRequired === true) && trusted.securityMode !== 'signed' && trusted.signedEvidenceRequired !== true) {
    fail('signed mode upgrade requires a protected-base runner ceremony');
  }
  if (typeof trusted.runnerBinarySha256 === 'string' && head.runnerBinarySha256 !== trusted.runnerBinarySha256) {
    fail('runnerBinarySha256 cannot change in a PR');
  }
  if (trusted.signers && typeof trusted.signers === 'object' && !Array.isArray(trusted.signers)) {
    if (!head.signers || typeof head.signers !== 'object' || Array.isArray(head.signers)) {
      fail('signers must remain an object');
    }
    for (const key of Object.keys(trusted.signers)) {
      const trustedRoles = signerRoles(trusted.signers[key], key);
      const headRoles = signerRoles(head.signers[key], key);
      for (const field of Object.keys(trusted.signers[key])) {
        if (!Object.prototype.hasOwnProperty.call(head.signers[key], field)) {
          fail(`signers.${key}.${field} cannot remove trusted signer property`);
        }
        if (stable(head.signers[key][field]) !== stable(trusted.signers[key][field])) {
          fail(`signers.${key}.${field} cannot change trusted signer property`);
        }
      }
      for (const field of Object.keys(head.signers[key])) {
        if (!Object.prototype.hasOwnProperty.call(trusted.signers[key], field)) {
          fail(`signers.${key}.${field} is an undeclared signer property`);
        }
      }
      if (trustedRoles.size !== headRoles.size) fail(`existing signer ${key} roles cannot change`);
      for (const role of trustedRoles) {
        if (!headRoles.has(role)) fail(`existing signer ${key} roles cannot change`);
      }
    }
  }
  if (head.signers !== undefined) rejectNewSigners(trusted.signers ?? {}, head.signers);
  assertArraySuperset('revokedKeys', trusted.revokedKeys, head.revokedKeys);
  assertArraySuperset('securitySensitivePatterns', trusted.securitySensitivePatterns, head.securitySensitivePatterns);
  if (typeof trusted.maxBundleAgeDays === 'number' && (typeof head.maxBundleAgeDays !== 'number' || head.maxBundleAgeDays > trusted.maxBundleAgeDays)) {
    fail('maxBundleAgeDays can only decrease or stay the same');
  }
}

// First confirm the base REF resolves. `git show <ref>:<path>` returns non-zero
// for BOTH "ref does not resolve" and "path absent at ref" — conflating them
// would fail OPEN (an unfetched/typo'd base would look like "no rails"). An
// unresolvable base means rails cannot be verified → fail closed.
const ref = git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], 'git rev-parse base');
if (ref.status !== 0) {
  fail(`base ref '${base}' does not resolve — rails cannot be verified. Fetch it (or pass the correct base).`);
}
trustedBase = ref.stdout.trim();
if (!/^[0-9a-f]{40,64}$/i.test(trustedBase)) fail(`base ref '${base}' did not resolve to an exact object ID`);

const configLs = git(['ls-tree', '--name-only', trustedBase, '--', '.adlc/config.json'], 'git ls-tree base config');
if (configLs.status !== 0) {
  fail(`git ls-tree failed for '${base}' config (operational error) — failing closed.`);
}
const baseHasConfig = Boolean(configLs.stdout.trim());
validateConfigIntegrity();

let baseSnapshot = null;
try {
  baseSnapshot = new GitTreeTicketStore({ cwd: process.cwd(), revision: trustedBase }).load();
} catch (error) {
  if (error.code !== 'STORE_NOT_FOUND') fail(`cannot load trusted-base ticket store: ${error.code ?? 'UNEXPECTED'}: ${error.message}`);
  if (baseHasConfig) {
    console.log(`rails-guard-ci: no ticket store at ${base} — protecting ADLC trust roots only.`);
  } else {
    // #314: same diff-not-filesystem rule as the main manifest block — a first-bootstrap
    // PR that ADDS a tracked non-empty manifest is rejected, but a gitignored untracked
    // manifest in the developer's tree is not (it is in zero commits), so local == CI here
    // too. committedManifestText() also fails closed on a symlink/submodule manifest.
    if (committedManifestAtHead().text.trim()) {
      fail('first bootstrap PR cannot introduce pre-populated .adlc/manifest.jsonl evidence');
    }
    console.log(`rails-guard-ci: no ticket store at ${base} — nothing was frozen.`);
    process.exit(0);
  }
}
const baseTickets = baseSnapshot?.mutableTickets() ?? [];

// T36 — rails completion lifecycle. A completed ticket's build-time rails
// auto-expire (stop freezing sibling paths), so a merged ticket no longer needs
// a manual admin rail lift.
//
// TRUST ANCHOR: a `completed: true` field on the ticket in the BASE
// tickets.json. This is forge-resistant WITHOUT trusting the manifest — which
// this gate CANNOT verify (it has no manifest signing key, and append-only does
// not stop a two-PR append of a fake completion entry). Instead it reuses the
// gate's OWN enforced trust: `assertBaseTicketContractsPreserved` (below) DENIES
// any PR that adds or changes a field on an EXISTING base ticket, so a non-admin
// cannot set `completed` on a still-frozen ticket — only the protected-base
// admin ceremony can — and it is read from the BASE ref, never HEAD, so a
// builder cannot self-unfreeze in their own PR. FAIL CLOSED: only a strict
// boolean `=== true` lifts (not "true"/1/truthy); a new ticket a PR authors can
// only skip ITS OWN rails, never another ticket's. A path frozen by any
// still-in-flight ticket stays frozen (union of the rest).
const rails = [];
for (const t of baseTickets) {
  if (t.completed === true) continue; // done → its rails auto-expire (T36); admin-set + contract-protected
  for (const r of t.rails ?? []) {
    rails.push(r);
  }
}

let verifiedMigration = false;
let verifiedMigrationStoreHash = null;
let verifiedMigrationArchiveHash = null;
if (baseSnapshot) {
  let headSnapshot;
  try {
    headSnapshot = detectTicketStore({ root: process.cwd() }).load();
  } catch (error) {
    if (error.code === 'STORE_NOT_FOUND') deny('base ticket store was removed or renamed at HEAD');
    fail(`cannot load HEAD ticket store: ${error.code ?? 'UNEXPECTED'}: ${error.message}`);
  }
  const isMigration = baseSnapshot.formatVersion === 0 && headSnapshot.formatVersion === 1;
  if (isMigration) {
    if (baseSnapshot.hash !== headSnapshot.hash) deny('legacy-to-directory migration changed logical ticket content');
    const legacyArchiveLs = git(['ls-tree', '--name-only', trustedBase, '--', '.adlc/tickets.archive.json'], 'git ls-tree base legacy archive');
    if (legacyArchiveLs.status !== 0) fail('cannot inspect trusted-base legacy archive');
    const baseHasLegacyArchive = Boolean(legacyArchiveLs.stdout.trim());
    let baseArchivedTickets = [];
    if (baseHasLegacyArchive) {
      const legacyArchive = git(['show', `${trustedBase}:.adlc/tickets.archive.json`], 'git show base legacy archive');
      if (legacyArchive.status !== 0) fail('cannot read existing trusted-base legacy archive');
      const parsedArchive = parseJson(legacyArchive.stdout, `${base}:.adlc/tickets.archive.json`);
      if (!parsedArchive || !Array.isArray(parsedArchive.tickets)) fail('base legacy archive has no tickets array');
      try { validateTickets(parsedArchive.tickets, { archive: true, validateGraph: false }); }
      catch (error) { fail(`base legacy archive is invalid: ${error.message}`); }
      baseArchivedTickets = parsedArchive.tickets;
    }
    let headArchive;
    try { headArchive = new DirectoryTicketStore('.adlc/ticket-archive', { archive: true }).load(); }
    catch (error) { fail(`cannot load migrated ticket archive: ${error.code ?? 'UNEXPECTED'}: ${error.message}`); }
    if (headArchive.hash !== storeHash(baseArchivedTickets)) deny('legacy-to-directory migration changed logical archive content');
    const migrationDiff = git(['diff', '--name-only', `${trustedBase}...HEAD`], 'git diff migration shape');
    if (migrationDiff.status !== 0) fail('cannot verify migration diff shape');
    const allowed = migrationDiff.stdout.trim().split('\n').filter(Boolean).every((path) =>
      path === '.adlc/tickets.json' || path === '.adlc/tickets.archive.json' || path === '.adlc/manifest.jsonl' || path === '.gitignore' || path.startsWith('.adlc/ticket-archive/') || path.startsWith('.adlc/tickets/')
    );
    if (!allowed) deny('legacy-to-directory transition must be a dedicated migration-only diff');
    verifiedMigration = true;
    verifiedMigrationStoreHash = headSnapshot.hash;
    verifiedMigrationArchiveHash = headArchive.hash;
  } else if (baseSnapshot.formatVersion !== headSnapshot.formatVersion) {
    deny('ticket store backend changed outside the supported legacy-to-directory migration');
  } else {
    assertBaseTicketContractsPreserved(baseTickets, headSnapshot.mutableTickets());
  }
}

const manifestLs = git(['ls-tree', '--name-only', trustedBase, '--', '.adlc/manifest.jsonl'], 'git ls-tree base manifest');
if (manifestLs.status !== 0) {
  fail(`git ls-tree failed for '${base}' manifest (operational error) — failing closed.`);
}
if (manifestLs.stdout.trim()) {
  // Base has a tracked manifest → the PR's HEAD version must be a regular blob (not a
  // symlink smuggling forged evidence past the prefix check) and append-only over the
  // base. Read the COMMITTED HEAD content, never the working tree (which follows links).
  const head = committedManifestAtHead();
  if (!head.present) {
    deny('.adlc/manifest.jsonl exists at base but is absent at HEAD');
  }
  const baseManifest = git(['show', `${trustedBase}:.adlc/manifest.jsonl`], 'git show base manifest', { raw: true });
  if (baseManifest.status !== 0) fail('git show failed for an existing base manifest (operational error) — failing closed.');
  const baseBytes = baseManifest.stdout; // Buffer
  // Append-only is a BYTE-for-byte prefix check (#314 round 7): a utf8-decoded comparison
  // could miss a raw-byte rewrite of the base region (invalid sequences collapse to U+FFFD).
  if (head.bytes.length < baseBytes.length || !head.bytes.subarray(0, baseBytes.length).equals(baseBytes)) {
    deny('.adlc/manifest.jsonl must be append-only in PRs');
  }
  if (verifiedMigration) validateMigrationEvidence(baseBytes.toString('utf8'), head.text, verifiedMigrationStoreHash, verifiedMigrationArchiveHash);
} else if (verifiedMigration) {
  // Verified migration ceremony (protected-base runner): the migration evidence lives in
  // the gitignored WORKING-TREE manifest by design. Read it EXACTLY ONCE and make both the
  // presence and validation decisions on that single snapshot — a two-read pattern (validate
  // one snapshot, presence-check a second) is a TOCTOU fail-open: an empty file skips
  // validation, then a swapped non-empty file satisfies presence with evidence never checked
  // (#314 round 4). The diff shape and CODEOWNERS attestation were verified upstream, which
  // is what makes trusting this local file sound in this branch only.
  // Read the migration evidence from the COMMITTED manifest (it is a tracked file — the
  // migration diff-shape allow-list expects it in the diff), the same object-bound reader as
  // every other path. validateMigrationEvidence denies empty/whitespace evidence, so ONE read
  // + one unconditional validation covers both presence and content — no working-tree read to
  // diverge from CI and no second snapshot to race against.
  validateMigrationEvidence('', committedManifestAtHead().text, verifiedMigrationStoreHash, verifiedMigrationArchiveHash);
} else if (committedManifestAtHead().text.trim()) {
  // Ordinary PR (#314): only a TRACKED manifest ADDED by the diff with non-empty evidence
  // denies. An untracked gitignored manifest reads as '' (not tracked at HEAD) and passes,
  // so the local verdict equals CI's clean checkout.
  deny('.adlc/manifest.jsonl cannot be created with evidence in a PR; create it empty during bootstrap or use the protected-base runner ceremony');
}

const immutableTrustRoots = rails.length || baseHasConfig
  ? [
      '.adlc/config.json',
      ...(verifiedMigration ? [] : ['.adlc/tickets/.store.json']),
      '.adlc/admin.pub',
      '.github/workflows/adlc-rails-guard.yml',
      // #141: the workflow that actually runs THIS gate and produces the
      // ADLC_PR_REVIEWS the ceremony reads. Since the gate's authorized-path
      // decision now depends on this file's integrity, it must be a trust root —
      // tampering it to forge reviews is itself a trust-root change.
      '.github/workflows/ci.yml',
      'CODEOWNERS',
      '.github/CODEOWNERS',
      'docs/CODEOWNERS',
      'docs/ci/rails-guard.yml',
      'scripts/rails-guard-ci.mjs',
      'packages/rails-guard/lib/trust-root-authorization.mjs',
      // The enforcement bin this script spawns to render the final verdict.
      // Freezing it is defense-in-depth, but the in-gate freeze CANNOT be
      // transitively complete: the bin is a thin CLI that delegates the verdict to
      // packages/rails-guard/lib/** (check.mjs -> rails.mjs / suppressions.mjs),
      // which in turn uses @adlc/tickets for the base-vs-head hash/contract
      // comparisons. That whole enforcement engine (packages/rails-guard/**,
      // packages/tickets/**) relies on branch-protection CODEOWNERS review as its
      // un-forgeable backstop — now CODEOWNERS-covered — the same merge gate this
      // entire ceremony rests on. (See #326 for tightening the trust-root tier.)
      'packages/rails-guard/bin/rails-guard.mjs',
      'scripts/test/rails-guard-workflow-hashes.json',
    ]
  : [];
let unique = [...new Set([...rails, ...immutableTrustRoots])];
if (unique.length === 0) {
  console.log(`rails-guard-ci: no rails declared at ${base} — nothing frozen.`);
  process.exit(0);
}

if (immutableTrustRoots.length) {
  const trustRootDiff = git(['diff', '--name-status', '-M', `${trustedBase}...HEAD`, '--', ...immutableTrustRoots], 'git diff trust roots');
  if (trustRootDiff.status !== 0) {
    fail('git diff trust roots failed (operational error) — failing closed.');
  }
  if (trustRootDiff.stdout.trim()) {
    const changedTrustRoots = trustRootDiff.stdout
      .trim()
      .split('\n')
      // Capture EVERY path column, not just the last: a rename row is
      // `R100\t<old>\t<new>`, and the frozen path in `unique` is the OLD one, so
      // both must be considered for owner lookup and the lift (otherwise a
      // legitimately-authorized rename is denied because only <new> is seen).
      .flatMap((line) => line.split('\t').slice(1).map((s) => s.trim()))
      .filter(Boolean);
    const decision = authorizeTrustRootChange(changedTrustRoots, trustedBase);
    if (decision.authorized) {
      // Authorized via the #141 ceremony — allow. This log is a convenience
      // pointer, NOT the authorization record: the approver is derived from the
      // workflow-provided ADLC_PR_REVIEWS and is therefore self-reported and
      // forgeable from the PR branch. The authoritative record is GitHub's own
      // review data + branch-protection CODEOWNERS review, which is what actually
      // gates the merge and cannot be faked from a PR. Do not treat this line as
      // proof of who approved.
      console.log(
        'rails-guard-ci: trust-root change AUTHORIZED via the #141 ceremony.\n' +
          `  ${decision.reason}\n` +
          `  approver (self-reported; authoritative source is GitHub's review record): ${decision.approver}\n` +
          `  changed: ${changedTrustRoots.join(', ')}`
      );
      // The authorized trust-root files must not be re-frozen by the rails-guard
      // bin below (it would deny the very change the ceremony just authorized).
      // Ticket-declared rails are untouched — only the authorized paths are lifted.
      unique = unique.filter((rail) => !changedTrustRoots.includes(rail));
    } else {
      deny(
        'ADLC trust root changed, deleted, or renamed and the change is NOT authorized ' +
          `(${decision.reason}). To authorize: apply the "trust-root-change" label and obtain a ` +
          'non-author CODEOWNER approval; otherwise use the protected-base admin path.\n' +
          trustRootDiff.stdout.trim()
      );
    }
  }
}

const argv = ['--base', trustedBase, ...unique.flatMap((r) => ['--rails', r])];

// Prefer the in-repo bin (this repo); fall back to a globally installed `adlc`.
const localBin = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'rails-guard',
  'bin',
  'rails-guard.mjs'
);
const result = existsSync(localBin)
  ? spawnSync(process.execPath, [localBin, ...argv], { stdio: 'inherit', timeout: 120000 })
  : spawnSync('adlc', ['rails-guard', ...argv], { stdio: 'inherit', timeout: 120000 });

if (result.error) fail(`could not run rails-guard: ${result.error.message}`);
if (result.signal) fail(`rails-guard timed out or was killed by ${result.signal}`);
process.exit(typeof result.status === 'number' ? result.status : 1);

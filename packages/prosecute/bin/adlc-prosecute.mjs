#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { parseArgs, printJson, opError, recordFinding, git, repoRoot, changedFiles, splitNulPaths, untrackedNonIgnoredPaths } from '@adlc/core';
import { readManifestForest } from '@adlc/gate-manifest/lib/forest.mjs';
import { detectTicketStore, GitTreeTicketStore } from '@adlc/tickets';
import { runProsecution, resolveProsecutionRevision, revisionIgnorePaths } from '../lib/run.mjs';
import { classifyTrustRootTier } from '../lib/tier.mjs';
import { recordCrossModelReview, carryForwardCrossModelReview, hasCrossModelApproveForRevision, manifestChainTrustworthy, manifestChainBreakReason, CROSS_MODEL_GATE, scopeObservedEntriesToAuthor } from '../lib/cross-model.mjs';
import { readObservedAttestations, assertNoTruncation, mirrorObservedAttestations } from '../lib/attestation-store.mjs';
import { getKey } from '@adlc/gate-manifest/lib/sign.mjs';
import { loadManifestKeyFromEnvLocal } from '../lib/load-env-local.mjs';

// FAIL-CLOSED distinction: a genuinely ABSENT ticket table contributes no rails
// (fine — nothing to check). But a table that EXISTS and is unreadable/malformed
// must NOT be silently treated as "no rails" — that would drop the rails
// dimension and let a change that is trust-root ONLY via a ticket rail evade the
// gate. So we throw on a present-but-corrupt table and let the caller op-error.
function readTicketArray(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`ticket table ${path} exists but cannot be read for tiering: ${err.message}`);
  }
  try {
    return JSON.parse(raw)?.tickets ?? [];
  } catch (err) {
    throw new Error(`ticket table ${path} is not valid JSON — tiering cannot proceed: ${err.message}`);
  }
}

// resolve(dir) is inside (or equal to) the repo root.
function isInsideRepo(root, resolvedDir) {
  const rel = relative(root, resolvedDir);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// The canonical repository ticket store, whichever BACKEND holds it. Reading the
// legacy `.adlc/tickets.json` path directly would fail open after a repo migrates
// to the sharded `.adlc/tickets/` backend: the file is gone, the ENOENT branch
// above yields an empty table, and every change that is trust-root ONLY via a
// ticket rail silently declassifies. detectTicketStore resolves the active
// backend instead.
//
// FAIL-CLOSED, matching readTicketArray's distinction: a genuinely ABSENT store
// contributes no rails, but a store that exists and cannot be resolved
// (ambiguous dual store, unfinished migration transaction, corrupt shard) must
// throw rather than degrade to "no rails".
//
// SECURITY — `env: {}` is load-bearing, not tidiness. detectTicketStore defaults
// to `env = process.env` and honours ADLC_TICKET_STORE / ADLC_TICKETS, which
// would make the CANONICAL store replaceable by the very author being gated:
// point either variable at a valid store that contains the active ticket but
// OMITS the repo's rails and a rails-only trust-root change declassifies,
// dropping the distinct-provider requirement. That is the same bypass the --dir
// containment rule below exists to prevent, just through a different door. An
// empty env disables override resolution, so the repo's real store always wins.
function readCanonicalTickets(root) {
  try {
    return detectTicketStore({ root, env: {} }).load().mutableTickets();
  } catch (err) {
    if (err.code === 'STORE_NOT_FOUND') return [];
    throw new Error(`canonical ticket store under ${root} exists but cannot be read for tiering: ${err.message}`);
  }
}

// Load the ticket table(s) whose `rails` define trust-root DENY paths for
// tiering. SECURITY: tiering is a GATE decision, so the rails source must be the
// repo's CANONICAL store — never REPLACEABLE by a caller-supplied --dir.
// Otherwise `--dir ../elsewhere` pointing at a table that OMITS the rails would
// declassify a change that is trust-root via the repo's real rails (a gate
// bypass). We therefore ALWAYS include the canonical store, and only UNION an
// additional --dir table when that dir is CONTAINED within the repo (so a custom
// in-repo ADLC workspace still tiers). The classifier unions rails across all
// tickets, so extra sources can only ADD deny-paths (fail-safe), never remove
// them; an out-of-repo --dir contributes nothing to tiering.
// The canonical store as the TRUSTED BASE has it. The worktree read above cannot
// distinguish "this repo has no ticket store" from "the store is tracked at base
// but not materialised here" — a sparse checkout or a skip-worktree entry leaves
// the shards absent WITHOUT git reporting them as deleted, so they never appear
// in changedFiles either. Collapsing that to an empty rail set fails OPEN: a
// rails-only trust-root change classifies as ordinary and skips the
// distinct-provider requirement. Reading the base tree closes it, and mirrors
// how rails-guard-ci.mjs resolves its rail set (base, never the PR worktree).
//
// A base that genuinely has no store contributes nothing; any other failure
// throws rather than degrading to "no rails".
function readBaseTickets(root, revision) {
  if (!revision) return [];
  try {
    return new GitTreeTicketStore({ cwd: root, revision }).load().mutableTickets();
  } catch (err) {
    if (err.code === 'STORE_NOT_FOUND') return [];
    throw new Error(`ticket store at base ${revision} cannot be read for tiering: ${err.message}`);
  }
}

// The SOURCE side of every rename/copy between the base and the change.
//
// `changedFiles` collects `git diff --name-only`, and with rename detection on
// (git's default) that reports ONLY the destination. So `git mv
// .adlc/tickets/t1--<hash>.json holding/` REMOVES a ticket contract from the
// trust root while the classifier sees nothing but an unprotected destination
// path — no TRUST_ROOT_PREFIXES entry matches and the change declassifies. The
// surviving store stays structurally valid, so an unrelated active ticket can
// still be prosecuted same-model. Archive shards, and the legacy
// `.adlc/tickets.json` itself, have the identical hole.
//
// Collect the sources explicitly rather than disabling rename detection, so the
// destination is still reported normally. `--name-status -z` is NUL-delimited:
// an R/C status carries TWO following paths, every other status carries one.
// Both the worktree and --cached diffs are read, mirroring changedFiles, so a
// rename that is merely STAGED is caught too.
function renamedSources(base, root) {
  const collect = (args) => {
    const tokens = splitNulPaths(git(args, { cwd: root, encoding: 'buffer' }));
    const sources = [];
    for (let index = 0; index < tokens.length;) {
      const status = tokens[index++];
      if (/^[RC]\d*$/.test(status)) {
        if (index < tokens.length) sources.push(tokens[index]);
        index += 2;
      } else {
        index += 1;
      }
    }
    return sources;
  };
  return [
    ...collect(['diff', '--name-status', '-z', '-M', base, '--']),
    ...collect(['diff', '--cached', '--name-status', '-z', '-M', base, '--']),
  ];
}

function loadTicketsForTier(dir, root, base) {
  // UNION, never replace: rails from the base and from the worktree both apply.
  // The classifier ORs deny-paths across tickets, so adding a source can only
  // widen the trust-root surface (fail-safe), never narrow it.
  const tickets = [...readBaseTickets(root, base), ...readCanonicalTickets(root)];
  const resolvedDir = resolve(dir);
  if (isInsideRepo(root, resolvedDir) && resolvedDir !== resolve(root, '.adlc')) {
    tickets.push(...readTicketArray(join(resolvedDir, 'tickets.json')));
  }
  return tickets;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    input: { type: 'string' },
    ticket: { type: 'string' },
    target: { type: 'string' },
    revision: { type: 'string' },
    dir: { type: 'string', default: '.adlc' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
    // Base ref used to compute the changed-file set for trust-root tiering.
    base: { type: 'string', default: 'main' },
    // record-cross-model attestation fields.
    provider: { type: 'string' },
    'author-provider': { type: 'string' },
    // #370: recording with no signing key is refused by default (the entry would be
    // inert and permanent). This makes an unsigned write a deliberate, auditable act.
    'allow-unsigned': { type: 'boolean', default: false },
    // revision-binding carry-forward — carry an EXISTING approve forward onto a moved base without a fresh review,
    // when the reviewed change itself is unchanged (see carryForwardCrossModelReview).
    'carry-forward': { type: 'string' },
    // #355 truncation anti-rollback anchor: OPTIONAL direct file path to the
    // protected-ref attestation store. Omitted → tier-check behaves exactly as
    // before (#354). Used by both `tier-check` and `mirror-attestations`.
    'attestation-store': { type: 'string' },
    // --record-finding mode: land one CONFIRMED prosecution finding in the
    // findings ledger so P7 lesson-foundry can cluster it (closes the P5→P7 loop).
    'record-finding': { type: 'boolean', default: false },
    file: { type: 'string' },
    desc: { type: 'string' },
    category: { type: 'string' },
    severity: { type: 'string' },
    line: { type: 'string' },
    verdict: { type: 'string' },
  },
});

if (values.help) {
  console.log(`adlc-prosecute --input <passes.json> --ticket id [--target label] [--revision rev] [--base main] [--dir .adlc] [--json]

ADLC P5 review-evidence recorder.

  When the change under prosecution is TRUST-ROOT TIER (touches an enforcement
  package, a gated-artifact producer, a rails deny-path, or a trust-root file —
  computed from the WORKING TREE vs <base>: two-dot 'git diff --name-only <base>'
  unioned with untracked files, so an UNCOMMITTED trust-root edit still tiers), a
  clean P5 ALSO requires a recorded cross-model adversarial approve from a provider
  DISTINCT from the author, bound to the reviewed revision. A tiered run MUST declare
  the author via --author-provider <p> (or ADLC_AUTHOR_PROVIDER) — without it the run
  FAILS CLOSED (exit 1), since distinctness cannot be proven without the author. The
  tier reasons are printed to stderr on a tiered run. If <base> is unresolvable the
  run FAILS CLOSED (exit 1): CI must fetch/provide the base.

  record-cross-model --ticket id --provider <p> --author-provider <a> --verdict approve
                     [--revision rev] [--input <passes.json>] [--base main] [--dir .adlc]
                     [--allow-unsigned]
      Register a cross-model attestation. Resolves the revision the SAME way the
      gate does (pass the same --input/--revision you use for the gate run) so the
      recorded revision matches. FAILS CLOSED if --provider === --author-provider.
      Also FAILS CLOSED without ADLC_MANIFEST_KEY, writing nothing: the entry
      would be unsigned, and the gate rejects unsigned attestations. Pass
      --allow-unsigned to write one deliberately anyway (forge-resistance tests);
      the success line is then replaced by a warning. --json reports "signed".

  record-cross-model --ticket id --carry-forward FROM_REVISION [--base main] [--dir .adlc]
      Carry an EXISTING approve forward onto a moved base WITHOUT a fresh review, when
      the reviewed change itself is unchanged (the revision-binding carry-forward path).
      Refuses unless a prior approve is recorded for FROM_REVISION, both identities are
      change-set form with an EQUAL change-set digest (COMPUTED, never asserted), the
      base actually moved, and the resulting chain depth stays within the cap — otherwise
      a FRESH distinct-provider review is required. --provider/--author-provider/--verdict
      are not accepted here: the carried entry keeps the ORIGINAL review's identity.

  tier-check ... [--attestation-store PATH]
      OPTIONAL: pass a direct file path to a protected-ref attestation store to
      also detect a dropped signed entry (TRUNCATION) that the manifest alone
      cannot see. Omitting this flag reproduces prior behavior exactly — this is
      opt-in hardening, not a required capability. The store path MUST be
      OUTSIDE the tree being tiered (like the ./_pr sibling-worktree pattern), or
      its own presence perturbs the working-tree revision hash.

  mirror-attestations --attestation-store PATH [--dir .adlc]
      Append every valid (signature-verified) cross-model entry from the
      manifest under --dir not already in the store at PATH, deduped by
      signature. Requires ADLC_MANIFEST_KEY. Intended for the trusted CI
      workflow, run BEFORE tier-check, against a base-controlled store path —
      never a PR-controlled one.

  --record-finding --file <path> --desc "<prose>" [--category <lens>] [--severity <s>] [--line <n>] [--verdict <v>] [--dir .adlc]
      Record ONE confirmed prosecution finding to <dir>/findings.jsonl for P7
      (lesson-foundry). Call once per surviving finding on a NOT-CLEAR verdict.
      Use plain-prose --desc without quoted/backticked literals so it routes to a
      spec-gap template rather than a lint rule.

Exit codes:
  0  two consecutive dry passes recorded (or a finding/attestation recorded)
  1  operational error (e.g. a finding missing --file/--desc — fails closed)
  2  verified findings remain, dry-pass convergence failed, or a trust-root-tier
     change lacks a matching cross-model attestation
     (with --attestation-store: also a rollback/truncation being detected)
`);
  process.exit(0);
}

// --- record-cross-model subcommand (register a cross-model attestation) ---
if (positionals[0] === 'record-cross-model') {
  // Signing convenience ONLY: pick up ADLC_MANIFEST_KEY from ./.env.local so a maintainer can
  // author an attestation without exporting the key first. This is deliberately NOT done for
  // tier-check: tier-check VERIFIES, and sourcing a verification key from the very tree being
  // verified would let a contributor force-add a .env.local + a matching forged approve and pass
  // a local gate (Codex #354 loader F2). A wrong key HERE only produces an attestation that fails
  // in CI under the real secret — inert, not a bypass. No-op in CI / when the key is already set.
  loadManifestKeyFromEnvLocal();
  if (!values.ticket) opError('record-cross-model requires --ticket');
  // #370 FAIL CLOSED — recording is a SIGNING operation, so with no key it cannot do its
  // job. It used to write the unsigned entry anyway, exit 0 and print success; the gate
  // then rejected the inert entry in CI and pointed the operator back at the step they had
  // just "completed" — after the distinct-provider adversarial review that produced the
  // attestation was already spent. That review is the cost, which is why this refuses
  // BEFORE the append rather than warning after it: `.adlc/manifest.jsonl` is append-only
  // and hash-chained, so a mistaken entry committed here is permanent noise.
  //
  // The unsigned path stays reachable, but only as a DELIBERATE act (#326's
  // forge-resistance test records unsigned on purpose to prove the gate rejects it), so
  // "the operator lost their key" and "this write is meant to be unsigned" are now
  // distinguishable at the call site instead of producing identical output.
  if (!getKey() && !values['allow-unsigned']) {
    opError(
      'record-cross-model: ADLC_MANIFEST_KEY is not set, so the attestation would be written UNSIGNED — and an unsigned entry would NOT satisfy the trust-root gate, which trusts an attestation only via its signature. Refusing to write it: the manifest is append-only, so the inert entry would be permanent.\n' +
      '  Set the key and re-run. Note it is commonly kept in the MAIN checkout\'s gitignored .env.local, which is ABSENT from a git worktree — from a worktree, source it explicitly. In bash or zsh:\n' +
      '    set -a; . /path/to/main-checkout/.env.local; set +a\n' +
      '  (that form is POSIX shell syntax and fails in fish, which has no `set -a` toggle — there, export the variable directly.)\n' +
      '  To write an unsigned entry on purpose (forge-resistance tests), pass --allow-unsigned.'
    );
  }
  let input;
  if (values.input) {
    try {
      input = JSON.parse(readFileSync(values.input, 'utf8'));
    } catch (err) {
      opError(`could not read --input: ${err.message}`);
    }
  }
  const revision = resolveProsecutionRevision({
    dir: values.dir,
    base: values.base,
    revision: values.revision,
    input,
    inputPath: values.input,
  });
  if (!revision) opError('revision could not be resolved; pass --revision or run inside a git worktree');

  // #365 Decision 2 / AC15 — refuse to record an attestation while an untracked-and-NOT-ignored
  // file is present, for the same reason runProsecution refuses: the change-set identity excludes
  // untracked files, so without this the tree could hold unaccounted state at the moment this
  // attestation is minted. Same ignorePaths construction as the identity, so the manifest itself,
  // --input, and review evidence never trigger it.
  //
  // Skipped when --revision is EXPLICIT, matching resolveChangeSetRevision's own short-circuit —
  // see the identical comment in runProsecution (lib/run.mjs) for why.
  if (values.revision === undefined || String(values.revision).trim() === '') {
    let untrackedPaths;
    try {
      untrackedPaths = untrackedNonIgnoredPaths({ ignorePaths: revisionIgnorePaths(process.cwd(), values.dir, input, values.input) });
    } catch (err) {
      opError(`cannot verify the working tree is free of untracked files: ${err.message}`);
    }
    if (untrackedPaths.length > 0) {
      opError(`refusing to record: untracked, non-ignored file(s) present in the working tree — ${untrackedPaths.join(', ')}`);
    }
  }

  // revision-binding carry-forward mode: re-attest an EXISTING approve at the newly-resolved revision
  // instead of recording a fresh one. Separate branch (not merged with the fresh-record path
  // below) because it takes NO --provider/--author-provider/--verdict — the carried entry keeps
  // the ORIGINAL review's identity, since it IS that review, just bound to a moved base.
  if (values['carry-forward']) {
    let carried;
    try {
      carried = carryForwardCrossModelReview({
        ticket: values.ticket,
        fromRevision: values['carry-forward'],
        revision,
        dir: values.dir,
        key: getKey(),
      });
    } catch (err) {
      opError(err.message); // fail closed: an unmoved/mismatched/uncapped/missing-prior carry is an operational error, never recorded
    }
    if (values.json) {
      printJson(carried);
    } else {
      console.log(`carried forward cross-model ${carried.data.verdict} for ${values.ticket} @ ${revision} (depth ${carried.data.carryDepth}, from ${carried.data.carriedFrom})`);
    }
    process.exit(0);
  }

  let entry;
  try {
    entry = recordCrossModelReview({
      ticket: values.ticket,
      revision,
      provider: values.provider,
      authorProvider: values['author-provider'],
      verdict: values.verdict,
      dir: values.dir,
      key: getKey(),
    });
  } catch (err) {
    opError(err.message); // fail closed: a same-provider or malformed attestation is exit 1, never recorded
  }
  // #370 — report what was actually WRITTEN, not what was intended. The success line is
  // the operator's evidence that the ceremony's last step worked, so it is printed only
  // for an entry that carries a signature; anything else gets the warning instead. Read
  // from the recorded entry rather than re-checking the key, so a signing path that
  // silently stops producing `sig` can never resurface as a false success.
  const signed = typeof entry.sig === 'string' && entry.sig !== '';
  if (values.json) {
    printJson({ ...entry, signed });
  } else if (signed) {
    console.log(`recorded cross-model ${entry.data.verdict} for ${values.ticket} @ ${revision} (${entry.data.provider} vs author ${entry.data.authorProvider})`);
  }
  // Always on stderr, so --json stdout stays machine-parseable.
  if (!signed) {
    console.error(
      `record-cross-model: recorded an UNSIGNED cross-model ${entry.data.verdict} for ${values.ticket} @ ${revision}. ` +
      'It will NOT satisfy the trust-root gate — the gate trusts an attestation only via its signature. ' +
      'Set ADLC_MANIFEST_KEY and re-record if this was not deliberate; the unsigned entry stays in the append-only manifest either way.'
    );
  }
  process.exit(0);
}

// --- mirror-attestations subcommand (#355: append newly-observed cross-model entries to
// the protected-ref attestation store) ---
// Called by the trusted workflow ONLY, BEFORE the gate step, against a base-controlled
// store path (never a PR-controlled one). Only ever mirrors CROSS_MODEL_GATE entries —
// this store exists solely to anchor that one gate's history outside the PR-controlled tree.
if (positionals[0] === 'mirror-attestations') {
  if (!values['attestation-store']) opError('mirror-attestations requires --attestation-store PATH');
  const key = getKey();
  if (!key) opError('mirror-attestations requires ADLC_MANIFEST_KEY to verify which entries are trustworthy to mirror');
  // #355 round-3 cross-model review (codex): each entry's OWN signature is still
  // verified inside mirrorObservedAttestations, but that alone is not enough — a
  // signed entry copied out of context from an unrelated, legitimate manifest is
  // individually valid yet says nothing trustworthy about THIS manifest. Refuse to
  // write to the shared, permanent store from a manifest whose chain does not
  // verify; the later gate step will reject this PR anyway, but the store must
  // never be poisoned with entries from an untrustworthy read. A malformed/
  // unparseable line is ALREADY covered here, not a separate case: verify()
  // (called by manifestChainTrustworthy) returns invalid on the first line it
  // cannot JSON.parse, before readEntries' tolerant `skipped` collection could
  // ever matter — checking `skipped` again here would be unreachable dead code.
  if (!manifestChainTrustworthy(values.dir, key)) {
    opError(`mirror-attestations: the manifest chain at ${values.dir} does not verify — refusing to mirror from an untrustworthy manifest into the shared attestation store`);
  }
  // Forest-aware (adversarial-review finding, T-MANIFEST-FOREST slice 3): once
  // a repo is segmented, every new cross-model entry lives in manifest.d/, not
  // root. A root-only read here mirrors NOTHING post-cutover, silently
  // dropping the anti-truncation anchor for every future approval/revocation.
  const { entries } = readManifestForest(values.dir);
  const crossModelEntries = entries.filter((entry) => (entry.gate ?? entry.type) === CROSS_MODEL_GATE);
  let appended;
  try {
    appended = mirrorObservedAttestations({ prEntries: crossModelEntries, storePath: values['attestation-store'], key });
  } catch (err) {
    // #355 round-5 cross-model review (codex): the store itself can be tampered with
    // (or the key rotated) — mirrorObservedAttestations fails closed rather than
    // silently continuing onto a corrupted store. Surface it through the CLI's
    // normal error path, not an uncaught exception.
    opError(err.message);
  }
  if (values.json) {
    printJson({ appended });
  } else {
    console.log(`mirror-attestations: appended ${appended} new cross-model attestation(s) to ${values['attestation-store']}`);
  }
  process.exit(0);
}

// --- tier-check subcommand (#326: the CI trust-root cross-model gate) ---
// Classify the change; if trust-root tier, REQUIRE a distinct-provider cross-model
// approve bound to the reviewed revision (fail closed). Always surfaces the tier
// decision so "no review required" and "review missing" are distinguishable.
if (positionals[0] === 'tier-check') {
  let root;
  let changed;
  let tickets;
  try {
    root = repoRoot();
    const tracked = changedFiles(values.base, root); // two-dot: working tree vs base
    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root })
      .split('\0').filter(Boolean);
    changed = [...new Set([...tracked, ...untracked, ...renamedSources(values.base, root)])];
    tickets = loadTicketsForTier(values.dir, root, values.base); // rails deny-path source
  } catch (err) {
    opError(`tier-check: cannot determine the changed-file set — base ref '${values.base}' unresolvable. Fetch it (git fetch origin ${values.base}) or pass --base <ref>. Underlying: ${err.message}`);
  }
  let tier;
  try {
    tier = classifyTrustRootTier({ changedFiles: changed, tickets });
  } catch (err) {
    opError(`tier-check: cannot classify the change: ${err.message}`);
  }

  // AC3: the tier decision is ALWAYS visible — tiered or not.
  if (!tier.isTrustRootTier) {
    if (values.json) printJson({ trustRootTier: false, reasons: [], crossModelRequired: false, satisfied: true });
    else console.log('tier-check: NOT trust-root tier — no cross-model review required.');
    process.exit(0);
  }
  console.error('tier-check: TRUST-ROOT tier — a distinct-provider cross-model approve is REQUIRED. Reasons:');
  for (const reason of tier.reasons) console.error(`  - ${reason}`);

  const authorProvider = values['author-provider'] ?? process.env.ADLC_AUTHOR_PROVIDER;
  if (!authorProvider) {
    opError('tier-check: trust-root tier but no --author-provider / ADLC_AUTHOR_PROVIDER — distinctness cannot be proven; failing closed');
  }
  const revision = resolveProsecutionRevision({ dir: values.dir, base: values.base, revision: values.revision });
  if (!revision) opError('tier-check: revision could not be resolved; run inside a git worktree or pass --revision');

  // #326 hardening — the attestation is trusted ONLY via its HMAC signature, verified with
  // the key. Without the key the gate cannot tell a real cross-model approve from a PR-forged
  // manifest line (a PR controls the manifest file but not the key), so it fails closed with a
  // distinct message rather than the misleading "no attestation".
  const key = getKey();
  if (!key) {
    if (values.json) {
      printJson({ trustRootTier: true, reasons: tier.reasons, crossModelRequired: true, satisfied: false, revision, keyAvailable: false });
    } else {
      console.error(`tier-check: ADLC_MANIFEST_KEY is not available, so cross-model attestations cannot be signature-verified — an unverifiable attestation is forgeable, so NONE is trusted. This required trust-root gate FAILS CLOSED for revision ${revision}. Provide the key as a CI secret (available to same-repo runs) and re-record the attestation with it.`);
    }
    process.exit(2);
  }

  // #355 truncation anti-rollback anchor — OPTIONAL. Reading the store here (rather than
  // inside hasCrossModelApproveForRevision) lets this CLI attribute a truncation failure
  // distinctly from "no attestation" below; passing `undefined` when the flag is absent
  // makes hasCrossModelApproveForRevision behave exactly as it did before this existed.
  const attestationStorePath = values['attestation-store'];
  let observedEntries;
  if (attestationStorePath) {
    try {
      observedEntries = readObservedAttestations(attestationStorePath, { key });
    } catch (err) {
      // #355 round-5 cross-model review (codex): a tampered/rotated-key store entry
      // now fails closed (see attestation-store.mjs) instead of being silently
      // dropped. Surface it through the CLI's normal error path.
      opError(`tier-check: ${err.message}`);
    }
  }

  const satisfied = hasCrossModelApproveForRevision({ dir: values.dir, revision, authorProvider, key, observedEntries });
  // #364 — WHY it failed, not just THAT it failed. hasCrossModelApproveForRevision checks the
  // chain before examining any entry, so "the chain does not verify" and "no entry matches this
  // revision" arrive here as the same `false`. Reporting both as a missing attestation sends the
  // operator to run a distinct-provider adversarial review and record one — work that cannot
  // clear a broken chain (record-cross-model refuses to append onto it). The review is the
  // wasted cost. `satisfied` still decides the exit code; this only attributes the cause.
  //
  // Short-circuit on `satisfied`: hasCrossModelApproveForRevision returns true ONLY after its
  // own manifestChainTrustworthy check passed, so satisfied ⇒ the chain verified. Re-deriving
  // it would re-read and re-verify the whole ledger on the PASS path for an answer already
  // known (cross-model review finding, MEDIUM). The || keeps the failing path exact.
  const chainTrustworthy = satisfied || manifestChainTrustworthy(values.dir, key);
  // Same short-circuit logic for the THIRD cause (#355): only worth re-deriving on the
  // failing path, and only meaningful when a store was actually supplied.
  let truncationDetected = false;
  if (!satisfied && chainTrustworthy && observedEntries !== undefined) {
    // Forest-aware for the same reason as mirror-attestations above: this
    // must see the SAME entries hasCrossModelApproveForRevision evaluated
    // (forest-wide since slice 2), or a segmented repo's truncation
    // attribution silently degrades to "root-only", the exact regression
    // this diagnostic branch exists to distinguish from a real gap.
    const { entries: prEntries } = readManifestForest(values.dir);
    // Same author-scoping hasCrossModelApproveForRevision applies internally (round-4
    // finding): recomputing this with UNSCOPED observedEntries would misreport a
    // cross-author revision collision as truncation instead of a missing attestation.
    const authorScopedObserved = scopeObservedEntriesToAuthor(observedEntries, authorProvider);
    truncationDetected = !assertNoTruncation({ prEntries, observedEntries: authorScopedObserved, revision, key }).ok;
  }
  if (values.json) {
    printJson({ trustRootTier: true, reasons: tier.reasons, crossModelRequired: true, satisfied, revision, chainTrustworthy, truncationDetected });
    process.exit(satisfied ? 0 : 2);
  }
  if (satisfied) {
    console.log(`tier-check: cross-model approve found for revision ${revision} (reviewer distinct from author ${authorProvider}). PASS.`);
    process.exit(0);
  }
  if (!chainTrustworthy) {
    // #378 — "does not verify" can have several distinct causes (see verify.mjs's
    // break.reason: 'signature invalid', 'unsigned entry', 'prev hash mismatch', 'seq
    // not monotonically increasing', 'malformed JSON', 'entry must be an object',
    // 'invalid seq', 'first entry prev must be null'). Name the two most common and
    // actionable ones specifically; fall back to a NEUTRAL message for the rest rather
    // than asserting a specific (and likely wrong) root cause like key rotation for
    // what could be raw ledger corruption or tampering unrelated to any key.
    const reason = manifestChainBreakReason(values.dir, key);
    const causeLine = reason === 'unsigned entry'
      ? `The usual cause is that an entry was appended WITHOUT ADLC_MANIFEST_KEY set after this ledger had already adopted signing — a config gap somewhere the entry was recorded, not a rotation. Ensure the key is set for every future record. To repair: \`adlc gate-manifest repair-chain --reason "<why>" --write --attest-unsigned\` — NOTE this re-signs EVERY currently-unsigned entry in the WHOLE manifest under today's key, including any honest legacy prefix that predates signing, not just the lapsed one; review \`adlc gate-manifest verify --allow-legacy-unsigned\` output first to confirm that is what you want.\n`
      : reason === 'signature invalid'
      ? `The usual cause is that ADLC_MANIFEST_KEY was ROTATED or replaced — every previously signed entry was signed with the OLD key and no longer verifies under the new one. Restore the original key, or migrate the signed history onto the new key.\n`
      : `Cause: ${reason ?? 'unknown'}. This is a ledger integrity problem (corruption, truncation, or out-of-order entries), not necessarily a key issue — investigate the manifest directly before assuming rotation.\n`;
    console.error(
      `tier-check: the manifest hash chain does NOT verify. This required check FAILS for revision ${revision}.\n` +
      `This is NOT a missing attestation. Recording a new one will not clear it: record-cross-model refuses to append onto an unverifiable chain, so a distinct-provider review run now would be wasted.\n` +
      causeLine +
      // --allow-legacy-unsigned here mirrors the SAME check that determined
      // chainTrustworthy (manifestChainTrustworthy also uses requireSignatures:false)
      // — the plain strict form would instead break at this ledger's own honest
      // legacy prefix (seq 1), masking the actual break point named above.
      `Diagnose with: adlc gate-manifest verify --allow-legacy-unsigned`
    );
    process.exit(2);
  }
  if (truncationDetected) {
    console.error(
      `tier-check: ROLLBACK/TRUNCATION DETECTED for revision ${revision} — the attestation store at ${attestationStorePath} holds a signed cross-model entry for this revision that is MISSING from this tree's manifest. This required check FAILS CLOSED.\n` +
      `This is NOT a missing attestation and recording a new one will not clear it: a signed entry (commonly a needs-attention revocation) was dropped from .adlc/manifest.jsonl after a trusted run observed it. Restore the dropped entry rather than overwriting it.`
    );
    process.exit(2);
  }
  console.error(
    `tier-check: NO SIGNATURE-VERIFIED cross-model attestation for revision ${revision} (author ${authorProvider}). This required check FAILS.\n` +
    `Record one AFTER a distinct-provider adversarial review, with ADLC_MANIFEST_KEY set so the entry is signed (an unsigned/forged entry is rejected):\n` +
    `  ADLC_MANIFEST_KEY=<key> adlc-prosecute record-cross-model --ticket <id> --provider <distinct-provider> --author-provider ${authorProvider} --verdict approve --revision ${revision}`
  );
  process.exit(2);
}

// --- record-finding mode (P5 → P7 bridge) ---
if (values['record-finding']) {
  let line;
  if (values.line !== undefined) {
    line = Number(values.line);
    if (!Number.isInteger(line) || line <= 0) opError(`--line must be a positive integer, got "${values.line}"`);
  }
  let entry;
  try {
    entry = recordFinding(
      {
        file: values.file,
        desc: values.desc,
        category: values.category,
        severity: values.severity,
        line,
        verdict: values.verdict,
      },
      values.dir
    );
  } catch (err) {
    opError(err.message); // fail closed: a malformed finding is exit 1, never a silent no-op
  }
  if (values.json) {
    printJson(entry);
  } else {
    console.log(`recorded finding → ${values.dir}/findings.jsonl (${entry.category}, ${entry.file})`);
  }
  process.exit(0);
}

if (!values.input) opError('usage: adlc-prosecute --input <passes.json> --ticket id');
if (!values.ticket) opError('usage: adlc-prosecute --input <passes.json> --ticket id');

let input;
try {
  input = JSON.parse(readFileSync(values.input, 'utf8'));
} catch (err) {
  opError(`could not read input: ${err.message}`);
}

// Classify the change under prosecution: if it is trust-root tier, a clean P5
// additionally requires a distinct-provider cross-model approve at this revision.
//
// WORKING-TREE-INCLUSIVE: prosecution binds to the working-tree revision
// (resolveRevision hashes the worktree), so the tier's changed-file set MUST match
// what is actually prosecuted — not just committed history. A three-dot
// `base...HEAD` diff misses an UNCOMMITTED edit to a trust-root file, which would
// let a converged P5 exit 0 with no attestation (fail-open). We therefore union:
//   • tracked changes of the working tree vs base (two-dot `git diff --name-only <base>`)
//   • untracked, non-ignored files (`git ls-files --others --exclude-standard`)
//
// FAIL CLOSED: if the changed-file set cannot be computed (base ref unresolvable,
// or not a git repo), we cannot decide whether the tier gate applies, so we REFUSE
// the run (exit 1) rather than fall back to an ungated P5. CI must provide the base
// (fetch it or pass --base <ref>); see docs/ci/rails-guard.yml.
let changed;
let root;
try {
  root = repoRoot();
  const tracked = changedFiles(values.base, root); // two-dot: working tree vs base
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root })
    .split('\0').filter(Boolean);
  changed = [...new Set([...tracked, ...untracked, ...renamedSources(values.base, root)])];
} catch (err) {
  opError(`cannot determine trust-root tier: base ref '${values.base}' unresolvable — fetch the base (e.g. git fetch origin main) or pass --base <ref>. Underlying: ${err.message}`);
}
let tier;
try {
  tier = classifyTrustRootTier({ changedFiles: changed, tickets: loadTicketsForTier(values.dir, root, values.base) });
} catch (err) {
  opError(`cannot determine trust-root tier: ${err.message}`);
}
const requireCrossModel = tier.isTrustRootTier;
if (tier.isTrustRootTier) {
  console.error(`trust-root tier: cross-model adversarial approve REQUIRED (base ${values.base}). Reasons:`);
  for (const reason of tier.reasons) console.error(`  - ${reason}`);
}

// Author identity anchored to THIS invocation (never the attestation's self-report).
const authorProvider = values['author-provider'] ?? process.env.ADLC_AUTHOR_PROVIDER;

const result = runProsecution(input, {
  ticket: values.ticket,
  key: getKey(),
  target: values.target,
  base: values.base,
  revision: values.revision,
  inputPath: values.input,
  dir: values.dir,
  requireCrossModel,
  authorProvider,
});

if (values.json) {
  printJson(result);
} else if (result.exitCode === 0) {
  console.log(result.message);
} else {
  console.error(result.message);
  if (result.errors) console.error(result.errors.join('\n'));
}

process.exit(result.exitCode);

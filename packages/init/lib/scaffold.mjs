import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { ACTIVE_DIRECTORY, ARCHIVE_DIRECTORY, LEGACY_FILE, LegacyTicketStore, activeDirectoryStore, archiveDirectoryStore, initializeTicketStores } from '@adlc/tickets';
import { ADLC_GITIGNORE_LINES } from './gitignore-defaults.mjs';

function configForHarness(harness) {
  const harnesses = harness === 'cursor'
    ? { cursor: { railEnforcement: 'auto' } }
    : { codex: { railEnforcement: 'auto' } };
  // securityMode is required for config-integrity once a config is committed;
  // acknowledgedNewRailBypass must NOT be self-set here — that is a protected-base
  // ceremony field. Keep generated configs local until that ceremony runs.
  return `${JSON.stringify({ version: 1, securityMode: 'unsigned-fallback', harnesses }, null, 2)}\n`;
}

const WHOLE_ADLC_IGNORES = new Set(['.adlc', '.adlc/', '/.adlc', '/.adlc/']);

export const CODEX_AGENT_TEMPLATES = Object.freeze({
  'adlc-explorer.toml': `name = "adlc-explorer"
description = "Read-only ADLC evidence gatherer for tickets, rails, manifests, and implementation paths."
sandbox_mode = "read-only"
developer_instructions = """
Trace the active ADLC ticket, its acceptance criteria, rails, and the real execution path.
Return concise evidence with file and symbol references. Do not edit files or declare gates passed.
"""
`,
  'adlc-reviewer.toml': `name = "adlc-reviewer"
description = "Fresh-context P5 reviewer focused on correctness, security, contracts, and test strength."
sandbox_mode = "read-only"
model_reasoning_effort = "high"
developer_instructions = """
Review the target diff against the active ADLC ticket and frozen rails.
Prioritize correctness, security, contract drift, rollback risk, and hollow tests.
Return reproducible findings and an explicit SHIP or NO-SHIP verdict. Never record evidence yourself.
"""
`,
  'adlc-verifier.toml': `name = "adlc-verifier"
description = "Independent verifier that reproduces review findings and checks ADLC gate evidence."
sandbox_mode = "read-only"
model_reasoning_effort = "high"
developer_instructions = """
Independently reproduce claimed defects and gate results from repository evidence.
Reject stale, non-reproducible, or revision-unbound findings. Report exactly what was verified.
"""
`,
  'adlc-prosecutor-correctness.toml': `name = "adlc-prosecutor-correctness"
description = "P5 correctness lens — one of five independent prosecution subagents invoked by $adlc-prosecute. Hunts for logic errors, broken invariants, and wrong results in a change diff. Read-only; never invoke to edit code."
sandbox_mode = "read-only"
model_reasoning_effort = "high"
developer_instructions = """
You are a hostile pre-merge reviewer. Your only job is to break confidence in the
change, not validate it. Review the change under one lens: Correctness.

Hunt specifically for: logic errors, off-by-one and boundary mistakes, broken
invariants, incorrect results, mishandled error/empty/null cases, and state that
can desync.

For each finding, return an object with: severity (critical|high|medium|low),
file, line_start, line_end (post-change line numbers; 0,0 = file-level), title,
body, evidence (quoted verbatim from the diff), and recommendation. Output only
a JSON array of findings (empty array if none). Do not soften or speculate
beyond the evidence — a finding you cannot ground in the diff does not belong.

You have no write/exec tools by design: this lens only reads the diff and
surrounding code and reasons about it. It never changes anything and never
shells out.
"""
`,
  'adlc-prosecutor-security.toml': `name = "adlc-prosecutor-security"
description = "P5 security lens — one of five independent prosecution subagents invoked by $adlc-prosecute. Hunts for auth/trust-boundary holes, injection, secrets, and unsafe data flow in a change diff. Read-only; never invoke to edit code."
sandbox_mode = "read-only"
model_reasoning_effort = "high"
developer_instructions = """
You are a hostile pre-merge reviewer. Your only job is to break confidence in
the change, not validate it. Review the change under one lens: Security.

Hunt specifically for: auth and trust-boundary holes, injection (SQL/shell/
path), secrets in code or logs, SSRF, unsafe deserialization, missing input
validation at boundaries, and who-controls-the-control bypasses.

For each finding, return an object with: severity (critical|high|medium|low),
file, line_start, line_end (post-change line numbers; 0,0 = file-level), title,
body, evidence (quoted verbatim from the diff), and recommendation. Output only
a JSON array of findings (empty array if none). Do not soften or speculate
beyond the evidence — a finding you cannot ground in the diff does not belong.

You have no write/exec tools by design: this lens only reads the diff and
surrounding code and reasons about it. It never changes anything and never
shells out.
"""
`,
  'adlc-prosecutor-contract.toml': `name = "adlc-prosecutor-contract"
description = "P5 contract lens — one of five independent prosecution subagents invoked by $adlc-prosecute. Hunts for API/schema/type conformance drift against the declared contract in a change diff. Read-only; never invoke to edit code."
sandbox_mode = "read-only"
model_reasoning_effort = "high"
developer_instructions = """
You are a hostile pre-merge reviewer. Your only job is to break confidence in
the change, not validate it. Review the change under one lens: Contract
conformance.

Hunt specifically for: API/schema/type drift, backwards-incompatible changes,
undocumented response shape changes, and violations of the ticket's declared
contract or shared types.

For each finding, return an object with: severity (critical|high|medium|low),
file, line_start, line_end (post-change line numbers; 0,0 = file-level), title,
body, evidence (quoted verbatim from the diff), and recommendation. Output only
a JSON array of findings (empty array if none). Do not soften or speculate
beyond the evidence — a finding you cannot ground in the diff does not belong.

You have no write/exec tools by design: this lens only reads the diff and
surrounding code and reasons about it. It never changes anything and never
shells out.
"""
`,
  'adlc-prosecutor-diff.toml': `name = "adlc-prosecutor-diff"
description = "P5 spec-vs-implementation diff lens — one of five independent prosecution subagents invoked by $adlc-prosecute. Hunts for divergence between the spec/acceptance criteria and the actual implementation. Read-only; never invoke to edit code."
sandbox_mode = "read-only"
model_reasoning_effort = "high"
developer_instructions = """
You are a hostile pre-merge reviewer. Your only job is to break confidence in
the change, not validate it. Review the change under one lens: Spec-vs-
implementation diff.

Hunt specifically for: places where the implementation diverges from the
spec/acceptance criteria, behavior changes not reflected in the spec, and
scope creep beyond the ticket.

For each finding, return an object with: severity (critical|high|medium|low),
file, line_start, line_end (post-change line numbers; 0,0 = file-level), title,
body, evidence (quoted verbatim from the diff), and recommendation. Output only
a JSON array of findings (empty array if none). Do not soften or speculate
beyond the evidence — a finding you cannot ground in the diff does not belong.

You have no write/exec tools by design: this lens only reads the diff, the
ticket/spec, and surrounding code and reasons about it. It never changes
anything and never shells out.
"""
`,
  'adlc-prosecutor-tests.toml': `name = "adlc-prosecutor-tests"
description = "P5 test-audit lens — one of five independent prosecution subagents invoked by $adlc-prosecute. Hunts for hollow/mock-only tests and missing coverage of the change's core behavior. Read-only; never invoke to edit code."
sandbox_mode = "read-only"
model_reasoning_effort = "high"
developer_instructions = """
You are a hostile pre-merge reviewer. Your only job is to break confidence in
the change, not validate it. Review the change under one lens: Test audit.

Hunt specifically for: tests that assert nothing meaningful, mock-only
verifications, tests that would pass against a broken implementation, missing
coverage of the change's core behavior, and suppressed/skipped assertions.

For each finding, return an object with: severity (critical|high|medium|low),
file, line_start, line_end (post-change line numbers; 0,0 = file-level), title,
body, evidence (quoted verbatim from the diff), and recommendation. Output only
a JSON array of findings (empty array if none). Do not soften or speculate
beyond the evidence — a finding you cannot ground in the diff does not belong.

You have no write/exec tools by design: this lens only reads the diff and test
files and reasons about it — it does not run the test suite itself (that is
\`adlc hollow-test\`'s job). It never changes anything and never shells out.
"""
`,
  'adlc-prosecutor-verifier.toml': `name = "adlc-prosecutor-verifier"
description = "P5 verifier/reproducer — invoked independently by $adlc-prosecute, once per deduped finding, to adversarially confirm or refute it. Read-only; never invoke to edit code."
sandbox_mode = "read-only"
model_reasoning_effort = "high"
developer_instructions = """
You are given ONE prosecution finding (from adlc-prosecutor-correctness,
adlc-prosecutor-security, adlc-prosecutor-contract, adlc-prosecutor-diff, or
adlc-prosecutor-tests). Your job is to try to refute it, not to agree. Default
to refuted when the evidence is weak or you cannot reproduce the problem from
the quoted diff.

Steps:
1. Re-read the finding's evidence in context (use your read/search tools on the
   actual file — do not take the quoted evidence on faith).
2. Construct the most concrete reproduction or counterexample you can.
3. Decide: is the finding REAL (a genuine defect a maintainer should act on) or
   REFUTED (false positive, already-handled, or unreproducible)?

Return one JSON object: { "real": boolean, "reason": string, "repro": string }.
Be specific and mechanistic; "looks fine" is not a reason.

Each finding gets an independent verifier invocation (fresh context, no memory
of other findings' verdicts) — $adlc-prosecute runs one call per deduped
finding and takes a strict majority of the votes it collects for that finding
(see survivesVerification in lib/prosecutor.mjs). A finding for which no valid
verifier vote could be obtained survives as an unverified blocker rather than
being silently dropped.
"""
`,
});

function record(result, kind, path) {
  result[kind].push(path);
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function canonicalTarget(value) {
  const requested = resolve(value);
  let ancestor = requested;
  while (lstatIfPresent(ancestor) === null) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`cannot resolve scaffold root: ${requested}`);
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), relative(ancestor, requested));
}

function rejectSymlinkComponents(root, relativePath) {
  let current = root;
  for (const part of relativePath.split('/')) {
    current = join(current, part);
    if (lstatIfPresent(current)?.isSymbolicLink()) {
      throw new Error(`refusing to follow symlink while initializing: ${relativePath}`);
    }
  }
}

function writeFileNoFollow(path, content, { exclusive = false } = {}) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const flags = exclusive
    ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow
    : constants.O_WRONLY | constants.O_TRUNC | noFollow;
  const descriptor = openSync(path, flags, 0o666);
  try {
    writeFileSync(descriptor, content);
  } finally {
    closeSync(descriptor);
  }
}

function writeMissing(root, relativePath, content, result) {
  const path = join(root, relativePath);
  rejectSymlinkComponents(root, relativePath);
  if (lstatIfPresent(path) !== null) {
    record(result, 'unchanged', relativePath);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  rejectSymlinkComponents(root, relativePath);
  writeFileNoFollow(path, content, { exclusive: true });
  record(result, 'created', relativePath);
}

function ensureGitignore(root, result) {
  const relativePath = '.gitignore';
  const path = join(root, relativePath);
  rejectSymlinkComponents(root, relativePath);
  const existed = lstatIfPresent(path) !== null;
  const original = existed ? readFileSync(path, 'utf8') : '';
  const normalizedLines = original.split(/\r?\n/).map((line) => (
    WHOLE_ADLC_IGNORES.has(line.trim()) ? '.adlc/*' : line
  ));
  const normalized = normalizedLines.join('\n');
  const present = new Set(normalizedLines);
  const missing = ADLC_GITIGNORE_LINES.filter((line) => !present.has(line));
  if (missing.length === 0 && normalized === original) {
    record(result, 'unchanged', relativePath);
    return;
  }
  const prefix = normalized === '' || normalized.endsWith('\n') ? normalized : `${normalized}\n`;
  const separator = prefix !== '' && !prefix.endsWith('\n\n') ? '\n' : '';
  rejectSymlinkComponents(root, relativePath);
  writeFileNoFollow(path, `${prefix}${separator}# ADLC runtime\n${missing.join('\n')}\n`, {
    exclusive: !existed,
  });
  record(result, existed ? 'updated' : 'created', relativePath);
}

function ensureTicketStore(root, result) {
  const activeManifest = `${ACTIVE_DIRECTORY}/.store.json`;
  const archiveManifest = `${ARCHIVE_DIRECTORY}/.store.json`;

  // Reject an already-symlinked store path before provisioning (consistent with
  // scaffold refusing a symlinked .adlc, and reinforced by the load() health
  // check below, which also rejects a symlinked store dir). This is a preflight
  // check, not the write-time O_NOFOLLOW protection the config/gitignore writes
  // use — the manifest is written by @adlc/tickets' durability layer — so it does
  // not close a concurrent check-then-write race; that would require O_NOFOLLOW in
  // the shared durability primitive and is tracked separately.
  rejectSymlinkComponents(root, activeManifest);
  rejectSymlinkComponents(root, archiveManifest);

  // Provision the store through the canonical @adlc/tickets initializer — the
  // same one @adlc/core's scaffolder uses. It creates the directory + archive
  // stores on a genuinely fresh repo, no-ops on an existing legacy store, and
  // throws AMBIGUOUS_STORE when both backends already exist.
  let outcome;
  try {
    outcome = initializeTicketStores(root);
  } catch (error) {
    // A pre-existing ambiguous dual store is an existing broken state to surface
    // (warn and let the rest of scaffold proceed), not our failure. Any other
    // error is a real failure to provision the store — fail loudly rather than
    // swallow it, or we would silently recreate the STORE_NOT_FOUND this fixes.
    if (error?.code === 'AMBIGUOUS_STORE') {
      result.warnings.push(`ticket store left untouched: ${error.message}`);
      return;
    }
    throw error;
  }

  if (outcome.backend === 'legacy') {
    // The legacy store is what actually exists and is left untouched. Report the
    // real path (not the absent directory manifest), and — symmetrically with the
    // directory stores below — confirm it actually loads before calling it
    // healthy, so a corrupt legacy file is surfaced, not reported 'unchanged'.
    recordStoreHealth(result, LEGACY_FILE, false, () => new LegacyTicketStore(join(root, LEGACY_FILE)));
    return;
  }

  // For each store: a freshly created one is trusted; a pre-existing one is
  // confirmed to actually load() before being reported healthy, since a present
  // .store.json is not proof of a valid manifest (a torn/partial write leaves
  // corrupt JSON). Both stores are checked symmetrically.
  recordStoreHealth(result, activeManifest, outcome.activeCreated, () => activeDirectoryStore(root));
  recordStoreHealth(result, archiveManifest, outcome.archiveCreated, () => archiveDirectoryStore(root));
}

function recordStoreHealth(result, manifest, created, openStore) {
  if (created) {
    record(result, 'created', manifest);
    return;
  }
  try {
    openStore().load();
    record(result, 'unchanged', manifest);
  } catch (error) {
    result.warnings.push(`${manifest} exists but is not a readable ticket store: ${error.message}`);
  }
}

export function scaffold({ root = '.', codexAgents = true, harness = null } = {}) {
  const target = canonicalTarget(root);
  const result = { root: target, created: [], updated: [], unchanged: [], warnings: [] };
  if (harness === 'cursor') codexAgents = false;

  const destinations = ['.adlc/specs', '.adlc/config.json', '.gitignore'];
  if (codexAgents) {
    destinations.push(...Object.keys(CODEX_AGENT_TEMPLATES).map((name) => `.codex/agents/${name}`));
  }
  for (const destination of destinations) rejectSymlinkComponents(target, destination);

  rejectSymlinkComponents(target, '.adlc/specs');
  mkdirSync(join(target, '.adlc/specs'), { recursive: true });
  rejectSymlinkComponents(target, '.adlc/specs');
  writeMissing(target, '.adlc/config.json', configForHarness(harness), result);
  ensureTicketStore(target, result);
  ensureGitignore(target, result);

  if (codexAgents) {
    for (const [name, content] of Object.entries(CODEX_AGENT_TEMPLATES)) {
      writeMissing(target, `.codex/agents/${name}`, content, result);
    }
  }

  return result;
}

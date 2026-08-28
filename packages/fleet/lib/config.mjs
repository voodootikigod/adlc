// Fleet configuration (spec §7.1). Settings live under the `fleet` key of
// `.adlc/config.json`; CLI flags override. The disposable-container override is
// NEVER honored from repo-committed config (adversarial-review N1) — only from
// the operator-local CLI flag.
//
// The autopilot extensions (issue-autopilot-local spec §14) add a second family
// of OPERATOR-LOCAL knobs: every one of them changes what a run may spend, what
// the worker may read, or where its git database lives — all decisions that a
// candidate tree must never be able to make for the orchestrator. They follow
// the exact `adapter` / `model` pattern (K1): honoured from argv only, and a
// repo-committed value is warned and ignored.

import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const DEFAULTS = Object.freeze({
  concurrency: 2,
  base: 'main',
  timeoutMinutes: 30,
  prosecuteFailOn: 'medium',
  // Two-strike policy (spec §12) — the historical hard-coded value, now a knob.
  maxStrikes: 2,
  // adversarial-review's own inline-diff grounding limit (its `--max-bytes`
  // default). Above it the reviewer silently drops findings as ungrounded.
  reviewMaxBytes: 262144,
});

/** Read modes for the MODEL plane (fleet-ext item 11). */
export const MODEL_PLANE_READ_MODES = Object.freeze(['host', 'bounded']);
/** Git-database modes for the worker's worktree (fleet-ext item 12). */
export const MODEL_PLANE_GIT_MODES = Object.freeze(['shared', 'mirror']);
/** Egress modes for the MODEL plane (fleet-ext item 13). */
export const MODEL_PLANE_EGRESS_MODES = Object.freeze(['open', 'allowlist']);

/** Bounds on `--max-strikes` (fleet-ext item 4). */
export const MAX_STRIKES_MIN = 1;
export const MAX_STRIKES_MAX = 50;

/**
 * The operator-local extension keys. A repo config that names ANY of them is
 * warned and ignored — stated as one list so the warning loop, the resolver and
 * the test table cannot drift from each other.
 */
export const OPERATOR_LOCAL_EXTENSION_KEYS = Object.freeze([
  'noPr', 'noComplete', 'deadEndFile', 'maxStrikes', 'wallClockMinutes', 'charterFile',
  'preStrikeArgv', 'preStrikeEnv', 'modelPlaneRead', 'modelPlaneReadOnly', 'modelPlaneGit',
  'modelPlaneGitMirror', 'modelPlaneEgress', 'workerDeps',
]);

/** Read the `fleet` config block from `.adlc/config.json`, or {} if absent. */
export function loadConfig(dir) {
  const p = join(dir, 'config.json');
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return parsed.fleet ?? {};
  } catch {
    return {};
  }
}

const isPosInt = (v) => Number.isInteger(v) && v > 0;

/**
 * Parse and validate the `--pre-strike-argv` / `--pre-strike-env` pair
 * (fleet-ext item 7). Throws with a precise message on any shape that could
 * turn the helper into a shell string or leak the manifest key into it.
 */
export function parsePreStrike({ argvJson, envJson } = {}) {
  if (argvJson == null && envJson == null) return { argv: null, env: null };
  if (argvJson == null || envJson == null) {
    throw new Error('--pre-strike-argv and --pre-strike-env must be given together');
  }
  let argv;
  let env;
  try { argv = JSON.parse(argvJson); } catch (e) { throw new Error(`--pre-strike-argv is not valid JSON: ${e.message}`); }
  try { env = JSON.parse(envJson); } catch (e) { throw new Error(`--pre-strike-env is not valid JSON: ${e.message}`); }
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string')) {
    throw new Error('--pre-strike-argv must be a non-empty JSON array of strings');
  }
  if (!isAbsolute(argv[0])) {
    throw new Error(`--pre-strike-argv[0] must be an absolute executable path (got ${JSON.stringify(argv[0])})`);
  }
  if (env === null || typeof env !== 'object' || Array.isArray(env) || !Object.values(env).every((v) => typeof v === 'string')) {
    throw new Error('--pre-strike-env must be a JSON object whose values are strings');
  }
  if (Object.hasOwn(env, 'ADLC_MANIFEST_KEY')) {
    throw new Error('--pre-strike-env must not carry ADLC_MANIFEST_KEY: the pre-strike helper never holds the ledger signing key');
  }
  return { argv, env };
}

/**
 * Validate the operator-local extension flags BEFORE they become config. Pure;
 * throws on the first violation with a message the CLI prints verbatim (exit 1).
 */
export function validateExtensionFlags(flags = {}) {
  const errors = [];
  if (flags.maxStrikes != null && !(Number.isInteger(flags.maxStrikes) && flags.maxStrikes >= MAX_STRIKES_MIN && flags.maxStrikes <= MAX_STRIKES_MAX)) {
    errors.push(`--max-strikes must be an integer in ${MAX_STRIKES_MIN}..${MAX_STRIKES_MAX}`);
  }
  if (flags.wallClockMinutes != null && !isPosInt(flags.wallClockMinutes)) {
    errors.push('--wall-clock-minutes must be a positive integer');
  }
  if (flags.modelPlaneRead != null && !MODEL_PLANE_READ_MODES.includes(flags.modelPlaneRead)) {
    errors.push(`--model-plane-read must be one of ${MODEL_PLANE_READ_MODES.join('|')}`);
  }
  for (const p of flags.modelPlaneReadOnly ?? []) {
    if (!isAbsolute(p)) errors.push(`--model-plane-read-only entries must be absolute paths (got ${JSON.stringify(p)})`);
  }
  if (flags.modelPlaneGit != null && !MODEL_PLANE_GIT_MODES.includes(flags.modelPlaneGit)) {
    errors.push(`--model-plane-git must be one of ${MODEL_PLANE_GIT_MODES.join('|')}`);
  }
  // A bounded plane binds only the worktree and the listed roots: a SHARED-git worktree's
  // `.git` file points at the repository's common directory outside every bind, so git
  // could not run inside. Bounded reads therefore require the mirror (codex r12).
  if (flags.modelPlaneRead === 'bounded' && flags.modelPlaneGit !== 'mirror') errors.push('--model-plane-read bounded requires --model-plane-git mirror (a shared-git worktree cannot reach its .git inside the plane)');
  if (flags.modelPlaneGit === 'mirror') {
    if (flags.modelPlaneRead !== 'bounded') errors.push('--model-plane-git mirror requires --model-plane-read bounded');
    // ONE writable mirror per run: concurrent untrusted workers must never share a Git
    // database they can all write (codex r11) — enforced on the RESOLVED config in the CLI.
    if (!flags.modelPlaneGitMirror || !isAbsolute(flags.modelPlaneGitMirror)) errors.push('--model-plane-git mirror requires --model-plane-git-mirror <absolute bare repo path>');
  } else if (flags.modelPlaneGitMirror != null) {
    errors.push('--model-plane-git-mirror is only meaningful with --model-plane-git mirror');
  }
  if (flags.modelPlaneEgress != null && !MODEL_PLANE_EGRESS_MODES.includes(flags.modelPlaneEgress)) {
    errors.push(`--model-plane-egress must be one of ${MODEL_PLANE_EGRESS_MODES.join('|')}`);
  }
  // The allowlist proxy only exists inside the bounded model plane (no network
  // namespace + bridge); with the host read policy the sandbox grants open
  // networking, so accepting the flag there would REPORT allowlist while
  // enforcing nothing (codex r3). Fail closed on the combination.
  if (flags.modelPlaneEgress === 'allowlist' && flags.modelPlaneRead !== 'bounded') {
    errors.push('--model-plane-egress allowlist requires --model-plane-read bounded');
  }
  if (flags.workerDeps != null && !isAbsolute(flags.workerDeps)) {
    errors.push('--worker-deps must be an absolute path');
  }
  if (flags.deadEndFile != null && typeof flags.deadEndFile !== 'string') errors.push('--dead-end-file must be a path');
  if (flags.charterFile != null && typeof flags.charterFile !== 'string') errors.push('--charter-file must be a path');
  if (errors.length) throw new Error(errors.join('; '));
  return true;
}

function extensionWarning(key) {
  return `SECURITY: .adlc/config.json set fleet.${key}; this setting is operator-local (CLI flag) only — ` +
    'a repo-committed value would let the candidate tree decide what the fleet spends, reads, or trusts — ignored.';
}

/**
 * Merge config + CLI flags into the effective run config. The
 * disposable-container override comes ONLY from `flags.disposableContainer`
 * (the operator-local CLI flag); a `disposableContainer` key in repo config is
 * ignored and surfaced as a warning (N1).
 */
export function resolveRunConfig(config = {}, flags = {}) {
  const warnings = [];
  const repoWantedOverride = config.disposableContainer === true;
  if (repoWantedOverride) {
    warnings.push(
      'SECURITY: .adlc/config.json set fleet.disposableContainer; repo config cannot disable the sandbox (N1) — ignored.'
    );
  }
  if (config.adapterCommand != null || config.adapterArgs != null) {
    warnings.push(
      'SECURITY: .adlc/config.json set fleet.adapterCommand/adapterArgs; the worker binary override is operator-local ' +
        '(CLI flag) only and CANNOT be set from repo config (A2) — ignored.'
    );
  }
  if (config.adapter != null) {
    warnings.push(
      'SECURITY: .adlc/config.json set fleet.adapter; the worker HARNESS is operator-local (--adapter) only — a repo ' +
        'config must not silently switch the fleet onto a harness with weaker worker containment (K1) — ignored.'
    );
  }
  if (config.model != null) {
    warnings.push(
      'SECURITY: .adlc/config.json set fleet.model; the worker MODEL is operator-local (--model) only — a repo config ' +
        'must not choose the model that judges it (operating-stack §4, §10) — ignored.'
    );
  }
  if (config.modelAuthKey != null) {
    warnings.push(
      'SECURITY: .adlc/config.json set fleet.modelAuthKey; the worker CREDENTIAL is operator-local ' +
        '(--model-auth-key) only. `modelAuthKey` names the ONE env var exempted from secret stripping, so a repo ' +
        'value chooses which host secret enters an unsandboxed worker — ignored.'
    );
  }
  if (config.modelPlaneWritable != null) {
    warnings.push(
      'SECURITY: .adlc/config.json set fleet.modelPlaneWritable; the model-plane WRITE boundary is operator-local ' +
        '(--model-plane-writable) only. That boundary exists to stop candidate-authored gate commands writing ' +
        'outside their worktree, so letting the candidate tree widen it would be the boundary disabling itself — ignored.'
    );
  }
  for (const key of OPERATOR_LOCAL_EXTENSION_KEYS) {
    if (config[key] != null) warnings.push(extensionWarning(key));
  }
  // `reviewMaxBytes` IS a repo key (fleet-ext item 8): it only narrows what the
  // reviewer inlines, and the autopilot mirrors the same value on its own
  // reviewer. A non-positive or non-integer value falls back to the default.
  let reviewMaxBytes = DEFAULTS.reviewMaxBytes;
  if (config.reviewMaxBytes != null) {
    // The key only NARROWS: a repository cannot widen the reviewer's grounding payload above the default (codex r6).
    if (isPosInt(config.reviewMaxBytes) && config.reviewMaxBytes <= DEFAULTS.reviewMaxBytes) reviewMaxBytes = config.reviewMaxBytes;
    else if (isPosInt(config.reviewMaxBytes)) warnings.push(`warning: .adlc/config.json fleet.reviewMaxBytes ${config.reviewMaxBytes} exceeds the maximum ${DEFAULTS.reviewMaxBytes} — using ${DEFAULTS.reviewMaxBytes}.`);
    else warnings.push(`warning: .adlc/config.json fleet.reviewMaxBytes is not a positive integer — using ${DEFAULTS.reviewMaxBytes}.`);
  }
  return {
    gate: config.gate ?? null,
    init: config.init ?? null,
    allowedCommands: config.allowedCommands ?? [],
    concurrency: flags.concurrency ?? config.concurrency ?? DEFAULTS.concurrency,
    base: flags.base ?? config.base ?? DEFAULTS.base,
    timeoutMinutes: config.timeoutMinutes ?? DEFAULTS.timeoutMinutes,
    prosecuteFailOn: config.prosecuteFailOn ?? DEFAULTS.prosecuteFailOn,
    reviewBin: config.reviewBin ?? null,
    reviewProvider: config.reviewProvider ?? null,
    reviewMaxBytes,
    // OPERATOR-LOCAL, and the most dangerous of the three.
    //
    // `modelAuthKey` names the single environment variable that is EXEMPTED from
    // `modelPlaneEnv`'s secret stripping, so whoever sets it chooses which host
    // secret reaches a code-capable, unsandboxed worker. Read from repo config, a
    // candidate could name `ADLC_MANIFEST_KEY` — the key that signs cross-model
    // attestations — and have the worker read the repo's own trust anchor, then
    // forge approvals with it. Same rule as `adapter` and `model`: CLI only.
    modelAuthKey: flags.modelAuthKey ?? null,
    // Worker harness selection (T44). OPERATOR-LOCAL only (adversarial-review K1):
    // a repo-committed config must not silently switch the fleet onto a harness
    // with weaker worker containment (only claude-code installs a per-worktree
    // permission allowlist). Default 'claude-code' — fully contained. The worker
    // BINARY override (adapterCommand/adapterArgs, A2) is likewise CLI-only.
    adapter: flags.adapter ?? 'claude-code',
    // The worker MODEL is operator-local too, as of the quartermaster layer.
    //
    // It used to be read from repo config as "non-executable data". That was only
    // ever safe by accident: claude-code, codex, and opencode all silently DROPPED
    // the model, so the value reached nothing but the agy adapter. Now that every
    // adapter forces its model onto the command line (§4c), a repo-committed
    // `fleet.model` would be a candidate tree choosing the model that builds and
    // judges it — the exact downgrade operating-stack §4/§10 exist to forbid. So
    // it moves to the CLI, alongside `adapter`, and a repo value is warned + ignored.
    model: flags.model ?? null,
    adapterStdin: config.adapterStdin === true,
    adapterCommand: flags.adapterCommand ?? null,
    adapterArgs: flags.adapterArgs ?? null,
    // Extra paths the MODEL-plane worker may write, beyond the worktree and the
    // harness's own declared state (#395). OPERATOR-LOCAL only, for the same
    // reason the sandbox override is: a repo-committed value would let the
    // candidate tree widen the boundary that exists to contain it.
    modelPlaneWritable: flags.modelPlaneWritable ?? [],
    // ---- autopilot extensions (issue-autopilot-local §14): operator-local only ----
    noPr: flags.noPr === true,
    noComplete: flags.noComplete === true,
    deadEndFile: flags.deadEndFile ?? null,
    maxStrikes: flags.maxStrikes ?? DEFAULTS.maxStrikes,
    wallClockMinutes: flags.wallClockMinutes ?? null,
    charterFile: flags.charterFile ?? null,
    preStrikeArgv: flags.preStrikeArgv ?? null,
    preStrikeEnv: flags.preStrikeEnv ?? null,
    modelPlaneRead: flags.modelPlaneRead ?? 'host',
    modelPlaneReadOnly: flags.modelPlaneReadOnly ?? [],
    modelPlaneGit: flags.modelPlaneGit ?? 'shared',
    modelPlaneGitMirror: flags.modelPlaneGitMirror ?? null,
    modelPlaneEgress: flags.modelPlaneEgress ?? 'open',
    workerDeps: flags.workerDeps ?? null,
    // operator-local ONLY:
    operatorOverride: flags.disposableContainer === true,
    repoConfigOverride: repoWantedOverride,
    warnings,
  };
}

// Configuration (spec §13; AC 28, 37, 77, 116, 125).
//
// Two families, never mixed:
//   REPO-COMMITTED (`.adlc/config.json` read from the PINNED blob, never the
//   working tree): the `autopilot` block below and `ticketSync`. These may be
//   LOWERED by the CLI but never raised.
//   OPERATOR-LOCAL (the quota is the OPERATOR's; the model/adapter decide who
//   judges): CLI flag > `ADLC_AUTOPILOT_<UPPER_SNAKE>` > default. A repo config
//   that names one of them is warned and ignored.

import { validateAgainst } from './schema-lite.mjs';
import { validateModel, validateRepoSpec, InputError } from './input.mjs';
import { active, registerSeams } from './mutations.mjs';

registerSeams(['config.skipTicketSyncSchema',
  'config.acceptZeroLimits',
]);

export const DISPATCH_APPROVAL_MODES = Object.freeze(['owner-or-label', 'label-only', 'trusted-authors']);
export const ALLOWED_WORKSPACE_DEPS = Object.freeze(['@adlc/core', '@adlc/fleet', '@adlc/tickets']);
export const SUPPORTED_ADAPTERS = Object.freeze(['claude-code']);

export const AUTOPILOT_DEFAULTS = Object.freeze({
  restMinutes: 10, maxOpenPrs: 5, maxRounds: 15, wallClockMinutes: 90, ciFixRounds: 2, ciWatchMinutes: 30,
  reviewMaxBytes: 262144, dispatchApproval: 'owner-or-label', protectedPathsExtra: [],
});

/** The repo `autopilot` block schema (§13). Unknown keys are `bad-config`. */
export const AUTOPILOT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['repo'],
  properties: {
    restMinutes: { type: 'integer', minimum: 1 },
    maxOpenPrs: { type: 'integer', minimum: 1 },
    maxRounds: { type: 'integer', minimum: 1 },
    wallClockMinutes: { type: 'integer', minimum: 1 },
    ciFixRounds: { type: 'integer', minimum: 0 },
    ciWatchMinutes: { type: 'integer', minimum: 1 },
    reviewMaxBytes: { type: 'integer', minimum: 1 },
    repo: { type: 'string', pattern: '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$' },
    dispatchApproval: { type: 'string', enum: [...DISPATCH_APPROVAL_MODES] },
    protectedPathsExtra: { type: 'array', items: { type: 'string' } },
    allowedWorkspaceDeps: { type: 'array', items: { type: 'string', enum: [...ALLOWED_WORKSPACE_DEPS] } },
  },
});

/** Operator-local keys that a repo config must never carry (warned + ignored, AC 28). */
export const OPERATOR_LOCAL_KEYS = Object.freeze(['quotaThreshold', 'quotaReserve', 'model', 'adapter', 'trustedBinDirs', 'sshIdentity', 'issue', 'force', 'dryRun']);
/** Repo keys the CLI may lower but never raise (§13). */
export const LOWER_ONLY_KEYS = Object.freeze(['restMinutes', 'maxOpenPrs', 'maxRounds', 'wallClockMinutes', 'ciFixRounds', 'ciWatchMinutes']);

export class ConfigError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code; this.exitCode = 1; }
}

/**
 * Validate the pinned config document. Returns { autopilot, fleet, ticketSync, warnings }.
 * `ticketSyncSchema` is the parsed JSON schema read from the pinned blob.
 */
export function validateRepoConfig(doc, { ticketSyncSchema }) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new ConfigError('bad-config', 'config is not an object');
  const warnings = [];
  const raw = { ...(doc.autopilot ?? {}) };
  const repoOperator = {};
  for (const k of OPERATOR_LOCAL_KEYS) {
    if (k in raw) { warnings.push(`SECURITY: .adlc/config.json set autopilot.${k}; this value is operator-local (CLI flag / ADLC_AUTOPILOT_*) only — ignored.`); repoOperator[k] = raw[k]; delete raw[k]; }
  }
  const errs = validateAgainst(AUTOPILOT_SCHEMA, raw, 'autopilot');
  if (errs.length) throw new ConfigError('bad-config', errs.join('; '));
  if (!doc.fleet || typeof doc.fleet !== 'object') throw new ConfigError('bad-config', 'fleet block missing');
  for (const k of ['gate', 'init', 'allowedCommands', 'reviewProvider', 'prosecuteFailOn', 'timeoutMinutes']) {
    if (!(k in doc.fleet)) throw new ConfigError('bad-config', `fleet.${k} missing`);
  }
  if (doc.fleet.reviewProvider !== 'codex') throw new ConfigError('bad-config', 'fleet.reviewProvider must be "codex"');
  if (!doc.ticketSync) throw new ConfigError('bad-config', 'ticketSync block missing');
  if (!ticketSyncSchema) throw new ConfigError('bad-config', 'ticket-sync schema unavailable at the pinned baseline');
  // Mutation seam `config.skipTicketSyncSchema`: the ticketSync block goes unvalidated.
  const tsErrs = active('config.skipTicketSyncSchema') ? [] : validateAgainst(ticketSyncSchema, { ticketSync: doc.ticketSync }, '$');
  if (tsErrs.length) throw new ConfigError('bad-config', tsErrs.join('; '));
  if (!active('config.skipTicketSyncSchema') && doc.ticketSync.select && 'query' in doc.ticketSync.select && typeof doc.ticketSync.select.query !== 'string') {
    throw new ConfigError('bad-config', 'ticketSync.select.query must be omitted or a string, never null');
  }
  const autopilot = { ...AUTOPILOT_DEFAULTS, ...raw, allowedWorkspaceDeps: raw.allowedWorkspaceDeps ?? [...ALLOWED_WORKSPACE_DEPS] };
  // Mutation seam `config.honourRepoOperatorKeys`: the ignored repo values leak through.
  if (active('config.honourRepoOperatorKeys')) Object.assign(autopilot, repoOperator);
  return { autopilot, fleet: doc.fleet, ticketSync: doc.ticketSync, warnings };
}

const UPPER = (k) => `ADLC_AUTOPILOT_${k.replace(/([A-Z])/g, '_$1').toUpperCase()}`;

function pick(flags, env, key, parse = (v) => v) {
  if (flags[key] !== undefined && flags[key] !== null) return { value: parse(flags[key]), source: 'flag' };
  const e = env[UPPER(key)];
  if (e !== undefined && e !== '') return { value: parse(e), source: 'env' };
  return { value: undefined, source: 'default' };
}

const int = (field) => (v) => {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  throw new InputError(field, 'expected an integer');
};

/** `10m`, `90s`, `2h` or bare minutes → milliseconds. */
export function parseDuration(v, field = 'rest') {
  if (typeof v === 'number') return v * 60_000;
  const m = /^(\d+)([smh])?$/.exec(String(v ?? ''));
  if (!m) throw new InputError(field, 'expected <n>[s|m|h]');
  const n = Number(m[1]);
  return m[2] === 's' ? n * 1000 : m[2] === 'h' ? n * 3_600_000 : n * 60_000;
}

/**
 * Resolve the operator-local values (§13) with the documented precedence and
 * bounds. `flags` are already-parsed CLI values; `env` is the orchestrator env.
 */
export function resolveOperatorLocal(flags = {}, env = {}) {
  const threshold = pick(flags, env, 'quotaThreshold', int('quota-threshold'));
  const reserve = pick(flags, env, 'quotaReserve', int('quota-reserve'));
  // The repo config may carry a (warned, ignored) quotaThreshold; the operator-
  // local resolution below never reads it — the seam `config.honourRepoOperatorKeys`
  // is exercised in validateRepoConfig, not here.
  const T = threshold.value ?? 50;
  const R = reserve.value ?? 5;
  const ceiling = active('config.acceptAnyThreshold') ? 100 : 50; // mutation seam
  if (!(Number.isInteger(T) && T >= 1 && T <= ceiling)) throw new ConfigError('bad-input:quota-threshold', `--quota-threshold must be an integer 1..50 (got ${T}); the "more than half remaining" rule can be tightened, never loosened`);
  if (!(Number.isInteger(R) && R >= 0 && R <= 49 && R < T)) throw new ConfigError('bad-input:quota-reserve', `--quota-reserve must be an integer 0..49 and < threshold (got ${R} vs ${T})`);
  const model = pick(flags, env, 'model');
  const adapter = pick(flags, env, 'adapter');
  const repo = pick(flags, env, 'repo');
  const trusted = pick(flags, env, 'trustedBinDirs', (v) => (Array.isArray(v) ? v : String(v).split(',').map((s) => s.trim()).filter(Boolean)));
  const ssh = pick(flags, env, 'sshIdentity');
  const rest = pick(flags, env, 'rest', (v) => parseDuration(v));
  const effectiveModel = validateModel(model.value ?? 'opus', 'model');
  const effectiveAdapter = adapter.value ?? 'claude-code';
  return {
    quotaThreshold: T, quotaReserve: R,
    model: effectiveModel, adapter: effectiveAdapter,
    adapterSupported: SUPPORTED_ADAPTERS.includes(effectiveAdapter),
    repo: repo.value != null ? validateRepoSpec(repo.value, 'repo') : null,
    trustedBinDirs: trusted.value ?? null,
    sshIdentity: ssh.value ?? null,
    restMs: rest.value ?? null,
    issue: flags.issue ?? null, force: flags.force === true, dryRun: flags.dryRun === true, dryRunShape: flags.dryRunShape === true,
    sources: { quotaThreshold: threshold.source, quotaReserve: reserve.source, model: model.source, adapter: adapter.source, repo: repo.source },
  };
}

/**
 * Apply CLI lowering to the repo block: each LOWER_ONLY key may be reduced by a
 * flag, never raised (`--max-rounds 20` against 15 → exit 1).
 */
export function applyLowering(autopilot, flags = {}) {
  const out = { ...autopilot };
  for (const key of LOWER_ONLY_KEYS) {
    const v = flags[key];
    if (v === undefined || v === null) continue;
    const n = int(key)(v);
    // A safety limit of zero is not a lowering, it is off (codex r9 A3). Seam `config.acceptZeroLimits`.
    if (n < 1 && !active('config.acceptZeroLimits')) throw new InputError(key, 'must be at least 1');
    // Mutation seam `config.allowRaise`: the CLI may raise a committed budget.
    if (!active('config.allowRaise') && n > autopilot[key]) throw new ConfigError('bad-input:' + key, `${key} may be lowered by the CLI but not raised above the committed ${autopilot[key]} (got ${n})`);
    out[key] = n;
  }
  return out;
}

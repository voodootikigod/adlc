// The fleet invocation (spec §6.4, §3.2 pre-strike helper, §7 budgets; AC 5,
// 20, 60, 64, 78, 81, 95, 103, 152, 162). Every value is passed as its own argv
// element — never a shell string — and the pre-strike helper receives the
// resolved values explicitly with a MINIMAL environment of exactly four keys.

import { branchFor, validateIssueNumber, validateTicketId } from './input.mjs';
import { pinnedRealpaths } from './tools.mjs';
import { registerSeams, active } from './mutations.mjs';

registerSeams(['fleetArgs.dropNoPr', 'fleetArgs.bareAdlcInHelper', 'fleetArgs.readSetIncludesRepo', 'fleetArgs.leakEnvToHelper', 'fleetArgs.bindToolDirs', 'fleetArgs.openEgress']);

/** fleet's closed ticket-outcome reason set (fleet lib/scheduler.mjs REASON_CODES). */
export const REASON_CODES_FLEET = Object.freeze(['quota-paused', 'lock-held', 'wall-clock', 'strikes-exhausted', 'ticket-blocked', 'flail', 'review-unavailable', 'mirror-fetch-failed']);
export const FLEET_BLOCKING_REASONS = Object.freeze(['wall-clock', 'strikes-exhausted', 'ticket-blocked', 'flail', 'review-unavailable', 'mirror-fetch-failed']);

export const SYSTEM_ROOTS = Object.freeze(['/usr', '/lib', '/lib64', '/etc/ssl', '/etc/resolv.conf', '/etc/hosts']);
export const PRE_STRIKE_ENV_KEYS = Object.freeze(['PATH', 'HOME', 'ADLC_AUTOPILOT_STATUS_FILE', 'ADLC_AUTOPILOT_LOCK_TOKEN']);

/** The pre-strike helper argv (§3.2): the pinned adlc, explicit resolved values, no shell. */
export function preStrikeArgv({ ctx, iterationId, wallClockRemaining }) {
  return [
    active('fleetArgs.bareAdlcInHelper') ? 'adlc' : ctx.pinned.adlc, 'autopilot', 'quota', '--json',
    '--model', ctx.local.model,
    '--quota-threshold', String(ctx.local.quotaThreshold),
    '--quota-reserve', String(ctx.local.quotaReserve),
    '--iteration', String(iterationId),
    '--start-ordinal', 'auto',
    '--wall-clock-remaining', String(wallClockRemaining),
  ];
}

export function preStrikeEnv({ ctx }) {
  const minimal = { PATH: ctx.env.path, HOME: ctx.env.home, ADLC_AUTOPILOT_STATUS_FILE: ctx.paths.statusFile, ADLC_AUTOPILOT_LOCK_TOKEN: ctx.lock?.token ?? '' };
  // Mutation seam: the orchestrator's raw environment leaks into the helper.
  return active('fleetArgs.leakEnvToHelper') ? { ...(ctx.env.raw ?? {}), ...minimal } : minimal;
}

/**
 * READ_SET (§6.4): the realpath of each pinned executable as a single FILE bind
 * unless it lives under a system root, plus the npm/corepack trees, plus the
 * fixed system roots. Never REPO_ROOT, .git, ISSUE_WT, HOME, /tmp.
 */
export function readSet({ ctx }) {
  const nodePrefix = ctx.pinned['node:realpath'] ? ctx.pinned['node:realpath'].replace(/\/bin\/node$/, '') : null;
  let files = pinnedRealpaths(ctx.pinned).filter((p) => !SYSTEM_ROOTS.some((r) => p === r || p.startsWith(r + '/')));
  // Mutation seam: bind the tools' parent DIRECTORIES instead of single files.
  if (active('fleetArgs.bindToolDirs')) files = files.map((p) => p.replace(/\/[^/]+$/, ''));
  const trees = nodePrefix ? [`${nodePrefix}/lib/node_modules/npm`, `${nodePrefix}/lib/node_modules/corepack`] : [];
  const set = [...new Set([...files, ...trees, ...SYSTEM_ROOTS])];
  // Mutation seam: the repository itself enters the read set.
  if (active('fleetArgs.readSetIncludesRepo')) set.push(ctx.repoRoot);
  return set;
}

/** The complete fleet argv for one dispatch (§6.4). */
export function buildFleetArgv({ ctx, issue, ticketId, budget, deadEndFile = null, mirror, workerDeps }) {
  const n = validateIssueNumber(issue);
  if (ticketId !== 'T-<ULID>') validateTicketId(ticketId);
  const argv = [
    ctx.pinned.adlc, 'fleet', 'run',
    '--tickets', ticketId,
    '--base', branchFor(n),
    '--adapter', ctx.local.adapter,
    '--model', ctx.local.model,
    '--concurrency', '1',
    '--max-strikes', String(budget.strikes),
    '--wall-clock-minutes', String(budget.wallClockMinutes),
    ...(active('fleetArgs.dropNoPr') ? ['--no-complete'] : ['--no-pr', '--no-complete']),
    '--pre-strike-argv', JSON.stringify(preStrikeArgv({ ctx, iterationId: ctx.iterationId, wallClockRemaining: budget.wallClockMinutes })),
    '--pre-strike-env', JSON.stringify(preStrikeEnv({ ctx })),
    '--charter-file', ctx.charterPath,
    '--model-plane-read', 'bounded',
    '--model-plane-read-only', readSet({ ctx }).join(','),
    '--model-plane-git', 'mirror',
    '--model-plane-git-mirror', mirror,
    '--model-plane-egress', active('fleetArgs.openEgress') ? 'open' : 'allowlist',
    '--worker-deps', workerDeps,
    '--json',
  ];
  if (deadEndFile) argv.push('--dead-end-file', deadEndFile);
  return argv;
}

/** The environment fleet inherits: the sanitized base + the bound git overlay (§9.1b), never the key. */
export function fleetEnv({ ctx }) {
  return { ...ctx.env.base, ...ctx.git.overlayEnv() };
}

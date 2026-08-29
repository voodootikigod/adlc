// Context assembly: builds the `ctx` object every module receives (see the
// contract in the package README / the module headers) from the operator-local
// values, the environment and the injectable collaborators. Nothing here talks
// to the world by itself; it wires the modules that do.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createSpawner } from './spawn.mjs';
import { createRedactor } from './redact.mjs';
import { keyBearingValues } from './keys.mjs';
import { autopilotPaths, resolveRepoRoot } from './paths.mjs';
import { createRecordStore } from './records.mjs';
import { gitBaseEnv } from './git-env.mjs';
import { lockHeldBy } from './lock.mjs';
import { dispatchFleet, writeDeadEnd, previewFleetArgv } from './dispatch.mjs';
import { initCommand } from './init.mjs';
import { revalidate, cacheShapedTicket } from './revalidate.mjs';
import { tokenRefresh, tokenMarginFor, readAccessToken } from './token-refresh.mjs';
import { selectForLoop, placeholderTicket } from './selection.mjs';
import { maintenanceDeps } from './maintenance.mjs';
import { readUsage } from './quota.mjs';
import { registerSeams, active } from './mutations.mjs';

registerSeams(['context.noUsageTransport']);
import { execFileSync } from 'node:child_process';

export const CHARTER_PATH = fileURLToPath(new URL('./charter-adlc.md', import.meta.url));

/** Lazily import the module set so a subcommand that needs only a few modules does not load all. */
async function loadModules(overrides) {
  const load = async (name) => overrides[name] ?? (await import(`./${name}.mjs`));
  const [preflight, select, triage, effects, create, recover, retire, reset, mirror, deps, diffcheck, gates, review, push, ci, maintain, digest, status, quotaGate, gitRunner, attempts, labels] = await Promise.all([
    load('preflight'), load('select'), load('triage'), load('effects'), load('create'), load('recover'), load('retire'), load('reset'),
    load('mirror'), load('deps'), load('diffcheck'), load('gates'), load('review'), load('push'), load('ci'), load('maintain'),
    load('digest'), load('status'), load('quota-gate'), load('git-runner'), load('attempts'), load('labels'),
  ]);
  return { preflight, select, triage, effects, create, recover, retire, reset, mirror, deps, diffcheck, gates, review, push, ci, maintain, digest, status, quotaGate, gitRunner, attempts, labels };
}

/**
 * Build the context. `overrides` lets tests substitute modules, the spawner
 * implementation, the clock, the git binary for REPO_ROOT resolution, and the
 * environment file reader.
 */
export async function buildContext({ flags, env, cwd, local, dryRun = false, overrides = {}, quotaOnly = false }) {
  const now = overrides.now ?? (() => Date.now());
  const recorder = overrides.recorder ?? [];
  const spawn = overrides.spawn ?? createSpawner({ recorder, spawnImpl: overrides.spawnImpl, kill: overrides.kill });
  const gitProbe = overrides.gitProbe ?? ((args, opts) => execFileSync('git', args, { cwd: opts?.cwd ?? cwd, encoding: 'utf8', env: { ...gitBaseEnv({ path: env.PATH ?? '', home: env.HOME ?? '' }) } }));
  const repoRoot = overrides.repoRoot ?? resolveRepoRoot({ cwd, git: gitProbe });
  const paths = autopilotPaths(repoRoot);
  const key = overrides.key ?? env.ADLC_MANIFEST_KEY ?? null;
  // The credential's access token is a secret literal from the start (redactor + actual-diff scan), not only at quota time.
  const credentialToken = overrides.credentialToken ?? (() => { try { return readAccessToken(env.HOME ?? ''); } catch { return null; } })();
  // The manifest key is a secret value for the redactor whether it arrived through the environment or an override.
  // The same literal set feeds the transcript redactor AND the actual-diff secret scan (codex r2 B2).
  const secretValues = keyBearingValues(env, [credentialToken, key].filter(Boolean));
  const redactor = createRedactor({ secretValues });
  const log = overrides.log ?? ((line) => { const r = redactor.redact(String(line), { withheld: '[withheld: redaction failed]' }); process.stderr.write(`${r.text}\n`); });
  const records = createRecordStore({ paths, redactor });
  const iterationToken = overrides.iterationToken ?? randomBytes(32).toString('hex');
  const iterationId = overrides.iterationId ?? `${new Date(now()).toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${iterationToken.slice(0, 8)}`;
  const modules = await loadModules(overrides.modules ?? {});
  const ctx = {
    repoRoot, paths, spawn, recorder, key, redactor, log, records, now, dryRun, local, flags, iterationId, iterationToken,
    env: { path: env.PATH ?? '', home: env.HOME ?? '', base: gitBaseEnv({ path: env.PATH ?? '', home: env.HOME ?? '' }), raw: env },
    secretValues,
    pinned: {}, config: null, remote: null, netGit: paths.netGit, netGitConfigSha256: null, ssh: null, gh: null, git: null,
    baseOid: null, lock: null, charterPath: overrides.charterPath ?? CHARTER_PATH, quotaOnly,
    // The orchestrator's own environment snapshot (never handed to a child as-is) and identity, for phase A.
    inherited: env, uid: overrides.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0), sleep: overrides.sleep ?? null,
    readEnvFile: overrides.readEnvFile ?? ((p) => readFileSync(p, 'utf8')),
    lockHeldBy: (token) => lockHeldBy(paths.adlc, token),
    modules,
  };
  ctx.status = modules.status.createStatusStore({ paths, lockToken: () => ctx.lock?.token ?? null, redactor, now });
  // The production usage reader: the endpoint over the runtime's fetch, then the
  // §3.3 fallback — the pinned `claude -p "/usage" --output-format json` on the host.
  const usageFallback = async () => {
    if (!ctx.pinned?.claude) throw new Error('claude is not pinned yet (phase A has not run)');
    const res = await ctx.spawn({ argv: [ctx.pinned.claude, '-p', '/usage', '--output-format', 'json'], cwd: ctx.paths.runsDir, env: { PATH: ctx.env.path, HOME: ctx.env.home }, deadlineMs: 60_000, stdoutCap: 64 * 1024, label: 'claude /usage' });
    if (res.status !== 0) throw new Error(`claude /usage exited ${res.status ?? res.reason}`);
    try { const doc = JSON.parse(res.stdout); return typeof doc?.result === 'string' ? doc.result : res.stdout; } catch { return res.stdout; }
  };
  // Mutation seam `context.noUsageTransport`: the reader is built without a transport (every sample is quota-unknown).
  const usageRead = overrides.quota?.read ?? (() => readUsage({ ...(active('context.noUsageTransport') ? {} : { fetchImpl: overrides.fetchImpl ?? globalThis.fetch, fallback: usageFallback }), accessToken: readAccessToken(ctx.env.home), log, ...(overrides.quota?.readOptions ?? {}) }));
  ctx.quota = modules.quotaGate.createQuotaGate({ read: usageRead, status: ctx.status, records, model: local?.model ?? 'opus', threshold: local?.quotaThreshold, reserve: local?.quotaReserve, now, log, ...(overrides.quota ?? {}) });
  ctx.deps = {
    preflight: modules.preflight, select: modules.select, triage: modules.triage, effects: modules.effects,
    create: modules.create, recover: modules.recover, retire: modules.retire, mirror: modules.mirror, deps: modules.deps,
    diffcheck: modules.diffcheck, gates: modules.gates, review: modules.review, push: modules.push, ci: modules.ci,
    maintain: modules.maintain, digest: modules.digest, status: ctx.status, quota: ctx.quota,
    selection: { select: overrides.select ?? selectForLoop, placeholderTicket },
    revalidate: overrides.revalidate ?? revalidate,
    dispatch: overrides.dispatch ?? dispatchFleet,
    deadEnd: overrides.deadEnd ?? writeDeadEnd,
    cacheShapedTicket: overrides.cacheShapedTicket ?? cacheShapedTicket,
    tokenRefresh: overrides.tokenRefresh ?? tokenRefresh,
    tokenMargin: overrides.tokenMargin ?? tokenMarginFor,
    sleep: overrides.sleep ?? null,
    fleetArgvPreview: overrides.fleetArgvPreview ?? previewFleetArgv,
    prTitlePreview: overrides.prTitlePreview ?? (({ issue, ticket }) => modules.push.prTitle({ issue: issue.number, ticket })),
    init: overrides.init ?? initCommand,
    ...(overrides.deps ?? {}),
  };
  ctx.deps.maintenanceDeps = overrides.maintenanceDeps ?? (() => maintenanceDeps({ ctx, deps: ctx.deps }));
  ctx.cleanupIteration = overrides.cleanupIteration ?? (async () => { try { await modules.preflight.cleanupPreflight?.(ctx); } catch { /* best effort */ } });
  return ctx;
}

export { join };

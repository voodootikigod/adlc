// The pinned baseline (§6.0) and preflight phase B (§9.2, §9.4, §9.6, the
// §14 spec-approval binding, the §6.4 token margin; AC 20, 31, 86, 116, 117,
// 120, 133, 158).
//
// Phase B reads EVERY repository input as `git show <BASE_OID>:<path>` — the
// working tree, a local `main` and `origin/main` never influence a verdict —
// and its one mutating check (the fleet dry-run) runs in a detached temporary
// worktree at BASE_OID that is removed afterwards. Dry-run reports that check
// as `skipped: needs-worktree` and never fetches.

import { readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEADLINES } from './spawn.mjs';
import { childEnv } from './keys.mjs';
import { validateRepoConfig } from './config.mjs';
import { validateOid } from './input.mjs';
import {
  PreflightError, asPreflightError, requireBaseline, showAtBaseline, BUILD_TICKET_ID,
  PLUGIN_JSON_PATH, CONFIG_PATH, TICKET_SYNC_SCHEMA_PATH, INSTALLED_PLUGINS_REL, CREDENTIALS_REL, TOKEN_MARGIN_MS,
} from './preflight-common.mjs';
import { checkSpecApproval } from './spec-approval.mjs';
import { registerSeams, active } from './mutations.mjs';

registerSeams([
  'preflight.fetchByName',            // the baseline fetch names `main` instead of the OID
  'preflight.ignoreFetchFailure',     // a failed baseline fetch is not base-unresolved
  'preflight.parityFromWorkingTree',  // plugin parity reads the working-tree plugin.json
  'preflight.trustWorkingTreeConfig', // config is read from the working tree
  'preflight.trustBlobRepo',          // a differing autopilot.repo in the blob rebinds the identity
  'preflight.ignoreTokenMargin',      // tokenShort is never reported
  'preflight.acceptAnyBaseSha',       // the fleet dry-run's baseSha is not compared
  'preflight.keepPreflightWorktree',  // the temporary worktree is not removed
]);

const PLUGIN_KEY = 'adlc@adlc';

/** §6.0: ls-remote → fetch BY OID into NET_GIT → local file-transport import → cat-file. Dry-run: ls-remote only. */
export async function resolveBaseline(ctx) {
  const url = ctx.remote.remoteFetchUrl;
  const fail = (d) => { throw new PreflightError('base-unresolved', d); };
  const ls = await ctx.git.net(['ls-remote', '--exit-code', url, 'refs/heads/main']);
  if (ls.status !== 0) fail(`ls-remote exited ${ls.status ?? ls.reason}: ${String(ls.stderr ?? '').trim().slice(0, 200)}`);
  const first = ls.stdout.split('\n').map((l) => l.trim()).find((l) => l.endsWith('\trefs/heads/main')) ?? '';
  let oid;
  try { oid = validateOid(first.split('\t')[0], { field: 'base-oid' }); } catch (e) { fail(`ls-remote returned no valid OID for refs/heads/main: ${e.message}`); }
  if (ctx.dryRun) { ctx.baseOid = oid; return oid; }
  const target = active('preflight.fetchByName') ? 'main' : oid;
  const fetched = await ctx.git.net(['fetch', '--no-tags', url, target]);
  if (fetched.status !== 0 && !active('preflight.ignoreFetchFailure')) fail(`fetch ${oid} exited ${fetched.status ?? fetched.reason}`);
  const imported = await ctx.git.local(ctx.repoRoot, ['fetch', '--no-tags', ctx.netGit, target], { deadlineMs: DEADLINES.gitNetwork, label: 'git fetch (local import)' });
  if (imported.status !== 0) fail(`local import of ${oid} exited ${imported.status ?? imported.reason}`);
  const present = await ctx.git.local(ctx.repoRoot, ['cat-file', '-e', `${oid}^{commit}`]);
  if (present.status !== 0) fail(`${oid} is not a commit in the primary repository after the import`);
  ctx.baseOid = oid;
  return oid;
}

/** The installed `adlc@adlc` version from either documented shape, or null when absent/ambiguous. */
export function installedPluginVersion(doc) {
  const plugins = doc?.plugins ?? doc;
  let entry = null;
  if (Array.isArray(plugins)) entry = plugins.find((p) => p?.name === PLUGIN_KEY) ?? null;
  else if (plugins && typeof plugins === 'object') entry = plugins[PLUGIN_KEY] ?? null;
  if (entry === null || entry === undefined) return null;
  const list = Array.isArray(entry) ? entry : [entry];
  const versions = [...new Set(list.map((e) => (typeof e?.version === 'string' ? e.version : null)))];
  return versions.length === 1 && versions[0] !== null ? versions[0] : null;
}

/** §6.4 item 14: `expiresAt − now ≥ wallClock + 30 min`; an unreadable file is short (fail closed). */
export function tokenMargin({ credentialsText, now, wallClockMs, marginMs = TOKEN_MARGIN_MS }) {
  if (active('preflight.ignoreTokenMargin')) return { tokenShort: false, expiresAt: null, remainingMs: null, reason: 'ignored' };
  let expiresAt = null;
  try { const v = JSON.parse(credentialsText)?.claudeAiOauth?.expiresAt; expiresAt = Number.isFinite(v) ? v : null; } catch { expiresAt = null; }
  if (expiresAt === null) return { tokenShort: true, expiresAt: null, remainingMs: null, reason: 'credentials-unreadable' };
  const remainingMs = expiresAt - now;
  const tokenShort = remainingMs < wallClockMs + marginMs;
  return { tokenShort, expiresAt, remainingMs, reason: tokenShort ? `token-expiring: ${Math.floor(remainingMs / 60_000)} min left, need ${Math.ceil((wallClockMs + marginMs) / 60_000)}` : null };
}

const readHostFile = (ctx, rel) => { const rf = ctx.fs?.readFile ?? ((p) => readFileSync(p, 'utf8')); return rf(join(ctx.env.home, rel)); };
const readWorkingTree = (ctx, rel) => { try { return readFileSync(join(ctx.repoRoot, rel), 'utf8'); } catch { return null; } };

async function pluginParity(ctx, oid) {
  const text = active('preflight.parityFromWorkingTree') ? readWorkingTree(ctx, PLUGIN_JSON_PATH) : await showAtBaseline(ctx, oid, PLUGIN_JSON_PATH);
  if (text === null) throw new PreflightError('plugin-parity', `${PLUGIN_JSON_PATH} absent at ${oid}`);
  let repoVersion;
  try { repoVersion = JSON.parse(text).version; } catch { throw new PreflightError('plugin-parity', 'pinned plugin.json is not JSON'); }
  let installed = null;
  try { installed = installedPluginVersion(JSON.parse(readHostFile(ctx, INSTALLED_PLUGINS_REL))); } catch { installed = null; }
  if (typeof repoVersion !== 'string' || installed === null || installed !== repoVersion) {
    throw new PreflightError('plugin-parity', `installed ${installed ?? 'none'} vs repo ${repoVersion ?? 'unknown'} at ${oid}`);
  }
  return { installed, repo: repoVersion };
}

async function pinnedConfig(ctx, oid) {
  const read = (p) => (active('preflight.trustWorkingTreeConfig') ? readWorkingTree(ctx, p) : showAtBaseline(ctx, oid, p));
  const configText = await read(CONFIG_PATH);
  if (configText === null) throw new PreflightError('bad-config', `${CONFIG_PATH} absent at ${oid}`);
  const schemaText = await read(TICKET_SYNC_SCHEMA_PATH);
  let doc; let schema = null;
  try { doc = JSON.parse(configText); } catch { throw new PreflightError('bad-config', `${CONFIG_PATH} at ${oid} is not JSON`); }
  try { schema = schemaText === null ? null : JSON.parse(schemaText); } catch { throw new PreflightError('bad-config', 'ticket-sync schema at the baseline is not JSON'); }
  let config;
  try { config = validateRepoConfig(doc, { ticketSyncSchema: schema }); } catch (e) { throw asPreflightError(e, 'bad-config'); }
  for (const w of config.warnings ?? []) ctx.log?.(w);
  const blobRepo = String(config.autopilot.repo ?? '');
  if (blobRepo.toLowerCase() !== String(ctx.local.repo ?? '').toLowerCase()) {
    if (active('preflight.trustBlobRepo')) ctx.local = { ...ctx.local, repo: blobRepo };
    else throw new PreflightError('repo-mismatch', `pinned autopilot.repo ${blobRepo} != operator-local ${ctx.local.repo}`);
  }
  ctx.config = config;
  return config;
}

async function removePreflightWorktree(ctx, wt) {
  if (active('preflight.keepPreflightWorktree')) return;
  await ctx.git.local(ctx.repoRoot, ['worktree', 'remove', '--force', wt], { label: 'git worktree remove (preflight)' });
  if (existsSync(wt)) rmSync(wt, { recursive: true, force: true });
  await ctx.git.local(ctx.repoRoot, ['worktree', 'prune'], { label: 'git worktree prune' });
}

/** §9.6: a detached worktree at BASE_OID, `adlc fleet run --dry-run --base <oid> --json`, `baseSha == oid`, then removal. */
export async function withPreflightWorktree(ctx, oid, fn) {
  const wt = ctx.paths.preflightWorktree(oid);
  await removePreflightWorktree(ctx, wt); // a leftover from a crash is removed first
  await ctx.git.localOut(ctx.repoRoot, ['worktree', 'add', '--detach', wt, oid]).catch((e) => { throw new PreflightError('base-unresolved', `worktree add failed: ${e.message}`); });
  try { return await fn(wt); } finally { await removePreflightWorktree(ctx, wt); }
}

export async function fleetDryRun(ctx, oid, wt) {
  const res = await ctx.spawn({
    argv: [ctx.pinned.adlc, 'fleet', 'run', '--dry-run', '--base', oid, '--json'],
    cwd: wt, env: { ...childEnv(ctx.env.base), ...ctx.git.overlayEnv() }, deadlineMs: DEADLINES.preflightScript, label: 'adlc fleet run --dry-run',
  });
  if (res.status !== 0) throw new PreflightError('fleet-dry-run-failed', `exited ${res.status ?? res.reason}: ${String(res.stderr ?? '').trim().slice(0, 200)}`);
  let doc;
  try { doc = JSON.parse(res.stdout); } catch { throw new PreflightError('fleet-dry-run-failed', 'fleet --json output is not JSON'); }
  if (doc?.baseSha !== oid && !active('preflight.acceptAnyBaseSha')) throw new PreflightError('fleet-dry-run-mismatch', `baseSha ${doc?.baseSha} != ${oid}`);
  return { baseSha: doc?.baseSha ?? null };
}

/**
 * Phase B. Returns { complete, incomplete, tokenShort, checks }.
 * @param opts.ticketId  the ticket about to be dispatched; the §14 binding runs only for the build ticket
 */
export async function phaseB(ctx, { dryRun = ctx.dryRun === true, ticketId = ctx.dispatchTicketId ?? null, now = ctx.now ?? Date.now } = {}) {
  const oid = requireBaseline(ctx);
  const checks = {}; const incomplete = [];
  if (dryRun) {
    const present = await ctx.git.local(ctx.repoRoot, ['cat-file', '-e', `${oid}^{commit}`]);
    if (present.status !== 0) return { complete: false, incomplete: ['baseline-not-local', 'fleet-dry-run-needs-worktree'], tokenShort: null, checks };
  }
  checks.pluginParity = await pluginParity(ctx, oid);
  checks.config = { ok: true, repo: (await pinnedConfig(ctx, oid)).autopilot.repo };
  const isBuild = ticketId === BUILD_TICKET_ID;
  const wallClockMs = (ctx.config.autopilot.wallClockMinutes ?? 90) * 60_000;
  let creds = null;
  try { creds = readHostFile(ctx, CREDENTIALS_REL); } catch { creds = null; }
  const margin = tokenMargin({ credentialsText: creds, now: now(), wallClockMs });
  checks.token = margin;
  if (dryRun) {
    if (isBuild) checks.specApproval = (await checkSpecApproval({ ctx, oid, ticketId, runnerCwd: null })).checks;
    else checks.specApproval = 'skipped: not-build-ticket';
    if (isBuild) incomplete.push('runner-gate-needs-worktree');
    incomplete.push('fleet-dry-run-needs-worktree');
    checks.fleetDryRun = 'skipped: needs-worktree';
    return { complete: false, incomplete, tokenShort: margin.tokenShort, checks };
  }
  await withPreflightWorktree(ctx, oid, async (wt) => {
    if (isBuild) checks.specApproval = (await checkSpecApproval({ ctx, oid, ticketId, runnerCwd: wt })).checks;
    else checks.specApproval = 'skipped: not-build-ticket';
    checks.fleetDryRun = await fleetDryRun(ctx, oid, wt);
  });
  return { complete: true, incomplete, tokenShort: margin.tokenShort, checks };
}

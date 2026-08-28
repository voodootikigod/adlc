// Dependency trees and the dependency-diff check (spec §6.4 worker-deps,
// §6.5b (ii)/(ii-b)/(iii); AC 52, 56, 75, 157, 162).
//
// npm on the host must NEVER consume worker-controlled input. So the worker's
// tree is built ONCE per run from a clone at BASE_OID cut from the worker mirror
// (reviewed content only), and the gates' tree from a clone at attestedHead
// AFTER the dependency-diff, lockfile and npm-config checks admitted the diff —
// with `--offline`, so the only registry route is the worker-deps install.
// Every host-side npm is the SANITIZED invocation: pinned npm, `ci
// --ignore-scripts --no-audit --no-fund`, an orchestrator-generated userconfig
// that pins the registry and nothing else, `--globalconfig /dev/null`, HOME an
// empty private directory, an env with no inherited NPM_CONFIG_*/npm_config_*
// and `npm_config_cache` = the run's private cache.

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { validateIssueNumber, validateOid } from './input.mjs';
import { DEADLINES } from './spawn.mjs';
import { compareLockfiles, parseLockfile, deepEqual } from './lockfile.mjs';
import { registerSeams, active } from './mutations.mjs';

registerSeams([
  'deps.allowAnyDep',       // an added dependency outside the allowed set passes
  'deps.useOperatorHome',   // npm runs with the operator's HOME instead of an empty private directory
  'deps.allowOnlineGate',   // the gate install drops --offline
  'deps.ignoreNpmrc',       // a worker-written .npmrc / overrides / file: spec is not npm-config-drift
  'deps.ignoreScripts',     // a changed `scripts` block passes
]);

export class DepsError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.name = 'DepsError'; this.code = code; this.exitCode = code === 'init-failed' ? 1 : 2; }
}

export const DEP_BLOCKS = Object.freeze(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']);
export const PINNED_REGISTRY = 'https://registry.npmjs.org/';
const FORBIDDEN_SPEC_RE = /^(?:file:|git:|git\+|github:|https?:|link:)|:\/\//;

/** The sanitized npm argv of §6.5b(iii). `offline` is the gate-side flag. */
export function sanitizedNpmArgv({ npm, userconfig, offline }) {
  const argv = [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--userconfig', userconfig, '--globalconfig', '/dev/null'];
  if (offline && !active('deps.allowOnlineGate')) argv.push('--offline');
  return argv;
}

/** Constructed field by field — never spread from a source env, so no NPM_CONFIG_* can ride along. */
export function sanitizedNpmEnv({ base, home, cache }) {
  return { PATH: base.PATH, HOME: home, LANG: base.LANG ?? 'C.UTF-8', LC_ALL: base.LC_ALL ?? 'C.UTF-8', TZ: base.TZ ?? 'UTC', npm_config_cache: cache };
}

function writeUserconfig(runDir, name) {
  mkdirSync(runDir, { recursive: true });
  const p = join(runDir, name);
  writeFileSync(p, `registry=${PINNED_REGISTRY}\n`, { mode: 0o600 });
  return p;
}

function privateHome(ctx, runDir, name) {
  if (active('deps.useOperatorHome')) return ctx.env.home;
  const p = join(runDir, name);
  rmSync(p, { recursive: true, force: true });
  mkdirSync(p, { recursive: true, mode: 0o700 });
  return p;
}

async function cloneAt({ ctx, runDir, source, dest, oid }) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const c = await ctx.git.local(runDir, ['clone', '-q', '--no-hardlinks', '--no-checkout', source, dest]);
  if (c.status !== 0) throw new DepsError('init-failed', `clone failed: ${c.stderr}`);
  const co = await ctx.git.local(dest, ['checkout', '-q', '--detach', oid]);
  if (co.status !== 0) throw new DepsError('init-failed', `checkout ${oid} failed: ${co.stderr}`);
}

async function npmCi({ ctx, issue, cwd, userconfigName, homeName, offline, label }) {
  const runDir = ctx.paths.runDir(issue);
  const r = await ctx.spawn({
    argv: sanitizedNpmArgv({ npm: ctx.pinned.npm, userconfig: writeUserconfig(runDir, userconfigName), offline }),
    cwd, env: sanitizedNpmEnv({ base: ctx.env.base, home: privateHome(ctx, runDir, homeName), cache: ctx.paths.npmCache(issue) }),
    deadlineMs: DEADLINES.npmCi, label,
  });
  return r;
}

/** §6.4: the worker's tree — a clone at BASE_OID from the worker mirror, then the ONE registry-capable install. */
export async function buildWorkerDeps({ ctx, issue, baseOid }) {
  validateIssueNumber(issue); validateOid(baseOid);
  const dest = ctx.paths.workerDeps(issue);
  await cloneAt({ ctx, runDir: ctx.paths.runDir(issue), source: ctx.paths.mirror(issue), dest, oid: baseOid });
  const r = await npmCi({ ctx, issue, cwd: dest, userconfigName: 'npmrc-worker', homeName: 'npm-home-worker', offline: false, label: 'npm-ci:worker-deps' });
  if (r.status !== 0) throw new DepsError('init-failed', `npm ci exited ${r.status ?? r.reason}`);
  return join(dest, 'node_modules');
}

/** §6.5b(iii): the gates' tree — a clone at attestedHead from the GATE mirror, installed OFFLINE from the private cache. */
export async function installGateDeps({ ctx, issue, attestedHead }) {
  validateIssueNumber(issue); validateOid(attestedHead);
  const dest = ctx.paths.gateDeps(issue);
  await cloneAt({ ctx, runDir: ctx.paths.runDir(issue), source: ctx.paths.gateMirror(issue), dest, oid: attestedHead });
  const r = await npmCi({ ctx, issue, cwd: dest, userconfigName: 'npmrc-gate', homeName: 'npm-home-gate', offline: true, label: 'npm-ci:gate-deps' });
  if (r.status !== 0) throw new DepsError('gate-deps-missing', `offline npm ci exited ${r.status ?? r.reason}`);
  return join(dest, 'node_modules');
}

const fail = (code, detail) => ({ ok: false, code, detail });
const workspaceRange = (v, lockstep) => v === '*' || v === 'workspace:*' || (lockstep != null && v === lockstep);

/**
 * §6.5b(ii)/(ii-b) over ONE package.json. `baseDoc` is null for a file that
 * does not exist at BASE_OID (a new workspace package).
 */
export function comparePackageJson(baseDoc, headDoc, { allowed = [], lockstepVersion = null, isRoot = false } = {}) {
  if (!headDoc || typeof headDoc !== 'object') return fail('third-party-dep', 'head package.json unparseable');
  const allowedSet = new Set(allowed);
  for (const block of DEP_BLOCKS) {
    const b = baseDoc?.[block] ?? {}; const h = headDoc[block] ?? {};
    if (typeof h !== 'object' || h === null) return fail('third-party-dep', `${block} is not an object`);
    for (const [k, v] of Object.entries(b)) {
      if (h[k] !== v) return fail('third-party-dep', `${block}.${k} changed or removed`);
    }
    for (const [k, v] of Object.entries(h)) {
      if (typeof v === 'string' && FORBIDDEN_SPEC_RE.test(v) && !active('deps.ignoreNpmrc')) return fail('npm-config-drift', `${block}.${k} uses a file:/git:/http: spec`);
      if (k in b || active('deps.allowAnyDep')) continue;
      if (!allowedSet.has(k) || !workspaceRange(v, lockstepVersion)) return fail('third-party-dep', `${block}.${k} added`);
    }
  }
  if (baseDoc && !active('deps.ignoreScripts') && !deepEqual(baseDoc.scripts ?? {}, headDoc.scripts ?? {})) return fail('third-party-dep', 'scripts changed');
  if (!active('deps.ignoreNpmrc')) {
    for (const k of ['publishConfig', 'overrides', 'resolutions']) {
      if (baseDoc ? !deepEqual(baseDoc[k], headDoc[k]) : (k !== 'publishConfig' && headDoc[k] !== undefined)) return fail('npm-config-drift', `${k} differs from base`);
    }
  }
  if (isRoot || baseDoc?.workspaces !== undefined || headDoc.workspaces !== undefined) {
    const b = baseDoc?.workspaces ?? []; const h = headDoc.workspaces ?? [];
    if (!Array.isArray(h) || b.some((w) => !h.includes(w))) return fail('npm-config-drift', 'workspaces entry removed');
    if (h.some((w) => !b.includes(w) && !/^packages\/[A-Za-z0-9._-]+$/.test(w))) return fail('npm-config-drift', 'workspaces gained a non-packages/<x> entry');
  }
  return { ok: true, code: null, detail: null };
}

async function showOrNull(ctx, cwd, ref, path) {
  const r = await ctx.git.local(cwd, ['show', `${ref}:${path}`]);
  return r.status === 0 ? r.stdout : null;
}
const parseOrNull = (t) => { try { return t === null ? null : JSON.parse(t); } catch { return undefined; } };

/**
 * §6.5b (ii)/(ii-b): every package.json, package-lock.json and .npmrc in
 * `git diff --name-only <base>...<head>` of ISSUE_WT.
 * @returns {{ ok, code: 'third-party-dep'|'lockfile-drift'|'npm-config-drift'|null, detail }}
 */
export async function dependencyDiffCheck({ ctx, issue, baseOid, head, allowed = [] }) {
  const cwd = ctx.paths.issueWorktree(validateIssueNumber(issue));
  validateOid(baseOid); validateOid(head);
  const files = (await ctx.git.localOut(cwd, ['diff', '--name-only', `${baseOid}...${head}`])).split('\n').filter(Boolean);
  const rootBase = parseOrNull(await showOrNull(ctx, cwd, baseOid, 'package.json'));
  const lockstepVersion = typeof rootBase?.version === 'string' ? rootBase.version : null;
  for (const f of files) {
    const name = basename(f);
    if (name === '.npmrc') { if (!active('deps.ignoreNpmrc')) return fail('npm-config-drift', `${f} changed`); continue; }
    if (name === 'package.json') {
      const base = parseOrNull(await showOrNull(ctx, cwd, baseOid, f));
      const headDoc = parseOrNull(await showOrNull(ctx, cwd, head, f));
      if (base === undefined || headDoc == null) return fail('third-party-dep', `${f} unparseable`);
      const r = comparePackageJson(base, headDoc, { allowed, lockstepVersion, isRoot: f === 'package.json' });
      if (!r.ok) return { ...r, detail: `${f}: ${r.detail}` };
      continue;
    }
    if (name === 'package-lock.json') {
      const r = compareLockfiles(parseLockfile(await showOrNull(ctx, cwd, baseOid, f) ?? ''), parseLockfile(await showOrNull(ctx, cwd, head, f) ?? ''), { allowed });
      if (!r.ok) return { ...r, detail: `${f}: ${r.detail}` };
    }
  }
  return { ok: true, code: null, detail: null };
}

/** §6.5b(i): ignored paths in ISSUE_WT outside the expected set → `ignored-file-drift`. */
export async function checkIgnoredFiles({ ctx, issue, allowedPrefixes = ['node_modules/', '.worktrees/', '.adlc/tmp/', '.adlc/fleet-status.json', '.adlc/fleet-logs/', '.adlc/fleet-log.txt'] }) {
  const cwd = ctx.paths.issueWorktree(validateIssueNumber(issue));
  const out = await ctx.git.localOut(cwd, ['status', '--porcelain', '--ignored']);
  const offending = out.split('\n').filter((l) => l.startsWith('!! ')).map((l) => l.slice(3)).filter((p) => !allowedPrefixes.some((a) => p === a || p.startsWith(a)));
  return offending.length ? { ok: false, code: 'ignored-file-drift', paths: offending } : { ok: true, code: null, paths: [] };
}

export const gateDepsExist = (nodeModules) => existsSync(nodeModules);

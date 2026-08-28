// The per-gate clone's git state: the pre-created tracking ref and the
// snapshot/re-verify bracket around every gate spawn (spec §6.6; AC 135, 141,
// 149).
//
// Repository code runs INSIDE the writable clone — including its `.git`, where
// the baseline ref the trust-root gates diff against lives — so no gate's
// verdict is accepted from a view its own code could have changed. The
// snapshot is taken before the spawn and again after it exits; any difference
// discards the verdict.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validateOid } from './input.mjs';
import { registerSeams, active } from './mutations.mjs';

registerSeams([
  'gates.clobberTrackingRef', // the tracking ref is written without the compare-and-swap
  'gates.skipSnapshotCheck',  // the post-gate snapshot is not compared
]);

export class GateRepoError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.name = 'GateRepoError'; this.code = code; this.exitCode = 2; }
}

export const ZERO_OID = '0'.repeat(40);
export const trackingRef = (oid) => `refs/remotes/origin/${validateOid(oid)}`;

/**
 * Create `refs/remotes/origin/<oid>` = oid with a zero-OID compare-and-swap.
 * An existing equal ref is left untouched (`created:false`); a different value,
 * or a ref that appears between the read and the create → `base-ref-conflict`.
 */
export async function ensureTrackingRef({ ctx, cwd, baseOid }) {
  const ref = trackingRef(baseOid);
  const read = await ctx.git.local(cwd, ['rev-parse', '--verify', '--quiet', ref]);
  if (read.status === 0) {
    if (read.stdout.trim() === baseOid) return { ref, created: false };
    throw new GateRepoError('base-ref-conflict', `${ref} is ${read.stdout.trim()}, not ${baseOid}`);
  }
  const argv = active('gates.clobberTrackingRef') ? ['update-ref', ref, baseOid] : ['update-ref', ref, baseOid, ZERO_OID];
  const w = await ctx.git.local(cwd, argv);
  if (w.status !== 0) throw new GateRepoError('base-ref-conflict', `could not create ${ref}: ${w.stderr.trim()}`);
  return { ref, created: true };
}

/** Delete the ref this bracket created, conditionally on its value (`update-ref -d <ref> <oid>`). */
export async function releaseTrackingRef({ ctx, cwd, baseOid, created = true }) {
  if (!created) return false;
  const r = await ctx.git.local(cwd, ['update-ref', '-d', trackingRef(baseOid), baseOid]);
  if (r.status !== 0) throw new GateRepoError('base-ref-moved', r.stderr.trim());
  return true;
}

function hooksExecutables(gitDir) {
  const dir = join(gitDir, 'hooks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => { try { const st = statSync(join(dir, n)); return st.isFile() && (st.mode & 0o111) !== 0; } catch { return false; } }).sort();
}

/** The complete git-state snapshot of one clone. */
export async function snapshotGateRepo({ ctx, cwd, baseOid }) {
  const gitDir = join(cwd, (await ctx.git.localOut(cwd, ['rev-parse', '--git-dir'])));
  const baseRefRead = await ctx.git.local(cwd, ['rev-parse', '--verify', '--quiet', trackingRef(baseOid)]);
  const exclude = join(gitDir, 'info', 'exclude');
  return {
    head: await ctx.git.localOut(cwd, ['rev-parse', 'HEAD']),
    baseRef: baseRefRead.status === 0 ? baseRefRead.stdout.trim() : null,
    forEachRef: await ctx.git.localOut(cwd, ['for-each-ref']),
    configList: await ctx.git.localOut(cwd, ['config', '--list', '--local']),
    hooksExecutables: hooksExecutables(gitDir),
    infoExclude: existsSync(exclude) ? readFileSync(exclude, 'utf8') : null,
    // node_modules is the orchestrator's read-only bind, not the gate's doing.
    statusPorcelain: await ctx.git.localOut(cwd, ['status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude)node_modules']),
  };
}

const CHECKS = Object.freeze([
  ['head', 'head-moved'], ['baseRef', 'base-ref-moved'], ['forEachRef', 'refs-changed'], ['configList', 'config-changed'],
  ['hooksExecutables', 'hooks-added'], ['infoExclude', 'exclude-changed'], ['statusPorcelain', 'tree-dirty'],
]);

/** @returns {{ same: boolean, reason: string|null }} the FIRST differing field's reason. */
export function compareSnapshots(before, after) {
  if (active('gates.skipSnapshotCheck')) return { same: true, reason: null };
  for (const [field, reason] of CHECKS) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) return { same: false, reason };
  }
  return { same: true, reason: null };
}

/** The pre-spawn sanity of a fresh clone; returns a reason or null. */
export function cloneSanity(snap, { attestedHead, baseOid }) {
  if (snap.head !== attestedHead) return 'head-moved';
  if (snap.baseRef !== baseOid) return 'base-ref-moved';
  if (snap.hooksExecutables.length) return 'hooks-added';
  if (snap.statusPorcelain !== '') return 'tree-dirty';
  return null;
}

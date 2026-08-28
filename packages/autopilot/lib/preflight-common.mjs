// Shared preflight vocabulary (spec §9, §14): the error class every phase
// throws, the pinned-blob paths phase B reads, and the one helper that turns
// "read a repository input" into `git show <BASE_OID>:<path>` so no phase-B
// check can fall back to the working tree.

import { validateOid } from './input.mjs';
import { registerSeams, active } from './mutations.mjs';

registerSeams(['preflight.phaseBWithoutBaseline']); // phase B reads HEAD when no baseline exists

export class PreflightError extends Error {
  constructor(code, detail, exitCode = 1) { super(detail ? `${code}: ${detail}` : code); this.code = code; this.detail = detail ?? null; this.exitCode = exitCode; }
}

/** The build ticket whose dispatch is bound to the spec approval (§14). */
export const BUILD_TICKET_ID = 'T-01M0Z3FN7SAS4HAH7CS63YQ0DH';
export const SPEC_PATH = 'docs/specs/issue-autopilot-local.md';
export const PLUGIN_JSON_PATH = 'plugins/adlc-claude-code/.claude-plugin/plugin.json';
export const CONFIG_PATH = '.adlc/config.json';
export const TICKET_SYNC_SCHEMA_PATH = 'packages/ticket-sync/schemas/adlc-config.schema.json';
export const MANIFEST_DIR = '.adlc/manifest.d';
export const ROOT_MANIFEST = '.adlc/manifest.jsonl';
export const INSTALLED_PLUGINS_REL = '.claude/plugins/installed_plugins.json';
export const CREDENTIALS_REL = '.claude/.credentials.json';
export const TOKEN_MARGIN_MS = 30 * 60_000;

/** Re-throw anything as a PreflightError, keeping a `code` the source already carries. */
export function asPreflightError(e, fallbackCode, detail) {
  if (e instanceof PreflightError) return e;
  const code = typeof e?.code === 'string' && !/^E[A-Z]+$/.test(e.code) ? e.code : fallbackCode;
  return new PreflightError(code, detail ?? e?.message, e?.exitCode ?? 1);
}

/** Phase B may only run with a resolved BASE_OID; anything else is `base-unresolved` (§9). */
export function requireBaseline(ctx) {
  // Mutation seam `preflight.phaseBWithoutBaseline`: phase B reads HEAD when no baseline exists.
  if (active('preflight.phaseBWithoutBaseline') && !ctx.baseOid) return 'HEAD';
  try { return validateOid(ctx.baseOid, { field: 'base-oid' }); }
  catch { throw new PreflightError('base-unresolved', 'phase B needs the BASE_OID of this iteration; no fallback to the working tree or a tracking ref'); }
}

/** `git show <oid>:<path>` through the local runner; a missing path is `null`. */
export async function showAtBaseline(ctx, oid, path) {
  const res = await ctx.git.local(ctx.repoRoot, ['show', `${oid}:${path}`], { label: `git show ${path}` });
  if (res.status !== 0) return null;
  if (res.truncated) throw new PreflightError('read-truncated', path);
  return res.stdout;
}

/** `git ls-tree --name-only <oid>:<dir>` → the entries of a tree at the baseline (empty when absent). */
export async function listTreeAtBaseline(ctx, oid, dir) {
  const res = await ctx.git.local(ctx.repoRoot, ['ls-tree', '--name-only', `${oid}:${dir}`], { label: `git ls-tree ${dir}` });
  if (res.status !== 0) return [];
  return res.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

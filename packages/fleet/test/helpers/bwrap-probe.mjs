// One usability probe for every real-bwrap test: the binary existing is not enough — user
// namespaces may be disabled, in which case `bwrap` exists and every sandboxed spawn fails.
import { spawnSync } from 'node:child_process';
import { detectBackend } from '../../lib/sandbox.mjs';

/** { ok:true } when a minimal bwrap sandbox can run node; else { ok:false, reason } (skip loudly with it). */
export function probeBwrap() {
  const backend = detectBackend();
  if (backend?.name !== 'bubblewrap') return { ok: false, reason: `no bubblewrap backend on this host (detected: ${backend?.name ?? 'none'})` };
  const res = spawnSync(backend.path ?? 'bwrap', ['--unshare-all', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--die-with-parent', '--', process.execPath, '-e', 'process.exit(0)'], { encoding: 'utf8', timeout: 10_000 });
  if (res.status === 0) return { ok: true };
  const reason = `bwrap cannot run a sandbox here (user namespaces unavailable?): ${(res.stderr || res.error?.message || '').trim().slice(0, 200)}`;
  // The CI image carries no bubblewrap today (an operator decision: .github is trust-root), so the
  // real-sandbox tests skip LOUDLY there and run for real on a bwrap-capable host.
  if (process.env.CI) console.warn(`SKIPPED (loudly) on CI: ${reason}`);
  return { ok: false, reason };
}

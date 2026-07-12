// The composed pre-merge gate (spec §8.3) — this is what actually WIRES the
// deterministic checks into the run pipeline (adversarial-review C1). The
// protected-path integrity scan and the scope check are library functions; this
// module is where they are invoked before a ticket may prosecute/merge, so the
// containment is in the path, not just defined.
//
// Order (fail at the first): build/test (sandboxed) → ticket-local scope check →
// protected-control-file integrity scan → rails-guard. Every collaborator is
// injected so the composition is testable without a real repo, and so the live
// deps builder can assemble it from the concrete git/sandbox implementations.

import { runGates, scopeViolations } from './gates.mjs';
import { scanProtectedPaths, isUnderProtectedPrefix, isInert } from './protected-paths.mjs';

/**
 * Collect the protected-prefix files a worker could have touched off the tracked
 * diff. `listProtected` comes from `git status --ignored --others` PLUS modified
 * tracked files, so it surfaces every worker-touchable control file: a modified
 * tracked trust root (`.adlc/tickets.json`), an untracked new control file, or an
 * ignored provisioned file (`.claude/settings.local.json`). A committed,
 * byte-identical file that a worker did not touch produces no git-status entry
 * and needs no check. Returns [{ path, bytes }]; injectable read so it is
 * unit-testable.
 */
export function collectProtectedCandidates({ listProtected, readBytes }) {
  const candidates = [];
  for (const path of new Set(listProtected())) {
    if (!isUnderProtectedPrefix(path) || isInert(path)) continue;
    let bytes;
    try { bytes = readBytes(path); } catch { continue; } // absent → nothing to compare
    if (bytes === undefined || bytes === null) continue;
    candidates.push({ path, bytes });
  }
  return candidates;
}

/**
 * Run the full deterministic gate for one ticket attempt. Returns
 * { ok, stage, output } — `stage` names the first failing check.
 *
 * @param deps.sandbox   the resolved Sandbox (repo-command plane)
 * @param deps.env       the scrubbed repo-command env
 * @param deps.gate      { build?, test? } commands
 * @param deps.changedPaths string[] from `git diff --name-only startSha..HEAD`
 * @param deps.templates Map<path,bytes> authoritative control-file versions
 * @param deps.listProtected / deps.readBytes  (see collectProtectedCandidates)
 * @param deps.railsGuard optional () => { ok, output } — the adlc rails-guard gate
 */
export async function runGatePipeline(ticket, deps) {
  // 1. build/test inside the sandbox.
  const build = await runGates(deps.sandbox, deps.gate, deps.env);
  if (!build.ok) {
    const failed = build.results.find((r) => !r.ok);
    return { ok: false, stage: `build/test:${failed?.key ?? '?'}`, output: failed?.output ?? '' };
  }

  // 2. ticket-local scope check (tracked diff).
  const outOfScope = scopeViolations(deps.changedPaths ?? [], ticket);
  if (outOfScope.length > 0) {
    return { ok: false, stage: 'scope', output: `out-of-scope paths: ${outOfScope.join(', ')}` };
  }

  // 3. protected-control-file integrity scan (ignored/unstaged trust roots, C1).
  const candidates = collectProtectedCandidates({
    listProtected: deps.listProtected ?? (() => []),
    readBytes: deps.readBytes ?? (() => undefined),
  });
  const scan = scanProtectedPaths(candidates, deps.templates ?? new Map());
  if (!scan.ok) {
    return { ok: false, stage: 'protected-paths', output: scan.violations.map((v) => `${v.path}: ${v.reason}`).join('; ') };
  }

  // 4. rails-guard (delegated to the adlc CLI in the live builder).
  if (deps.railsGuard) {
    const rg = await deps.railsGuard();
    if (!rg.ok) return { ok: false, stage: 'rails-guard', output: rg.output ?? 'rail touched' };
  }

  return { ok: true, stage: 'passed', output: '' };
}

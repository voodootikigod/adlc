// WorkerAdapter: GitHub Copilot CLI (`copilot -p`, non-interactive). Model plane (K2).
//
// PERMISSION POSTURE — verified end-to-end against Copilot CLI 1.0.73 (the
// #240 live deny-proof; see docs/integrations/copilot-probe-appendix.md):
//
// A `preToolUse` rails-guard hook denies a rail edit by raising a permission
// *ask* (its `{reason}` becomes the ask message). Headless, that ask cannot be
// answered by a human, so it defaults to DENY and BLOCKS the tool — and it
// overrides an explicit `--allow-tool`. The ONE thing that neuters it is
// `--allow-all-tools`/`--yolo`, which installs an allow-all override that
// auto-approves the hook's ask. So a fleet worker must NOT run with
// `--allow-all-tools` if in-session rail protection is wanted.
//
// DEFAULT invocation therefore uses an explicit tool ALLOWLIST
// (`--allow-tool write --allow-tool shell`; reads are auto-allowed), which lets
// non-rail edits run unattended while the rails-guard hook still blocks rail
// edits. Set `allowAllTools: true` only for a CI-gate-only worker that
// deliberately forgoes in-session rail enforcement.
//
// Denial always beats allow, so `denyShell`/`denyTools` still strip capability
// even under `--allow-all-tools` — live-verified in scripts/copilot-live-deny.mjs
// (`--deny-tool shell` blocked the shell tool while `--allow-all-tools` was set).
// Overridable wholesale via `command`/`args`. Text output only (no JSON mode).
import { defaultExec, mapResult } from './_shared.mjs';

export const name = 'copilot';
export const pool = 'default';

/** Run-time aliases this harness resolves for itself (operating-stack §4b rule 6). */
export const aliases = Object.freeze(['default']);

/** `copilot -p` exposes no model flag in this adapter, so it cannot force the registry's model (§4c). */
export const forcesModel = false;

/**
 * §4c ATTEST half: whether this adapter reports the concrete model its harness
 * actually ran (`resolvedModel`). NONE do yet — that is spec §9.3 — so an
 * alias-based channel cannot be bound to any adapter today, which is exactly
 * what §4c round-11 requires: without attestation, an alias is an unverifiable
 * claim about what executed.
 */
export const attestsResolvedModel = false;

// Tools a worker needs to make progress unattended. Reads are auto-allowed by
// the CLI; `write` covers edit/create, `shell` covers command execution. The
// rails-guard hook still gates rail PATHS within these tools.
const DEFAULT_ALLOW_TOOLS = Object.freeze(['write', 'shell']);

export async function dispatch({
  worktree,
  prompt,
  timeoutMs,
  env,
  exec = defaultExec,
  command = 'copilot',
  args,
  allowAllTools = false,
  allowTools,
  denyTools,
  denyShell = false,
}) {
  let argv = args;
  if (!argv) {
    argv = ['-p', prompt];
    if (allowAllTools) {
      // Opt-in autonomy: neuters the in-session rails-guard hook (the hook's
      // deny-ask is auto-approved). Rail enforcement then relies solely on the
      // rails-guard-ci diff gate.
      argv.push('--allow-all-tools');
    } else {
      for (const tool of allowTools ?? DEFAULT_ALLOW_TOOLS) argv.push('--allow-tool', tool);
    }
    for (const tool of denyTools ?? []) argv.push('--deny-tool', tool);
    if (denyShell) argv.push('--deny-tool', 'shell');
  }
  const res = await exec(command, argv, { cwd: worktree, env, timeout: timeoutMs });
  return mapResult(res);
}

// WorkerAdapter: Cursor agent CLI (`cursor-agent -p`, headless print). Model plane (K2).
//
// DEFAULT invocation: `cursor-agent -p <prompt>` — Cursor's headless/print CLI.
// Confidence: medium — VERIFY the `cursor-agent` binary name and `-p` flag
// against the installed Cursor CLI. Overridable via `command`/`args`.

import { defaultExec, mapResult } from './_shared.mjs';

export const name = 'cursor';
export const pool = 'default';

/**
 * 7.3 model-plane filesystem policy (#395) -- session state only.
 *
 * `.cursor/` itself is absent for the same reason `.claude/` is: it holds `rules/`
 * and an MCP config, which are executable configuration for the operator's next session.
 */
export const homeState = Object.freeze({
  dirs: Object.freeze(['.local/share/cursor-agent', '.cache/cursor-agent', '.cursor/chats']),
  files: Object.freeze(['.local/share/cursor-agent/auth.json', '.cursor/cli-config.json']),
});

/** Run-time aliases this harness resolves for itself (operating-stack §4b rule 6). */
export const aliases = Object.freeze(['default']);

/** `cursor-agent -p` exposes no model flag in this adapter, so it CANNOT force the registry's model —
 * validation refuses to bind it to a seat that names one rather than let the ambient default run
 * under a plan that claims otherwise (§4c). */
export const forcesModel = false;

/**
 * §4c ATTEST half: whether this adapter reports the concrete model its harness
 * actually ran (`resolvedModel`). NONE do yet — that is spec §9.3 — so an
 * alias-based channel cannot be bound to any adapter today, which is exactly
 * what §4c round-11 requires: without attestation, an alias is an unverifiable
 * claim about what executed.
 */
export const attestsResolvedModel = false;

/**
 * §4b transport classes this harness can serve (issue #396).
 * Session-based; no metered path is verified here, so none is declared.
 */
export const transports = Object.freeze({
  subscription: Object.freeze({}),
});

export async function dispatch({ worktree, prompt, timeoutMs, env, exec = defaultExec, command = 'cursor-agent', args }) {
  const argv = args ?? ['-p', prompt];
  const res = await exec(command, argv, { cwd: worktree, env, timeout: timeoutMs });
  return mapResult(res);
}

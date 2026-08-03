// WorkerAdapter: Google Gemini CLI (`jetski --print` or `agy --print`). Model plane (K2).
//
// DEFAULT invocation: `[agent] --print [--model <model>]` with the prompt on STDIN.
// Confidence: HIGH — this shape is verified against antigravity-booster's
// runAgy (../antigravity-booster/lib/agy.mjs), which pipes the prompt to stdin
// and reads print-mode stdout. `model` comes from `fleet.model`. Overridable via
// `command`/`args`. agy/jetski meters per-model quota pools.

import { accessSync, constants, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { defaultExec, mapResult, modelArgs } from './_shared.mjs';

export const name = 'gemini';
export const pool = 'default';

/** Run-time aliases this harness resolves for itself (operating-stack §4b rule 6). */
export const aliases = Object.freeze(['default', 'agy', 'jetski']);

/** `--model` accepts an explicit model, so this adapter can serve a registry seat (§4c). */
export const forcesModel = true;

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
 * Session-based; no metered path is verified here, so none is declared. The
 * `agy`/`jetski` wrappers front the same binaries and declare the same class.
 */
export const transports = Object.freeze({
  subscription: Object.freeze({}),
});

function detectBinary(targets = ['jetski', 'agy']) {
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(e => e.toLowerCase())
    : [''];

  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const normalized = dir.replace(/[\\/]+$/, '').replace(/\\/g, '/');
    if (!isAbsolute(dir)) continue;
    if (normalized.endsWith('node_modules/.bin') || normalized.endsWith('node-gyp-bin')) continue;
    for (const binName of targets) {
      for (const ext of extensions) {
        const candidate = join(dir, binName + ext);
        try {
          const stat = statSync(candidate);
          if (stat.isFile()) {
            accessSync(candidate, constants.X_OK);
            return candidate;
          }
        } catch {
          // keep looking
        }
      }
    }
  }
  return null;
}

export async function dispatch({ worktree, prompt, timeoutMs, env, exec = defaultExec, command, args, model }) {
  let resolvedCommand = command;
  if (!resolvedCommand) {
    resolvedCommand = detectBinary();
    if (!resolvedCommand && exec !== defaultExec) {
      resolvedCommand = 'agy';
    }
  } else if (resolvedCommand === 'agy' || resolvedCommand === 'jetski') {
    resolvedCommand = detectBinary([resolvedCommand]);
    if (!resolvedCommand && exec !== defaultExec) {
      resolvedCommand = command;
    }
  }
  if (!resolvedCommand) {
    throw new Error('Google Gemini integration: safe agent binary not found in PATH.');
  }

  // `modelArgs` (not a bare truthiness check) so the registry's `default`
  // sentinel is NOT emitted literally as `--model default` — that names a model
  // agy/jetski does not have. It means "let the harness resolve its own default".
  const argv = args ?? ['--print', ...modelArgs('--model', model)];
  // agy/jetski reads the prompt from stdin (not an argv position).
  const res = await exec(resolvedCommand, argv, { cwd: worktree, env, timeout: timeoutMs, input: prompt });
  return mapResult(res);
}

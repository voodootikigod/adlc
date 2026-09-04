// WorkerAdapter: Google Gemini CLI (`jetski --print <prompt>` or `agy --print <prompt>`). Model plane (K2).
//
// DEFAULT invocation: `[agent] --print <prompt> [--model <model>]`, prompt as an
// argv value. Confidence: HIGH — `--print` is a Go string flag whose VALUE is the
// prompt (agy/jetski `--help`: "--print  Alias for --prompt"); there is no
// stdin-print mode, so a bare `--print` with the prompt piped on stdin errors
// with "flag needs an argument: -print" (issue #866). `model` comes from
// `fleet.model`. Overridable via `command`/`args`; `useStdin: true` restores the
// old stdin-piped form (prompt NOT in argv) for a caller that still wants it.
// agy/jetski meters per-model quota pools.

import { accessSync, constants, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { defaultExec, mapResult, modelArgs } from './_shared.mjs';

export const name = 'gemini';
export const pool = 'default';

/** 7.3 model-plane filesystem policy (#395) -- session state only; declared settings stay read-only. */
export const homeState = Object.freeze({
  dirs: Object.freeze(['.gemini/tmp', '.gemini/sessions', '.cache/gemini']),
  files: Object.freeze(['.gemini/oauth_creds.json', '.gemini/google_accounts.json']),
});

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

export async function dispatch({ worktree, prompt, timeoutMs, env, exec = defaultExec, command, args, model, useStdin = false }) {
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
  const argv = args ?? (useStdin
    ? ['--print', ...modelArgs('--model', model)]
    : ['--print', prompt, ...modelArgs('--model', model)]);
  // `--print` takes the prompt as its argv value by default (see header); the
  // stdin form is opt-in via `useStdin` for a caller that still wants it.
  const opts = { cwd: worktree, env, timeout: timeoutMs };
  if (useStdin) opts.input = prompt;
  const res = await exec(resolvedCommand, argv, opts);
  return mapResult(res);
}

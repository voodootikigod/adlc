/**
 * Real dependencies for `superviseLoop` — the half that touches processes, the
 * clock and the filesystem.
 *
 * It lives beside the loop rather than inside the CLI because every decision
 * here is a decision: which argv becomes the passthrough command, what the
 * child's argument vector looks like, which environment the continue step gets
 * (the one WITH the key) versus the child (the one without), and what a
 * non-zero exit from `handoff continue` means. A CLI branch holding those is a
 * branch no test drives.
 */

import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readDenyMarker } from './deny-marker.mjs';
import { verifyCaptureHash } from './capture.mjs';
import { superviseChildEnv, transcriptPathFor } from './supervise.mjs';

/** This package's own CLI — the continue step runs the real command, not a stub. */
export const HANDOFF_BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'handoff.mjs');

/**
 * Split `supervise [flags] -- <command> [args...]` at the `--` separator.
 *
 * The separator is required rather than inferred. Without it a wrapper flag and
 * the supervised command's own flags are indistinguishable (`--dir` means
 * something to both), and guessing which side of the line an argument belongs
 * on is how a wrapper silently swallows an argument the operator meant for the
 * harness.
 *
 * @param {string[]} argv
 * @returns {{ ok: true, flags: string[], command: string, args: string[] }
 *          | { ok: false, error: string }}
 */
export function splitPassthrough(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const at = list.indexOf('--');
  if (at === -1) {
    return {
      ok: false,
      error: 'supervise needs the harness command after `--` (e.g. `adlc handoff supervise -- claude`)',
    };
  }
  const flags = list.slice(0, at);
  const [command, ...args] = list.slice(at + 1);
  if (typeof command !== 'string' || command.length === 0) {
    return { ok: false, error: 'supervise needs a command after `--` (e.g. `-- claude --model opus`)' };
  }
  return { ok: true, flags, command, args };
}

/**
 * The argument vector for one supervised spawn.
 *
 * `--session-id` leads so the minted id cannot be shadowed by a passthrough
 * argument, and the bootstrap prompt trails as the positional argument the
 * harness auto-submits (live probe, 2026-08-13: `claude --session-id <uuid>
 * "<prompt>"` boots the TUI and submits the prompt). The first spawn has no
 * prompt — that session is the operator's to drive.
 *
 * @returns {string[]}
 */
export function childArgv({ sessionId, prompt, args = [] }) {
  const argv = ['--session-id', sessionId, ...args];
  if (typeof prompt === 'string' && prompt.length > 0) argv.push(prompt);
  return argv;
}

/**
 * A spawner that hands the loop a `{ exited, kill }` handle.
 *
 * `stdio: 'inherit'` is what makes this a wrapper rather than a runner: the
 * operator keeps their terminal, and the supervisor never sits between them and
 * the harness. The environment is scrubbed on EVERY spawn (contract item 24),
 * not once at startup — a scrub that lives in the caller is a scrub the second
 * spawn can forget.
 */
export function nodeSpawner({ command, args = [], cwd, env, spawnFn = nodeSpawn, onSpawn = null }) {
  return ({ sessionId, prompt }) => {
    const child = spawnFn(command, childArgv({ sessionId, prompt, args }), {
      cwd,
      env: superviseChildEnv(env),
      stdio: 'inherit',
    });
    const handle = {
      pid: child.pid,
      // The return is the POINT, not a detail: `terminateChild` treats an
      // explicit false as "already gone" and reports `signalled: false`, which
      // is what tells the loop an exit was somebody else's doing. Node returns
      // true for a live child and false for a reaped one (verified against a
      // real child process in supervise-runtime.test.mjs), so discarding it
      // made that guard permanently unreachable in production while a stub
      // returning false kept its unit test green.
      kill: (signal) => {
        try {
          return child.kill(signal);
        } catch {
          // A child that cannot be signalled at all is already gone — the same
          // fact node reports as false, so it is reported the same way.
          return false;
        }
      },
      exited: new Promise((resolve) => {
        // Both events settle the same fact. `error` fires when the command
        // could not be started at all, which must not leave the loop polling a
        // child that was never running.
        child.once('exit', (code, signal) => resolve({ code, signal }));
        child.once('error', (error) => resolve({ code: null, signal: null, error }));
      }),
    };
    if (onSpawn) onSpawn(handle);
    return handle;
  };
}

/** Promise-shaped `execFile` — injectable so the continue step is testable. */
export function runNodeScript(script, args, { cwd, env, execFileFn = nodeExecFile, maxBuffer = 8 * 1024 * 1024 }) {
  return new Promise((resolve) => {
    execFileFn(
      process.execPath,
      [script, ...args],
      { cwd, env, encoding: 'utf8', maxBuffer },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        });
      },
    );
  });
}

/**
 * Run `handoff continue --write --json` for a denied session.
 *
 * This is the ONLY place the supervisor's manifest key is used, and it is
 * passed to this child alone — never to `superviseChildEnv`, which strips it.
 *
 * Every non-zero exit is a degrade for the caller: exit 2 is the spec's own
 * "nothing was consumed" signal, and exit 1 (a missing key, an I/O failure)
 * leaves just as little consumed. The two are distinguished in the message, not
 * in the verdict, because the operator's next move is the same either way.
 */
export function cliContinueRunner({ cwd, dir, env, bin = HANDOFF_BIN, run = runNodeScript }) {
  return async ({ denySession, captureFrom }) => {
    const args = ['continue', '--deny-session', denySession, '--dir', dir, '--write', '--json'];
    if (typeof captureFrom === 'string' && captureFrom.length > 0) {
      args.push('--capture-from', captureFrom);
    }
    const result = await run(bin, args, { cwd, env });
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' ');
      return {
        ok: false,
        error: `\`handoff continue\` exited ${result.code}${detail ? `: ${detail}` : ''}`,
      };
    }
    let payload;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      return { ok: false, error: '`handoff continue` did not print a JSON payload' };
    }
    return { ok: true, payload };
  };
}

/**
 * SIGINT ownership for the wrapper.
 *
 * Without a handler the wrapper dies on Ctrl-C and orphans a child that owns
 * the terminal. With one, the signal is forwarded to the session the operator
 * was actually talking to and the loop stops looking for new denies — an
 * interrupted session is one the operator has decided to end, not one to
 * continue into a successor.
 */
export function createInterrupt({ signals = process, signal = 'SIGINT' } = {}) {
  const state = { stopped: false, child: null };
  const handler = () => {
    state.stopped = true;
    if (state.child) state.child.kill(signal);
  };
  signals.on(signal, handler);
  return {
    isStopped: () => state.stopped,
    attach: (child) => {
      state.child = child;
    },
    raise: handler,
    dispose: () => {
      if (typeof signals.off === 'function') signals.off(signal, handler);
      else if (typeof signals.removeListener === 'function') signals.removeListener(signal, handler);
    },
  };
}

/** Transcript mtime, or null when the file is not there (yet). */
export function statTranscriptFile(path, { stat = statSync } = {}) {
  try {
    const info = stat(path);
    return { mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Assemble every dependency `superviseLoop` needs from the real environment.
 *
 * @param {object} opts
 * @param {string} opts.root repo root
 * @param {string} opts.adlcDir ledger directory (`--dir`)
 * @param {string} opts.command harness command from the passthrough
 * @param {string[]} opts.args passthrough arguments
 * @param {Record<string,string|undefined>} opts.env the OPERATOR's environment
 * @returns {{ deps: object, interrupt: object }}
 */
export function createSuperviseDeps({
  root,
  adlcDir,
  command,
  args,
  env,
  homeDir = homedir(),
  log = (line) => console.error(line),
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  mintSessionId = randomUUID,
  signals = process,
}) {
  const interrupt = createInterrupt({ signals });
  const deps = {
    mintSessionId,
    spawn: nodeSpawner({
      command,
      args,
      cwd: root,
      env,
      onSpawn: (child) => interrupt.attach(child),
    }),
    readOpenDeny: (sessionId) => {
      const got = readDenyMarker(root, sessionId);
      return got.ok && got.record?.status === 'open' ? got.record : null;
    },
    transcriptPath: (sessionId) => transcriptPathFor({ homeDir, cwd: root, sessionId }),
    statTranscript: (path) => statTranscriptFile(path),
    runContinue: cliContinueRunner({ cwd: root, dir: adlcDir, env }),
    verifyCapture: ({ denySession, contentHash }) => verifyCaptureHash(root, denySession, contentHash),
    log,
    now,
    sleep,
    interrupt,
  };
  return { deps, interrupt };
}

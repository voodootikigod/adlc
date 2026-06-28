// gh.mjs — the ONLY code that shells out to `gh`. Uses execFile with an argv
// array (never a shell string), so untrusted issue content can never be
// interpolated into a command (CONVENTIONS / design C4). The runner is injected
// everywhere else, so all logic above this file is testable with zero network.

import { execFile } from 'node:child_process';

/** A real `gh` runner: resolves to {ok, code, stdout, stderr, error}. Never rejects. */
export function makeGhRunner() {
  return (args, { cwd } = {}) =>
    new Promise((resolve) => {
      execFile('gh', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const error = err.code === 'ENOENT' ? 'gh-not-found' : (stderr || err.message);
          resolve({ ok: false, code: typeof err.code === 'number' ? err.code : 1, stdout: stdout ?? '', stderr: stderr ?? '', error });
        } else {
          resolve({ ok: true, code: 0, stdout: stdout ?? '', stderr: stderr ?? '', error: null });
        }
      });
    });
}

/** Run a gh command expecting JSON on stdout. Returns {ok, data} or {ok:false, error}. */
export async function ghJson(runner, args, opts) {
  const r = await runner(args, opts);
  if (!r.ok) return { ok: false, error: r.error || r.stderr || `gh exited ${r.code}`, code: r.code };
  try {
    return { ok: true, data: JSON.parse(r.stdout) };
  } catch (e) {
    return { ok: false, error: `gh returned non-JSON output: ${e.message}` };
  }
}

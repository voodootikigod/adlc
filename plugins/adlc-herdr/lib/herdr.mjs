// The single shim every herdr CLI call goes through (plan §6.5). One file to
// fix when the pre-1.0 herdr CLI changes shape. Contract frozen in
// test/herdr-shim.test.mjs (rail): fixed argv arrays, no shell, trusted
// binary resolution (HERDR_BIN_PATH or literal "herdr"), runtime failures
// fail soft, malformed requests fail closed before anything spawns.
import { execFile } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 10_000;

/** Build the argv for a herdr invocation. Throws on malformed input. */
export function herdrArgv(args, { env = process.env } = {}) {
  if (!Array.isArray(args) || args.length === 0 || args.some((a) => typeof a !== 'string')) {
    throw new TypeError('herdr args must be a non-empty array of strings');
  }
  const bin = typeof env.HERDR_BIN_PATH === 'string' && env.HERDR_BIN_PATH.length > 0
    ? env.HERDR_BIN_PATH
    : 'herdr';
  return [bin, ...args];
}

function defaultExec(file, args, opts) {
  return new Promise((resolve) => {
    execFile(file, args, opts, (error, stdout, stderr) => {
      if (error) {
        resolve({
          code: typeof error.code === 'number' ? error.code : 1,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        });
      } else {
        resolve({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '' });
      }
    });
  });
}

/**
 * Run a herdr CLI command. Resolves {ok:true, stdout} on exit 0, otherwise
 * {ok:false, ...} — never rejects for runtime failures (spawn errors,
 * non-zero exits, timeouts).
 */
export async function runHerdr(args, { env = process.env, exec = defaultExec, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const argv = herdrArgv(args, { env });
  try {
    const { code, stdout, stderr } = await exec(argv[0], argv.slice(1), { timeout: timeoutMs, shell: false });
    if (code === 0) return { ok: true, stdout };
    return { ok: false, code, stderr };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Run a herdr CLI command and parse its stdout as JSON, failing soft on
 *  malformed output. */
export async function runHerdrJson(args, opts = {}) {
  const res = await runHerdr(args, opts);
  if (!res.ok) {
    const out = { ok: false };
    if ('code' in res) out.code = res.code;
    if ('error' in res) out.error = res.error;
    return out;
  }
  try {
    return { ok: true, value: JSON.parse(res.stdout) };
  } catch {
    return { ok: false, error: 'malformed JSON from herdr' };
  }
}

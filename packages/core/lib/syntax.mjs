// core/lib/syntax.mjs
// One tri-state syntax check shared by mutation tools. A checker failure is
// always `unknown`: treating infrastructure failure as invalid would discard a
// mutant without proving that the mutant itself is malformed.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const JAVASCRIPT_EXT_RE = /\.(?:js|mjs|cjs)$/i;
const TYPESCRIPT_EXT_RE = /\.(?:ts|mts|cts|tsx|jsx)$/i;
const TYPESCRIPT_WORKER = fileURLToPath(new URL('./syntax-check-typescript.mjs', import.meta.url));

export function syntaxLanguage(file) {
  if (JAVASCRIPT_EXT_RE.test(file)) return 'javascript';
  if (TYPESCRIPT_EXT_RE.test(file)) return 'typescript';
  return null;
}

function typeScriptCandidates(filePath) {
  const candidates = [];
  let dir = dirname(resolve(filePath));
  while (true) {
    const packagePath = join(dir, 'node_modules', 'typescript', 'package.json');
    if (existsSync(packagePath)) candidates.push({ dir, packagePath });
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates;
}

function inspectTypeScript(filePath) {
  const skipped = [];
  for (const { dir, packagePath } of typeScriptCandidates(filePath)) {
    let manifest = {};
    try {
      manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
      const require = createRequire(join(dir, 'adlc-syntax-resolver.cjs'));
      const path = require.resolve('typescript');
      const ts = require(path);
      if (typeof ts.createSourceFile === 'function' && typeof ts.createProgram === 'function') {
        return {
          resolved: { path, version: ts.version ?? manifest.version ?? 'unknown' },
          skipped,
        };
      }
      skipped.push({ version: ts.version ?? manifest.version ?? 'unknown', path: packagePath });
    } catch {
      // A present package that cannot be loaded is not a usable parser. Keep
      // walking because a workspace parent can still provide TypeScript 5/6.
      skipped.push({ version: manifest.version ?? 'unknown', path: packagePath });
    }
  }
  return { resolved: null, skipped };
}

/**
 * The `typescript` package to parse `filePath` with: the nearest one, walking up
 * from the file's directory, whose module has the JavaScript parser API
 * (`createSourceFile`, `createProgram`). Resolved from the FILE, not from this
 * package or the cwd: pnpm and nested workspaces put the compiler next to the
 * code that uses it. A package without the API is skipped, not fatal —
 * TypeScript 7 is the native port (`main: null`, no JS API), and this
 * repository's own apps/docs pins it below a root 5.x. A relative file path is
 * resolved against the caller's current working directory before that walk.
 *
 * @param {string} filePath
 * @returns {{ path: string, version: string } | null}
 */
export function resolveTypeScript(filePath) {
  return inspectTypeScript(filePath).resolved;
}

/**
 * TRI-STATE syntax check: 'valid' | 'invalid' | 'unknown' (#293, #312, #313).
 *
 * Mutation tools score a mutant by a non-zero exit, and a file that does not
 * PARSE also exits non-zero, so an unparseable mutant must be discarded before
 * any test runs. "Could not determine" must never collapse into either answer:
 * as 'valid' it reopens the false kill (the test command fails on the parse
 * error and is credited), and as 'invalid' it discards a mutant that may have
 * been a survivor. A checker that is killed, times out, cannot spawn, or exits
 * with anything but its two verdict codes is therefore 'unknown', and callers
 * refuse to score it.
 *
 * JavaScript keeps `node --check`: it asks exactly the right question — would
 * Node accept this file — honouring the real extension and package type. The
 * TypeScript family runs the repository's own `typescript` in a child process
 * (syntax-check-typescript.mjs), so no @adlc package depends on a parser
 * (CONVENTIONS rule 1) and a parser crash cannot take the caller down with it.
 *
 * @param {string} filePath path to the (possibly mutated) file; relative paths use cwd
 * @param {string} cwd
 * @param {string} [execPath] node binary to check with; overridable for tests
 * @returns {{verdict:'valid'|'invalid'|'unknown', detail:string|null}}
 */
export function checkSyntaxDetail(filePath, cwd, execPath = process.execPath) {
  const language = syntaxLanguage(filePath);
  if (language === null) {
    const extension = extname(filePath) || '(none)';
    return { verdict: 'unknown', detail: `no syntax checker for ${extension}` };
  }
  const args = language === 'javascript'
    ? ['--check', filePath]
    : [TYPESCRIPT_WORKER, filePath];
  const result = spawnSync(execPath, args, {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
  });
  if (result.error?.code === 'ETIMEDOUT') {
    return { verdict: 'unknown', detail: 'timed out after 30s' };
  }
  if (result.error) return { verdict: 'unknown', detail: result.error.message };
  if (result.signal) return { verdict: 'unknown', detail: `killed by ${result.signal}` };
  if (typeof result.status !== 'number') return { verdict: 'unknown', detail: 'exit unknown' };
  if (language === 'javascript') {
    return { verdict: result.status === 0 ? 'valid' : 'invalid', detail: null };
  }
  if (result.status === 0) return { verdict: 'valid', detail: null };
  if (result.status === 65) return { verdict: 'invalid', detail: null };
  const lastError = result.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  const detail = lastError?.replace(/^adlc syntax check:\s*/, '') || `exit ${result.status}`;
  return { verdict: 'unknown', detail };
}

/** The verdict-only compatibility surface used by existing callers. */
export function checkSyntax(filePath, cwd, execPath = process.execPath) {
  return checkSyntaxDetail(filePath, cwd, execPath).verdict;
}

export function syntaxCheckProblem(filePath) {
  const language = syntaxLanguage(filePath);
  if (language === 'javascript') return null;
  if (language === null) return `${filePath}: no syntax checker exists for this extension`;

  const { resolved, skipped } = inspectTypeScript(filePath);
  if (resolved !== null) return null;
  const skippedText = skipped.length > 0
    ? `; ${skipped.map((item) => `skipped typescript ${item.version} at ${item.path}: no JavaScript parser API`).join('; ')}`
    : '';
  return `${filePath}: the typescript package with a JavaScript parser API was not found from its directory${skippedText}; install it with npm i -D typescript`;
}

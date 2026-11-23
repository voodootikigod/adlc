#!/usr/bin/env node
// A separate process contains parser crashes and candidate node_modules/typescript
// execution, and gives the parent an exit code that cannot be confused with
// Node's ordinary uncaught-error exit of 1.

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const VALID = 0;
const INVALID = 65;
const CANNOT_DECIDE = 3;

function cannotDecide(message) {
  console.error(`adlc syntax check: ${message}`);
  process.exit(CANNOT_DECIDE);
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

const tsCache = new Map();

function inspectTypeScriptInWorker(filePath) {
  const cacheKey = dirname(resolve(filePath));
  if (tsCache.has(cacheKey)) return tsCache.get(cacheKey);
  const skipped = [];
  for (const { dir, packagePath } of typeScriptCandidates(filePath)) {
    let manifest = {};
    try {
      manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
      const req = createRequire(join(dir, 'adlc-syntax-resolver.cjs'));
      const path = req.resolve('typescript');
      const ts = req(path);
      if (typeof ts.createSourceFile === 'function' && typeof ts.createProgram === 'function') {
        const hit = {
          resolved: { path, version: ts.version ?? manifest.version ?? 'unknown' },
          skipped,
          ts,
        };
        tsCache.set(cacheKey, hit);
        return hit;
      }
      skipped.push({ version: ts.version ?? manifest.version ?? 'unknown', path: packagePath });
    } catch {
      // A present package that cannot be loaded is not a usable parser. Keep
      // walking because a workspace parent can still provide TypeScript 5/6.
      skipped.push({ version: manifest.version ?? 'unknown', path: packagePath });
    }
  }
  const miss = { resolved: null, skipped, ts: null };
  tsCache.set(cacheKey, miss);
  return miss;
}

function checkFileWithTs(file) {
  const { resolved, ts } = inspectTypeScriptInWorker(file);
  if (resolved === null || !ts) {
    return { verdict: 'unknown', detail: `typescript could not be resolved from ${file}` };
  }
  const name = join(dirname(file), `.__adlc_syntax__${extname(file).toLowerCase()}`);
  const text = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const host = {
    getSourceFile: (candidate) => candidate === name ? sourceFile : undefined,
    fileExists: (candidate) => candidate === name,
    readFile: (candidate) => candidate === name ? text : undefined,
    getDefaultLibFileName: () => '',
    writeFile: () => {},
    getCurrentDirectory: () => dirname(file),
    getDirectories: () => [],
    getCanonicalFileName: (candidate) => candidate,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  const program = ts.createProgram({
    rootNames: [name],
    options: { noResolve: true, noLib: true, allowJs: true, jsx: ts.JsxEmit.Preserve },
    host,
  });
  const held = program.getSourceFile(name);
  if (held === undefined) {
    return { verdict: 'unknown', detail: `typescript did not retain ${file}` };
  }
  return {
    verdict: program.getSyntacticDiagnostics(held).length === 0 ? 'valid' : 'invalid',
    detail: null,
  };
}

try {
  if (process.argv[2] === '--daemon') {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const req = JSON.parse(line);
        const res = typeof req?.file === 'string'
          ? checkFileWithTs(req.file)
          : { verdict: 'unknown', detail: 'no file was provided' };
        process.stdout.write(`${JSON.stringify(res)}\n`);
      } catch (err) {
        process.stdout.write(`${JSON.stringify({ verdict: 'unknown', detail: err instanceof Error ? err.message : String(err) })}\n`);
      }
    });
  } else if (process.argv[2] === '--probe') {
    const target = process.argv[3];
    if (!target) cannotDecide('no file was provided for --probe');
    const { resolved, skipped } = inspectTypeScriptInWorker(target);
    process.stdout.write(JSON.stringify({ resolved, skipped }));
    process.exit(VALID);
  } else {
    const file = process.argv[2];
    if (!file) cannotDecide('no file was provided');
    const res = checkFileWithTs(file);
    if (res.verdict === 'unknown') cannotDecide(res.detail);
    process.exit(res.verdict === 'valid' ? VALID : INVALID);
  }
} catch (err) {
  cannotDecide(err instanceof Error ? err.message : String(err));
}

#!/usr/bin/env node
// A separate process contains parser crashes and candidate node_modules/typescript
// execution, and gives the parent an exit code that cannot be confused with
// Node's ordinary uncaught-error exit of 1.

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';

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

function inspectTypeScriptInWorker(filePath) {
  const skipped = [];
  for (const { dir, packagePath } of typeScriptCandidates(filePath)) {
    let manifest = {};
    try {
      manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
      const req = createRequire(join(dir, 'adlc-syntax-resolver.cjs'));
      const path = req.resolve('typescript');
      const ts = req(path);
      if (typeof ts.createSourceFile === 'function' && typeof ts.createProgram === 'function') {
        return {
          resolved: { path, version: ts.version ?? manifest.version ?? 'unknown' },
          skipped,
          ts,
        };
      }
      skipped.push({ version: ts.version ?? manifest.version ?? 'unknown', path: packagePath });
    } catch {
      // A present package that cannot be loaded is not a usable parser. Keep
      // walking because a workspace parent can still provide TypeScript 5/6.
      skipped.push({ version: manifest.version ?? 'unknown', path: packagePath });
    }
  }
  return { resolved: null, skipped, ts: null };
}

try {
  if (process.argv[2] === '--probe') {
    const target = process.argv[3];
    if (!target) cannotDecide('no file was provided for --probe');
    const { resolved, skipped } = inspectTypeScriptInWorker(target);
    process.stdout.write(JSON.stringify({ resolved, skipped }));
    process.exit(VALID);
  }

  const file = process.argv[2];
  if (!file) cannotDecide('no file was provided');
  const { resolved, ts } = inspectTypeScriptInWorker(file);
  if (resolved === null || !ts) cannotDecide(`typescript could not be resolved from ${file}`);

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
  if (held === undefined) cannotDecide(`typescript did not retain ${file}`);
  process.exit(program.getSyntacticDiagnostics(held).length === 0 ? VALID : INVALID);
} catch (err) {
  cannotDecide(err instanceof Error ? err.message : String(err));
}

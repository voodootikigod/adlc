// Isolation (AC1): another adlc verb never resolves @adlc/decision-layer.
// No enforce mode (AC12): the only mention of `enforce` in lib is the mode
// rejection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runBin, tmp } from '@adlc/core/test-kit';
import { installNoNetwork } from './helpers/no-network.mjs';
import { changeRepo } from './helpers/fixtures.mjs';

installNoNetwork();

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const ADLC = join(PACKAGE_DIR, '..', 'cli', 'bin', 'adlc.mjs');
const REGISTER = pathToFileURL(join(PACKAGE_DIR, 'test', 'helpers', 'resolve-log-register.mjs')).href;

/** Run `adlc <args>` and return the decision-layer URLs it resolved, in any process it started. */
function resolvedBy(t, args, cwd) {
  const log = join(tmp(t, 'decision-resolve-'), 'resolved.log');
  const result = runBin(ADLC, args, {
    cwd,
    timeout: 60_000,
    env: { DECISION_RESOLVE_LOG: log, NODE_OPTIONS: `--import=${REGISTER}`, TYPESAFE_API_KEY: '', JEV_API_KEY: '' },
  });
  return { result, urls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
}

test('running another verb never resolves the decision layer', (t) => {
  const { dir } = changeRepo(t);
  const { result, urls } = resolvedBy(t, ['ticket', 'list'], dir);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(urls, []);
});

test('the resolve log does see the decision layer when its own verb runs', (t) => {
  const { result, urls } = resolvedBy(t, ['decision', 'evaluate', '--mode', 'off'], tmp(t, 'decision-off-'));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(urls.some((url) => url.endsWith('/packages/decision-layer/lib/cli.mjs')), urls.join('\n'));
});

// Static, dynamic and CommonJS imports of the package or any subpath. A plain
// string naming the package (the registry's packageName) is not an import.
const IMPORTS_DECISION_LAYER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"`]@adlc\/decision-layer(?:\/[^'"`]*)?['"`]/;

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:mjs|cjs|js)$/.test(entry.name) ? [path] : [];
  });
}

test('the import matcher catches every import form and ignores a plain string', () => {
  for (const source of [
    "import { main } from '@adlc/decision-layer';",
    "import x from \"@adlc/decision-layer/lib/cli.mjs\";",
    "import '@adlc/decision-layer';",
    "const m = await import('@adlc/decision-layer/lib/cli.mjs');",
    "const m = await import( `@adlc/decision-layer` );",
    "const m = require('@adlc/decision-layer');",
    "export { main } from '@adlc/decision-layer';",
  ]) assert.ok(IMPORTS_DECISION_LAYER.test(source), source);
  for (const source of [
    "{ name: 'decision', packageName: '@adlc/decision-layer', binName: 'adlc-decision' }",
    "import x from '@adlc/decision-layer-other';",
  ]) assert.ok(!IMPORTS_DECISION_LAYER.test(source), source);
});

test('the CLI package never imports the decision layer', () => {
  const files = sourceFiles(join(PACKAGE_DIR, '..', 'cli'));
  assert.ok(files.some((file) => file.endsWith('registry.mjs')), 'the walk did not reach the CLI sources');
  for (const file of files) {
    if (file.includes(`${join('cli', 'test')}`)) continue;
    assert.ok(!IMPORTS_DECISION_LAYER.test(readFileSync(file, 'utf8')), `${file} imports the decision layer`);
  }
});

test('the only mention of enforce in lib is the mode rejection', () => {
  const lib = join(PACKAGE_DIR, 'lib');
  const hits = readdirSync(lib).flatMap((name) => readFileSync(join(lib, name), 'utf8').split('\n')
    .filter((line) => /enforce/i.test(line))
    .map((line) => ({ name, line: line.trim() })));
  assert.equal(hits.length, 1, JSON.stringify(hits));
  assert.equal(hits[0].name, 'config.mjs');
  assert.match(hits[0].line, /unknown --mode .*enforce mode is not part of this version/);
});

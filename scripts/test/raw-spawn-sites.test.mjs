// raw-spawn-sites.test.mjs — the raw-Node-spawn detector recognises every
// ordinary way a test spawns Node, reports what it cannot parse, and the hook
// spawn guard scans every plugin test directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as detector from './raw-spawn-sites.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const { rawSpawnSites } = detector;

const lines = (...src) => src.join('\n');

test('a string-literal node binary is a Node spawn', () => {
  const src = lines("import { spawnSync } from 'node:child_process';", "spawnSync('node', [HOOK, 'rails'], { input });");
  assert.deepEqual(rawSpawnSites(src), [{ line: 2 }]);
});

test('process.argv[0] is a Node spawn', () => {
  const src = lines("import { execFileSync } from 'node:child_process';", 'execFileSync(process.argv[0], [HOOK], {});');
  assert.deepEqual(rawSpawnSites(src), [{ line: 2 }]);
});

test('execSync and exec with a node command line are Node spawns', () => {
  const cases = [
    lines("import { execSync } from 'node:child_process';", 'execSync(`node "${cjsPath}" status`, { encoding: \'utf8\' });'),
    lines("import { execSync } from 'node:child_process';", 'execSync(`${process.execPath} ${HOOK}`, {});'),
    lines("import { exec } from 'node:child_process';", "exec('node ' + HOOK, () => {});"),
    lines("import { execSync } from 'node:child_process';", "execSync(process.execPath + ' ' + HOOK);"),
    lines("import { execSync } from 'node:child_process';", "execSync('node hook.mjs');"),
  ];
  for (const src of cases) assert.deepEqual(rawSpawnSites(src), [{ line: 2 }], `not detected: ${src}`);
});

test('a command line that merely mentions node is not a Node spawn', () => {
  const cases = [
    "import { execSync } from 'node:child_process';\nexecSync('git status');",
    "import { execSync } from 'node:child_process';\nexecSync(`nodemon ${x}`);",
    "import { spawnSync } from 'node:child_process';\nspawnSync('nodejs-helper', []);",
    "import { spawnSync } from 'node:child_process';\nspawnSync(process.argv[1], []);",
  ];
  for (const src of cases) assert.deepEqual(rawSpawnSites(src), [], `false positive: ${src}`);
});

test('an unparseable module is reported rather than passed', () => {
  const sites = rawSpawnSites('export const = ;\nspawnSync(process.execPath, [HOOK]);');
  assert.equal(sites.length, 1, 'a module the detector cannot read must not scan clean');
  assert.equal(sites[0].reason, 'unparseable');
});

test('the scanned directories are every plugin test directory on disk', () => {
  const scanned = typeof detector.pluginTestDirectories === 'function' ? detector.pluginTestDirectories(ROOT) : [];
  const onDisk = readdirSync(join(ROOT, 'plugins'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) => [`plugins/${e.name}/hooks/test`, `plugins/${e.name}/test`])
    .filter((dir) => existsSync(join(ROOT, dir)))
    .sort();
  assert.ok(onDisk.includes('plugins/adlc-cursor/test'), 'fixture sanity: plugins/adlc-cursor/test exists');
  assert.deepEqual([...scanned].sort(), onDisk);
});

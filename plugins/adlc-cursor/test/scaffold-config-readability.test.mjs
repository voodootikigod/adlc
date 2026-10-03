// scaffold-config-readability.test.mjs — an existing `.adlc/config.json` counts
// as present only when it parses to a JSON object; otherwise the scaffolder
// warns, leaves the file untouched, and the CLI exits non-zero.

import assert from 'node:assert/strict';
import { spawnHook } from './helpers/run-hook.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { tmp } from '@adlc/core/test-kit';
import { ensureConfig } from '../lib/scaffold.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'scaffold-cli.mjs');

function repoWithConfig(t, content) {
  const root = tmp(t, 'cursor-scaffold-config-');
  mkdirSync(join(root, '.git'), { recursive: true });
  if (content !== undefined) {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'config.json'), content);
  }
  return root;
}

const UNREADABLE = [
  { name: 'empty', content: '', reason: /not readable JSON/ },
  { name: 'malformed', content: '{"securityMode":', reason: /not readable JSON/ },
  { name: 'array', content: '[]', reason: /expected a top-level object/ },
  { name: 'null', content: 'null', reason: /expected a top-level object/ },
  { name: 'string', content: '"x"', reason: /expected a top-level object/ },
];

for (const { name, content, reason } of UNREADABLE) {
  test(`ensureConfig: ${name} config.json is reported with a warning and left untouched`, (t) => {
    const root = repoWithConfig(t, content);
    const result = ensureConfig(root);
    assert.equal(result.created, false);
    assert.match(result.warning, /^\.adlc\/config\.json exists but /);
    assert.match(result.warning, reason);
    assert.equal(readFileSync(join(root, '.adlc', 'config.json'), 'utf8'), content);
  });
}

test('ensureConfig: a readable object config is present with no warning', (t) => {
  const root = repoWithConfig(t, '{"securityMode":"signed"}\n');
  const result = ensureConfig(root);
  assert.deepEqual(result, { path: join(root, '.adlc', 'config.json'), created: false });
});

test('ensureConfig: an absent config is created with defaults and no warning', (t) => {
  const root = repoWithConfig(t);
  const result = ensureConfig(root);
  assert.deepEqual(result, { path: join(root, '.adlc', 'config.json'), created: true });
  assert.deepEqual(JSON.parse(readFileSync(result.path, 'utf8')), { securityMode: 'unsigned-fallback' });
});

test('scaffold-cli: an empty config.json fails the run and names the file', (t) => {
  const root = repoWithConfig(t, '');
  const r = spawnHook([CLI, root]);
  assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`);
  assert.doesNotMatch(r.stdout, /config\.json\s+— present/);
  assert.match(r.stderr, /\.adlc\/config\.json exists but is not readable JSON/);
  assert.equal(readFileSync(join(root, '.adlc', 'config.json'), 'utf8'), '');
});

test('scaffold-cli: a readable config.json is present and the run succeeds', (t) => {
  const root = repoWithConfig(t, '{"securityMode":"signed"}\n');
  const r = spawnHook([CLI, root]);
  assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
  assert.match(r.stdout, /\.adlc\/config\.json\s+— present/);
});

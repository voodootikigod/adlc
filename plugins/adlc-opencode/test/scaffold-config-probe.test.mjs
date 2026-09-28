// scaffold-config-probe.test.mjs — /adlc-init must not report an existing
// .adlc/config.json as present and fine when it is not a JSON object: every
// later gate that reads the config would then fail with an unrelated error.
// The file is still never clobbered; the operator is told and the run fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnHook } from './helpers/run-hook.mjs';
import { tmp } from '@adlc/core/test-kit';
import { ensureConfig } from '../lib/scaffold.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'scaffold-cli.mjs');

function withConfig(t, text) {
  const root = tmp(t, 'oc-cfg-probe-');
  mkdirSync(join(root, '.adlc'), { recursive: true });
  if (text !== null) writeFileSync(join(root, '.adlc', 'config.json'), text);
  return root;
}

for (const [label, text] of [['garbage', 'not json at all'], ['empty', ''], ['array', '[]'], ['scalar', '42'], ['null', 'null']]) {
  test(`ensureConfig: a ${label} config.json is reported, not accepted, and left untouched`, (t) => {
    const root = withConfig(t, text);
    const r = ensureConfig(root);
    assert.equal(r.created, false);
    assert.match(r.warning ?? '', /\.adlc\/config\.json exists but is not readable JSON/);
    assert.equal(readFileSync(join(root, '.adlc', 'config.json'), 'utf8'), text, 'never clobbered');
  });
}

test('ensureConfig: a valid object config is present with no warning', (t) => {
  const root = withConfig(t, '{"securityMode":"unsigned-fallback"}');
  const r = ensureConfig(root);
  assert.equal(r.created, false);
  assert.equal(r.warning, undefined);
});

test('ensureConfig: an absent config is still created', (t) => {
  const root = withConfig(t, null);
  const r = ensureConfig(root);
  assert.equal(r.created, true);
  assert.equal(typeof JSON.parse(readFileSync(r.path, 'utf8')), 'object');
});

function runCli(root) {
  return spawnHook([CLI], { cwd: root });
}

test('scaffold-cli: a malformed config.json fails the run and says why', (t) => {
  const root = withConfig(t, 'not json at all');
  const r = runCli(root);
  assert.equal(r.status, 1, 'an operational error, not a gate failure');
  assert.match(r.stderr, /config\.json exists but is not readable JSON/);
  assert.doesNotMatch(r.stdout, /config\.json present/);
});

test('scaffold-cli: a valid config.json still succeeds', (t) => {
  const root = withConfig(t, '{}');
  const r = runCli(root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /config\.json present/);
});

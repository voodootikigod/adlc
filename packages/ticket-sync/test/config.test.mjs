import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveRepo, selectorArgs } from '../lib/config.mjs';

function repoWithConfig(json) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-cfg-'));
  mkdirSync(join(dir, '.adlc'));
  if (json !== null) writeFileSync(join(dir, '.adlc', 'config.json'), typeof json === 'string' ? json : JSON.stringify(json));
  return dir;
}

test('loadConfig: missing file → ok:false with a clear error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-cfg-'));
  mkdirSync(join(dir, '.adlc'));
  try {
    const r = loadConfig(dir);
    assert.ok(!r.ok);
    assert.ok(r.errors[0].includes('config not found'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadConfig: invalid JSON → ok:false', () => {
  const dir = repoWithConfig('{ not json');
  try { assert.ok(!loadConfig(dir).ok); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadConfig: schema-invalid (missing provider) → ok:false', () => {
  const dir = repoWithConfig({ ticketSync: {} });
  try {
    const r = loadConfig(dir);
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => e.includes('provider')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadConfig: valid → ok:true with config', () => {
  const dir = repoWithConfig({ ticketSync: { provider: 'github', repo: 'acme/app' } });
  try {
    const r = loadConfig(dir);
    assert.ok(r.ok);
    assert.equal(r.config.ticketSync.repo, 'acme/app');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resolveRepo: explicit config repo wins', () => {
  assert.deepEqual(resolveRepo({ repo: 'acme/app' }), { ok: true, repo: 'acme/app' });
});

test('resolveRepo: derives owner/repo from https and ssh git remotes', () => {
  assert.equal(resolveRepo({}, { gitRemoteUrl: 'https://github.com/acme/app.git' }).repo, 'acme/app');
  assert.equal(resolveRepo({}, { gitRemoteUrl: 'git@github.com:acme/app.git' }).repo, 'acme/app');
});

test('resolveRepo: non-derivable → ok:false', () => {
  assert.ok(!resolveRepo({}, { gitRemoteUrl: 'https://example.com/x' }).ok);
});

test('selectorArgs: default is open issues with json + limit', () => {
  const args = selectorArgs({}, { limit: 100 });
  assert.deepEqual(args.slice(0, 3), ['issue', 'list', '--json']);
  assert.ok(args.includes('--state') && args[args.indexOf('--state') + 1] === 'open');
  assert.ok(args.includes('--limit') && args[args.indexOf('--limit') + 1] === '100');
});

test('selectorArgs: labels and query expand to flags', () => {
  const args = selectorArgs({ select: { state: 'all', labels: ['adlc', 'p1'], query: 'is:open' } });
  assert.equal(args[args.indexOf('--state') + 1], 'all');
  assert.equal(args.filter((a) => a === '--label').length, 2);
  assert.ok(args.includes('--search') && args[args.indexOf('--search') + 1] === 'is:open');
});

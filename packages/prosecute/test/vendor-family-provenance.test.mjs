// Concern: provider distinctness is decided per vendor FAMILY, not per raw string, and an
// empty or omitted run author fails closed rather than accepting unanchored attestations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signEntry } from '@adlc/gate-manifest/lib/sign.mjs';
import { normalizeProvider, recordCrossModelReview, hasCrossModelApproveForRevision, scopeObservedEntriesToAuthor } from '../lib/cross-model.mjs';

const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;

const KEY = 'vendor-family-provenance-test-key';

function withLedger(fn) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-vendor-family-'));
  try {
    const dir = join(root, '.adlc');
    mkdirSync(dir, { recursive: true });
    return fn(dir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('normalizeProvider collapses claude/anthropic, codex/gpt/openai, and gemini/agy/google families and blocks intra-family review', () => {
  for (const value of ['claude', 'Anthropic', ' claude-opus-4.1 ', 'claude.3']) assert.equal(normalizeProvider(value), 'anthropic', value);
  for (const value of ['codex', 'OpenAI', 'gpt-5', 'gpt', 'o3', 'o4-mini', 'o1.5', 'ｏｐｅｎａｉ']) assert.equal(normalizeProvider(value), 'openai', value);
  for (const value of ['gemini', 'agy', 'Antigravity', 'google', 'gemini-2.5-pro', 'gemini.3']) assert.equal(normalizeProvider(value), 'google', value);
  assert.equal(normalizeProvider('Mistral AI'), 'mistralai');
  assert.equal(normalizeProvider('gptx'), 'gptx');
  assert.equal(normalizeProvider(undefined), '');
  assert.equal(normalizeProvider(''), '');

  withLedger((dir) => {
    const record = (provider, authorProvider) => recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider, authorProvider, verdict: 'approve', dir, key: KEY });
    assert.throws(() => record('claude-3', 'anthropic'), /distinct from the author/);
    assert.throws(() => record('gpt-5', 'codex'), /distinct from the author/);
    assert.throws(() => record('gemini-2.5-pro', 'agy'), /distinct from the author/);
    assert.equal(record('codex', 'anthropic').data.provider, 'codex');
  });
});

test('hasCrossModelApproveForRevision anchors strictly to canonical vendor family and fails closed when authorProvider is empty', () => {
  withLedger((dir) => {
    recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider: 'gpt-5', authorProvider: 'claude', verdict: 'approve', dir, key: KEY });
    const gate = (authorProvider, observedEntries) => hasCrossModelApproveForRevision({ dir, revision: 'rev-1', authorProvider, key: KEY, observedEntries });

    // Empty / missing author fails closed so an unanchored attestation cannot self-approve.
    assert.equal(gate(''), false);
    assert.equal(gate(undefined), false);
    // Configured author: canonical family matching across aliases ('claude' === 'anthropic' === 'claude-opus-4').
    assert.equal(gate('anthropic'), true);
    assert.equal(gate('claude-opus-4'), true);
    assert.equal(gate('openai'), false, 'reviewer family equals the run author');
    assert.equal(gate('google'), false, 'attestation was recorded for a different author family');

    // Observed-attestation scoping uses canonical family normalization too.
    const foreign = {
      seq: 99, gate: 'cross-model-review', ticket: 'T1', ts: new Date().toISOString(), files: {}, prev: null,
      data: { revision: 'rev-1', provider: 'openai', authorProvider: 'agy', verdict: 'needs-attention' },
    };
    foreign.sig = signEntry(KEY, foreign);
    assert.equal(gate('anthropic', [foreign]), true, 'foreign-author entry is scoped out when the author is configured');
    assert.equal(scopeObservedEntriesToAuthor([foreign], 'gemini-2.5-pro').length, 1);
    assert.equal(scopeObservedEntriesToAuthor([foreign], '').length, 0);
  });
});

test('tier-check CLI fails closed on both omitted and empty --author-provider while honoring configured vendor-family aliases', () => {
  const repo = mkdtempSync(join(tmpdir(), 'adlc-tier-empty-author-'));
  try {
    const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    mkdirSync(join(repo, '.adlc'), { recursive: true });
    writeFileSync(join(repo, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id: 'T1', title: 't', scope: ['packages/prosecute/**'], rails: [], edges: [] }] }));
    g('add', '-A');
    g('commit', '-qm', 'base');
    g('checkout', '-q', '-b', 'feat');
    mkdirSync(join(repo, 'packages', 'prosecute', 'lib'), { recursive: true });
    writeFileSync(join(repo, 'packages', 'prosecute', 'lib', 'x.mjs'), 'export const x = 1;\n');
    g('add', '-A');
    g('commit', '-qm', 'change');

    const childEnv = { ...process.env, ADLC_MANIFEST_KEY: KEY, ADLC_AUTHOR_PROVIDER: '' };
    const omitted = spawnSync(process.execPath, [BIN, 'tier-check', '--base', 'main', '--dir', '.adlc'], { cwd: repo, env: childEnv, encoding: 'utf8' });
    assert.equal(omitted.status, 1);

    const emptyFlag = spawnSync(process.execPath, [BIN, 'tier-check', '--base', 'main', '--author-provider', '', '--dir', '.adlc'], { cwd: repo, env: childEnv, encoding: 'utf8' });
    assert.equal(emptyFlag.status, 1);

    const revJson = spawnSync(process.execPath, [BIN, 'tier-check', '--base', 'main', '--author-provider', 'google', '--dir', '.adlc', '--json'], { cwd: repo, env: childEnv, encoding: 'utf8' });
    assert.equal(revJson.status, 2);
    const rev = JSON.parse(revJson.stdout).revision;

    const rec = spawnSync(process.execPath, [BIN, 'record-cross-model', '--ticket', 'T1', '--provider', 'codex', '--author-provider', 'agy', '--verdict', 'approve', '--revision', rev, '--dir', '.adlc'], { cwd: repo, env: childEnv, encoding: 'utf8' });
    assert.equal(rec.status, 0, rec.stderr);

    const ok = spawnSync(process.execPath, [BIN, 'tier-check', '--base', 'main', '--author-provider', 'gemini-2.5-pro', '--dir', '.adlc'], { cwd: repo, env: childEnv, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

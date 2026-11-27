// Concern: provider distinctness is decided per vendor FAMILY, not per raw string, and an
// empty or omitted run author fails closed rather than accepting unanchored attestations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signEntry } from '@adlc/gate-manifest/lib/sign.mjs';
import { record as recordManifest } from '@adlc/gate-manifest/lib/record.mjs';
import {
  normalizeProvider,
  recordCrossModelReview,
  hasCrossModelApprove,
  hasCrossModelApproveForRevision,
  scopeObservedEntriesToAuthor,
  CROSS_MODEL_GATE,
} from '../lib/cross-model.mjs';

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

test('normalizeProvider resolves vendor families and agy:<model>, refuses bare agy, and blocks intra-family review', () => {
  for (const value of ['claude', 'Anthropic', ' claude-opus-4.1 ', 'claude.3', 'agy:Claude Sonnet 4.6 (Thinking)', 'antigravity:Claude Opus 4.6 (Thinking)']) {
    assert.equal(normalizeProvider(value), 'anthropic', value);
  }
  for (const value of ['codex', 'OpenAI', 'gpt-5', 'gpt', 'o3', 'o4-mini', 'o1.5', 'ｏｐｅｎａｉ', 'antigravity:gpt-5.1', 'agy:o3-mini']) {
    assert.equal(normalizeProvider(value), 'openai', value);
  }
  for (const value of ['gemini', 'google', 'gemini-2.5-pro', 'gemini.3', 'agy:Gemini 2.5 Pro', 'agy:Gemini 3.5 Flash (Medium)', 'antigravity:gemma-3-27b']) {
    assert.equal(normalizeProvider(value), 'google', value);
  }
  assert.equal(normalizeProvider('agy', { model: 'Claude Opus 4.6 (Thinking)' }), 'anthropic');
  assert.equal(normalizeProvider('agy', { model: 'Gemini 3.5 Flash (Medium)' }), 'google');
  assert.equal(normalizeProvider('antigravity', { model: 'gpt-5.1' }), 'openai');
  // Bare or unknown-model agy/antigravity fails closed to ''.
  for (const value of ['agy', 'AGY', 'antigravity', 'Antigravity', 'agy:', 'antigravity:', 'agy:unknown-model']) {
    assert.equal(normalizeProvider(value), '', value);
  }
  assert.equal(normalizeProvider('agy', { model: 'unknown-model' }), '');
  assert.equal(normalizeProvider('Mistral AI'), 'mistralai');
  assert.equal(normalizeProvider('gptx'), 'gptx');
  assert.equal(normalizeProvider(undefined), '');
  assert.equal(normalizeProvider(''), '');

  withLedger((dir) => {
    const record = (provider, authorProvider) => recordCrossModelReview({ ticket: 'T1', revision: 'rev-1', provider, authorProvider, verdict: 'approve', dir, key: KEY });
    assert.throws(() => record('claude-3', 'anthropic'), /distinct from the author/);
    assert.throws(() => record('gpt-5', 'codex'), /distinct from the author/);
    assert.throws(() => record('gemini-2.5-pro', 'agy:Gemini 2.5 Pro'), /distinct from the author/);
    assert.throws(() => record('agy:Claude Opus 4.6 (Thinking)', 'anthropic'), /distinct from the author/);
    assert.throws(() => record('agy:Claude Sonnet 4.6', 'anthropic'), /distinct from the author/);
    assert.throws(() => record('agy', 'anthropic'), /ambiguous|agy:<model>/);
    assert.throws(() => record('antigravity', 'anthropic'), /ambiguous|agy:<model>/);
    assert.throws(() => record('codex', 'agy'), /ambiguous|agy:<model>/);
    assert.equal(record('codex', 'anthropic').data.provider, 'codex');
    assert.equal(record('agy:Gemini 2.5 Pro', 'anthropic').data.provider, 'agy:Gemini 2.5 Pro');
  });
});

test('bare agy approve fails closed while historical bare agy/antigravity needs-attention revokes approvals', () => {
  withLedger((dir) => {
    // A validly-signed historical approve with bare provider:'agy' must NOT satisfy the gate.
    recordManifest({
      gate: CROSS_MODEL_GATE,
      ticket: 'T1',
      rawData: JSON.stringify({ provider: 'agy', authorProvider: 'anthropic', verdict: 'approve', revision: 'rev-bare-approve' }),
      dir,
      key: KEY,
    });
    assert.equal(hasCrossModelApprove({ dir, ticket: 'T1', revision: 'rev-bare-approve', authorProvider: 'anthropic', key: KEY }), false);
    assert.equal(hasCrossModelApproveForRevision({ dir, revision: 'rev-bare-approve', authorProvider: 'anthropic', key: KEY }), false);

    // A genuine distinct-provider approve is revoked by a historical bare 'agy' needs-attention.
    recordCrossModelReview({ ticket: 'T1', revision: 'rev-agy-revoke', provider: 'agy:Gemini 2.5 Pro', authorProvider: 'anthropic', verdict: 'approve', dir, key: KEY });
    assert.equal(hasCrossModelApprove({ dir, ticket: 'T1', revision: 'rev-agy-revoke', authorProvider: 'anthropic', key: KEY }), true);
    recordManifest({
      gate: CROSS_MODEL_GATE,
      ticket: 'T1',
      rawData: JSON.stringify({ provider: 'agy', authorProvider: 'anthropic', verdict: 'needs-attention', revision: 'rev-agy-revoke' }),
      dir,
      key: KEY,
    });
    assert.equal(hasCrossModelApprove({ dir, ticket: 'T1', revision: 'rev-agy-revoke', authorProvider: 'anthropic', key: KEY }), false);
    assert.equal(hasCrossModelApproveForRevision({ dir, revision: 'rev-agy-revoke', authorProvider: 'anthropic', key: KEY }), false);

    // Same for bare 'antigravity' revoking an openai approve on the same revision.
    recordCrossModelReview({ ticket: 'T2', revision: 'rev-ag-revoke', provider: 'openai', authorProvider: 'anthropic', verdict: 'approve', dir, key: KEY });
    assert.equal(hasCrossModelApproveForRevision({ dir, revision: 'rev-ag-revoke', authorProvider: 'anthropic', key: KEY }), true);
    recordManifest({
      gate: CROSS_MODEL_GATE,
      ticket: 'T2',
      rawData: JSON.stringify({ provider: 'Antigravity', authorProvider: 'anthropic', verdict: 'needs-attention', revision: 'rev-ag-revoke' }),
      dir,
      key: KEY,
    });
    assert.equal(hasCrossModelApprove({ dir, ticket: 'T2', revision: 'rev-ag-revoke', authorProvider: 'anthropic', key: KEY }), false);
    assert.equal(hasCrossModelApproveForRevision({ dir, revision: 'rev-ag-revoke', authorProvider: 'anthropic', key: KEY }), false);
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
    assert.equal(gate('agy:Claude Sonnet 4.6 (Thinking)'), true);
    assert.equal(gate('openai'), false, 'reviewer family equals the run author');
    assert.equal(gate('google'), false, 'attestation was recorded for a different author family');

    // Observed-attestation scoping uses canonical family normalization too.
    const foreign = {
      seq: 99, gate: 'cross-model-review', ticket: 'T1', ts: new Date().toISOString(), files: {}, prev: null,
      data: { revision: 'rev-1', provider: 'openai', authorProvider: 'agy:Gemini 2.5 Pro', verdict: 'needs-attention' },
    };
    foreign.sig = signEntry(KEY, foreign);
    assert.equal(gate('anthropic', [foreign]), true, 'foreign-author entry is scoped out when the author is configured');
    assert.equal(scopeObservedEntriesToAuthor([foreign], 'gemini-2.5-pro').length, 1);
    assert.equal(scopeObservedEntriesToAuthor([foreign], '').length, 0);
    assert.equal(scopeObservedEntriesToAuthor([foreign], 'agy').length, 0);
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

    const bareRec = spawnSync(process.execPath, [BIN, 'record-cross-model', '--ticket', 'T1', '--provider', 'agy', '--author-provider', 'anthropic', '--verdict', 'approve', '--revision', rev, '--dir', '.adlc'], { cwd: repo, env: childEnv, encoding: 'utf8' });
    assert.notEqual(bareRec.status, 0, 'bare agy provider must fail closed');

    const rec = spawnSync(process.execPath, [BIN, 'record-cross-model', '--ticket', 'T1', '--provider', 'codex', '--author-provider', 'agy:Gemini 2.5 Pro', '--verdict', 'approve', '--revision', rev, '--dir', '.adlc'], { cwd: repo, env: childEnv, encoding: 'utf8' });
    assert.equal(rec.status, 0, rec.stderr);

    const ok = spawnSync(process.execPath, [BIN, 'tier-check', '--base', 'main', '--author-provider', 'gemini-2.5-pro', '--dir', '.adlc'], { cwd: repo, env: childEnv, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

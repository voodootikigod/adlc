// build-gate.test.mjs — T49. Drift test: the hook's inline KEEP-IN-SYNC
// copies of packages/build-gate's risk-tier and depth-signal logic must
// produce IDENTICAL output to the real package across shared fixtures — the
// same precedent as packages/core/test/shell.test.mjs for the rails-guard
// shell classifier copy. Plus coverage for the allow/deny decision itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeRiskTier as hookComputeRiskTier,
  deriveRiskSignals as hookDeriveRiskSignals,
  countToolCalls as hookCountToolCalls,
  computeDepthSignal as hookComputeDepthSignal,
  isDegraded as hookIsDegraded,
  globMatch as hookGlobMatch,
  decide,
  recordBuildGateBypass,
} from '../adlc-build-gate.mjs';

import { computeRiskTier as coreComputeRiskTier, deriveRiskSignals as coreDeriveRiskSignals } from '../../../../packages/build-gate/lib/risk.mjs';
import { countToolCalls as coreCountToolCalls, computeDepthSignal as coreComputeDepthSignal, isDegraded as coreIsDegraded } from '../../../../packages/build-gate/lib/depth-signal.mjs';
import { globMatch as coreGlobMatch } from '../../../../packages/core/lib/tickets.mjs';

// A naive "replace ** then replace *" globMatch implementation does NOT
// correctly handle a leading `**/` (fails to match a root-level path) --
// caught during T50 by comparing this hook's copy against the canonical
// implementation with these exact fixtures. Pinned here so it can't regress.
const GLOB_FIXTURES = [
  ['**/.env', '.env'],
  ['**/.env', 'src/.env'],
  ['**/auth/**', 'auth/login.mjs'],
  ['**/*guard*', 'guard.mjs'],
  ['.adlc/tickets/**', '.adlc/tickets/t1.json'],
  ['src/**', 'src/a/b.mjs'],
];

test('drift: globMatch is identical to @adlc/core (packages/core/lib/tickets.mjs), including leading **/ patterns', () => {
  for (const [pattern, path] of GLOB_FIXTURES) {
    assert.equal(hookGlobMatch(pattern, path), coreGlobMatch(pattern, path), `globMatch drift for ${pattern} ~ ${path}`);
  }
});

const TICKET_FIXTURES = [
  { id: 'T1', title: 'plain', category: 'feature' },
  { id: 'T2', title: 'declared high', risk: 'high' },
  { id: 'T3', title: 'declared normal cannot downgrade', risk: 'normal', category: 'contract' },
  { id: 'T4', title: 'external effect', external: true },
  { id: 'T5', title: 'mutates identity', mutatesIdentity: true },
  { id: 'T6', title: 'malformed scope', scope: 'not-an-array' },
  { id: 'T7', title: 'touches manifest', scope: ['.adlc/manifest.jsonl'] },
  { id: 'T8', title: 'touches trust root', rails: ['.adlc/tickets.json'] },
  { id: 'T9', title: 'architecture category', category: 'architecture' },
  { id: 'T10', title: 'unrelated scope glob', scope: ['src/**'] },
];

test('drift: risk-tier computation is identical to packages/build-gate/lib/risk.mjs', () => {
  for (const ticket of TICKET_FIXTURES) {
    assert.deepEqual(hookDeriveRiskSignals(ticket), coreDeriveRiskSignals(ticket), `deriveRiskSignals drift for ${ticket.id}`);
    assert.deepEqual(hookComputeRiskTier(ticket), coreComputeRiskTier(ticket), `computeRiskTier drift for ${ticket.id}`);
  }
});

const TEXT_FIXTURES = [
  '',
  'plain prose with no tool markers',
  Array.from({ length: 45 }, () => '"type": "tool_use"').join('\n'),
  Array.from({ length: 10 }, (_, i) => `Writing file-${i}.mjs`).join('\n'),
  'Editing a.mjs\nCreated b.mjs\n"type":"tool_use"\n',
];

test('drift: depth-signal computation is identical to packages/build-gate/lib/depth-signal.mjs', () => {
  for (const text of TEXT_FIXTURES) {
    assert.equal(hookCountToolCalls(text), coreCountToolCalls(text));
    assert.deepEqual(hookComputeDepthSignal({ text }), coreComputeDepthSignal({ text }));
  }
  for (const depth of [0, 40, 41, 100]) {
    for (const sessionBytes of [0, 256 * 1024, 256 * 1024 + 1, 1024 * 1024]) {
      assert.equal(hookIsDegraded({ depth, sessionBytes }), coreIsDegraded({ depth, sessionBytes }), `isDegraded drift for depth=${depth} bytes=${sessionBytes}`);
    }
  }
});

function withTempTranscript(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-build-gate-'));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, content);
  try {
    return fn(path, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('decide: normal-risk ticket is always allowed, no transcript needed', () => {
  const result = decide({ ticket: { id: 'T1', category: 'feature' }, transcriptPath: null, bypassRequested: false });
  assert.equal(result.decision, 'allow');
});

test('decide: high-risk ticket in a shallow session is allowed', () => {
  withTempTranscript('a couple of tool calls\n"type":"tool_use"\n', (path) => {
    const result = decide({ ticket: { id: 'T2', risk: 'high' }, transcriptPath: path, bypassRequested: false });
    assert.equal(result.decision, 'allow');
  });
});

test('decide: high-risk ticket in a degraded (deep) session is denied', () => {
  const deep = Array.from({ length: 50 }, () => '"type": "tool_use"').join('\n');
  withTempTranscript(deep, (path) => {
    const result = decide({ ticket: { id: 'T2', risk: 'high' }, transcriptPath: path, bypassRequested: false });
    assert.equal(result.decision, 'deny');
    assert.match(result.reason, /ADLC_BUILD_GATE_BYPASS/);
  });
});

test('decide: high-risk + degraded + bypass requested returns pending-bypass, not a silent allow', () => {
  const deep = Array.from({ length: 50 }, () => '"type": "tool_use"').join('\n');
  withTempTranscript(deep, (path) => {
    const result = decide({ ticket: { id: 'T2', risk: 'high' }, transcriptPath: path, bypassRequested: true });
    assert.equal(result.decision, 'pending-bypass');
    assert.equal(typeof result.depth, 'number');
  });
});

test('decide: high-risk ticket with missing transcript_path fails closed (deny), never treated as shallow', () => {
  const result = decide({ ticket: { id: 'T2', risk: 'high' }, transcriptPath: null, bypassRequested: false });
  assert.equal(result.decision, 'deny');
  assert.match(result.reason, /transcript_path/);
});

test('decide: high-risk ticket with unreadable transcript_path fails closed (deny)', () => {
  const result = decide({ ticket: { id: 'T2', risk: 'high' }, transcriptPath: '/nonexistent/path/does-not-exist.jsonl', bypassRequested: false });
  assert.equal(result.decision, 'deny');
});

test('recordBuildGateBypass writes a real build-gate-bypass entry to the gate-manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-build-gate-manifest-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    const ok = recordBuildGateBypass('T2', ['declared-risk-high'], 55, 300000, { cwd: dir });
    assert.equal(ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordBuildGateBypass returns false (never throws) when the adlc CLI cannot write', () => {
  // A cwd with no writable .adlc parent (a file where a directory is expected)
  // simulates an unrecordable override — must report false, not throw.
  const dir = mkdtempSync(join(tmpdir(), 'adlc-build-gate-fail-'));
  try {
    writeFileSync(join(dir, '.adlc'), 'not a directory'); // .adlc is a FILE, not writable as a dir
    const ok = recordBuildGateBypass('T2', ['declared-risk-high'], 55, 300000, { cwd: dir });
    assert.equal(ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

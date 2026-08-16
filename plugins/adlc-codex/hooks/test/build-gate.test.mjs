// build-gate.test.mjs — T49. Drift test: the hook's inline KEEP-IN-SYNC
// copies of packages/build-gate's risk-tier and depth-signal logic must
// produce IDENTICAL output to the real package across shared fixtures — the
// same precedent as packages/core/test/shell.test.mjs for the rails-guard
// shell classifier copy. Plus coverage for the allow/deny decision itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'adlc-build-gate.mjs');

// recordBuildGateBypass spawnSync's `adlc` from ambient PATH, and this test file
// calls it IN-PROCESS — so the resolved binary is whatever the test runner's PATH
// happens to hold. Resolve the workspace-local CLI deterministically instead
// (same WITH_ADLC convention as the claude-code sibling): the mutation-gate CI
// job runs these tests WITHOUT run-tests.mjs's node_modules/.bin PATH prepend
// and has no global adlc, while a dev machine may have a stale global one —
// either way, ambient PATH is the wrong resolver for a hermetic test (#378).
const REPO_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'node_modules', '.bin');
const NODE_DIR = dirname(process.execPath);

function withAdlcOnPath(fn) {
  const prev = process.env.PATH;
  process.env.PATH = `${REPO_BIN}:${NODE_DIR}:${prev ?? ''}`;
  try { return fn(); } finally { process.env.PATH = prev; }
}

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
  // isDegraded's COMPARISON LOGIC (inclusive >= against whichever thresholds
  // are resolved) must stay identical between the hook's copy and the
  // canonical — proven here with an EXPLICIT, shared threshold on both
  // sides. This deliberately does NOT compare the two DEFAULTS against each
  // other: since Round-5 (context-rot-threshold-calibration), the hook's own
  // DEFAULT_BYTES_THRESHOLD is intentionally recalibrated to 8 MiB while the
  // canonical package's default stays at the old 256 KiB (its own test file
  // is a rail frozen by ticket T156, not completed — and unlike a plain
  // constant rename, that frozen test directly asserts the OLD numeric
  // behavior, so recalibrating the library would break it; there is no
  // override mechanism for a rail-edit violation) — see
  // plugins/adlc-codex/hooks/adlc-build-gate.mjs's DEFAULT_BYTES_THRESHOLD
  // comment for the full rationale. Asserting default equality here would
  // pin exactly the divergence this fix intentionally introduces.
  for (const depth of [0, 40, 41, 100]) {
    for (const sessionBytes of [0, 256 * 1024, 256 * 1024 + 1, 1024 * 1024]) {
      assert.equal(
        hookIsDegraded({ depth, sessionBytes, depthThreshold: 40, bytesThreshold: 256 * 1024 }),
        coreIsDegraded({ depth, sessionBytes, depthThreshold: 40, bytesThreshold: 256 * 1024 }),
        `isDegraded drift for depth=${depth} bytes=${sessionBytes}`,
      );
    }
  }
});

test('the hook build-gate DEFAULT_BYTES_THRESHOLD is deliberately recalibrated to 8 MiB, not the canonical package default (Round-5)', () => {
  assert.equal(hookIsDegraded({ depth: 0, sessionBytes: 8 * 1024 * 1024 }), true);
  assert.equal(hookIsDegraded({ depth: 0, sessionBytes: 8 * 1024 * 1024 - 1 }), false);
  // The exact reported bug: a routine fresh-session baseline (well over the
  // old 256 KiB threshold, comfortably under the new 8 MiB one) must NOT be
  // classified as degraded.
  assert.equal(hookIsDegraded({ depth: 0, sessionBytes: 400 * 1024 }), false);
});

test('MAX_SCAN_BYTES is exactly 8 MiB, matching DEFAULT_BYTES_THRESHOLD (Round-9)', () => {
  // MAX_SCAN_BYTES must be AT LEAST DEFAULT_BYTES_THRESHOLD (see its own
  // comment) — the Round-9 regression test above proves the window is wide
  // enough for one specific ~500 KiB fixture, but does not pin the constant's
  // actual value, so an off-by-one drift there is invisible to it. Pin the
  // exact value directly.
  const src = readFileSync(HOOK, 'utf8');
  const scan = src.match(/const MAX_SCAN_BYTES = ([^;]+);/);
  assert.ok(scan, 'scan-window constant present');
  const scanBytes = Function(`"use strict"; return (${scan[1]});`)();
  assert.equal(scanBytes, 8 * 1024 * 1024);
  assert.ok(scanBytes >= 8 * 1024 * 1024, 'scan window must be at least the byte threshold');
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

test('decide: deep tool-call history EARLY in a transcript, pushed out of the old 256 KiB window by later padding, is still denied (Round-9 regression)', () => {
  // Round-9 review: DEFAULT_BYTES_THRESHOLD was recalibrated to 8 MiB, but if
  // the depth-counting SCAN WINDOW had stayed at the old 256 KiB, a
  // transcript sized between 256 KiB and 8 MiB with its real tool-call depth
  // EARLY in the file (pushed out of a 256 KiB tail window by later
  // non-tool-call padding) would be undercounted to a false "shallow" depth,
  // AND no longer trip the (now much higher) byte threshold either — the two
  // signals would stop jointly covering that size range. This is the exact
  // scenario: 50 real tool calls, then ~500 KiB of padding, total ~500 KiB
  // (under the new 8 MiB byte threshold, over the OLD 256 KiB window).
  const deep = Array.from({ length: 50 }, () => '"type": "tool_use"').join('\n');
  const padding = 'x'.repeat(500 * 1024);
  withTempTranscript(`${deep}\n${padding}`, (path) => {
    const result = decide({ ticket: { id: 'T2', risk: 'high' }, transcriptPath: path, bypassRequested: false });
    assert.equal(result.decision, 'deny', `expected the early tool-call depth to still be counted; got: ${JSON.stringify(result)}`);
  });
});

test('recordBuildGateBypass writes a real build-gate-bypass entry to the gate-manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-build-gate-manifest-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    const ok = withAdlcOnPath(() => recordBuildGateBypass('T2', ['declared-risk-high'], 55, 300000, { cwd: dir }));
    assert.equal(ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordBuildGateBypass returns false (never throws) when the adlc CLI cannot write', () => {
  // A cwd with no writable .adlc parent (a file where a directory is expected)
  // simulates an unrecordable override — must report false, not throw. The PATH
  // shim matters here too: without a resolvable adlc this passes VACUOUSLY via
  // spawn-ENOENT instead of exercising the real cannot-write branch it names.
  const dir = mkdtempSync(join(tmpdir(), 'adlc-build-gate-fail-'));
  try {
    writeFileSync(join(dir, '.adlc'), 'not a directory'); // .adlc is a FILE, not writable as a dir
    const ok = withAdlcOnPath(() => recordBuildGateBypass('T2', ['declared-risk-high'], 55, 300000, { cwd: dir }));
    assert.equal(ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

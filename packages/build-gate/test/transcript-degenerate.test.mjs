// test/transcript-degenerate.test.mjs — issue #588: a `--transcript` that
// yields no recognizable tool calls is "could not measure", never a definitive
// allow for a high-risk ticket.
//
// Before this change an empty, truncated, compacted or unrecognized transcript
// produced depth 0, and the gate reported `degraded: false, decision: 'allow'`
// with the same reason text as a genuinely fresh session — a green from a
// measurement that measured nothing. The CLI now carries the rule the hook path
// already had (docs/specs/build-gate-fitness.md, Known limitations): an
// unverifiable session must not be allowed through for a high-risk ticket.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { classifyTranscriptSignal, computeDepthSignal } from '../lib/depth-signal.mjs';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(PKG_ROOT, 'bin', 'build-gate.mjs');

// Every fixture directory this file mints is registered here and removed by the
// after() hook (scripts/test/tmp-fixture-boundary.test.mjs requires it).
const FIXTURES = new Set();
after(() => {
  for (const dir of FIXTURES) rmSync(dir, { recursive: true, force: true });
  FIXTURES.clear();
});

function run(args, { cwd, env = {} } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function ticketRepo(tickets) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-build-gate-degenerate-'));
  FIXTURES.add(dir);
  mkdirSync(join(dir, '.adlc'));
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets }));
  return dir;
}

const HIGH = [{ id: 'T1', title: 'x', category: 'contract' }];
const NORMAL = [{ id: 'T1', title: 'x', category: 'feature' }];

function emptyTranscript(dir) {
  const path = join(dir, 'empty.jsonl');
  writeFileSync(path, '');
  return path;
}

/** ~1 MB of base64-looking text with no tool-call record and no prose tool line. */
function junkTranscript(dir) {
  const path = join(dir, 'junk.log');
  const chunk = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODk=';
  const lines = [];
  while (lines.join('\n').length < 1_048_576) lines.push(chunk.repeat(8));
  writeFileSync(path, lines.join('\n'));
  return path;
}

function measuredTranscript(dir, toolCalls) {
  const path = join(dir, 'measured.jsonl');
  const line = JSON.stringify({ type: 'tool_use', name: 'Read' });
  writeFileSync(path, Array.from({ length: toolCalls }, () => line).join('\n'));
  return path;
}

// ---- AC1: high-risk + degenerate transcript → exit 1, could-not-measure --------

test('AC1: high-risk ticket + empty --transcript → exit 1, could not derive a context signal', () => {
  const dir = ticketRepo(HIGH);
  const r = run(['T1', '--transcript', emptyTranscript(dir), '--json'], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /could not derive a context signal from .*empty\.jsonl/);
  assert.match(r.stderr, /no recognizable tool calls/);
  assert.match(r.stderr, /refusing to treat an unmeasured session as fresh/);
  assert.equal(r.stdout.trim(), '', 'an operational error prints no JSON decision');
});

test('AC1: high-risk ticket + 1 MB unrecognized-format --transcript → exit 1, same message', () => {
  const dir = ticketRepo(HIGH);
  const r = run(['T1', '--transcript', junkTranscript(dir)], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /could not derive a context signal/);
  assert.doesNotMatch(r.stdout, /allow/);
});

// ---- AC2: non-high-risk + degenerate transcript → allow, labelled -------------

test('AC2: normal ticket + empty --transcript --json → allow with signalSource transcript-empty', () => {
  const dir = ticketRepo(NORMAL);
  const r = run(['T1', '--transcript', emptyTranscript(dir), '--json'], { cwd: dir });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'allow');
  assert.equal(out.signalSource, 'transcript-empty');
  assert.match(out.reason, /no context signal could be derived from the transcript/);
  assert.match(out.reason, /not high-risk/);
  assert.equal(out.depth, 0);
});

test('AC2: the human one-liner carries the signal source', () => {
  const dir = ticketRepo(NORMAL);
  const r = run(['T1', '--transcript', emptyTranscript(dir)], { cwd: dir });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /build-gate: allow \(T1, risk=normal\) — no context signal could be derived from the transcript.*\[signal: transcript-empty\]/);
});

// ---- AC3: measured transcript and explicit flags behave exactly as today ------

test('AC3: high-risk ticket + transcript with real tool calls below threshold → allow, signalSource transcript', () => {
  const dir = ticketRepo(HIGH);
  const r = run(['T1', '--transcript', measuredTranscript(dir, 5), '--json'], { cwd: dir });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'allow');
  assert.equal(out.depth, 5);
  assert.equal(out.signalSource, 'transcript');
  assert.match(out.reason, /below threshold/);
});

test('AC3: high-risk ticket + transcript past threshold still denies (regression), signalSource transcript', () => {
  const dir = ticketRepo(HIGH);
  const r = run(['T1', '--transcript', measuredTranscript(dir, 100), '--json'], { cwd: dir });
  assert.equal(r.code, 2);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'deny');
  assert.equal(out.signalSource, 'transcript');
});

test('AC3: --depth alongside an empty transcript wins → signalSource flags, depth-driven deny', () => {
  const dir = ticketRepo(HIGH);
  const r = run(['T1', '--transcript', emptyTranscript(dir), '--depth', '999', '--json'], { cwd: dir });
  assert.equal(r.code, 2);
  const out = JSON.parse(r.stdout);
  assert.equal(out.signalSource, 'flags');
  assert.equal(out.depth, 999);
  assert.equal(out.decision, 'deny');
});

test('AC3: --session-bytes alongside an empty transcript also counts as flags', () => {
  const dir = ticketRepo(HIGH);
  const r = run(['T1', '--transcript', emptyTranscript(dir), '--session-bytes', '12', '--json'], { cwd: dir });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.signalSource, 'flags');
  assert.equal(out.sessionBytes, 12);
});

test('AC3: --depth with no transcript → signalSource flags (unchanged behaviour)', () => {
  const dir = ticketRepo(HIGH);
  const r = run(['T1', '--depth', '3', '--json'], { cwd: dir });
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).signalSource, 'flags');
});

// ---- AC4: classifyTranscriptSignal is a pure table ---------------------------

test('AC4: classifyTranscriptSignal — zero tool calls is degenerate regardless of bytes', () => {
  assert.equal(classifyTranscriptSignal({ depth: 0, bytes: 0 }), 'degenerate');
  assert.equal(classifyTranscriptSignal({ depth: 0, bytes: 900_000 }), 'degenerate');
  assert.equal(classifyTranscriptSignal({ depth: 1, bytes: 10 }), 'measured');
  assert.equal(classifyTranscriptSignal({ depth: 40, bytes: 0 }), 'measured');
});

test('AC4: classifyTranscriptSignal agrees with computeDepthSignal on real text', () => {
  assert.equal(classifyTranscriptSignal(computeDepthSignal({ text: '' })), 'degenerate');
  assert.equal(classifyTranscriptSignal(computeDepthSignal({ text: 'x'.repeat(5000) })), 'degenerate');
  assert.equal(classifyTranscriptSignal(computeDepthSignal({ text: '{"type":"tool_use"}' })), 'measured');
});

test('AC4: classifyTranscriptSignal is pure — same input, same output, input untouched', () => {
  const sig = Object.freeze({ depth: 0, bytes: 42 });
  const before = JSON.stringify(sig);
  assert.equal(classifyTranscriptSignal(sig), classifyTranscriptSignal(sig));
  assert.equal(JSON.stringify(sig), before);
  // A missing or non-numeric depth is not a measurement either.
  assert.equal(classifyTranscriptSignal({}), 'degenerate');
  assert.equal(classifyTranscriptSignal({ depth: Number.NaN }), 'degenerate');
});

// ---- AC5: no signal at all is still today's allow, labelled none -------------

test('AC5: no --transcript and no flags → allow, signalSource none', () => {
  const dir = ticketRepo(HIGH);
  const r = run(['T1', '--json'], { cwd: dir });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'allow');
  assert.equal(out.signalSource, 'none');
  assert.match(out.reason, /below threshold/);
});

// ---- regression: file-level errors keep their existing messages --------------

test('a missing --transcript path is still the existing operational error', () => {
  const dir = ticketRepo(HIGH);
  const r = run(['T1', '--transcript', join(dir, 'nope.jsonl')], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /transcript file not found/);
});

// ---- direction guard: the bypass env overrides a DENY, never an unmeasured session

test('ADLC_BUILD_GATE_BYPASS=1 does not rescue a high-risk ticket with a degenerate transcript (fails closed)', () => {
  const dir = ticketRepo(HIGH);
  const r = run(['T1', '--transcript', emptyTranscript(dir), '--json'], {
    cwd: dir,
    env: { ADLC_BUILD_GATE_BYPASS: '1', ADLC_MANIFEST_KEY: 'k'.repeat(64) },
  });
  assert.equal(r.code, 1, 'an operational error is not a deny, so there is nothing to override');
  assert.match(r.stderr, /could not derive a context signal/);
  assert.equal(r.stdout.trim(), '');
});

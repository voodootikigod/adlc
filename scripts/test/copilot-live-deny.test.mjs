// Unit coverage for scripts/copilot-live-deny.mjs — exercises the skip gate and
// the control/treatment/deny-tool proof logic against a MOCK `copilot` binary
// (no real model turns, no credits), mirroring the mock-harness approach in
// opencode-live-deny's tests. Without this, the mutation-gate's slow path would
// find surviving mutants in the live-deny harness (it is not otherwise run in CI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'copilot-live-deny.mjs');

// A fake `copilot` that reproduces the three verified behaviors the proof asserts:
//  --version                        → print a version
//  ... --deny-tool shell            → refuse the shell tool, write nothing
//  ... --allow-all-tools (control)  → perform the edit (rail → CHANGED)
//  ... --allow-tool ... (treatment) → hook blocks; no edit
function withFakeCopilot(fn) {
  const bin = mkdtempSync(join(tmpdir(), 'fake-copilot-bin-'));
  const fake = join(bin, 'copilot');
  writeFileSync(fake, [
    '#!/usr/bin/env bash',
    'if [[ "$*" == *"--version"* ]]; then echo "GitHub Copilot CLI 0.0.0-mock"; exit 0; fi',
    'if [[ "$*" == *"--deny-tool shell"* ]]; then',
    '  echo "Permission to run this tool was denied due to the following rules: shell"; exit 0',
    'fi',
    'if [[ "$*" == *"--allow-all-tools"* ]]; then printf "CHANGED" > protected/rail.txt; exit 0; fi',
    'echo "the edit was blocked"; exit 0',
    '',
  ].join('\n'));
  chmodSync(fake, 0o755);
  try { return fn(bin); } finally { rmSync(bin, { recursive: true, force: true }); }
}

test('skips (exit 3) when ADLC_COPILOT_LIVE_INSTALL is not set', () => {
  const { ADLC_COPILOT_LIVE_INSTALL: _e, ...env } = process.env;
  const r = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
  assert.equal(r.status, 3, r.stdout + r.stderr);
});

test('--require fails (exit 1) when no copilot binary resolves', () => {
  const { ADLC_COPILOT_LIVE_INSTALL: _e, ...base } = process.env;
  const bin = mkdtempSync(join(tmpdir(), 'empty-bin-'));
  try {
    // PATH with only node available, no `copilot` on it.
    const env = { ...base, ADLC_COPILOT_LIVE_INSTALL: '1', PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${dirname(process.execPath)}` };
    const r = spawnSync(process.execPath, [SCRIPT, '--require'], { env, encoding: 'utf8' });
    assert.equal(r.status, 1);
  } finally { rmSync(bin, { recursive: true, force: true }); }
});

test('PASS against a mock copilot: control edits, treatment blocks, deny-tool blocks shell', () => {
  withFakeCopilot((bin) => {
    const { ADLC_COPILOT_LIVE_INSTALL: _e, ...base } = process.env;
    const env = { ...base, ADLC_COPILOT_LIVE_INSTALL: '1', PATH: `${bin}:${process.env.PATH}` };
    const r = spawnSync(process.execPath, [SCRIPT, '--require'], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, `expected pass; got:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /control ok/);
    assert.match(r.stdout, /treatment ok/);
    assert.match(r.stdout, /deny-tool ok/);
  });
});

test('FAILS (exit 1) when the mock copilot does NOT block the rail (treatment regression)', () => {
  // A copilot that ALWAYS edits (even in treatment) must make the proof fail —
  // proving the treatment assertion is load-bearing, not hollow.
  const bin = mkdtempSync(join(tmpdir(), 'fake-copilot-bad-'));
  const fake = join(bin, 'copilot');
  writeFileSync(fake, [
    '#!/usr/bin/env bash',
    'if [[ "$*" == *"--version"* ]]; then echo mock; exit 0; fi',
    'if [[ "$*" == *"--deny-tool shell"* ]]; then echo "denied ... shell"; exit 0; fi',
    'printf "CHANGED" > protected/rail.txt; exit 0', // always edits, even in treatment
    '',
  ].join('\n'));
  chmodSync(fake, 0o755);
  try {
    const { ADLC_COPILOT_LIVE_INSTALL: _e, ...base } = process.env;
    const env = { ...base, ADLC_COPILOT_LIVE_INSTALL: '1', PATH: `${bin}:${process.env.PATH}` };
    const r = spawnSync(process.execPath, [SCRIPT, '--require'], { env, encoding: 'utf8' });
    assert.equal(r.status, 1);
  } finally { rmSync(bin, { recursive: true, force: true }); }
});

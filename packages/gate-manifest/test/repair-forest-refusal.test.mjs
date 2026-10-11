// Concern: repair-chain in a segmented (forest) repository — issue #651.
//
// The root ledger of a forest is frozen because every segment's first entry
// carries `anchor: { segment: 'root', seq, lineHash }` bound to root's exact raw
// bytes. `repairChain` renumbers and re-serialises every root entry, so running it
// there turns a one-line root break into a forest-wide anchor mismatch — and it
// used to report success. These tests pin the refusal, that it fires before any
// byte is touched, and that the non-segmented path is untouched.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import { ledgerPath, sha256 } from '@adlc/core';
import { repairChain, repairTarget } from '../lib/repair.mjs';
import { record } from '../lib/record.mjs';
import { verify } from '../lib/verify.mjs';

const REASON = 'fix the broken root chain';
const ULID = '0'.repeat(26);
const SEGMENT = `feat-x-${ULID}.jsonl`;

/** A root ledger whose second line's `prev` does not match line one's bytes. */
function writeBrokenRoot(dir) {
  mkdirSync(dir, { recursive: true });
  const first = JSON.stringify({ seq: 1, gate: 'p5-finding', ts: '2026-01-01T00:00:00.000Z', files: {}, prev: null });
  const second = JSON.stringify({ seq: 2, gate: 'p5-complete', ts: '2026-01-01T00:00:01.000Z', files: {}, prev: 'f'.repeat(64) });
  writeFileSync(ledgerPath('manifest', dir), `${first}\n${second}\n`);
}

function activateSegments(dir) {
  mkdirSync(join(dir, 'manifest.d'), { recursive: true });
  writeFileSync(join(dir, 'manifest.d', '.store.json'), JSON.stringify({ format: 'adlc-manifest-segments', version: 1 }));
}

/** Root (broken) plus one segment anchored to root seq 2: the issue's repro. */
function forestFixture(t) {
  const dir = tmp(t, 'gate-manifest-repair-forest-');
  writeBrokenRoot(dir);
  activateSegments(dir);
  const first = { seq: 1, anchor: { segment: 'root', seq: 2, lineHash: 'a'.repeat(64) }, branch: 'feat/x', gate: 'seg-a', ts: '2026-01-01T00:00:02.000Z', files: {}, prev: null };
  writeFileSync(join(dir, 'manifest.d', SEGMENT), `${JSON.stringify(first)}\n`);
  return dir;
}

const snapshot = (dir) => ({
  root: readFileSync(ledgerPath('manifest', dir), 'utf8'),
  files: readdirSync(dir).sort(),
  segments: existsSync(join(dir, 'manifest.d')) ? readdirSync(join(dir, 'manifest.d')).sort() : [],
});

describe('repairTarget: the decision is a pure read of the activation state', () => {
  it("answers 'forest-refused' for a directory carrying the activation marker", (t) => {
    const dir = tmp(t, 'gate-manifest-repair-target-');
    writeBrokenRoot(dir);
    activateSegments(dir);
    const before = snapshot(dir);
    assert.equal(repairTarget(dir), 'forest-refused');
    assert.deepEqual(snapshot(dir), before);
  });

  it("answers 'forest-refused' when the root ends in a manifest-cutover entry with no marker", (t) => {
    const dir = tmp(t, 'gate-manifest-repair-target-');
    mkdirSync(dir, { recursive: true });
    writeFileSync(ledgerPath('manifest', dir), `${JSON.stringify({ seq: 1, gate: 'manifest-cutover', ts: 'x', files: {}, prev: null })}\n`);
    assert.equal(repairTarget(dir), 'forest-refused');
  });

  it("answers 'root' for a never-segmented directory, creating nothing", (t) => {
    const dir = tmp(t, 'gate-manifest-repair-target-');
    writeBrokenRoot(dir);
    const before = snapshot(dir).files;
    assert.equal(repairTarget(dir), 'root');
    assert.deepEqual(readdirSync(dir).sort(), before);
  });
});

describe('repairChain refuses a forest before touching anything (#651)', () => {
  it('throws the refusal on --write, leaves root byte-identical, writes no backup and no repair record', (t) => {
    const dir = forestFixture(t);
    const before = snapshot(dir);
    assert.throws(
      () => repairChain({ dir, reason: REASON, write: true, key: null }),
      (err) => err instanceof Error
        && err.message.startsWith('repair-chain refuses to rewrite the frozen root of a segmented repository')
        && /anchors? to root/.test(err.message)
        && /migrate-branch/.test(err.message)
        && /adopt/.test(err.message),
    );
    const after = snapshot(dir);
    assert.equal(after.root, before.root, 'root bytes must be untouched');
    assert.deepEqual(after.files, before.files, 'no .pre-repair-*.bak may appear');
    assert.ok(!after.files.some((f) => f.includes('.pre-repair-')));
    assert.deepEqual(after.segments, before.segments);
    assert.ok(!after.root.includes('manifest-chain-repair'));
  });

  it('throws the same refusal for the dry-run plan', (t) => {
    const dir = forestFixture(t);
    const before = snapshot(dir);
    assert.throws(
      () => repairChain({ dir, reason: REASON, write: false, key: null }),
      /refuses to rewrite the frozen root of a segmented repository/,
    );
    assert.deepEqual(snapshot(dir), before);
  });

  it('refuses even when the reason is too short — the forest check comes first', (t) => {
    const dir = forestFixture(t);
    assert.throws(
      () => repairChain({ dir, reason: 'x', write: true, key: null }),
      /refuses to rewrite the frozen root of a segmented repository/,
    );
  });
});

describe('repair-chain through the bin', () => {
  const bin = new URL('../bin/gate-manifest.mjs', import.meta.url).pathname;
  const env = { ...process.env };
  delete env.ADLC_MANIFEST_KEY;

  it('exits 1 naming the refusal on a forest, and the forest is untouched', (t) => {
    const dir = forestFixture(t);
    const before = snapshot(dir);
    const run = spawnSync(process.execPath, [bin, 'repair-chain', '--dir', dir, '--reason', REASON, '--write'], { encoding: 'utf8', env });
    assert.equal(run.status, 1, `stdout=${run.stdout} stderr=${run.stderr}`);
    assert.match(run.stderr, /refuses to rewrite the frozen root/);
    assert.deepEqual(snapshot(dir), before);
  });

  it('still repairs a never-segmented broken ledger exactly as before', (t) => {
    const dir = tmp(t, 'gate-manifest-repair-root-');
    record({ gate: 'rails-bypass', dir, key: null });
    const path = ledgerPath('manifest', dir);
    appendFileSync(path, '{"type":"p5-complete","ticket":"T-1"}\n');
    assert.equal(verify(dir, { key: null }).valid, false);
    const original = readFileSync(path, 'utf8');

    const run = spawnSync(process.execPath, [bin, 'repair-chain', '--dir', dir, '--reason', REASON, '--write', '--json'], { encoding: 'utf8', env });
    assert.equal(run.status, 0, `stdout=${run.stdout} stderr=${run.stderr}`);
    const result = JSON.parse(run.stdout);
    assert.equal(result.ok, true);
    assert.equal(existsSync(result.backup), true);
    assert.equal(readFileSync(result.backup, 'utf8'), original);
    assert.equal(result.originalHash, sha256(original));
    assert.equal(verify(dir, { key: null }).valid, true);
  });
});

// Tests for spec-lint's evidence recording: lib/record.mjs (pure lib call)
// and the bin's --record/--ticket wiring (CLI contract).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordResult, GATE_NAME } from '../lib/record.mjs';
import { record as manifestRecord } from '@adlc/gate-manifest/lib/record.mjs';

const BIN = new URL('../bin/spec-lint.mjs', import.meta.url).pathname;
const NODE = process.execPath;

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'spec-lint-record-'));
}

const VERIFIED_SPEC = '# Spec\n\n## Acceptance Criteria\n- foo: `test -f foo`\n';
const WISH_SPEC = '# Spec\n\n## Acceptance Criteria\n- foo works correctly\n';

test('recordResult: writes a spec-lint entry bound to the ticket and spec file', () => {
  const dir = tmpDir();
  const adlc = join(dir, '.adlc');
  const specPath = join(dir, 'spec.md');
  writeFileSync(specPath, VERIFIED_SPEC);
  try {
    const entry = recordResult({ ticket: 'T1', specPath, dir: adlc, key: null });
    assert.equal(entry.gate, GATE_NAME);
    assert.equal(entry.ticket, 'T1');
    assert.equal(entry.data.verified, true, 'a genuinely passing run records verified:true, never false');
    assert.ok(entry.files[specPath], 'spec file is hashed into entry.files');
    const manifest = readFileSync(join(adlc, 'manifest.jsonl'), 'utf8');
    assert.match(manifest, /"gate":"spec-lint"/);
    assert.match(manifest, /"ticket":"T1"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: --record with --ticket writes a manifest entry on a passing run', () => {
  const dir = tmpDir();
  const specPath = join(dir, 'spec.md');
  writeFileSync(specPath, VERIFIED_SPEC);
  try {
    const r = spawnSync(NODE, [BIN, specPath, '--record', '--ticket', 'T1', '--dir', join(dir, '.adlc')], {
      encoding: 'utf8', cwd: dir,
    });
    assert.equal(r.status, 0, r.stderr);
    const manifest = readFileSync(join(dir, '.adlc', 'manifest.jsonl'), 'utf8');
    assert.match(manifest, /"gate":"spec-lint"/);
    assert.match(manifest, /"ticket":"T1"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: --record without --ticket exits 1 (fail closed, never an unbound record)', () => {
  const dir = tmpDir();
  const specPath = join(dir, 'spec.md');
  writeFileSync(specPath, VERIFIED_SPEC);
  try {
    const r = spawnSync(NODE, [BIN, specPath, '--record', '--dir', join(dir, '.adlc')], { encoding: 'utf8', cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--ticket/);
    assert.equal(existsSync(join(dir, '.adlc', 'manifest.jsonl')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: --record on a FAILING run (a wish present) does not write a manifest entry', () => {
  const dir = tmpDir();
  const specPath = join(dir, 'spec.md');
  writeFileSync(specPath, WISH_SPEC);
  try {
    const r = spawnSync(NODE, [BIN, specPath, '--record', '--ticket', 'T1', '--dir', join(dir, '.adlc')], {
      encoding: 'utf8', cwd: dir,
    });
    assert.equal(r.status, 2);
    assert.equal(existsSync(join(dir, '.adlc', 'manifest.jsonl')), false, 'a WISH must not be recorded as passing evidence');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recordResult: spec path containing commas is hashed whole and not split', () => {
  const dir = tmpDir();
  const adlc = join(dir, '.adlc');
  const specPath = join(dir, 'spec,v2.md');
  writeFileSync(specPath, VERIFIED_SPEC);
  try {
    const entry = recordResult({ ticket: 'T1', specPath, dir: adlc, key: null });
    assert.equal(entry.gate, GATE_NAME);
    assert.equal(entry.ticket, 'T1');
    assert.equal(typeof entry.files[specPath], 'string', 'spec file with comma must be hashed');
    assert.notEqual(entry.files[specPath], null);
    assert.equal(Object.keys(entry.files).length, 1, 'must have exactly one file entry, not comma-split fragments');
    assert.equal(entry.files['spec'], undefined);
    assert.equal(entry.files['v2.md'], undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: --record with comma-containing spec path writes single valid hash to manifest', () => {
  const dir = tmpDir();
  const specPath = join(dir, 'spec,v2.md');
  writeFileSync(specPath, VERIFIED_SPEC);
  try {
    const r = spawnSync(NODE, [BIN, specPath, '--record', '--ticket', 'T1', '--dir', join(dir, '.adlc')], {
      encoding: 'utf8', cwd: dir,
    });
    assert.equal(r.status, 0, r.stderr);
    const manifest = readFileSync(join(dir, '.adlc', 'manifest.jsonl'), 'utf8');
    const parsed = JSON.parse(manifest.trim());
    assert.equal(parsed.ticket, 'T1');
    assert.equal(typeof parsed.files[specPath], 'string');
    assert.equal(parsed.files['spec'], undefined);
    assert.equal(parsed.files['v2.md'], undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


// recordResult replaced gate-manifest's record() (whose rawFiles comma-split
// fragmented a spec path containing a comma, #775). Everything ELSE about the
// entry — field set, v1 signature format, file hashes, data — must be what
// record() would have written, or a spec-lint P1 record silently changes shape
// for every consumer that reads it.
test('recordResult: keyed entry has the same shape and signature version as gate-manifest record()', () => {
  const dir = tmpDir();
  const key = 'a1'.repeat(32);
  const specPath = join(dir, 'spec.md');
  writeFileSync(specPath, VERIFIED_SPEC);
  try {
    const ours = recordResult({ ticket: 'T1', specPath, dir: join(dir, 'ours'), key });
    const theirs = manifestRecord({
      gate: GATE_NAME, ticket: 'T1', rawData: JSON.stringify({ verified: true }), rawFiles: specPath,
      dir: join(dir, 'theirs'), key,
    });
    assert.deepEqual(Object.keys(ours).sort(), Object.keys(theirs).sort());
    assert.equal(ours.sigVersion, theirs.sigVersion, 'signature version must not drift from record()');
    assert.equal(typeof ours.sig, 'string');
    assert.deepEqual(ours.files, theirs.files);
    assert.deepEqual(ours.data, theirs.data);
    assert.equal(ours.gate, theirs.gate);
    assert.equal(ours.ticket, theirs.ticket);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

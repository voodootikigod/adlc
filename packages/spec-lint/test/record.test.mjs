// Tests for spec-lint's evidence recording: lib/record.mjs (pure lib call)
// and the bin's --record/--ticket wiring (CLI contract).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { recordResult, GATE_NAME } from '../lib/record.mjs';
import { record as manifestRecord } from '@adlc/gate-manifest/lib/record.mjs';
import { tmp } from '@adlc/core/test-kit';

const BIN = new URL('../bin/spec-lint.mjs', import.meta.url).pathname;
const NODE = process.execPath;

const VERIFIED_SPEC = '# Spec\n\n## Acceptance Criteria\n- foo: `test -f foo`\n';
const WISH_SPEC = '# Spec\n\n## Acceptance Criteria\n- foo works correctly\n';

test('recordResult: writes a spec-lint entry bound to the ticket and spec file', (t) => {
  const dir = tmp(t, 'spec-lint-record-');
  const adlc = join(dir, '.adlc');
  const specPath = join(dir, 'spec.md');
  writeFileSync(specPath, VERIFIED_SPEC);
  const entry = recordResult({ ticket: 'T1', specPath, dir: adlc, key: null });
  assert.equal(entry.gate, GATE_NAME);
  assert.equal(entry.ticket, 'T1');
  assert.equal(entry.data.verified, true, 'a genuinely passing run records verified:true, never false');
  assert.ok(entry.files[specPath], 'spec file is hashed into entry.files');
  const manifest = readFileSync(join(adlc, 'manifest.jsonl'), 'utf8');
  assert.match(manifest, /"gate":"spec-lint"/);
  assert.match(manifest, /"ticket":"T1"/);
});

test('CLI: --record with --ticket writes a manifest entry on a passing run', (t) => {
  const dir = tmp(t, 'spec-lint-record-');
  const specPath = join(dir, 'spec.md');
  writeFileSync(specPath, VERIFIED_SPEC);
  const r = spawnSync(NODE, [BIN, specPath, '--record', '--ticket', 'T1', '--dir', join(dir, '.adlc')], {
    encoding: 'utf8', cwd: dir,
  });
  assert.equal(r.status, 0, r.stderr);
  const manifest = readFileSync(join(dir, '.adlc', 'manifest.jsonl'), 'utf8');
  assert.match(manifest, /"gate":"spec-lint"/);
  assert.match(manifest, /"ticket":"T1"/);
});

test('CLI: --record without --ticket exits 1 (fail closed, never an unbound record)', (t) => {
  const dir = tmp(t, 'spec-lint-record-');
  const specPath = join(dir, 'spec.md');
  writeFileSync(specPath, VERIFIED_SPEC);
  const r = spawnSync(NODE, [BIN, specPath, '--record', '--dir', join(dir, '.adlc')], { encoding: 'utf8', cwd: dir });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--ticket/);
  assert.equal(existsSync(join(dir, '.adlc', 'manifest.jsonl')), false);
});

test('CLI: --record on a FAILING run (a wish present) does not write a manifest entry', (t) => {
  const dir = tmp(t, 'spec-lint-record-');
  const specPath = join(dir, 'spec.md');
  writeFileSync(specPath, WISH_SPEC);
  const r = spawnSync(NODE, [BIN, specPath, '--record', '--ticket', 'T1', '--dir', join(dir, '.adlc')], {
    encoding: 'utf8', cwd: dir,
  });
  assert.equal(r.status, 2);
  assert.equal(existsSync(join(dir, '.adlc', 'manifest.jsonl')), false, 'a WISH must not be recorded as passing evidence');
});

test('recordResult: spec path containing commas is hashed whole and not split', (t) => {
  const dir = tmp(t, 'spec-lint-record-');
  const adlc = join(dir, '.adlc');
  const specPath = join(dir, 'spec,v2.md');
  writeFileSync(specPath, VERIFIED_SPEC);
  const entry = recordResult({ ticket: 'T1', specPath, dir: adlc, key: null });
  assert.equal(entry.gate, GATE_NAME);
  assert.equal(entry.ticket, 'T1');
  assert.equal(typeof entry.files[specPath], 'string', 'spec file with comma must be hashed');
  assert.notEqual(entry.files[specPath], null);
  assert.equal(Object.keys(entry.files).length, 1, 'must have exactly one file entry, not comma-split fragments');
  assert.equal(entry.files['spec'], undefined);
  assert.equal(entry.files['v2.md'], undefined);
});

test('CLI: --record with comma-containing spec path writes single valid hash to manifest', (t) => {
  const dir = tmp(t, 'spec-lint-record-');
  const specPath = join(dir, 'spec,v2.md');
  writeFileSync(specPath, VERIFIED_SPEC);
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
});


// recordResult replaced gate-manifest's record() (whose rawFiles comma-split
// fragmented a spec path containing a comma, #775). Everything ELSE about the
// entry — field set, v1 signature format, file hashes, data — must be what
// record() would have written, or a spec-lint P1 record silently changes shape
// for every consumer that reads it.
test('recordResult: keyed entry has the same shape and signature version as gate-manifest record()', (t) => {
  const dir = tmp(t, 'spec-lint-record-');
  const key = 'a1'.repeat(32);
  const specPath = join(dir, 'spec.md');
  writeFileSync(specPath, VERIFIED_SPEC);
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
});

// continue-exclusivity.test.mjs — one successor id, one authorization.
//
// The denier's lock cannot serialize this: two continuations of DIFFERENT
// denies hold different locks, so an exists-then-write pair leaves a window in
// which both see a free id and the later write replaces the earlier grant. The
// create itself has to be the claim (O_EXCL).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeResumeAuth, readResumeAuth } from '../lib/resume-auth.mjs';
import { writeTextExclusive } from '../lib/atomic-json.mjs';
import { resumeAuthPath } from '../lib/paths.mjs';
import { BIN, KEYED, TEST_KEY, denyPathFor, readJson, seedBoundDeny } from './continue-cli-support.mjs';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-excl-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('writeTextExclusive creates once and refuses thereafter', () => {
  withTempDir((dir) => {
    const path = join(dir, 'nested', 'claim.txt');
    assert.deepEqual(writeTextExclusive(path, 'first\n'), { ok: true, bytes: 'first\n' });
    const second = writeTextExclusive(path, 'second\n');
    assert.equal(second.ok, false);
    assert.equal(second.exists, true);
    assert.equal(readFileSync(path, 'utf8'), 'first\n', 'the first writer keeps the file');
  });
});

test('the exclusively-created auth is written in the ledger artifact format', () => {
  withTempDir((root) => {
    // The exclusive path builds its own body rather than going through
    // writeJsonAtomic, so its serialization is a second place the artifact
    // format can drift — and every other test parses it back, which cannot see
    // that happen.
    const got = writeResumeAuth(
      root,
      'successor',
      { ticketId: 'T155', contentHash: 'a'.repeat(64), denySessionId: 'denier-a' },
      { key: TEST_KEY, exclusive: true },
    );
    assert.equal(got.ok, true);
    const raw = readFileSync(resumeAuthPath(root, 'successor'), 'utf8');
    assert.equal(raw, `${JSON.stringify(got.doc, null, 2)}\n`);
    assert.ok(raw.startsWith('{\n  "schema"'), 'two-space indented');
    assert.ok(raw.endsWith('}\n'), 'newline terminated');
  });
});

test('an exclusive resume-auth cannot be minted twice for one successor', () => {
  withTempDir((root) => {
    const fields = { ticketId: 'T155', contentHash: 'a'.repeat(64), denySessionId: 'denier-a' };
    const first = writeResumeAuth(root, 'successor', fields, { key: TEST_KEY, exclusive: true });
    assert.equal(first.ok, true);
    assert.equal(first.created, true);
    assert.equal(first.resumeAuth.verified, true);

    // A second continuation, of a DIFFERENT deny, naming the same successor.
    const second = writeResumeAuth(
      root,
      'successor',
      { ...fields, denySessionId: 'denier-b' },
      { key: TEST_KEY, exclusive: true },
    );
    assert.equal(second.ok, false);
    assert.equal(second.exists, true);

    // The first grant is intact and still names its own deny.
    const held = readResumeAuth(root, 'successor', { key: TEST_KEY });
    assert.equal(held.verified, true);
    assert.equal(held.deny_session_id, 'denier-a');
  });
});

test('a non-exclusive write still replaces, so the flag is what protects', () => {
  withTempDir((root) => {
    const fields = { ticketId: 'T155', contentHash: 'a'.repeat(64), denySessionId: 'denier-a' };
    writeResumeAuth(root, 'successor', fields, { key: TEST_KEY, exclusive: true });
    const replaced = writeResumeAuth(
      root,
      'successor',
      { ...fields, denySessionId: 'denier-b' },
      { key: TEST_KEY },
    );
    assert.equal(replaced.ok, true, 'the legacy path is unchanged for resume');
    assert.equal(readResumeAuth(root, 'successor', { key: TEST_KEY }).deny_session_id, 'denier-b');
  });
});

test('a corrupt file at the successor path still blocks the claim', () => {
  withTempDir((root) => {
    // Not a valid auth, but it OWNS the id: minting over it would destroy
    // whatever produced it and hand the id to a second run.
    mkdirSync(join(root, '.adlc', 'handoffs'), { recursive: true });
    writeFileSync(resumeAuthPath(root, 'successor'), 'not json', 'utf8');
    const got = writeResumeAuth(
      root,
      'successor',
      { ticketId: 'T155', contentHash: 'a'.repeat(64), denySessionId: 'denier-a' },
      { key: TEST_KEY, exclusive: true },
    );
    assert.equal(got.ok, false);
    assert.equal(got.exists, true);
    assert.equal(readFileSync(resumeAuthPath(root, 'successor'), 'utf8'), 'not json');
  });
});

test('two continuations racing for one successor: exactly one wins', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'handoff-excl-race-'));
  try {
    // Two DIFFERENT denies — so the denier lock cannot serialize them — both
    // continuing into the same successor id.
    seedBoundDeny(cwd, 'denier-one', 'T155');
    seedBoundDeny(cwd, 'denier-two', 'T155');

    const start = (deny) =>
      new Promise((resolve) => {
        execFile(
          process.execPath,
          [BIN, 'continue', '--deny-session', deny, '--session', 'shared-successor', '--write', '--json'],
          { cwd, env: { ...process.env, ...KEYED } },
          (err) => resolve(err ? (err.code ?? 1) : 0),
        );
      });

    const codes = await Promise.all([start('denier-one'), start('denier-two')]);
    assert.equal(
      codes.filter((c) => c === 0).length,
      1,
      `exactly one continuation may claim the successor, got ${JSON.stringify(codes)}`,
    );
    assert.ok(codes.includes(2), 'the loser degrades rather than failing obscurely');

    // One authorization exists, it verifies, and it names the deny that won.
    const auths = readdirSync(join(cwd, '.adlc', 'handoffs')).filter((n) => n.endsWith('.resume-auth.json'));
    assert.deepEqual(auths, ['shared-successor.resume-auth.json']);
    const held = readResumeAuth(cwd, 'shared-successor', { key: TEST_KEY });
    assert.equal(held.verified, true);
    assert.equal(readJson(denyPathFor(cwd, held.deny_session_id)).status, 'consumed');

    // …and the deny that lost is untouched: still open, nothing consumed.
    const loser = held.deny_session_id === 'denier-one' ? 'denier-two' : 'denier-one';
    assert.equal(readJson(denyPathFor(cwd, loser)).status, 'open');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

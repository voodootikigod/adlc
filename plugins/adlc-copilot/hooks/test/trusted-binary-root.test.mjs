// A `sudo npm i -g @adlc/cli` install is root-owned. The copilot hook trusts it on
// the same terms as the codex and Claude Code hooks; the three inlined copies must
// agree on every case, since none of them can import another.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import * as copilot from '../adlc-build-gate.mjs';
import * as codex from '../../../adlc-codex/hooks/adlc-handoff-gate.mjs';
import * as claudeCode from '../../../adlc-claude-code/hooks/adlc-hook.mjs';

const { candidateRejection, candidateStats, ownershipRejection, resolveTrustedBinary } = copilot;

const ROOT_FILE = { uid: 0, mode: 0o100755 };
const ROOT_LINK = { uid: 0, mode: 0o120777 };
const ROOT_DIR = { uid: 0, mode: 0o40755 };
const SELF = 1000;

// [label, stats, expected: null or a pattern the rejection must match]
const CASES = [
  ['locked root install', { file: ROOT_FILE, link: ROOT_LINK, dir: ROOT_DIR, ancestors: [ROOT_DIR] }, null],
  ['root file placed directly', { file: ROOT_FILE, link: ROOT_FILE, dir: ROOT_DIR }, null],
  ['own file', { file: { uid: SELF, mode: 0o100777 }, link: { uid: SELF, mode: 0o100777 }, dir: { uid: SELF, mode: 0o40777 } }, null],
  ['group-writable root file', { file: { uid: 0, mode: 0o100775 }, link: ROOT_LINK, dir: ROOT_DIR }, /writable by group or others/],
  ['other-writable root file', { file: { uid: 0, mode: 0o100757 }, link: ROOT_LINK, dir: ROOT_DIR }, /writable by group or others/],
  ['planted link', { file: ROOT_FILE, link: { uid: SELF, mode: 0o120777 }, dir: ROOT_DIR }, /link that root does not own/],
  ['writable hard entry', { file: ROOT_FILE, link: { uid: 0, mode: 0o100775 }, dir: ROOT_DIR }, /link that root does not own/],
  ['sticky world dir', { file: ROOT_FILE, link: ROOT_LINK, dir: { uid: 0, mode: 0o41777 } }, /its directory/],
  ['user-owned dir', { file: ROOT_FILE, link: ROOT_LINK, dir: { uid: SELF, mode: 0o40755 } }, /its directory/],
  ['foreign ancestor', { file: ROOT_FILE, link: ROOT_LINK, dir: ROOT_DIR, ancestors: [ROOT_DIR, { uid: 1001, mode: 0o40755 }] }, /directory above it/],
  ['writable ancestor', { file: ROOT_FILE, link: ROOT_LINK, dir: ROOT_DIR, ancestors: [{ uid: 0, mode: 0o40775 }] }, /directory above it/],
  ['foreign non-root file', { file: { uid: 1001, mode: 0o100755 }, link: ROOT_LINK, dir: ROOT_DIR }, /uid 1001/],
];

for (const [label, stats, expected] of CASES) {
  test(`copilot ownershipRejection: ${label}`, () => {
    const got = ownershipRejection(stats, SELF);
    if (expected === null) assert.equal(got, null);
    else assert.match(got, expected);
  });
}

test('the copilot, codex and Claude Code copies give the same answer on every case', () => {
  for (const [label, stats] of CASES) {
    const want = claudeCode.ownershipRejection(stats, SELF);
    assert.equal(copilot.ownershipRejection(stats, SELF), want, `copilot differs on ${label}`);
    assert.equal(codex.ownershipRejection(stats, SELF), want, `codex differs on ${label}`);
  }
  for (const dir of ['/repo/node_modules/.bin', 'bin', '/usr/local/bin']) {
    for (const stats of [null, { file: ROOT_FILE, link: ROOT_LINK, dir: ROOT_DIR }]) {
      const want = claudeCode.candidateRejection(dir, stats, SELF);
      assert.equal(copilot.candidateRejection(dir, stats, SELF), want, `copilot candidateRejection differs on ${dir}`);
      assert.equal(codex.candidateRejection(dir, stats, SELF), want, `codex candidateRejection differs on ${dir}`);
    }
  }
  assert.deepEqual(copilot.ancestorDirs('/a/b/c'), claudeCode.ancestorDirs('/a/b/c'));
});

test('node_modules and relative PATH entries are refused before ownership is judged', () => {
  assert.match(candidateRejection('/repo/node_modules/.bin', { file: ROOT_FILE, link: ROOT_LINK, dir: ROOT_DIR }, SELF), /node_modules/);
  assert.match(candidateRejection('bin', null, SELF), /relative PATH entry/);
  assert.match(candidateRejection('/usr/local/bin', null, SELF), /could not be inspected/);
  assert.equal(candidateRejection('/usr/local/bin', { file: { uid: 7, mode: 0o100777 } }, null), null);
});

test('the resolver still returns the user\'s own install, and skips node_modules and relative entries', (t) => {
  const own = tmp(t, 'adlc-copilot-own-');
  writeFileSync(join(own, 'adlc'), '#!/bin/sh\n');
  chmodSync(join(own, 'adlc'), 0o755);
  assert.equal(resolveTrustedBinary('adlc', own), join(own, 'adlc'));
  const nm = join(tmp(t, 'adlc-copilot-nm-'), 'node_modules', '.bin');
  mkdirSync(nm, { recursive: true });
  writeFileSync(join(nm, 'adlc'), '#!/bin/sh\n');
  assert.equal(resolveTrustedBinary('adlc', `${nm}:${own}`), join(own, 'adlc'));
  assert.equal(resolveTrustedBinary('adlc', `.:${own}`), join(own, 'adlc'));
  assert.equal(resolveTrustedBinary('adlc', ''), null);
});

const AS_ROOT = process.getuid?.() === 0 && 'running as root';

function rootShLink() {
  if (AS_ROOT) return AS_ROOT;
  try {
    const st = lstatSync('/usr/bin/sh');
    return st.isSymbolicLink() && st.uid === 0 && statSync('/usr/bin/sh').uid === 0 ? false : 'no root-owned /usr/bin/sh symlink';
  } catch {
    return 'no /usr/bin/sh';
  }
}

test('a root-owned system symlink, the shape sudo npm -g creates, resolves', { skip: rootShLink() }, () => {
  assert.equal(resolveTrustedBinary('sh', '/usr/bin'), '/usr/bin/sh');
});

test('a symlink the user owns, pointing at a root-owned shell, is not trusted', { skip: AS_ROOT }, (t) => {
  const dir = tmp(t, 'adlc-copilot-shlink-');
  symlinkSync('/bin/sh', join(dir, 'adlc'));
  assert.equal(resolveTrustedBinary('adlc', dir), null);
});

test('ancestors are gathered only for a root-owned file this user does not own', (t) => {
  const dir = tmp(t, 'adlc-anc-only-');
  const file = join(dir, 'adlc');
  writeFileSync(file, '');
  const own = statSync(file);
  assert.equal(candidateStats(file, dir, 'adlc', own, own.uid).ancestors, undefined, 'own file');
  assert.equal(candidateStats(file, dir, 'adlc', { ...own, uid: 0 }, 0).ancestors, undefined, 'root\'s own file');
  assert.equal(candidateStats(file, dir, 'adlc', { ...own, uid: 1001 }, own.uid).ancestors, undefined, 'foreign non-root file');
  assert.ok(candidateStats(file, dir, 'adlc', { ...own, uid: 0 }, own.uid).ancestors.length >= 2, 'root file seen by another user');
});

test('a PATH that is not a string resolves nothing', () => {
  assert.equal(resolveTrustedBinary('adlc', undefined), null);
  assert.equal(resolveTrustedBinary('adlc', 42), null);
});

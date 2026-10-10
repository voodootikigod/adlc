// A `sudo npm i -g @adlc/cli` install is root-owned. The codex hooks trust it on
// the same terms as the Claude Code hook: root owns the file, the PATH entry, its
// directory and every directory above, and none of them is group/other-writable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import { ancestorDirs, candidateRejection, candidateStats, ownershipRejection, resolveTrustedBinary } from '../adlc-handoff-gate.mjs';

const ROOT_FILE = { uid: 0, mode: 0o100755 };
const ROOT_LINK = { uid: 0, mode: 0o120777 };
const ROOT_DIR = { uid: 0, mode: 0o40755 };
const SELF = 1000;

test('a locked root-owned install is trusted', () => {
  assert.equal(ownershipRejection({ file: ROOT_FILE, link: ROOT_LINK, dir: ROOT_DIR, ancestors: [ROOT_DIR] }, SELF), null);
  assert.equal(ownershipRejection({ file: ROOT_FILE, link: ROOT_FILE, dir: ROOT_DIR }, SELF), null);
});

test('a root-owned file group or others can write is refused', () => {
  assert.match(ownershipRejection({ file: { uid: 0, mode: 0o100775 }, link: ROOT_LINK, dir: ROOT_DIR }, SELF), /writable by group or others/);
  assert.match(ownershipRejection({ file: { uid: 0, mode: 0o100757 }, link: ROOT_LINK, dir: ROOT_DIR }, SELF), /writable by group or others/);
});

test('a root-owned file through a link, directory or ancestor root does not lock is refused', () => {
  assert.match(ownershipRejection({ file: ROOT_FILE, link: { uid: SELF, mode: 0o120777 }, dir: ROOT_DIR }, SELF), /link that root does not own/);
  assert.match(ownershipRejection({ file: ROOT_FILE, link: { uid: 0, mode: 0o100775 }, dir: ROOT_DIR }, SELF), /link that root does not own/);
  assert.match(ownershipRejection({ file: ROOT_FILE, link: ROOT_LINK, dir: { uid: 0, mode: 0o41777 } }, SELF), /its directory/);
  assert.match(ownershipRejection({ file: ROOT_FILE, link: ROOT_LINK, dir: ROOT_DIR, ancestors: [ROOT_DIR, { uid: 1001, mode: 0o40755 }] }, SELF), /directory above it/);
});

test('a file owned by another non-root account is refused; the user\'s own is trusted', () => {
  assert.match(ownershipRejection({ file: { uid: 1001, mode: 0o100755 }, link: ROOT_LINK, dir: ROOT_DIR }, SELF), /uid 1001/);
  assert.equal(ownershipRejection({ file: { uid: SELF, mode: 0o100777 }, link: { uid: SELF, mode: 0o100777 }, dir: { uid: SELF, mode: 0o40777 } }, SELF), null);
});

test('node_modules and relative PATH entries are refused before ownership is judged', () => {
  assert.match(candidateRejection('/repo/node_modules/.bin', { file: ROOT_FILE, link: ROOT_LINK, dir: ROOT_DIR }, SELF), /node_modules/);
  assert.match(candidateRejection('bin', { file: ROOT_FILE, link: ROOT_LINK, dir: ROOT_DIR }, SELF), /relative PATH entry/);
  assert.match(candidateRejection('/usr/local/bin', null, SELF), /could not be inspected/);
  assert.equal(candidateRejection('/usr/local/bin', { file: ROOT_FILE, link: ROOT_LINK, dir: ROOT_DIR }, null), null);
});

test('ancestorDirs walks up to the filesystem root', () => {
  assert.deepEqual(ancestorDirs('/usr/local/bin/adlc'), ['/usr/local/bin', '/usr/local', '/usr', '/']);
});

function ownAdlc(t) {
  const dir = tmp(t, 'adlc-codex-own-');
  writeFileSync(join(dir, 'adlc'), '#!/bin/sh\n');
  chmodSync(join(dir, 'adlc'), 0o755);
  return dir;
}

test('the resolver still returns the user\'s own install, and skips node_modules and relative entries', (t) => {
  const own = ownAdlc(t);
  assert.equal(resolveTrustedBinary('adlc', own), join(own, 'adlc'));
  const nm = join(tmp(t, 'adlc-codex-nm-'), 'node_modules', '.bin');
  mkdirSync(nm, { recursive: true });
  writeFileSync(join(nm, 'adlc'), '#!/bin/sh\n');
  assert.equal(resolveTrustedBinary('adlc', `${nm}:${own}`), join(own, 'adlc'));
  assert.equal(resolveTrustedBinary('adlc', `.:${own}`), join(own, 'adlc'));
  assert.equal(resolveTrustedBinary('adlc', ''), null);
  assert.equal(resolveTrustedBinary('adlc', undefined), null);
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
const NO_ROOT_SH = rootShLink();

test('a root-owned system symlink, the shape sudo npm -g creates, resolves', { skip: NO_ROOT_SH }, () => {
  assert.equal(resolveTrustedBinary('sh', '/usr/bin'), '/usr/bin/sh');
  const stats = candidateStats('/usr/bin/sh', '/usr/bin', 'sh', statSync('/usr/bin/sh'), SELF);
  assert.ok(stats.ancestors.length >= 2);
});

test('a symlink the user owns, pointing at a root-owned shell, is not trusted', { skip: AS_ROOT }, (t) => {
  const dir = tmp(t, 'adlc-codex-shlink-');
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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ancestorDirs,
  binaryCandidates,
  candidateAncestors,
  candidateRejection,
  candidateStats,
  ownershipRejection,
  resolveTrustedBinary,
  untrustedBinaryReason,
} from '../index.mjs';

describe('ownershipRejection', () => {
  const lockedDir = { uid: 0, mode: 0o040755 };
  const lockedFile = { uid: 0, mode: 0o100755 };
  const rootSymlink = { uid: 0, mode: 0o120777 };

  it('accepts a file owned by selfUid regardless of mode or ancestors', () => {
    assert.equal(
      ownershipRejection(
        {
          file: { uid: 1000, mode: 0o100777 },
          link: { uid: 1000, mode: 0o100777 },
          dir: { uid: 1000, mode: 0o040777 },
        },
        1000,
      ),
      null,
    );
  });

  it('rejects a file owned by neither selfUid nor root (including uid 1)', () => {
    assert.equal(
      ownershipRejection(
        {
          file: { uid: 1, mode: 0o100755 },
          link: lockedFile,
          dir: lockedDir,
        },
        1000,
      ),
      'it is owned by uid 1, not by you or by root',
    );
    assert.equal(
      ownershipRejection(
        {
          file: { uid: 2000, mode: 0o100755 },
          link: lockedFile,
          dir: lockedDir,
        },
        1000,
      ),
      'it is owned by uid 2000, not by you or by root',
    );
  });

  it('accepts a root-owned non-writable file reached via a root-owned symlink or hardlink in locked directories', () => {
    assert.equal(
      ownershipRejection(
        {
          file: lockedFile,
          link: rootSymlink,
          dir: lockedDir,
          ancestors: [lockedDir],
        },
        1000,
      ),
      null,
    );
    assert.equal(
      ownershipRejection(
        {
          file: lockedFile,
          link: lockedFile,
          dir: lockedDir,
          ancestors: [lockedDir],
        },
        1000,
      ),
      null,
    );
  });

  it('rejects a root-owned file that is group- or world-writable', () => {
    assert.equal(
      ownershipRejection(
        {
          file: { uid: 0, mode: 0o100775 },
          link: rootSymlink,
          dir: lockedDir,
          ancestors: [lockedDir],
        },
        1000,
      ),
      'it is root-owned but writable by group or others',
    );
    assert.equal(
      ownershipRejection(
        {
          file: { uid: 0, mode: 0o100757 },
          link: rootSymlink,
          dir: lockedDir,
          ancestors: [lockedDir],
        },
        1000,
      ),
      'it is root-owned but writable by group or others',
    );
  });

  it('rejects a root-owned file reached through a non-root link or a writable non-symlink link', () => {
    assert.equal(
      ownershipRejection(
        {
          file: lockedFile,
          link: { uid: 1, mode: 0o120777 },
          dir: lockedDir,
          ancestors: [lockedDir],
        },
        1000,
      ),
      'it is reached through a link that root does not own',
    );
    assert.equal(
      ownershipRejection(
        {
          file: lockedFile,
          link: { uid: 0, mode: 0o100775 },
          dir: lockedDir,
          ancestors: [lockedDir],
        },
        1000,
      ),
      'it is reached through a link that root does not own',
    );
  });

  it('rejects when the containing directory or any ancestor is not root-owned or is writable by group/others', () => {
    assert.equal(
      ownershipRejection(
        {
          file: lockedFile,
          link: rootSymlink,
          dir: { uid: 1, mode: 0o040755 },
          ancestors: [lockedDir],
        },
        1000,
      ),
      'its directory is not root-owned or is writable by group or others',
    );
    assert.equal(
      ownershipRejection(
        {
          file: lockedFile,
          link: rootSymlink,
          dir: { uid: 0, mode: 0o040775 },
          ancestors: [lockedDir],
        },
        1000,
      ),
      'its directory is not root-owned or is writable by group or others',
    );
    assert.equal(
      ownershipRejection(
        {
          file: lockedFile,
          link: rootSymlink,
          dir: lockedDir,
          ancestors: [lockedDir, { uid: 1, mode: 0o040755 }],
        },
        1000,
      ),
      'a directory above it is not root-owned or is writable by group or others',
    );
    assert.equal(
      ownershipRejection(
        {
          file: lockedFile,
          link: rootSymlink,
          dir: lockedDir,
          ancestors: [lockedDir, { uid: 0, mode: 0o040777 }],
        },
        1000,
      ),
      'a directory above it is not root-owned or is writable by group or others',
    );
  });
});

describe('ancestorDirs and candidateAncestors', () => {
  it('lists every ancestor directory from nearest parent up to the filesystem root', () => {
    assert.deepEqual(ancestorDirs('/a/b/c/file'), ['/a/b/c', '/a/b', '/a', '/']);
  });

  it('combines realpath ancestors of the candidate file and its PATH directory', (t) => {
    const tmp = mkdtempSync(join(tmpdir(), 'adlc-trusted-ancestors-'));
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const realDir = join(tmp, 'real', 'bin');
    const linkDir = join(tmp, 'linked', 'bin');
    mkdirSync(realDir, { recursive: true });
    mkdirSync(linkDir, { recursive: true });
    const target = join(realDir, 'adlc');
    const candidate = join(linkDir, 'adlc');
    writeFileSync(target, '#!/bin/sh\n');
    symlinkSync(target, candidate);

    const ancestors = candidateAncestors(candidate, linkDir, 'adlc');
    assert.ok(Array.isArray(ancestors));
    assert.ok(ancestors.includes(realDir));
    assert.ok(ancestors.includes(linkDir));
    assert.equal(ancestors.at(-1), '/');
  });
});

describe('candidateStats and candidateRejection', () => {
  it('populates ancestors only when file.uid === 0 and selfUid !== 0', (t) => {
    const tmp = mkdtempSync(join(tmpdir(), 'adlc-trusted-stats-'));
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const bin = join(tmp, 'adlc');
    writeFileSync(bin, '#!/bin/sh\n');

    const rootFile = { uid: 0, mode: 0o100755 };
    const nonRootStats = candidateStats(bin, tmp, 'adlc', rootFile, 1000);
    assert.equal(nonRootStats.file, rootFile);
    assert.ok(Array.isArray(nonRootStats.ancestors));
    assert.ok(nonRootStats.ancestors.length > 0);

    const rootSelfStats = candidateStats(bin, tmp, 'adlc', rootFile, 0);
    assert.equal(rootSelfStats.ancestors, undefined);

    const userFile = { uid: 1000, mode: 0o100755 };
    const userStats = candidateStats(bin, tmp, 'adlc', userFile, 2000);
    assert.equal(userStats.ancestors, undefined);
  });

  it('orders location checks before stat and ownership checks', () => {
    assert.equal(
      candidateRejection('relative/bin', null, 1000),
      'it is reached through a relative PATH entry, which resolves inside the repository',
    );
    assert.equal(
      candidateRejection('/repo/node_modules/.bin', null, 1000),
      'it is inside node_modules, where a repository could have placed it',
    );
    assert.equal(
      candidateRejection('/usr/local/bin', null, 1000),
      'its link or a directory above it could not be inspected',
    );
    const validStats = {
      file: { uid: 1000, mode: 0o100755 },
      link: { uid: 1000, mode: 0o100755 },
      dir: { uid: 1000, mode: 0o040755 },
    };
    assert.equal(candidateRejection('/usr/local/bin', validStats, 1000), null);
    assert.equal(
      candidateRejection('/usr/local/bin', validStats, 2000),
      'it is owned by uid 1000, not by you or by root',
    );
    assert.equal(candidateRejection('/usr/local/bin', validStats, null), null);
  });
});

describe('binaryCandidates, resolveTrustedBinary, and untrustedBinaryReason', () => {
  it('returns empty candidates and null reason for non-string or empty pathEnv, including 1-char relative PATH', (t) => {
    assert.deepEqual(binaryCandidates('adlc', ''), []);
    assert.deepEqual(binaryCandidates('adlc', undefined), []);
    assert.equal(resolveTrustedBinary('adlc', ''), null);
    assert.equal(untrustedBinaryReason('adlc', ''), null);

    const tmp = mkdtempSync(join(tmpdir(), 'adlc-trusted-dotpath-'));
    const prevCwd = process.cwd();
    t.after(() => {
      process.chdir(prevCwd);
      rmSync(tmp, { recursive: true, force: true });
    });
    writeFileSync(join(tmp, 'adlc'), '#!/bin/sh\n');
    process.chdir(tmp);

    const dotCandidates = binaryCandidates('adlc', '.');
    assert.equal(dotCandidates.length, 1);
    assert.equal(
      dotCandidates[0].rejection,
      'it is reached through a relative PATH entry, which resolves inside the repository',
    );
    assert.equal(resolveTrustedBinary('adlc', '.'), null);
    assert.match(
      untrustedBinaryReason('adlc', '.'),
      /"adlc" was not run because it is reached through a relative PATH entry/,
    );
  });

  it('skips missing entries, directories, relative paths, and node_modules, resolving the first trusted binary', (t) => {
    const tmp = mkdtempSync(join(tmpdir(), 'adlc-trusted-resolve-'));
    t.after(() => rmSync(tmp, { recursive: true, force: true }));

    const nmBin = join(tmp, 'node_modules', '.bin');
    const dirCollision = join(tmp, 'dir-entry');
    const trustedDir = join(tmp, 'trusted');
    mkdirSync(nmBin, { recursive: true });
    mkdirSync(join(dirCollision, 'adlc'), { recursive: true });
    mkdirSync(trustedDir, { recursive: true });

    const nmCandidate = join(nmBin, 'adlc');
    const trustedCandidate = join(trustedDir, 'adlc');
    writeFileSync(nmCandidate, '#!/bin/sh\n');
    writeFileSync(trustedCandidate, '#!/bin/sh\n');
    chmodSync(nmCandidate, 0o755);
    chmodSync(trustedCandidate, 0o755);

    const pathEnv = ['', join(tmp, 'missing'), dirCollision, nmBin, trustedDir].join(':');
    const candidates = binaryCandidates('adlc', pathEnv);
    assert.deepEqual(candidates, [
      {
        candidate: nmCandidate,
        rejection: 'it is inside node_modules, where a repository could have placed it',
      },
      {
        candidate: trustedCandidate,
        rejection: null,
      },
    ]);
    assert.equal(resolveTrustedBinary('adlc', pathEnv), trustedCandidate);
    assert.equal(untrustedBinaryReason('adlc', pathEnv), null);
  });

  it('explains the first refused candidate when all candidates on PATH are rejected', (t) => {
    const tmp = mkdtempSync(join(tmpdir(), 'adlc-trusted-refused-'));
    t.after(() => rmSync(tmp, { recursive: true, force: true }));

    const nmBin = join(tmp, 'node_modules', '.bin');
    const nmBin2 = join(tmp, 'other', 'node_modules', '.bin');
    mkdirSync(nmBin, { recursive: true });
    mkdirSync(nmBin2, { recursive: true });
    const first = join(nmBin, 'adlc');
    const second = join(nmBin2, 'adlc');
    writeFileSync(first, '#!/bin/sh\n');
    writeFileSync(second, '#!/bin/sh\n');

    const singleReason = untrustedBinaryReason('adlc', nmBin);
    assert.equal(
      singleReason,
      `${JSON.stringify(first)} was not run because it is inside node_modules, where a repository could have placed it. Install @adlc/cli globally (npm i -g @adlc/cli) as yourself or as root.`,
    );

    const multiReason = untrustedBinaryReason('adlc', `${nmBin}:${nmBin2}`);
    assert.equal(multiReason, singleReason);
  });

  it('uses process.getuid when present and tolerates environments without process.getuid', (t) => {
    const tmp = mkdtempSync(join(tmpdir(), 'adlc-trusted-uid-'));
    const origGetuid = process.getuid;
    t.after(() => {
      process.getuid = origGetuid;
      rmSync(tmp, { recursive: true, force: true });
    });

    const bin = join(tmp, 'adlc');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o777);

    process.getuid = () => 999999;
    assert.equal(resolveTrustedBinary('adlc', tmp), null);
    assert.match(untrustedBinaryReason('adlc', tmp), /not by you or by root|writable by group or others/);

    process.getuid = undefined;
    assert.equal(resolveTrustedBinary('adlc', tmp), bin);
  });
});

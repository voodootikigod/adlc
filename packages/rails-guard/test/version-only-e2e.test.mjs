// #228 end-to-end: drive the real rails-guard binary over a real git repo.
//
// The unit tests prove the predicate; this proves the whole gate — git plumbing,
// the resolver, exit codes — behaves on the exact scenario from the issue:
// a live ticket rails packages/<x>/**, and a release bumps that package.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'rails-guard.mjs');

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'rg-228-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'test@test.invalid');
  run('config', 'user.name', 'Test');
  run('config', 'commit.gpgsign', 'false');
  run('config', 'tag.gpgsign', 'false');
  mkdirSync(join(dir, 'packages', 'build-gate', 'lib'), { recursive: true });
  writeFileSync(
    join(dir, 'packages', 'build-gate', 'package.json'),
    JSON.stringify({ name: '@adlc/build-gate', version: '1.5.0', main: 'lib/tier.mjs',
      dependencies: { '@adlc/core': '^1.5.0' } }, null, 2) + '\n'
  );
  writeFileSync(join(dir, 'packages', 'build-gate', 'lib', 'tier.mjs'), 'export const tier = 1;\n');
  run('add', '-A');
  run('commit', '-q', '-m', 'base');
  const baseSha = run('rev-parse', 'HEAD').trim();
  return { dir, run, baseSha };
}

function guard(dir, baseSha, rails) {
  return spawnSync(process.execPath, [BIN, '--base', baseSha, '--rails', rails], {
    cwd: dir, encoding: 'utf8',
  });
}

const RAIL = 'packages/build-gate/**';

test('a lockstep version bump under a live rail PASSES (the #228 regression)', () => {
  const { dir, baseSha } = makeRepo();
  try {
    writeFileSync(
      join(dir, 'packages', 'build-gate', 'package.json'),
      JSON.stringify({ name: '@adlc/build-gate', version: '1.5.1', main: 'lib/tier.mjs',
        dependencies: { '@adlc/core': '^1.5.1' } }, null, 2) + '\n'
    );
    const res = guard(dir, baseSha, RAIL);
    assert.equal(res.status, 0, `expected pass, got ${res.status}: ${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a behaviour edit under the SAME rail still FAILS (the guard is not weakened)', () => {
  const { dir, baseSha } = makeRepo();
  try {
    writeFileSync(join(dir, 'packages', 'build-gate', 'lib', 'tier.mjs'), 'export const tier = 99;\n');
    const res = guard(dir, baseSha, RAIL);
    assert.equal(res.status, 2, `expected deny, got ${res.status}: ${res.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a version bump SMUGGLING a manifest behaviour change still FAILS', () => {
  const { dir, baseSha } = makeRepo();
  try {
    writeFileSync(
      join(dir, 'packages', 'build-gate', 'package.json'),
      JSON.stringify({ name: '@adlc/build-gate', version: '1.5.1', main: 'lib/tier.mjs',
        dependencies: { '@adlc/core': '^1.5.1' },
        scripts: { postinstall: 'echo pwned' } }, null, 2) + '\n'
    );
    const res = guard(dir, baseSha, RAIL);
    assert.equal(res.status, 2, `expected deny, got ${res.status}: ${res.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a bump COMMITTED (not just working-tree) under a live rail also passes', () => {
  const { dir, run, baseSha } = makeRepo();
  try {
    writeFileSync(
      join(dir, 'packages', 'build-gate', 'package.json'),
      JSON.stringify({ name: '@adlc/build-gate', version: '1.5.1', main: 'lib/tier.mjs',
        dependencies: { '@adlc/core': '^1.5.1' } }, null, 2) + '\n'
    );
    run('add', '-A');
    run('commit', '-q', '-m', 'chore: bump to 1.5.1');
    const res = guard(dir, baseSha, RAIL);
    assert.equal(res.status, 0, `expected pass, got ${res.status}: ${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting a railed manifest during a bump still FAILS', () => {
  const { dir, baseSha } = makeRepo();
  try {
    rmSync(join(dir, 'packages', 'build-gate', 'package.json'));
    const res = guard(dir, baseSha, RAIL);
    assert.equal(res.status, 2, `expected deny, got ${res.status}: ${res.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// P5 prosecution regression: readFileSync follows symlinks while `git show`
// returns the blob, so a manifest replaced by a symlink to identical text
// compared equal and was exempted — while git recorded a typechange. The link
// target then lives outside the rail and can be swapped freely afterwards.
test('replacing a railed manifest with a symlink still FAILS', { skip: process.platform === 'win32' }, () => {
  // THE BASELINE MODE IS THE POINT. A symlink reports its executable bits set,
  // so against an ordinary 0644 baseline the executable-bit parity check rejects
  // this incidentally and the regular-file guard is never exercised — the test
  // passed while pinning nothing.
  //
  // Committing the baseline as 100755 makes parity HOLD for a symlink, so only
  // `lstatSync(file).isFile()` can deny. The symlink target is canonical bumped
  // JSON so every content check would otherwise pass too.
  const { dir, run } = makeRepo();
  try {
    const manifest = join(dir, 'packages', 'build-gate', 'package.json');
    run('update-index', '--chmod=+x', 'packages/build-gate/package.json');
    run('commit', '-q', '-m', 'executable baseline');
    const newBase = run('rev-parse', 'HEAD').trim();
    const bumped = JSON.stringify({ name: '@adlc/build-gate', version: '1.5.1', main: 'lib/tier.mjs',
      dependencies: { '@adlc/core': '^1.5.1' } }, null, 2) + '\n';
    // The link must RESOLVE to canonical bumped JSON. A dangling link would make
    // the read throw, and the test would pass on that instead of on the guard.
    writeFileSync(join(dir, 'packages', 'build-gate', 'target.json'), bumped);
    rmSync(manifest);
    symlinkSync('target.json', manifest);
    const res = guard(dir, newBase, RAIL);
    assert.equal(res.status, 2, `expected deny, got ${res.status}: ${res.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Cross-model round-4 regression, reproduced against the real binary. UTF-8
// decoding is not injective, so a baseline holding raw byte 0x80 and a working
// tree holding raw 0x81 both decoded to U+FFFD and compared equal — a genuine
// byte-level difference, exempted. Must be caught at the byte boundary.
test('a manifest differing only in INVALID UTF-8 bytes still FAILS', () => {
  const { dir, run, baseSha } = makeRepo();
  try {
    const manifest = join(dir, 'packages', 'build-gate', 'package.json');
    const body = (v, byte) => Buffer.concat([
      Buffer.from(`{\n  "version": "${v}",\n  "description": "`, 'utf8'),
      Buffer.from([byte]),
      Buffer.from('"\n}\n', 'utf8'),
    ]);
    writeFileSync(manifest, body('1.5.0', 0x80));
    run('add', '-A');
    run('commit', '-q', '-m', 'invalid utf8 baseline');
    const newBase = run('rev-parse', 'HEAD').trim();
    writeFileSync(manifest, body('1.5.1', 0x81)); // different byte, same decode
    const res = guard(dir, newBase, RAIL);
    assert.equal(res.status, 2, `expected deny, got ${res.status}: ${res.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flipping a railed manifest to executable still FAILS', { skip: process.platform === 'win32' }, () => {
  const { dir, baseSha } = makeRepo();
  try {
    const manifest = join(dir, 'packages', 'build-gate', 'package.json');
    writeFileSync(
      manifest,
      JSON.stringify({ name: '@adlc/build-gate', version: '1.5.1', main: 'lib/tier.mjs',
        dependencies: { '@adlc/core': '^1.5.1' } }, null, 2) + '\n'
    );
    chmodSync(manifest, 0o755);
    const res = guard(dir, baseSha, RAIL);
    assert.equal(res.status, 2, `expected deny, got ${res.status}: ${res.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Cross-model round 4 flagged these guards as unpinned by any test. Each was
// correct but unverified, which is how the earlier hollow-coverage failures
// started — a guard nobody tests is a guard nobody notices losing.

test('a manifest under a git CLEAN FILTER still FAILS', () => {
  // `git diff` applies clean filters; a direct read does not. A filter can
  // rewrite content on its way into the index while the comparator sees only an
  // innocent version edit, so the diff and the committed blob disagree.
  const { dir, run, baseSha } = makeRepo();
  try {
    run('config', 'filter.rewrite.clean', 'sed s/tier/EVIL/');
    writeFileSync(join(dir, '.gitattributes'), 'packages/build-gate/package.json filter=rewrite\n');
    writeFileSync(
      join(dir, 'packages', 'build-gate', 'package.json'),
      JSON.stringify({ name: '@adlc/build-gate', version: '1.5.1', main: 'lib/tier.mjs',
        dependencies: { '@adlc/core': '^1.5.1' } }, null, 2) + '\n'
    );
    const res = guard(dir, baseSha, RAIL);
    assert.equal(res.status, 2, `expected deny, got ${res.status}: ${res.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a manifest that was a SYMLINK at the baseline still FAILS', { skip: process.platform === 'win32' }, () => {
  // The mode check has to hold on the base side too, not only at HEAD.
  //
  // THE FIXTURE IS THE POINT. An earlier version pointed the symlink at
  // `real.json`, so the blob git stores is the literal string "real.json" —
  // which is not JSON, and the canonical precondition rejected it no matter what
  // the mode guard did. The test passed while pinning nothing.
  //
  // A symlink's blob content IS its target path, so the target is written as
  // canonical JSON text. Now `git show base:<file>` yields a document that would
  // sail through every content check, and ONLY the base-mode guard can deny.
  const { dir, run } = makeRepo();
  try {
    const manifest = join(dir, 'packages', 'build-gate', 'package.json');
    const jsonAsPath = JSON.stringify({ version: '1.5.0' }, null, 2) + '\n';
    rmSync(manifest);
    symlinkSync(jsonAsPath, manifest); // dangling by design; only the blob matters
    run('add', '-A');
    run('commit', '-q', '-m', 'symlink baseline');
    const newBase = run('rev-parse', 'HEAD').trim();
    rmSync(manifest);
    writeFileSync(manifest, JSON.stringify({ version: '1.5.1' }, null, 2) + '\n');
    const res = guard(dir, newBase, RAIL);
    assert.equal(res.status, 2, `expected deny, got ${res.status}: ${res.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a manifest under working-tree-encoding still FAILS', () => {
  // Round-6 regression. `working-tree-encoding` re-encodes between the working
  // tree and the index, so a value holding a non-ASCII character on disk is
  // committed as different bytes — a real change to `main`, invisible to a
  // comparator that only reads the working tree. The resolver checked `filter`
  // and `ident` but not this.
  const { dir, run } = makeRepo();
  try {
    const manifest = join(dir, 'packages', 'build-gate', 'package.json');
    // Baseline committed WITHOUT the attribute, so the blob holds `é` as UTF-8.
    writeFileSync(manifest,
      JSON.stringify({ name: '@adlc/build-gate', version: '1.5.0', main: './safe-é.mjs',
        dependencies: { '@adlc/core': '^1.5.0' } }, null, 2) + '\n');
    run('add', '-A');
    run('commit', '-q', '-m', 'plain baseline');
    const newBase = run('rev-parse', 'HEAD').trim();
    // NOW add the attribute. Git will read the working tree as ISO-8859-1, so
    // UTF-8 `é` (C3 A9) becomes two characters `Ã©` in the committed blob —
    // a real change to `main`. Both forms are valid UTF-8, so the byte-fidelity
    // check cannot catch this; only rejecting the attribute can.
    writeFileSync(join(dir, '.gitattributes'),
      'packages/build-gate/package.json working-tree-encoding=ISO-8859-1\n');
    writeFileSync(manifest,
      JSON.stringify({ name: '@adlc/build-gate', version: '1.5.1', main: './safe-é.mjs',
        dependencies: { '@adlc/core': '^1.5.1' } }, null, 2) + '\n');
    const res = guard(dir, newBase, RAIL);
    assert.equal(res.status, 2, `expected deny, got ${res.status}: ${res.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a filename containing git PATHSPEC MAGIC still FAILS', { skip: process.platform === 'win32' }, () => {
  // Round-7 scenario. `changedFiles` returns raw paths, but ls-tree takes a
  // PATHSPEC, and git reads a leading `:(...)` as magic — verified
  // directly: `ls-tree <base> -- ':(top)victim/package.json'` reports the mode of
  // `victim/package.json`, a different file.
  //
  // Both baseline paths deliberately hold the SAME blob under different modes:
  // the literal magic-looking path is a symlink (120000) whose target text is
  // canonical JSON, while the interpreted path is a regular file (100644)
  // containing that JSON. After the literal path becomes a canonical bumped
  // regular file, every content check passes. Either production defence denies
  // this; with both literal handling and the leading-colon refusal removed,
  // ls-tree reads the decoy's 100644 mode and the typechange is exempted.
  const { dir, run } = makeRepo();
  try {
    const baseline = JSON.stringify({ version: '1.5.0' }, null, 2) + '\n';
    mkdirSync(join(dir, 'victim'), { recursive: true });
    writeFileSync(join(dir, 'victim', 'package.json'), baseline);
    mkdirSync(join(dir, ':(top)victim'), { recursive: true });
    const magicManifest = join(dir, ':(top)victim', 'package.json');
    symlinkSync(baseline, magicManifest); // Git stores the target text as the blob.
    run('add', '-A');
    run('commit', '-q', '-m', 'same blob under regular and symlink modes');
    const newBase = run('rev-parse', 'HEAD').trim();
    const interpreted = run('ls-tree', newBase, '--', ':(top)victim/package.json');
    assert.match(interpreted, /^100644 /,
      'fixture must make non-literal ls-tree report the decoy mode');

    rmSync(magicManifest);
    writeFileSync(magicManifest, JSON.stringify({ version: '1.5.1' }, null, 2) + '\n');

    const res = spawnSync(process.execPath, [BIN, '--base', newBase, '--rails', '**/package.json'], {
      cwd: dir, encoding: 'utf8',
    });
    assert.equal(res.status, 2, `expected deny, got ${res.status}: ${res.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a manifest under the ident attribute still FAILS', () => {
  // Round-7 regression. `ident` expands $Id$ into $Id: <sha> $ in the working
  // tree and collapses it back to $Id$ in the blob. So a baseline holding
  // `main: "$Id: safe $"` commits as `main: "$Id$"` — a real change to `main`
  // while the comparator sees the unchanged expanded text. The guard existed but
  // no test pinned it; removing `ident` from the query left all 158 green.
  const { dir, run } = makeRepo();
  try {
    const manifest = join(dir, 'packages', 'build-gate', 'package.json');
    writeFileSync(manifest, JSON.stringify({ version: '1.5.0', main: '$Id: safe $' }, null, 2) + '\n');
    run('add', '-A');
    run('commit', '-q', '-m', 'baseline with expanded ident');
    const newBase = run('rev-parse', 'HEAD').trim();
    writeFileSync(join(dir, '.gitattributes'), 'packages/build-gate/package.json ident\n');
    writeFileSync(manifest, JSON.stringify({ version: '1.5.1', main: '$Id: safe $' }, null, 2) + '\n');
    const res = guard(dir, newBase, RAIL);
    assert.equal(res.status, 2, `expected deny, got ${res.status}: ${res.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

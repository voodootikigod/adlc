// Tests for the herdr-plugin marketplace-mirror sync (scripts/sync-herdr-mirror.mjs):
// the pure README transform + the fs mirroring (flatten, stale-file removal,
// .git preservation, fail-closed target guard).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transformReadme, mirrorBanner, syncMirror, MIRROR, MONOREPO } from '../sync-herdr-mirror.mjs';

test('mirrorBanner names the mirror, the monorepo source, and the install command', () => {
  const b = mirrorBanner();
  assert.match(b, /read-only mirror/i);
  assert.match(b, new RegExp(MONOREPO));
  assert.match(b, new RegExp(`herdr plugin install ${MIRROR}`));
});

test('mirrorBanner is a well-formed markdown blockquote — every content line starts with "> " so it renders as a callout', () => {
  const contentLines = mirrorBanner().split('\n').filter((l) => l.trim() !== '');
  assert.ok(contentLines.length >= 5, 'banner has its content lines');
  for (const line of contentLines) {
    assert.ok(line.startsWith('> '), `every banner line is a blockquote line, got: ${JSON.stringify(line)}`);
  }
});

test('transformReadme prepends the banner and rewrites monorepo-relative links to absolute; leaves others alone', () => {
  const out = transformReadme('# adlc-herdr\n\nSee [plan](../../docs/herdr-integration-plan.md) and [lib](../lib/x.mjs).\nExternal: [herdr](https://herdr.dev). Local: [readme](./README.md).\n');
  assert.match(out, /read-only mirror/i, 'banner prepended');
  assert.match(out, new RegExp(`\\]\\(https://github.com/${MONOREPO}/blob/main/docs/herdr-integration-plan.md\\)`), '../../ link → absolute');
  assert.match(out, new RegExp(`\\]\\(https://github.com/${MONOREPO}/blob/main/lib/x.mjs\\)`), '../ link → absolute');
  assert.match(out, /\]\(https:\/\/herdr\.dev\)/, 'already-absolute link untouched');
  assert.match(out, /\]\(\.\/README\.md\)/, 'in-repo relative link untouched');
});

test('transformReadme rewrites reference-style link definitions too, not just inline links', () => {
  const out = transformReadme('# x\n\n[plan]: ../../docs/plan.md\n[abs]: https://herdr.dev\n[here]: ./README.md\n');
  assert.match(out, new RegExp(`\\]: https://github.com/${MONOREPO}/blob/main/docs/plan.md`), 'ref-style ../ definition → absolute');
  assert.match(out, /\]: https:\/\/herdr\.dev/, 'already-absolute ref-style definition untouched');
  assert.match(out, /\]: \.\/README\.md/, 'in-repo ref-style definition untouched');
});

// Build a minimal fake monorepo root with a plugins/adlc-herdr tree + LICENSE.
function fakeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'adlc-mirror-src-'));
  const plugin = join(root, 'plugins', 'adlc-herdr');
  mkdirSync(join(plugin, 'bin'), { recursive: true });
  mkdirSync(join(plugin, 'lib'), { recursive: true });
  writeFileSync(join(plugin, 'herdr-plugin.toml'), 'id = "adlc"\nversion = "0.2.0"\n');
  writeFileSync(join(plugin, 'README.md'), '# adlc-herdr\n\nSee [plan](../../docs/plan.md).\n');
  writeFileSync(join(plugin, 'bin', 'watcher.mjs'), "import x from '../lib/x.mjs';\n");
  writeFileSync(join(plugin, 'lib', 'x.mjs'), 'export default 1;\n');
  writeFileSync(join(root, 'LICENSE'), 'MIT\n');
  return root;
}

test('syncMirror flattens the plugin into the target root, adds LICENSE, and transforms the README', () => {
  const root = fakeRepo();
  const target = mkdtempSync(join(tmpdir(), 'adlc-mirror-dst-'));
  const written = syncMirror({ repoRoot: root, targetDir: target });
  assert.deepEqual(written, ['LICENSE', 'README.md', 'bin', 'herdr-plugin.toml', 'lib']);
  assert.ok(existsSync(join(target, 'herdr-plugin.toml')), 'manifest at root');
  assert.ok(existsSync(join(target, 'bin', 'watcher.mjs')) && existsSync(join(target, 'lib', 'x.mjs')), 'bin + lib siblings at root');
  assert.equal(readFileSync(join(target, 'LICENSE'), 'utf8'), 'MIT\n', 'monorepo LICENSE carried over');
  assert.match(readFileSync(join(target, 'README.md'), 'utf8'), /read-only mirror/i, 'README transformed');
});

test('syncMirror does NOT propagate a .github/ directory into the mirror (no workflow-injection path)', () => {
  const root = fakeRepo();
  const plugin = join(root, 'plugins', 'adlc-herdr');
  mkdirSync(join(plugin, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(plugin, '.github', 'workflows', 'evil.yml'), 'on:\n  schedule:\n    - cron: "* * * * *"\n');
  const target = mkdtempSync(join(tmpdir(), 'adlc-mirror-dst-'));
  const written = syncMirror({ repoRoot: root, targetDir: target });
  assert.equal(existsSync(join(target, '.github')), false, 'no .github/ reaches the mirror');
  assert.ok(!written.includes('.github'), 'the entries list excludes .github');
  assert.ok(existsSync(join(target, 'herdr-plugin.toml')), 'real plugin content is still synced');
});

test('syncMirror REMOVES files deleted from the plugin (no stale content) but PRESERVES .git', () => {
  const root = fakeRepo();
  const target = mkdtempSync(join(tmpdir(), 'adlc-mirror-dst-'));
  mkdirSync(join(target, '.git'));
  writeFileSync(join(target, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(target, 'STALE.md'), 'old file removed from the plugin');
  syncMirror({ repoRoot: root, targetDir: target });
  assert.equal(existsSync(join(target, 'STALE.md')), false, 'stale file removed');
  assert.ok(existsSync(join(target, '.git', 'HEAD')), '.git preserved');
});

test('syncMirror FAILS CLOSED on a non-empty target that is not a git checkout (never wipes a wrong dir)', () => {
  const root = fakeRepo();
  const target = mkdtempSync(join(tmpdir(), 'adlc-mirror-dst-'));
  writeFileSync(join(target, 'important.txt'), 'not a mirror checkout');
  assert.throws(() => syncMirror({ repoRoot: root, targetDir: target }), /refusing to sync/);
  assert.ok(existsSync(join(target, 'important.txt')), 'the non-mirror dir is left untouched');
});

test('syncMirror rejects a NON-EXISTENT target with a clear message (pins the exists-OR-is-directory guard)', () => {
  const root = fakeRepo();
  const missing = join(mkdtempSync(join(tmpdir(), 'adlc-mirror-')), 'does-not-exist');
  assert.throws(() => syncMirror({ repoRoot: root, targetDir: missing }), /target is not a directory/);
});

test('syncMirror rejects a target that is a FILE, not a directory (pins the is-directory guard)', () => {
  const root = fakeRepo();
  const filePath = join(mkdtempSync(join(tmpdir(), 'adlc-mirror-')), 'a-file');
  writeFileSync(filePath, 'i am a file');
  assert.throws(() => syncMirror({ repoRoot: root, targetDir: filePath }), /target is not a directory/);
});

test('syncMirror REFUSES to sync into the source repo itself even when it is a git checkout (the `node sync.mjs .` footgun)', () => {
  const root = fakeRepo();
  mkdirSync(join(root, '.git')); // the monorepo IS a git checkout, so the .git-presence check alone would have passed — and then wiped it
  assert.throws(() => syncMirror({ repoRoot: root, targetDir: root }), /source repo or an overlapping path/);
  assert.ok(existsSync(join(root, 'plugins', 'adlc-herdr', 'herdr-plugin.toml')), 'the source tree is left untouched');
});

test('syncMirror resolves symlinks before the overlap check (a target symlinked to the source is refused, not wiped)', () => {
  const root = fakeRepo();
  mkdirSync(join(root, '.git')); // make the source look like a valid checkout so only the overlap guard can stop it
  const link = join(mkdtempSync(join(tmpdir(), 'adlc-mirror-lnk-')), 'target-link');
  symlinkSync(root, link); // target is a symlink pointing AT the source root — a plain string compare would miss it
  assert.throws(() => syncMirror({ repoRoot: root, targetDir: link }), /source repo or an overlapping path/);
  assert.ok(existsSync(join(root, 'plugins', 'adlc-herdr', 'herdr-plugin.toml')), 'the source tree is left untouched');
});

test('syncMirror FAILS CLOSED if the plugin tree contains a symlink (no write-through, no shipped symlink)', () => {
  const root = fakeRepo();
  const plugin = join(root, 'plugins', 'adlc-herdr');
  const secret = join(mkdtempSync(join(tmpdir(), 'adlc-mirror-sec-')), 'secret.txt');
  writeFileSync(secret, 'top secret');
  rmSync(join(plugin, 'README.md'));
  symlinkSync(secret, join(plugin, 'README.md')); // README committed as a symlink to an outside file
  const target = mkdtempSync(join(tmpdir(), 'adlc-mirror-dst-'));
  assert.throws(() => syncMirror({ repoRoot: root, targetDir: target }), /symlink \(tampering signal\)/);
  assert.equal(readFileSync(secret, 'utf8'), 'top secret', 'the symlink target file was NOT written through');
});

test('syncMirror FAILS CLOSED if the monorepo LICENSE is a symlink (the license copy is covered by the guard, not shipped)', () => {
  const root = fakeRepo();
  const outside = join(mkdtempSync(join(tmpdir(), 'adlc-mirror-sec-')), 'secret.pem');
  writeFileSync(outside, 'PRIVATE KEY');
  rmSync(join(root, 'LICENSE'));
  symlinkSync(outside, join(root, 'LICENSE')); // monorepo LICENSE replaced by a symlink to a secret
  const target = mkdtempSync(join(tmpdir(), 'adlc-mirror-dst-'));
  assert.throws(() => syncMirror({ repoRoot: root, targetDir: target }), /symlink \(tampering signal\)/);
});

test('syncMirror REFUSES a target that CONTAINS the source repo (overlap either direction)', () => {
  const base = mkdtempSync(join(tmpdir(), 'adlc-mirror-nest-'));
  const root = join(base, 'mono');
  mkdirSync(join(root, 'plugins', 'adlc-herdr'), { recursive: true });
  writeFileSync(join(root, 'plugins', 'adlc-herdr', 'herdr-plugin.toml'), 'id = "adlc"\n');
  mkdirSync(join(base, '.git')); // make the enclosing dir look like a valid checkout so only the overlap guard can stop it
  assert.throws(() => syncMirror({ repoRoot: root, targetDir: base }), /source repo or an overlapping path/);
});

test('syncMirror throws when the plugin dir is missing (operational error, not a silent no-op)', () => {
  const empty = mkdtempSync(join(tmpdir(), 'adlc-mirror-norepo-'));
  const target = mkdtempSync(join(tmpdir(), 'adlc-mirror-dst-'));
  assert.throws(() => syncMirror({ repoRoot: empty, targetDir: target }), /plugin dir not found/);
});

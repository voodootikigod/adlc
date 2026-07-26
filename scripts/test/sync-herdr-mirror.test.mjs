// Tests for the herdr-plugin marketplace-mirror sync (scripts/sync-herdr-mirror.mjs):
// the pure README transform + the fs mirroring (flatten, stale-file removal,
// .git preservation, fail-closed target guard).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transformReadme, mirrorBanner, syncMirror, MIRROR, MONOREPO } from '../sync-herdr-mirror.mjs';

test('mirrorBanner names the mirror, the monorepo source, and the install command', () => {
  const b = mirrorBanner();
  assert.match(b, /read-only mirror/i);
  assert.match(b, new RegExp(MONOREPO));
  assert.match(b, new RegExp(`herdr plugin install ${MIRROR}`));
});

test('transformReadme prepends the banner and rewrites monorepo-relative links to absolute; leaves others alone', () => {
  const out = transformReadme('# adlc-herdr\n\nSee [plan](../../docs/herdr-integration-plan.md) and [lib](../lib/x.mjs).\nExternal: [herdr](https://herdr.dev). Local: [readme](./README.md).\n');
  assert.match(out, /read-only mirror/i, 'banner prepended');
  assert.match(out, new RegExp(`\\]\\(https://github.com/${MONOREPO}/blob/main/docs/herdr-integration-plan.md\\)`), '../../ link → absolute');
  assert.match(out, new RegExp(`\\]\\(https://github.com/${MONOREPO}/blob/main/lib/x.mjs\\)`), '../ link → absolute');
  assert.match(out, /\]\(https:\/\/herdr\.dev\)/, 'already-absolute link untouched');
  assert.match(out, /\]\(\.\/README\.md\)/, 'in-repo relative link untouched');
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

test('syncMirror throws when the plugin dir is missing (operational error, not a silent no-op)', () => {
  const empty = mkdtempSync(join(tmpdir(), 'adlc-mirror-norepo-'));
  const target = mkdtempSync(join(tmpdir(), 'adlc-mirror-dst-'));
  assert.throws(() => syncMirror({ repoRoot: empty, targetDir: target }), /plugin dir not found/);
});

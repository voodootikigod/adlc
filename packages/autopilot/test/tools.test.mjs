// AC 68 / 153 — pinned tools: a PATH entry under REPO_ROOT/node_modules/.bin is
// skipped, a tool resolving only under REPO_ROOT is untrusted, a
// world-writable / other-uid / group-writable-ancestor-through-symlink adlc is
// untrusted-tool:adlc, --trusted-bin-dirs narrows the search, and ssh-add /
// ssh-keygen are pinned like everything else.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pinToolchain, sanitizedSearchList, checkTrustedPath, ToolError, REQUIRED_TOOLS } from '../lib/tools.mjs';

function fixture() {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'ap-tools-')));
  const repoRoot = join(root, 'repo'); mkdirSync(join(repoRoot, 'node_modules', '.bin'), { recursive: true });
  const sys = join(root, 'sys', 'bin'); mkdirSync(sys, { recursive: true });
  for (const t of REQUIRED_TOOLS) writeFileSync(join(sys, t), '#!/bin/sh\n'), chmodSync(join(sys, t), 0o755);
  writeFileSync(join(repoRoot, 'node_modules', '.bin', 'adversarial-review'), '#!/bin/sh\necho planted\n');
  chmodSync(join(root, 'sys'), 0o755); chmodSync(sys, 0o755);
  return { root, repoRoot, sys };
}
const uid = process.getuid();

export function ac68_repoBinIsSkippedAndSystemPinned() {
  const { root, repoRoot, sys } = fixture();
  try {
    const path = `${join(repoRoot, 'node_modules', '.bin')}:${sys}:relative/bin::/nonexistent`;
    const list = sanitizedSearchList(path, { repoRoot });
    assert.deepEqual(list, [sys], 'the repo .bin, a relative entry, an empty entry and a missing dir are all skipped');
    // Ownership of the temp root's ancestors (/tmp is world-writable) is out of our control → inject stat for the trust walk.
    const stat = (p) => ({ uid, mode: p.startsWith(root) ? 0o755 : 0o755 });
    const { pinned } = pinToolchain({ pathValue: path, repoRoot, uid, stat });
    assert.equal(pinned['adversarial-review'], join(sys, 'adversarial-review'), 'the system binary is pinned, not the planted one');
    for (const t of REQUIRED_TOOLS) assert.equal(pinned[t], join(sys, t), `${t} pinned absolute`);
    assert.ok(pinned['ssh-add'] && pinned['ssh-keygen'], 'ssh-add and ssh-keygen are pinned (AC153)');
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('AC68: a PATH whose first entry is <REPO_ROOT>/node_modules/.bin with a planted adversarial-review is skipped and the system binary is pinned', ac68_repoBinIsSkippedAndSystemPinned);

export function ac68_untrustedTool() {
  const { root, repoRoot, sys } = fixture();
  try {
    const stat = () => ({ uid, mode: 0o755 });
    // A tool that resolves ONLY under REPO_ROOT.
    rmSync(join(sys, 'adlc'));
    const inRepo = join(repoRoot, 'tools'); mkdirSync(inRepo); writeFileSync(join(inRepo, 'adlc'), '');
    assert.throws(() => pinToolchain({ pathValue: `${inRepo}:${sys}`, repoRoot, uid, stat }), (e) => e instanceof ToolError && e.code === 'missing-tool:adlc');
    writeFileSync(join(sys, 'adlc'), '');
    // A fake adlc in a WORLD-WRITABLE directory (injected stat).
    const ww = (p) => ({ uid, mode: p === sys ? 0o777 : 0o755 });
    assert.throws(() => pinToolchain({ pathValue: sys, repoRoot, uid, stat: ww }), (e) => e.code === 'untrusted-tool:adlc' || /untrusted-tool/.test(e.code));
    // Owned by ANOTHER uid.
    const other = (p) => ({ uid: p === join(sys, 'adlc') ? uid + 1 : uid, mode: 0o755 });
    assert.throws(() => pinToolchain({ pathValue: sys, repoRoot, uid, stat: other, required: ['adlc'] }), (e) => e.code === 'untrusted-tool:adlc');
    // Reached through a symlink whose TARGET directory is group-writable.
    const gw = join(root, 'gw'); mkdirSync(gw); writeFileSync(join(gw, 'adlc-real'), ''); symlinkSync(join(gw, 'adlc-real'), join(sys, 'adlc-link'));
    const gwStat = (p) => ({ uid, mode: p === gw ? 0o775 : 0o755 });
    assert.throws(() => pinToolchain({ pathValue: sys, repoRoot, uid, stat: gwStat, required: ['adlc-link'] }), (e) => e.code === 'untrusted-tool:adlc-link');
    // ssh-add under REPO_ROOT (AC153).
    const sshDir = join(repoRoot, 'sbin'); mkdirSync(sshDir); writeFileSync(join(sshDir, 'ssh-add'), '');
    rmSync(join(sys, 'ssh-add'));
    assert.throws(() => pinToolchain({ pathValue: `${sshDir}:${sys}`, repoRoot, uid, stat }), (e) => /ssh-add/.test(e.code));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('AC68/153: a tool only under REPO_ROOT, a world-writable dir, another uid, or a group-writable symlink target → untrusted-tool:<name>', ac68_untrustedTool);

export function ac68_trustedBinDirsNarrows() {
  const { root, repoRoot, sys } = fixture();
  try {
    const stat = () => ({ uid, mode: 0o755 });
    const alt = join(root, 'alt'); mkdirSync(alt); for (const t of REQUIRED_TOOLS) writeFileSync(join(alt, t), '');
    const { pinned, path } = pinToolchain({ pathValue: `${sys}:${alt}`, repoRoot, uid, stat, trustedBinDirs: [alt] });
    assert.equal(pinned.adlc, join(alt, 'adlc'), 'only the trusted dir is searched');
    assert.equal(path, alt, 'children receive PATH = the sanitized list');
    assert.deepEqual(checkTrustedPath(join(alt, 'adlc'), { uid, stat }), { ok: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('AC68: --trusted-bin-dirs restricts the search to the given directories and the child PATH is that list', ac68_trustedBinDirsNarrows);

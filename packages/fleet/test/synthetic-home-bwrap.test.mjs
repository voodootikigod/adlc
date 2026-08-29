// Synthetic HOME contract under REAL bubblewrap (spec AC156, the parts fleet owns).
//
// A temporary fake HOME stands in for the operator's: a 0600 credential with
// dummy bytes, a settings.json carrying a `hooks` key, a `.claude.json`, a plugin
// tree, an `.ssh` directory and a `secret.txt`. `prepareSyntheticHome` stages the
// leaves; `BoundedModelSandbox` mounts the tmpfs AT that HOME path; `/usr/bin/sh`
// scripts inside report what the worker would see. Every denial is paired with
// a control or a host-side check, so a script that could never have worked
// cannot pass as "contained".
//
// SKIPS LOUDLY without bwrap. The pure half is synthetic-home.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, statSync, symlinkSync, readdirSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectBackend } from '../lib/sandbox.mjs';
import { probeBwrap } from './helpers/bwrap-probe.mjs';
import { SYSTEM_ROOTS, BoundedModelSandbox, checkReadSetInvariant } from '../lib/bounded-model-plane.mjs';
import { prepareSyntheticHome } from '../lib/synthetic-home.mjs';
import * as claudeCode from '../lib/adapters/claude-code.mjs';

const backend = detectBackend();
const bwrapProbe = probeBwrap();
const bwrapSkip = bwrapProbe.ok ? false : `bounded model plane needs a USABLE bubblewrap; ${bwrapProbe.reason}`;
const SH = '/usr/bin/sh';
const CRED = '{"claudeAiOauth":{"accessToken":"dummy-token","expiresAt":1}}';

const scratch = (prefix) => realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
const spawnExec = (argv, opts) => spawnSync(argv[0], argv.slice(1), { ...opts, encoding: 'utf8' });

function fakeHost() {
  const root = scratch('sh-bwrap-');
  const home = join(root, 'home');
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  mkdirSync(join(home, '.ssh'), { recursive: true });
  mkdirSync(join(home, '.config', 'gh'), { recursive: true });
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
  writeFileSync(join(home, '.claude', '.credentials.json'), CRED, { mode: 0o600 });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', hooks: { PreToolUse: [] }, mcpServers: {} }));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ userID: 'u1', projects: { '/x': {} } }));
  writeFileSync(join(home, '.claude', 'plugins', 'x'), 'plugin-bytes');
  writeFileSync(join(home, '.claude', 'projects', 'host-session.json'), 'host');
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'PRIVATE');
  writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'token');
  writeFileSync(join(home, '.gitconfig'), '[user]');
  writeFileSync(join(home, '.npmrc'), '//registry/:_authToken=x');
  writeFileSync(join(home, 'secret.txt'), 'host-secret');
  const worktree = join(root, 'wt');
  mkdirSync(worktree);
  const staging = join(root, 'stage');
  const prepared = prepareSyntheticHome({ hostHome: home, stagingDir: staging, adapter: claudeCode });
  const sb = new BoundedModelSandbox({ backend, worktree, readOnlyPaths: [...SYSTEM_ROOTS], exec: spawnExec, ...prepared });
  return { root, home, worktree, staging, prepared, sb };
}

const inside = (sb, script) => sb.run([SH, '-c', script]);

test('the staged profile satisfies the §6.4 invariant the orchestrator checks before dispatch', { skip: bwrapSkip }, () => {
  const { root, prepared, worktree } = fakeHost();
  try {
    const r = checkReadSetInvariant({ readOnlyPaths: [...SYSTEM_ROOTS], writableRoots: [worktree], ...prepared });
    assert.equal(r.ok, true, r.violations.join('\n'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('inside: $HOME/.claude/.credentials.json is readable and byte-equal; rewrite/truncate/unlink/rename all FAIL; host file and inode untouched', { skip: bwrapSkip }, async () => {
  const { root, home, sb } = fakeHost();
  try {
    const hostCred = join(home, '.claude', '.credentials.json');
    const inoBefore = statSync(hostCred).ino;
    const read = await inside(sb, 'cat "$HOME/.claude/.credentials.json"');
    assert.equal(read.status, 0, read.stderr);
    assert.equal(read.stdout, CRED, 'byte-equal to the host credential');

    const attacks = {
      rewrite: 'printf pwned > "$HOME/.claude/.credentials.json"',
      truncate: ': > "$HOME/.claude/.credentials.json"',
      unlink: 'rm "$HOME/.claude/.credentials.json"',
      rename: 'printf x > "$HOME/.claude/new" && mv "$HOME/.claude/new" "$HOME/.claude/.credentials.json"',
      chmod: 'chmod 666 "$HOME/.claude/.credentials.json"',
    };
    for (const [name, script] of Object.entries(attacks)) {
      const res = await inside(sb, script);
      assert.notEqual(res.status, 0, `${name} must fail: ${res.stderr}`);
      assert.match(res.stderr, /Read-only file system|Device or resource busy|Permission denied|Operation not permitted/, `${name}: ${res.stderr}`);
    }
    const after = await inside(sb, 'cat "$HOME/.claude/.credentials.json"');
    assert.equal(after.stdout, CRED, 'still intact inside after the attacks');
    assert.equal(readFileSync(hostCred, 'utf8'), CRED, 'host bytes identical');
    assert.equal(statSync(hostCred).ino, inoBefore, 'same inode — nothing replaced it');
    assert.equal(statSync(hostCred).mode & 0o777, 0o600);

    // CONTROL: the rewrite script works against an unprotected file, so the
    // denials above are the sandbox's doing and not a broken script.
    const control = spawnSync(SH, ['-c', 'printf pwned > "$T/f"'], { env: { ...process.env, T: root }, encoding: 'utf8' });
    assert.equal(control.status, 0, control.stderr);
    assert.equal(readFileSync(join(root, 'f'), 'utf8'), 'pwned');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('inside: settings.json has no hooks/mcpServers and is read-only; the plugin tree is readable and read-only', { skip: bwrapSkip }, async () => {
  const { root, sb } = fakeHost();
  try {
    const res = await inside(sb, 'cat "$HOME/.claude/settings.json"');
    assert.equal(res.status, 0, res.stderr);
    const doc = JSON.parse(res.stdout);
    assert.deepEqual(doc, { model: 'opus' });
    assert.equal('hooks' in doc, false);
    const w = await inside(sb, 'printf x >> "$HOME/.claude/settings.json"');
    assert.notEqual(w.status, 0, 'settings.json is a read-only leaf');
    const plugin = await inside(sb, 'cat "$HOME/.claude/plugins/x" && printf y > "$HOME/.claude/plugins/new"');
    assert.notEqual(plugin.status, 0, 'a write into the plugin tree fails');
    assert.equal(plugin.stdout, 'plugin-bytes', 'but the tree is readable');
    assert.deepEqual(readdirSync(join(root, 'home', '.claude', 'plugins')), ['x'], 'and the host tree is untouched');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('inside: $HOME/.claude.json is writable, and the write lands in the staged copy — never the host file', { skip: bwrapSkip }, async () => {
  const { root, home, staging, sb } = fakeHost();
  try {
    const hostBefore = readFileSync(join(home, '.claude.json'), 'utf8');
    const res = await inside(sb, 'cat "$HOME/.claude.json" && printf \'{"rewritten":true}\' > "$HOME/.claude.json"');
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout), { userID: 'u1' }, 'the generated document carries only allowlisted keys');
    assert.equal(readFileSync(join(staging, 'claude.json'), 'utf8'), '{"rewritten":true}', 'the harness rewrite reaches the staged copy');
    assert.equal(readFileSync(join(home, '.claude.json'), 'utf8'), hostBefore, 'the host file is byte-identical');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('inside: every homeState.dirs scratch dir exists, is EMPTY and writable; a file written there is absent from the host', { skip: bwrapSkip }, async () => {
  const { root, home, prepared, sb } = fakeHost();
  try {
    assert.equal(prepared.homeScratchDirs.length, claudeCode.homeState.dirs.length);
    for (const dir of prepared.homeScratchDirs) {
      const res = await inside(sb, `[ -d "${dir}" ] && [ -z "$(ls -A "${dir}")" ] && printf s > "${dir}/probe" && cat "${dir}/probe"`);
      assert.equal(res.status, 0, `${dir}: ${res.stderr}`);
      assert.equal(res.stdout, 's');
      assert.ok(!existsSync(join(dir, 'probe')), `${dir}/probe must not exist on the host`);
    }
    // The host's `.claude/projects` holds a session file; inside it was EMPTY —
    // the operator's copy of a scratch dir is never bound.
    assert.ok(existsSync(join(home, '.claude', 'projects', 'host-session.json')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('inside: ~/.ssh, ~/.config/gh, ~/.gitconfig, ~/.npmrc and $HOME/secret.txt are ENOENT — the host HOME is not bound', { skip: bwrapSkip }, async () => {
  const { root, home, sb } = fakeHost();
  try {
    const probes = ['.ssh', '.ssh/id_ed25519', '.config/gh', '.gitconfig', '.npmrc', 'secret.txt', '.claude/hooks'];
    for (const p of probes) {
      const res = await inside(sb, `if [ -e "$HOME/${p}" ]; then echo present; else echo absent; fi; cat "$HOME/${p}" 2>&1`);
      assert.equal(res.stdout.split('\n')[0], 'absent', `${p} must be ENOENT inside`);
      assert.match(res.stdout, /No such file or directory/, `${p}: ENOENT, not merely denied`);
      assert.ok(existsSync(join(home, p)) || p === '.claude/hooks', `${p} exists on the host — so its absence is the sandbox's doing`);
    }
    const env = await inside(sb, 'echo "$HOME"; ls -A "$HOME"');
    assert.equal(env.status, 0, env.stderr);
    assert.equal(env.stdout.split('\n')[0], home, 'HOME inside IS the host HOME path');
    assert.deepEqual(env.stdout.trim().split('\n').slice(1).sort(), ['.cache', '.claude', '.claude.json'], 'nothing else of the operator HOME exists inside');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a symlinked host credential is refused on the real fs (O_NOFOLLOW → ELOOP), before anything is staged', () => {
  const root = scratch('sh-symlink-');
  try {
    const home = join(root, 'home');
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(join(root, 'real.json'), CRED, { mode: 0o600 });
    symlinkSync(join(root, 'real.json'), join(home, '.claude', '.credentials.json'));
    const staging = join(root, 'stage');
    assert.throws(() => prepareSyntheticHome({ hostHome: home, stagingDir: staging, adapter: claudeCode }), /^Error: credential-file-insecure: .*ELOOP/);
    assert.ok(!existsSync(join(staging, 'credentials.json')), 'no copy was made');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

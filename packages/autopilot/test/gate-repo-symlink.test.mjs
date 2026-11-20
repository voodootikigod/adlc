import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync as rm } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { HOST_SAFE_GIT, snapshotGateRepo, gitMetadataUnchanged, cloneSanity, compareSnapshots, ensureTrackingRef } from '../lib/gate-repo.mjs';
import { runOuterGates } from '../lib/gates.mjs';
import { createGateMirror } from '../lib/mirror.mjs';
import { normalizeProvider } from '../lib/review.mjs';
import { makeCtx } from './helpers/gates-ctx.mjs';
import { makeRepo, addIssueWorktree, writeFiles, commitAll, git, REPO } from './helpers/gates-fixture.mjs';

const ctx = {
  git: {
    localOut: async (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(),
    local: async (cwd, args) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
  },
};

test('HOST_SAFE_GIT disables core.logallrefupdates and symlinked .git/info or .git/info/exclude yields structured gate-repo-stale / gate-repo-moved without throwing', async () => {
  assert.deepEqual([...HOST_SAFE_GIT], ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.sshCommand=/bin/false', '-c', 'core.logallrefupdates=false']);
  assert.equal(normalizeProvider(undefined), '');
  assert.equal(normalizeProvider(null), '');
  assert.equal(normalizeProvider(42), '');
  assert.equal(normalizeProvider('codex'), 'openai');
  assert.equal(normalizeProvider('gpt-5'), 'openai');
  assert.equal(normalizeProvider('o3-mini'), 'openai');
  assert.equal(normalizeProvider('claude-opus-4'), 'anthropic');
  assert.equal(normalizeProvider('anthropic'), 'anthropic');
  assert.equal(normalizeProvider('agy'), 'google');
  assert.equal(normalizeProvider('gemini-2.5-pro'), 'google');
  assert.equal(normalizeProvider('Antigravity'), 'google');
  assert.equal(normalizeProvider('google'), 'google');
  assert.equal(normalizeProvider('  Mistral AI '), 'mistralai');
  const scratchRoot = mkdtempSync(join(tmpdir(), 'gate-symlink-'));
  const dir = join(scratchRoot, 'repo');
  mkdirSync(dir, { recursive: true });
  try {
    execFileSync('git', ['init', '-q', '--template='], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i'], { cwd: dir });
    const baseOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    await ensureTrackingRef({ ctx, cwd: dir, baseOid });

    // Clean baseline snapshot with a regular .git/info/exclude file
    const exclude = join(dir, '.git', 'info', 'exclude');
    mkdirSync(join(dir, '.git', 'info'), { recursive: true });
    writeFileSync(exclude, '# baseline\n');
    const cleanSnap = await snapshotGateRepo({ ctx, cwd: dir, baseOid });
    assert.equal(cleanSnap.infoExclude, '# baseline\n');
    assert.equal(cloneSanity(cleanSnap, { attestedHead: baseOid, baseOid }), null);
    assert.equal(gitMetadataUnchanged(cleanSnap, dir), null);
    assert.deepEqual(compareSnapshots(cleanSnap, cleanSnap), { same: true, reason: null });

    // Missing .git/info/exclude is null and still clean
    rm(exclude, { force: true });
    const missingExcludeSnap = await snapshotGateRepo({ ctx, cwd: dir, baseOid });
    assert.equal(missingExcludeSnap.infoExclude, null);
    assert.equal(cloneSanity(missingExcludeSnap, { attestedHead: baseOid, baseOid }), null);

    // Symlinked .git/info/exclude is surfaced via cloneSanity, gitMetadataUnchanged, and compareSnapshots without throwing
    const target = join(scratchRoot, 'outside.txt');
    writeFileSync(target, 'outside\n');
    mkdirSync(join(dir, '.git', 'info'), { recursive: true });
    symlinkSync(target, exclude);
    assert.equal(gitMetadataUnchanged(cleanSnap, dir), 'exclude-symlink');
    const symlinkSnap = await snapshotGateRepo({ ctx, cwd: dir, baseOid });
    assert.equal(symlinkSnap.head, null, 'host git status/rev-parse must not run after symlinked exclude is detected');
    assert.equal(cloneSanity(symlinkSnap, { attestedHead: baseOid, baseOid }), 'exclude-symlink');
    assert.deepEqual(compareSnapshots(cleanSnap, symlinkSnap), { same: false, reason: 'exclude-symlink' });
    assert.deepEqual(compareSnapshots(symlinkSnap, cleanSnap), { same: false, reason: 'exclude-symlink' });

    // Symlinked .git/info directory itself is also rejected
    rm(exclude, { force: true });
    rm(join(dir, '.git', 'info'), { recursive: true, force: true });
    const extInfo = join(scratchRoot, 'ext-info');
    mkdirSync(extInfo, { recursive: true });
    writeFileSync(join(extInfo, 'exclude'), '# ext\n');
    symlinkSync(extInfo, join(dir, '.git', 'info'));
    assert.equal(gitMetadataUnchanged(cleanSnap, dir), 'exclude-symlink');
    const infoLinkSnap = await snapshotGateRepo({ ctx, cwd: dir, baseOid });
    assert.equal(cloneSanity(infoLinkSnap, { attestedHead: baseOid, baseOid }), 'exclude-symlink');

    // End-to-end runOuterGates test: a gate planting .git/info/exclude as a symlink produces structured gate-repo-moved (never throws)
    const preflightText = readFileSync(join(REPO, 'scripts', 'preflight.mjs'), 'utf8');
    const { root, baseOid: repoBase } = makeRepo({ files: { 'scripts/preflight.mjs': preflightText, 'packages/foo/lib/x.mjs': 'export const x = 1;\n' } });
    try {
      git(root, ['remote', 'add', 'origin', 'git@github.com:o/r.git']);
      const FAKE_BWRAP = '/fake/bwrap';
      const ISSUE = 9;
      const gateCtx = makeCtx({
        repoRoot: root,
        baseOid: repoBase,
        pinned: { bwrap: FAKE_BWRAP },
        handlers: {
          [FAKE_BWRAP]: async (args) => {
            const cloneDir = args[args.indexOf('--chdir') + 1];
            const ex = join(cloneDir, '.git', 'info', 'exclude');
            mkdirSync(join(cloneDir, '.git', 'info'), { recursive: true });
            rm(ex, { force: true });
            symlinkSync(target, ex);
            return { status: 0 };
          },
        },
      });
      const wt = addIssueWorktree(root, gateCtx.paths.issueWorktree(ISSUE), ISSUE, repoBase);
      writeFiles(wt, { 'packages/foo/lib/x.mjs': 'export const x = 2;\n' });
      const attestedHead = commitAll(wt, 'worker + attest');
      const deps = join(gateCtx.paths.runDir(ISSUE), 'gate-deps', 'node_modules');
      mkdirSync(deps, { recursive: true });
      await createGateMirror({ ctx: gateCtx, issue: ISSUE, attestedHead, baseOid: repoBase });
      const gateRes = await runOuterGates({
        ctx: gateCtx,
        issue: ISSUE,
        attestedHead,
        baseOid: repoBase,
        gateDepsNodeModules: deps,
        backend: { name: 'bubblewrap', platform: 'linux' },
      });
      assert.equal(gateRes.ok, false);
      assert.equal(gateRes.code, 'gate-repo-moved');
      assert.equal(gateRes.reason, 'exclude-symlink');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  } finally { rmSync(scratchRoot, { recursive: true, force: true }); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, rmSync as rm } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { HOST_SAFE_GIT, snapshotGateRepo, GateRepoError } from '../lib/gate-repo.mjs';
import { normalizeProvider } from '../lib/review.mjs';

const ctx = {
  git: {
    localOut: async (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(),
    local: async (cwd, args) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
  },
};

test('HOST_SAFE_GIT disables core.logallrefupdates and snapshotGateRepo rejects symlinked .git/info/exclude', async () => {
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
  const dir = mkdtempSync(join(tmpdir(), 'gate-symlink-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i'], { cwd: dir });
    const baseOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    const exclude = join(dir, '.git', 'info', 'exclude');
    mkdirSync(join(dir, '.git', 'info'), { recursive: true });
    rm(exclude, { force: true });
    writeFileSync(join(dir, 'target.txt'), 'x');
    symlinkSync(join(dir, 'target.txt'), exclude);
    await assert.rejects(() => snapshotGateRepo({ ctx, cwd: dir, baseOid }), (e) => e instanceof GateRepoError && e.code === 'exclude-symlink');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

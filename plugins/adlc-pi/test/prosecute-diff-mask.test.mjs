// prosecute-diff-mask.test.mjs — adlc_prosecute masks credentials on the removed
// side of the diff before any lens prompt is built. `pi.exec` is backed by the
// real git binary, so the diff shape is git's own, not a fixture's. Offline;
// the temp repo and its .adlc ledger dir are removed afterwards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeProsecuteExecute } from '../lib/prosecute-tool.mjs';

const TOKEN = ['gh', 'p_', 'aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5'].join('');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const realGitPi = {
  async exec(cmd, args, { cwd } = {}) {
    try {
      return { stdout: execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 };
    } catch (err) {
      return { stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? ''), code: err.status ?? 1 };
    }
  },
};

test('no lens prompt carries a token the change removes; the masked removal is still reviewed', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-pi-mask-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  // A user config that changes `git diff` output must not switch the mask off:
  // forced color, and an external driver that prints the old file raw.
  git(dir, 'config', 'color.ui', 'always');
  writeFileSync(join(dir, 'raw-diff.sh'), '#!/bin/sh\ncat "$2"\n', { mode: 0o755 });
  git(dir, 'config', 'diff.external', join(dir, 'raw-diff.sh'));
  writeFileSync(join(dir, 'config.mjs'), `export const token = "${TOKEN}";\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(dir, 'config.mjs'), 'export const token = process.env.TOKEN;\n');
  git(dir, 'commit', '-q', '-am', 'remove the hardcoded token');

  const prompts = [];
  const execute = makeProsecuteExecute({
    pi: realGitPi,
    getActive: () => ({ ticketId: 'T1', ticket: { id: 'T1', title: 't' } }),
    getCwd: () => dir,
    runLensFactory: () => async (prompt) => { prompts.push(prompt); return '[]'; },
  });
  const result = await execute('tc', { base }, undefined, undefined, {});
  assert.equal(result.isError, false);
  assert.ok(prompts.length > 0, 'lenses ran on the collected diff');
  for (const prompt of prompts) assert.ok(!prompt.includes(TOKEN), 'a lens prompt carried the removed token');
  assert.ok(prompts.some((p) => p.includes('-export const token = "[redacted]";')), 'lenses still see the masked removal');
  assert.ok(prompts.some((p) => p.includes('+export const token = process.env.TOKEN;')), 'added lines are unchanged');
});

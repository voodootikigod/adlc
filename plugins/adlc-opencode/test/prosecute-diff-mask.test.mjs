// prosecute-diff-mask.test.mjs — adlc_prosecute masks credentials on the removed
// side of the diff before any lens or verifier prompt is built. Drives the real
// git binary for captureDiff (no mocked diff shape) and the real tool for the
// prompt path. Offline; temp repos are removed afterwards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProsecuteTool, captureDiff } from '../lib/prosecute-tool.mjs';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const TOKEN = ['gh', 'p_', 'aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5'].join('');
const TOOL_CTX = { sessionID: 'ses_parent', agent: 'build', messageID: 'msg_1', id: 'call_1' };

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function repoRemovingSecret(t) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-oc-mask-'));
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
  writeFileSync(join(dir, 'config.mjs'), `export const token = "${TOKEN}";\nexport const n = 1;\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(dir, 'config.mjs'), 'export const token = process.env.TOKEN;\nexport const n = 1;\n');
  git(dir, 'commit', '-q', '-am', 'remove the hardcoded token');
  return dir;
}

test('captureDiff against the real git binary masks a removed token and keeps the rest of the diff', (t) => {
  const dir = repoRemovingSecret(t);
  const { diff, error } = captureDiff({ base: 'main', cwd: dir });
  assert.equal(error, null);
  assert.ok(!diff.includes(TOKEN), 'the removed token must not reach the review text');
  assert.match(diff, /^-export const token = "\[redacted\]";$/m);
  assert.match(diff, /^\+export const token = process\.env\.TOKEN;$/m);
  assert.match(diff, /^--- a\/config\.mjs$/m);
});

test('no lens or verifier prompt carries a token the change removes', async (t) => {
  const dir = repoRemovingSecret(t);
  const prompts = [];
  const session = {
    create: async () => ({ id: `ses_child_${prompts.length}` }),
    prompt: async (req) => { prompts.push(req.text); return { id: 'inb' }; },
    wait: async () => {},
    context: async () => [{ type: 'assistant', agent: 'x', content: [{ type: 'text', text: '```json\n[]\n```' }] }],
  };
  const def = buildProsecuteTool({ root: dir, pkgRoot: PKG, session });
  await def.execute({ base: 'main' }, TOOL_CTX);
  assert.ok(prompts.length > 0, 'lenses ran on the captured diff');
  for (const text of prompts) assert.ok(!text.includes(TOKEN), 'a prompt carried the removed token');
  assert.ok(prompts.some((text) => text.includes('-export const token = "[redacted]";')), 'lenses still see the masked removal');
});

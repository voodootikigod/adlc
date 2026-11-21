import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnHook } from './helpers/run-hook.mjs';

const HOOK_SCRIPT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'adlc-rails-guard.mjs');

function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-codex-subdir-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  mkdirSync(join(dir, 'src', 'frozen'), { recursive: true });
  mkdirSync(join(dir, 'src', 'deep', 'nested'), { recursive: true });
  writeFileSync(join(dir, 'src', 'frozen', 'guard.mjs'), 'export const x = 1;\n');
  symlinkSync(join(dir, 'src', 'frozen'), join(dir, 'src', 'deep', 'link-frozen'));
  writeFileSync(
    join(dir, '.adlc', 'tickets.json'),
    JSON.stringify({
      tickets: [{
        id: 'T1',
        title: 'Subdir symlink test',
        status: 'in-progress',
        rails: ['src/frozen/guard.mjs'],
      }],
    }, null, 2),
  );
  writeFileSync(join(dir, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
  return dir;
}

function runHook(payload, { cwd }) {
  return spawnHook([HOOK_SCRIPT], {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: cwd },
    input: JSON.stringify(payload),
    timeout: 15_000,
  });
}

test('codex rails-guard discovers enclosing ADLC root from nested subdir and blocks ancestor symlink and parent-dir deletion', (t) => {
  const repo = makeRepo(t);
  const deep = join(repo, 'src', 'deep', 'nested');

  const symlinkWrite = runHook(
    {
      tool_name: 'edit_file',
      cwd: deep,
      tool_input: { file_path: '../link-frozen/guard.mjs' },
    },
    { cwd: deep },
  );
  assert.equal(symlinkWrite.status, 2, symlinkWrite.stderr);
  assert.match(symlinkWrite.stderr, /blocked rail edit/);

  const ancestorRm = runHook(
    {
      tool_name: 'bash',
      cwd: repo,
      tool_input: { command: 'rm -rf src/frozen' },
    },
    { cwd: repo },
  );
  assert.equal(ancestorRm.status, 2, ancestorRm.stderr);
  assert.match(ancestorRm.stderr, /blocked rail edit/);
});

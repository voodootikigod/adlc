import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnHook } from './helpers/run-hook.mjs';

const HOOKS_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const RAILS_HOOK = join(HOOKS_DIR, 'adlc-rails-guard.mjs');
const BUILD_GATE_HOOK = join(HOOKS_DIR, 'adlc-build-gate.mjs');

function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-copilot-subdir-'));
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
        title: 'Copilot subdir test',
        status: 'in-progress',
        risk: 'high',
        rails: ['src/frozen/guard.mjs'],
      }],
    }, null, 2),
  );
  writeFileSync(join(dir, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
  return dir;
}

test('copilot rails-guard discovers enclosing ADLC root from subdir and blocks ancestor symlink and ancestor dir deletion', (t) => {
  const repo = makeRepo(t);
  const deep = join(repo, 'src', 'deep', 'nested');
  const fakeHome = mkdtempSync(join(tmpdir(), 'adlc-copilot-home-'));
  t.after(() => rmSync(fakeHome, { recursive: true, force: true }));

  const symlinkWrite = spawnHook([RAILS_HOOK], {
    cwd: deep,
    env: { PATH: process.env.PATH ?? '', HOME: fakeHome },
    input: JSON.stringify({
      toolName: 'edit',
      cwd: deep,
      toolArgs: JSON.stringify({ path: '../link-frozen/guard.mjs' }),
    }),
    timeout: 15_000,
  });
  assert.equal(symlinkWrite.status, 0);
  const symVerdict = JSON.parse(symlinkWrite.stdout);
  assert.match(symVerdict.reason, /blocked rail edit/);

  const ancestorRm = spawnHook([RAILS_HOOK], {
    cwd: repo,
    env: { PATH: process.env.PATH ?? '', HOME: fakeHome },
    input: JSON.stringify({
      toolName: 'bash',
      cwd: repo,
      toolArgs: JSON.stringify({ command: 'rm -rf src/frozen' }),
    }),
    timeout: 15_000,
  });
  assert.equal(ancestorRm.status, 0);
  const rmVerdict = JSON.parse(ancestorRm.stdout);
  assert.match(rmVerdict.reason, /blocked rail edit/);
});

test('copilot build-gate discovers enclosing ADLC root from nested subdir and denies degraded high-risk session', (t) => {
  const repo = makeRepo(t);
  const deep = join(repo, 'src', 'deep', 'nested');
  const fakeHome = mkdtempSync(join(tmpdir(), 'adlc-copilot-home-'));
  t.after(() => rmSync(fakeHome, { recursive: true, force: true }));
  const transcript = join(repo, 'session.jsonl');
  writeFileSync(transcript, `${'{"type":"tool_use"}\n'.repeat(45)}`);

  const res = spawnHook([BUILD_GATE_HOOK], {
    cwd: deep,
    env: { PATH: process.env.PATH ?? '', HOME: fakeHome },
    input: JSON.stringify({
      toolName: 'edit',
      cwd: deep,
      transcriptPath: transcript,
      toolArgs: JSON.stringify({ path: 'ok.mjs' }),
    }),
    timeout: 15_000,
  });
  assert.equal(res.status, 0);
  const verdict = JSON.parse(res.stdout);
  assert.match(verdict.reason, /high-risk|degraded/i);
});

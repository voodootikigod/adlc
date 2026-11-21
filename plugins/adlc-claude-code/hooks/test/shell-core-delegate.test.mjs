import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOKS_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const HOOK_SCRIPT = join(HOOKS_DIR, 'adlc-hook.mjs');
const HOOKS_JSON = join(HOOKS_DIR, 'hooks.json');
const GENERATED_SHELL = join(HOOKS_DIR, 'generated-shell.mjs');

function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-cc-shell-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  mkdirSync(join(dir, 'src', 'frozen'), { recursive: true });
  mkdirSync(join(dir, 'src', 'sub'), { recursive: true });
  writeFileSync(join(dir, 'src', 'frozen', 'guard.mjs'), 'export const x = 1;\n');
  writeFileSync(join(dir, 'src', 'sub', 'ok.mjs'), 'export const ok = 1;\n');
  writeFileSync(
    join(dir, '.adlc', 'tickets.json'),
    JSON.stringify({
      tickets: [{
        id: 'T1',
        title: 'Shell rail gating test',
        status: 'in-progress',
        rails: ['src/frozen/guard.mjs'],
        scope: ['src/**'],
      }],
    }, null, 2),
  );
  writeFileSync(join(dir, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
  return dir;
}

function runRails(payload, { cwd, env = {} }) {
  return spawnSync(process.execPath, [HOOK_SCRIPT, 'rails'], {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: cwd, ...env },
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15_000,
  });
}

test('generated-shell.mjs has zero @adlc/* runtime imports and hooks.json wires Bash to rails', () => {
  const generated = readFileSync(GENERATED_SHELL, 'utf8');
  assert.doesNotMatch(generated, /from\s+['"]@adlc\//);
  const config = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
  const bashEntry = (config.hooks?.PreToolUse ?? []).find((e) => e.matcher === 'Bash');
  assert.ok(bashEntry, 'PreToolUse must include a Bash matcher');
  assert.ok(
    bashEntry.hooks.some((h) => /adlc-hook-run\.mjs\s+rails/.test(h.command)),
    'Bash PreToolUse matcher must invoke rails',
  );
});

test('Bash rails gate allows read-only commands and denies opaque, rail-targeting, and ancestor-deleting commands', (t) => {
  const repo = makeRepo(t);
  const subDir = join(repo, 'src', 'sub');

  const ro = runRails({ tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: subDir }, { cwd: subDir });
  assert.equal(ro.status, 0, ro.stderr);

  const opaque = runRails(
    { tool_name: 'Bash', tool_input: { command: "sh -c 'echo pwn > src/frozen/guard.mjs'" }, cwd: repo },
    { cwd: repo },
  );
  assert.equal(opaque.status, 2);
  assert.match(opaque.stdout, /permissionDecision.*deny/);

  const directRail = runRails(
    { tool_name: 'Bash', tool_input: { command: 'rm -f ../frozen/guard.mjs' }, cwd: subDir },
    { cwd: subDir },
  );
  assert.equal(directRail.status, 2);
  assert.match(directRail.stdout, /frozen rail/);

  const ancestorDelete = runRails(
    { tool_name: 'Bash', tool_input: { command: 'rm -rf src/frozen' }, cwd: repo },
    { cwd: repo },
  );
  assert.equal(ancestorDelete.status, 2);
  assert.match(ancestorDelete.stdout, /frozen rail/);

  const sedExec = runRails(
    { tool_name: 'Bash', tool_input: { command: 'cat package.json | sed -n \'e perl -e "unlink q(src/frozen/guard.mjs)"\'' }, cwd: repo },
    { cwd: repo },
  );
  assert.equal(sedExec.status, 2);
  assert.match(sedExec.stdout, /permissionDecision.*deny/);

  const outputOpt = runRails(
    { tool_name: 'Bash', tool_input: { command: 'git diff --output=.adlc/tickets.json' }, cwd: repo },
    { cwd: repo },
  );
  assert.equal(outputOpt.status, 2);
  assert.match(outputOpt.stdout, /permissionDecision.*deny/);

  const allowedWrite = runRails(
    { tool_name: 'Bash', tool_input: { command: 'touch src/sub/ok.mjs' }, cwd: repo },
    { cwd: repo },
  );
  assert.equal(allowedWrite.status, 0, allowedWrite.stderr);
});

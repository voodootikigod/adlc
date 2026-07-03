import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'claude-code-plugin-smoke.mjs');
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('claude-code-plugin-smoke passes against the repo', () => {
  const result = spawnSync(process.execPath, [SCRIPT, REPO], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `smoke test failed:\n${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.ok, true);
});

// Regression coverage for issue #50: the plugin is namespaced "adlc", so the
// real invocable form of a plugin command inside Claude Code is
// "/adlc:adlc-<name>" — a bare "/adlc-<name>" recommendation silently fails to
// invoke. Prove the smoke test catches this by injecting a bare reference into
// a throwaway copy of the plugin and confirming the guard fires.
test('claude-code-plugin-smoke fails on a bare, non-namespaced command recommendation', () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), 'adlc-cc-smoke-'));
  try {
    cpSync(REPO, tmpRepo, {
      recursive: true,
      filter: (src) => !src.includes(`${resolve(REPO, '.git')}`) && !src.includes(`${resolve(REPO, 'node_modules')}`),
    });

    const skillPath = join(tmpRepo, 'plugins/adlc-claude-code/skills/adlc/SKILL.md');
    const original = readFileSync(skillPath, 'utf8');
    // Re-introduce exactly the bug fixed in #50: a bare, non-namespaced command
    // recommendation instead of the scoped "/adlc:adlc-ticket" form.
    assert.ok(original.includes('/adlc:adlc-ticket'), 'fixture assumption stale: expected the scoped form to be present before regression injection');
    const regressed = original.replace('/adlc:adlc-ticket', '/adlc-ticket');
    writeFileSync(skillPath, regressed);

    const result = spawnSync(process.execPath, [SCRIPT, tmpRepo], { encoding: 'utf8' });
    assert.notStrictEqual(result.status, 0, 'smoke test should fail when a bare /adlc-ticket recommendation is present');
    assert.match(result.stderr, /bare, non-namespaced command reference/);
    assert.match(result.stderr, /adlc-ticket/);
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

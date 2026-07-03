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

// Regression coverage for the review-round-1 finding on issue #50: the guard must
// also cover docs/integrations/claude-code.md, the plugin's own homepage doc
// (plugin.json's "homepage" field points at it), not just the
// plugins/adlc-claude-code/{commands,skills,agents,hooks} tree. A bare command
// recommendation there is the exact bug #50 was filed against, since it's the
// first thing a user reads right after installing the plugin.
test('claude-code-plugin-smoke fails on a bare command recommendation in the homepage doc', () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), 'adlc-cc-smoke-'));
  try {
    cpSync(REPO, tmpRepo, {
      recursive: true,
      filter: (src) => !src.includes(`${resolve(REPO, '.git')}`) && !src.includes(`${resolve(REPO, 'node_modules')}`),
    });

    const docPath = join(tmpRepo, 'docs/integrations/claude-code.md');
    const original = readFileSync(docPath, 'utf8');
    assert.ok(original.includes('/adlc:adlc-init'), 'fixture assumption stale: expected the scoped form to be present before regression injection');
    const regressed = original.replace('/adlc:adlc-init', '/adlc-init');
    writeFileSync(docPath, regressed);

    const result = spawnSync(process.execPath, [SCRIPT, tmpRepo], { encoding: 'utf8' });
    assert.notStrictEqual(result.status, 0, 'smoke test should fail when the homepage doc recommends a bare /adlc-init');
    assert.match(result.stderr, /bare, non-namespaced command reference/);
    assert.match(result.stderr, /docs\/integrations\/claude-code\.md/);
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// Regression coverage for the review-round-4 finding on issue #50: the guard must
// also cover the repo's top-level README.md — the first file a GitHub visitor
// reads, with its own "Use it in Claude Code" quick-start — not just the
// plugins/adlc-claude-code/* tree and docs/integrations/claude-code.md.
test('claude-code-plugin-smoke fails on a bare command recommendation in README.md', () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), 'adlc-cc-smoke-'));
  try {
    cpSync(REPO, tmpRepo, {
      recursive: true,
      filter: (src) => !src.includes(`${resolve(REPO, '.git')}`) && !src.includes(`${resolve(REPO, 'node_modules')}`),
    });

    const readmePath = join(tmpRepo, 'README.md');
    const original = readFileSync(readmePath, 'utf8');
    assert.ok(original.includes('/adlc:adlc-init'), 'fixture assumption stale: expected the scoped form to be present before regression injection');
    const regressed = original.replace('/adlc:adlc-init', '/adlc-init');
    writeFileSync(readmePath, regressed);

    const result = spawnSync(process.execPath, [SCRIPT, tmpRepo], { encoding: 'utf8' });
    assert.notStrictEqual(result.status, 0, 'smoke test should fail when README.md recommends a bare /adlc-init');
    assert.match(result.stderr, /bare, non-namespaced command reference/);
    assert.match(result.stderr, /README\.md/);
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// Regression coverage for the review-round-4 finding on issue #50: the guard must
// also cover docs/adr/0003-adlc-claude-code-plugin.md — the plugin's own design
// ADR, cross-linked from docs/integrations/claude-code.md — not just the
// plugins/adlc-claude-code/* tree and the two other guidance docs.
test('claude-code-plugin-smoke fails on a bare command recommendation in the design ADR', () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), 'adlc-cc-smoke-'));
  try {
    cpSync(REPO, tmpRepo, {
      recursive: true,
      filter: (src) => !src.includes(`${resolve(REPO, '.git')}`) && !src.includes(`${resolve(REPO, 'node_modules')}`),
    });

    const adrPath = join(tmpRepo, 'docs/adr/0003-adlc-claude-code-plugin.md');
    const original = readFileSync(adrPath, 'utf8');
    assert.ok(original.includes('/adlc:adlc-init'), 'fixture assumption stale: expected the scoped form to be present before regression injection');
    const regressed = original.replace('/adlc:adlc-init', '/adlc-init');
    writeFileSync(adrPath, regressed);

    const result = spawnSync(process.execPath, [SCRIPT, tmpRepo], { encoding: 'utf8' });
    assert.notStrictEqual(result.status, 0, 'smoke test should fail when the design ADR recommends a bare /adlc-init');
    assert.match(result.stderr, /bare, non-namespaced command reference/);
    assert.match(result.stderr, /docs\/adr\/0003-adlc-claude-code-plugin\.md/);
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
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

// Regression coverage for issue #96: the pre-#96 guard only scanned a hardcoded
// allowlist of "extra" doc paths (docs/integrations/claude-code.md, README.md,
// the design ADR). Every round of #50/#89's adversarial review after the first
// found a NEW doc surface with a bare reference the allowlist didn't know about.
// Prove the guard now covers an ARBITRARY new doc under docs/ with no allowlist
// entry required — the whole point of the fix.
test('claude-code-plugin-smoke fails on a bare command recommendation in an arbitrary new doc under docs/', () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), 'adlc-cc-smoke-'));
  try {
    cpSync(REPO, tmpRepo, {
      recursive: true,
      filter: (src) => !src.includes(`${resolve(REPO, '.git')}`) && !src.includes(`${resolve(REPO, 'node_modules')}`),
    });

    // A brand-new doc, nested two levels deep, never listed in any allowlist.
    const newDocDir = join(tmpRepo, 'docs/guides/onboarding');
    mkdirSync(newDocDir, { recursive: true });
    const newDocPath = join(newDocDir, 'quickstart.md');
    writeFileSync(newDocPath, '# Quickstart\n\nRun /adlc-ticket to get started.\n');

    const result = spawnSync(process.execPath, [SCRIPT, tmpRepo], { encoding: 'utf8' });
    assert.notStrictEqual(result.status, 0, 'smoke test should fail on a bare command reference in a brand-new, never-allowlisted doc');
    assert.match(result.stderr, /bare, non-namespaced command reference/);
    assert.match(result.stderr, /docs\/guides\/onboarding\/quickstart\.md/);
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// Regression coverage for issue #96: the command-name list itself was a second,
// independent hardcoded allowlist (['init', 'ticket', 'distill', 'maintain']) that
// silently missed '/adlc-prosecute' after the prosecutor-parity feature (#61) added
// a fifth command — a live, real instance of exactly this bug class was found on
// docs/integrations/claude-code.md and plugins/adlc-claude-code/commands/adlc-prosecute.md's
// own heading while building this fix. Prove the guard derives its command names from
// the commands/ directory itself, so a newly added command file is covered automatically.
test('claude-code-plugin-smoke fails on a bare reference to a newly-added command with no hardcoded name update', () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), 'adlc-cc-smoke-'));
  try {
    cpSync(REPO, tmpRepo, {
      recursive: true,
      filter: (src) => !src.includes(`${resolve(REPO, '.git')}`) && !src.includes(`${resolve(REPO, 'node_modules')}`),
    });

    // Add a brand-new command file the guard has never been told about by name.
    const newCommandPath = join(tmpRepo, 'plugins/adlc-claude-code/commands/adlc-brandnew.md');
    writeFileSync(
      newCommandPath,
      '---\ndescription: a fixture-only command.\n---\n\n# /adlc:adlc-brandnew\n\nSee also /adlc-brandnew for the bare (buggy) form.\n'
    );

    const result = spawnSync(process.execPath, [SCRIPT, tmpRepo], { encoding: 'utf8' });
    assert.notStrictEqual(result.status, 0, 'smoke test should fail on a bare reference to a command it discovers dynamically, with no code change to a name list');
    assert.match(result.stderr, /bare, non-namespaced command reference/);
    assert.match(result.stderr, /adlc-brandnew/);
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// Regression coverage for issue #96: a repo-wide scan must not false-positive on
// paths that are genuinely not live Claude-Code guidance — archived/superseded
// docs (which deliberately preserve the historical bare-command text as a record)
// and other harnesses' own integration docs (where a bare "/adlc-*" is that
// harness's correct, intentional invocation syntax, verified per-harness in #50).
test('claude-code-plugin-smoke does not false-positive on excluded, genuinely out-of-scope docs', () => {
  const result = spawnSync(process.execPath, [SCRIPT, REPO], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `smoke test should pass against the real repo, which has known bare-command text in excluded paths:\n${result.stderr}`);

  // Sanity-check the fixture assumption: these files DO contain bare command
  // text today (proving the pass above isn't just "nothing to find").
  const archivePath = join(REPO, 'docs/archive/claude-code-plan.md');
  const cursorDocPath = join(REPO, 'docs/integrations/cursor.md');
  assert.match(readFileSync(archivePath, 'utf8'), /\/adlc-init/, 'fixture assumption stale: expected archived doc to still contain bare command text');
  assert.match(readFileSync(cursorDocPath, 'utf8'), /\/adlc-init/, 'fixture assumption stale: expected Cursor doc to still contain its own bare command text');
});

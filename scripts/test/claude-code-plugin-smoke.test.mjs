import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
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

// Regression coverage: namespacedCommandNames is derived from filenames on disk
// (plugins/adlc-claude-code/commands/*.md), not a hardcoded literal list, so a
// derived name must be treated as untrusted regex input, not spliced unescaped
// into `new RegExp(...)`. Two failure modes if unescaped: (1) a name containing
// "." would make the pattern match ANY character there (a silent false
// positive), and (2) a name containing an unbalanced metacharacter like "("
// would throw an uncaught SyntaxError from `new RegExp(...)`, crashing the
// script with a raw stack trace instead of the script's own clean fail() path.
test('claude-code-plugin-smoke escapes regex metacharacters in derived command names (no wildcard false positive)', () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), 'adlc-cc-smoke-'));
  try {
    cpSync(REPO, tmpRepo, {
      recursive: true,
      filter: (src) => !src.includes(`${resolve(REPO, '.git')}`) && !src.includes(`${resolve(REPO, 'node_modules')}`),
    });

    // A command name containing a literal "." — if spliced unescaped into the
    // regex, "." matches any character, so "/adlc-v1X2" would wrongly match too.
    writeFileSync(
      join(tmpRepo, 'plugins/adlc-claude-code/commands/adlc-v1.2.md'),
      '---\ndescription: a fixture-only versioned command.\n---\n\n# /adlc:adlc-v1.2\n'
    );
    const fixtureDocPath = join(tmpRepo, 'docs/fixture-regex-escape.md');
    writeFileSync(fixtureDocPath, '# Fixture\n\nThis mentions /adlc-v1X2 which must NOT be treated as a bare command match.\n');

    const noFalsePositive = spawnSync(process.execPath, [SCRIPT, tmpRepo], { encoding: 'utf8' });
    assert.strictEqual(
      noFalsePositive.status,
      0,
      `an unescaped "." would wrongly match "/adlc-v1X2" as if it were "/adlc-v1.2"; guard should not fire here:\n${noFalsePositive.stderr}`
    );

    // Sanity check: the ACTUAL literal form (unnamespaced) is still caught, so
    // the escaping isn't just accidentally matching nothing at all.
    writeFileSync(fixtureDocPath, '# Fixture\n\nRun /adlc-v1.2 to use the fixture command.\n');
    const literalMatchStillCaught = spawnSync(process.execPath, [SCRIPT, tmpRepo], { encoding: 'utf8' });
    assert.notStrictEqual(literalMatchStillCaught.status, 0, 'the literal bare form "/adlc-v1.2" should still be caught');
    assert.match(literalMatchStillCaught.stderr, /bare, non-namespaced command reference/);
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('claude-code-plugin-smoke fails cleanly (not an uncaught crash) on a command filename containing an unbalanced regex metacharacter', () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), 'adlc-cc-smoke-'));
  try {
    cpSync(REPO, tmpRepo, {
      recursive: true,
      filter: (src) => !src.includes(`${resolve(REPO, '.git')}`) && !src.includes(`${resolve(REPO, 'node_modules')}`),
    });

    // An unescaped "(" in the alternation would throw "Unterminated group" from
    // `new RegExp(...)` — an uncaught SyntaxError, not this script's own fail().
    writeFileSync(
      join(tmpRepo, 'plugins/adlc-claude-code/commands/adlc-a(b.md'),
      '---\ndescription: a fixture-only command with a regex-hostile filename.\n---\n\n# fixture\n'
    );

    const result = spawnSync(process.execPath, [SCRIPT, tmpRepo], { encoding: 'utf8' });
    assert.doesNotMatch(result.stderr, /SyntaxError/, 'must not crash with an uncaught RegExp SyntaxError');
    assert.doesNotMatch(result.stderr, /Unterminated group/, 'must not crash with an uncaught RegExp SyntaxError');
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// Regression coverage: a command filename of exactly "adlc-.md" derives an
// EMPTY name, producing an empty alternative in the regex alternation
// (equivalent to `(?:init|ticket|)`). An empty alternative matches the empty
// string at any position, which widens "/adlc-<name>" into effectively
// "/adlc-" matching ANY bare command reference — silently reintroducing the
// "match too much" failure class the escaping fix exists to close, just via a
// different route (an empty string, not an unescaped metacharacter).
test('claude-code-plugin-smoke does not let a degenerate empty-name command file widen the match to any bare reference', () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), 'adlc-cc-smoke-'));
  try {
    cpSync(REPO, tmpRepo, {
      recursive: true,
      filter: (src) => !src.includes(`${resolve(REPO, '.git')}`) && !src.includes(`${resolve(REPO, 'node_modules')}`),
    });

    // A degenerate command filename that derives an empty name.
    writeFileSync(join(tmpRepo, 'plugins/adlc-claude-code/commands/adlc-.md'), '---\ndescription: a fixture-only degenerate command file.\n---\n\n# fixture\n');

    // An UNRELATED bare command name that isn't a real command at all — should
    // never be flagged. If the empty derived name widens the alternation, this
    // would wrongly match.
    const fixtureDocPath = join(tmpRepo, 'docs/fixture-empty-name.md');
    writeFileSync(fixtureDocPath, '# Fixture\n\nThis mentions /adlc-notarealcommand which must NOT be treated as a bare command match.\n');

    const result = spawnSync(process.execPath, [SCRIPT, tmpRepo], { encoding: 'utf8' });
    assert.strictEqual(
      result.status,
      0,
      `an empty derived name would wrongly widen the match to any "/adlc-<anything>" reference:\n${result.stderr}`
    );
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// Regression coverage: Node's Dirent.isDirectory() reports false for a symlink
// even when its target IS a directory, so collectMarkdownFiles() must not rely
// on the dirent's own type flags — a symlinked doc directory under docs/ would
// otherwise be recursed into by neither branch (not a directory by the dirent
// flag, and its name doesn't end in ".md" either), making it silently invisible
// to the scan with zero trace in the tool's output. This is the same "silent
// blind spot" failure class #96 exists to close, reached via a filesystem-type
// route instead of a hardcoded-list route.
test('claude-code-plugin-smoke follows a symlinked directory under docs/ instead of silently skipping it', () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), 'adlc-cc-smoke-'));
  try {
    cpSync(REPO, tmpRepo, {
      recursive: true,
      filter: (src) => !src.includes(`${resolve(REPO, '.git')}`) && !src.includes(`${resolve(REPO, 'node_modules')}`),
    });

    // A real directory OUTSIDE docs/, containing a bare-command doc, linked
    // INTO docs/ as a directory symlink (e.g. simulating a vendored/shared docs
    // tree in a monorepo).
    const externalDir = join(tmpRepo, '..', 'adlc-cc-smoke-external-docs');
    mkdirSync(externalDir, { recursive: true });
    writeFileSync(join(externalDir, 'hidden.md'), '# Hidden\n\nRun /adlc-ticket to get started.\n');
    symlinkSync(externalDir, join(tmpRepo, 'docs/linked-external'), 'dir');

    try {
      const result = spawnSync(process.execPath, [SCRIPT, tmpRepo], { encoding: 'utf8' });
      assert.notStrictEqual(
        result.status,
        0,
        'smoke test should fail on a bare command reference reached through a symlinked doc directory, not silently skip it'
      );
      assert.match(result.stderr, /bare, non-namespaced command reference/);
      assert.match(result.stderr, /linked-external/);
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

// Regression coverage: an earlier version of this guard had TWO independent,
// hand-duplicated recursive file-collection loops — one for the plugin's own
// guidance tree (commands/skills/agents/hooks), one for the doc-wide scan
// (docs/). The symlinked-directory fix (see the test above) was applied to
// only the doc-wide copy, leaving the plugin-tree copy with the IDENTICAL
// blind spot: a symlinked directory under commands/ (or skills/, agents/,
// hooks/) was invisible to the scan. Both now share one traversal
// (collectFilesRecursively) so this can't recur as "fixed in one of two
// copies but not the other" a third time. Prove the plugin-tree scan follows
// a symlinked directory too.
test('claude-code-plugin-smoke follows a symlinked directory under the plugin guidance tree instead of silently skipping it', () => {
  const tmpRepo = mkdtempSync(join(tmpdir(), 'adlc-cc-smoke-'));
  try {
    cpSync(REPO, tmpRepo, {
      recursive: true,
      filter: (src) => !src.includes(`${resolve(REPO, '.git')}`) && !src.includes(`${resolve(REPO, 'node_modules')}`),
    });

    const externalDir = join(tmpRepo, '..', 'adlc-cc-smoke-external-commands');
    mkdirSync(externalDir, { recursive: true });
    writeFileSync(join(externalDir, 'hidden.md'), '# Hidden\n\nRun /adlc-ticket to get started.\n');
    symlinkSync(externalDir, join(tmpRepo, 'plugins/adlc-claude-code/commands/linked-external'), 'dir');

    try {
      const result = spawnSync(process.execPath, [SCRIPT, tmpRepo], { encoding: 'utf8' });
      assert.notStrictEqual(
        result.status,
        0,
        'smoke test should fail on a bare command reference reached through a symlinked directory under commands/, not silently skip it'
      );
      assert.match(result.stderr, /bare, non-namespaced command reference/);
      assert.match(result.stderr, /linked-external/);
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true });
  }
});

/**
 * Tests for skill-rot — runs offline, uses mkdtemp temp dirs, cleaned up after each test.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { findSkills } from '../lib/find-skills.mjs';
import { extractClaims } from '../lib/extract-claims.mjs';
import { verifyClaim } from '../lib/verify-claims.mjs';
import { checkSkill } from '../lib/rot-checker.mjs';
import { parseFrontmatter, upsertFrontmatter } from '../lib/frontmatter.mjs';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'skill-rot-test-'));
}

function writeSkill(dir, relPath, content) {
  const full = join(dir, relPath);
  mkdirSync(resolve(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return full;
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/skill-rot.mjs', import.meta.url));

// ─── find-skills ────────────────────────────────────────────────────────────

describe('findSkills', () => {
  test('finds SKILL.md files recursively', () => {
    const tmp = makeTempDir();
    try {
      writeSkill(tmp, 'skills/foo/SKILL.md', '# Foo');
      writeSkill(tmp, 'skills/bar/baz/SKILL.md', '# Bar');
      writeSkill(tmp, 'skills/notme.md', '# Not a skill');

      const results = findSkills(['skills'], tmp);
      assert.equal(results.length, 2);
      assert.ok(results.some((p) => p.includes('foo/SKILL.md')));
      assert.ok(results.some((p) => p.includes('baz/SKILL.md')));
    } finally {
      cleanup(tmp);
    }
  });

  test('skips node_modules and .git', () => {
    const tmp = makeTempDir();
    try {
      writeSkill(tmp, 'skills/valid/SKILL.md', '# Valid');
      writeSkill(tmp, 'skills/node_modules/hidden/SKILL.md', '# Hidden');
      writeSkill(tmp, 'skills/.git/hidden/SKILL.md', '# Hidden');

      const results = findSkills(['skills'], tmp);
      assert.equal(results.length, 1);
      assert.ok(results[0].includes('valid/SKILL.md'));
    } finally {
      cleanup(tmp);
    }
  });

  test('returns empty array when root does not exist (non-strict)', () => {
    const tmp = makeTempDir();
    try {
      const results = findSkills(['nonexistent-root'], tmp);
      assert.deepEqual(results, []);
    } finally {
      cleanup(tmp);
    }
  });

  test('throws when root does not exist with strict: true', () => {
    const tmp = makeTempDir();
    try {
      assert.throws(() => {
        findSkills(['nonexistent-root'], tmp, { strict: true });
      }, /path does not exist/);
    } finally {
      cleanup(tmp);
    }
  });

  test('supports single SKILL.md file path as root', () => {
    const tmp = makeTempDir();
    try {
      const skillPath = writeSkill(tmp, 'my-skill/SKILL.md', '# My Skill');
      const results = findSkills(['my-skill/SKILL.md'], tmp, { strict: true });
      assert.equal(results.length, 1);
      assert.equal(results[0], skillPath);
    } finally {
      cleanup(tmp);
    }
  });

  test('strict: an explicit FILE that is not SKILL.md throws (not silently skipped)', () => {
    const tmp = makeTempDir();
    try {
      writeSkill(tmp, 'docs/README.md', '# not a skill');
      assert.throws(() => {
        findSkills(['docs/README.md'], tmp, { strict: true });
      }, /not a skills directory or SKILL\.md file/);
    } finally {
      cleanup(tmp);
    }
  });

  test('non-strict: an explicit FILE that is not SKILL.md is skipped', () => {
    const tmp = makeTempDir();
    try {
      writeSkill(tmp, 'docs/README.md', '# not a skill');
      assert.deepEqual(findSkills(['docs/README.md'], tmp), []);
    } finally {
      cleanup(tmp);
    }
  });

  // chmod 000 does not restrict root, and is not a permission model Windows
  // honours — the unreadable-subtree cases only mean something elsewhere.
  const canLockDirs = process.platform !== 'win32' && process.getuid?.() !== 0;

  test('strict: an unreadable subtree under an explicit root throws (not silently skipped)', { skip: !canLockDirs }, () => {
    const tmp = makeTempDir();
    const locked = join(tmp, 'skills', 'locked');
    try {
      writeSkill(tmp, 'skills/ok/SKILL.md', '# ok');
      mkdirSync(locked, { recursive: true });
      chmodSync(locked, 0o000);
      assert.throws(() => findSkills(['skills'], tmp, { strict: true }), /cannot read directory .*locked/);
    } finally {
      try { chmodSync(locked, 0o755); } catch {}
      cleanup(tmp);
    }
  });

  test('non-strict: an unreadable subtree is skipped and the readable skills are returned', { skip: !canLockDirs }, () => {
    const tmp = makeTempDir();
    const locked = join(tmp, 'skills', 'locked');
    try {
      const ok = writeSkill(tmp, 'skills/ok/SKILL.md', '# ok');
      mkdirSync(locked, { recursive: true });
      chmodSync(locked, 0o000);
      assert.deepEqual(findSkills(['skills'], tmp), [ok]);
    } finally {
      try { chmodSync(locked, 0o755); } catch {}
      cleanup(tmp);
    }
  });

  test('searches multiple roots', () => {
    const tmp = makeTempDir();
    try {
      writeSkill(tmp, '.claude/skills/a/SKILL.md', '# A');
      writeSkill(tmp, '.agents/skills/b/SKILL.md', '# B');
      // Only these two roots exist
      const results = findSkills(['.claude/skills', '.agents/skills', 'skills'], tmp);
      assert.equal(results.length, 2);
    } finally {
      cleanup(tmp);
    }
  });
});

describe('CLI explicit path validation', () => {
  test('fails with exit 1 when explicit positional directory does not exist', () => {
    const tmp = makeTempDir();
    try {
      const r = spawnSync(process.execPath, [BIN, 'nonexistent-skills-dir'], {
        cwd: tmp,
        encoding: 'utf8',
      });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /explicit search path does not exist/);
    } finally {
      cleanup(tmp);
    }
  });

  test('fails with exit 1 when explicit positional does not exist alongside valid root', () => {
    const tmp = makeTempDir();
    try {
      writeSkill(tmp, 'valid-skills/a/SKILL.md', '# Valid Skill\nRun `ls` to list.');
      const r = spawnSync(process.execPath, [BIN, 'valid-skills', 'missing-dir'], {
        cwd: tmp,
        encoding: 'utf8',
      });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /explicit search path does not exist/);
      assert.match(r.stderr, /missing-dir/);
    } finally {
      cleanup(tmp);
    }
  });

  test('emits json error with exit 1 when explicit path missing and --json passed', () => {
    const tmp = makeTempDir();
    try {
      const r = spawnSync(process.execPath, [BIN, 'typo-dir', '--json'], {
        cwd: tmp,
        encoding: 'utf8',
      });
      assert.equal(r.status, 1);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.error, 'explicit search path does not exist');
      assert.equal(parsed.path, 'typo-dir');
    } finally {
      cleanup(tmp);
    }
  });

  test('fails with exit 1 when an explicit positional is a file that is not SKILL.md', () => {
    const tmp = makeTempDir();
    try {
      writeSkill(tmp, 'docs/README.md', '# not a skill');
      const r = spawnSync(process.execPath, [BIN, 'docs/README.md'], { cwd: tmp, encoding: 'utf8' });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /not a skills directory or SKILL\.md file/);
      assert.match(r.stderr, /README\.md/);
    } finally {
      cleanup(tmp);
    }
  });

  test('fails with exit 1 when an explicit root holds an unreadable subtree', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
    const tmp = makeTempDir();
    const locked = join(tmp, 'skills', 'locked');
    try {
      writeSkill(tmp, 'skills/ok/SKILL.md', '# ok\nRun `ls` to list.');
      mkdirSync(locked, { recursive: true });
      chmodSync(locked, 0o000);
      const r = spawnSync(process.execPath, [BIN, 'skills'], { cwd: tmp, encoding: 'utf8' });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /cannot read directory .*locked/);
    } finally {
      try { chmodSync(locked, 0o755); } catch {}
      cleanup(tmp);
    }
  });

  test('succeeds when explicit paths all exist', () => {
    const tmp = makeTempDir();
    try {
      writeSkill(tmp, 'custom/my-skill/SKILL.md', '# Valid Skill\nRun `ls` to list.');
      const r = spawnSync(process.execPath, [BIN, 'custom'], {
        cwd: tmp,
        encoding: 'utf8',
      });
      assert.equal(r.status, 0);
    } finally {
      cleanup(tmp);
    }
  });
});

// ─── extract-claims ─────────────────────────────────────────────────────────

describe('extractClaims', () => {
  test('extracts command from inline backtick', () => {
    const content = 'Run `ls -la` to list files.';
    const claims = extractClaims(content);
    assert.ok(claims.some((c) => c.type === 'command' && c.value === 'ls'));
  });

  test('extracts command from fenced code block', () => {
    const content = '```bash\ngit status\n```';
    const claims = extractClaims(content);
    assert.ok(claims.some((c) => c.type === 'command' && c.value === 'git'));
  });

  test('extracts path from inline backtick', () => {
    const content = 'Edit `src/index.mjs` for config.';
    const claims = extractClaims(content);
    assert.ok(claims.some((c) => c.type === 'path' && c.value === 'src/index.mjs'));
  });

  test('extracts npm run script ref', () => {
    const content = 'Run `npm run build` to compile.';
    const claims = extractClaims(content);
    assert.ok(claims.some((c) => c.type === 'script' && c.value === 'build'));
  });

  test('extracts pnpm script ref', () => {
    const content = 'Use `pnpm test` to run tests.';
    const claims = extractClaims(content);
    assert.ok(claims.some((c) => c.type === 'script' && c.value === 'test'));
  });

  test('skips placeholder tokens like <NAME>', () => {
    const content = 'Run `<MY_COMMAND> arg` to do something.';
    const claims = extractClaims(content);
    // <MY_COMMAND> should not appear as a command claim
    assert.ok(!claims.some((c) => c.type === 'command' && c.value === '<MY_COMMAND>'));
  });

  test('skips UPPERCASE_VAR tokens', () => {
    const content = 'Set `MY_ENV_VAR=value` first.';
    const claims = extractClaims(content);
    assert.ok(!claims.some((c) => c.type === 'command' && c.value === 'MY_ENV_VAR'));
  });

  test('deduplicates repeated claims', () => {
    const content = 'Use `git` here and `git` there.';
    const claims = extractClaims(content);
    const gitClaims = claims.filter((c) => c.type === 'command' && c.value === 'git');
    assert.equal(gitClaims.length, 1);
  });
});

// ─── verify-claims ──────────────────────────────────────────────────────────

describe('verifyClaim — command', () => {
  test('ls command is ok', () => {
    const tmp = makeTempDir();
    try {
      const result = verifyClaim(
        { type: 'command', value: 'ls', raw: 'ls' },
        { repoRoot: tmp, skillDir: tmp }
      );
      assert.equal(result.status, 'ok');
    } finally {
      cleanup(tmp);
    }
  });

  test('definitely-not-a-binary-xyz is stale', () => {
    const tmp = makeTempDir();
    try {
      const result = verifyClaim(
        { type: 'command', value: 'definitely-not-a-binary-xyz', raw: 'definitely-not-a-binary-xyz' },
        { repoRoot: tmp, skillDir: tmp }
      );
      assert.equal(result.status, 'stale');
      assert.ok(result.reason.includes('definitely-not-a-binary-xyz'));
    } finally {
      cleanup(tmp);
    }
  });

  test('binary in node_modules/.bin is ok', () => {
    const tmp = makeTempDir();
    try {
      const binDir = join(tmp, 'node_modules', '.bin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, 'my-local-tool'), '#!/usr/bin/env node\n', { mode: 0o755 });

      const result = verifyClaim(
        { type: 'command', value: 'my-local-tool', raw: 'my-local-tool' },
        { repoRoot: tmp, skillDir: tmp }
      );
      assert.equal(result.status, 'ok');
    } finally {
      cleanup(tmp);
    }
  });

  test('placeholder token is unverifiable', () => {
    const tmp = makeTempDir();
    try {
      const result = verifyClaim(
        { type: 'command', value: 'MY_BINARY', raw: 'MY_BINARY' },
        { repoRoot: tmp, skillDir: tmp }
      );
      assert.equal(result.status, 'unverifiable');
    } finally {
      cleanup(tmp);
    }
  });
});

describe('verifyClaim — path', () => {
  test('existing path is ok', () => {
    const tmp = makeTempDir();
    try {
      writeFileSync(join(tmp, 'package.json'), '{}');
      const result = verifyClaim(
        { type: 'path', value: 'package.json', raw: 'package.json' },
        { repoRoot: tmp, skillDir: tmp }
      );
      // 'package.json' alone doesn't match PATH_RE (no /) — path claims with /
      // Let's test with a path containing /
      const result2 = verifyClaim(
        { type: 'path', value: 'src/index.mjs', raw: 'src/index.mjs' },
        { repoRoot: tmp, skillDir: tmp }
      );
      assert.equal(result2.status, 'stale'); // file doesn't exist
    } finally {
      cleanup(tmp);
    }
  });

  test('existing nested path is ok', () => {
    const tmp = makeTempDir();
    try {
      mkdirSync(join(tmp, 'src'), { recursive: true });
      writeFileSync(join(tmp, 'src', 'index.mjs'), 'export default {}');

      const result = verifyClaim(
        { type: 'path', value: 'src/index.mjs', raw: 'src/index.mjs' },
        { repoRoot: tmp, skillDir: tmp }
      );
      assert.equal(result.status, 'ok');
    } finally {
      cleanup(tmp);
    }
  });

  test('missing path is stale', () => {
    const tmp = makeTempDir();
    try {
      const result = verifyClaim(
        { type: 'path', value: 'nonexistent/file.mjs', raw: 'nonexistent/file.mjs' },
        { repoRoot: tmp, skillDir: tmp }
      );
      assert.equal(result.status, 'stale');
    } finally {
      cleanup(tmp);
    }
  });

  test('path relative to skill dir is ok', () => {
    const tmp = makeTempDir();
    try {
      const skillDir = join(tmp, 'skills', 'my-skill');
      mkdirSync(skillDir, { recursive: true });
      mkdirSync(join(skillDir, 'scripts'), { recursive: true });
      writeFileSync(join(skillDir, 'scripts', 'setup.sh'), '#!/bin/bash');

      const result = verifyClaim(
        { type: 'path', value: 'scripts/setup.sh', raw: 'scripts/setup.sh' },
        { repoRoot: tmp, skillDir }
      );
      assert.equal(result.status, 'ok');
    } finally {
      cleanup(tmp);
    }
  });
});

describe('verifyClaim — script', () => {
  test('script in package.json is ok', () => {
    const tmp = makeTempDir();
    try {
      writeFileSync(
        join(tmp, 'package.json'),
        JSON.stringify({ scripts: { build: 'tsc', test: 'node --test' } }),
        'utf8'
      );

      const result = verifyClaim(
        { type: 'script', value: 'build', raw: 'npm run build' },
        { repoRoot: tmp, skillDir: tmp }
      );
      assert.equal(result.status, 'ok');
    } finally {
      cleanup(tmp);
    }
  });

  test('missing script in package.json is stale', () => {
    const tmp = makeTempDir();
    try {
      writeFileSync(
        join(tmp, 'package.json'),
        JSON.stringify({ scripts: { build: 'tsc' } }),
        'utf8'
      );

      const result = verifyClaim(
        { type: 'script', value: 'deploy', raw: 'npm run deploy' },
        { repoRoot: tmp, skillDir: tmp }
      );
      assert.equal(result.status, 'stale');
    } finally {
      cleanup(tmp);
    }
  });

  test('no package.json is unverifiable', () => {
    const tmp = makeTempDir();
    try {
      const result = verifyClaim(
        { type: 'script', value: 'build', raw: 'npm run build' },
        { repoRoot: tmp, skillDir: tmp }
      );
      assert.equal(result.status, 'unverifiable');
    } finally {
      cleanup(tmp);
    }
  });
});

// ─── frontmatter ────────────────────────────────────────────────────────────

describe('parseFrontmatter', () => {
  test('parses existing frontmatter', () => {
    const content = '---\ntitle: My Skill\nauthor: test\n---\n# Body\n';
    const { frontmatter, body, hasFrontmatter } = parseFrontmatter(content);
    assert.equal(hasFrontmatter, true);
    assert.equal(frontmatter.title, 'My Skill');
    assert.equal(frontmatter.author, 'test');
    assert.ok(body.includes('# Body'));
  });

  test('returns hasFrontmatter=false when no frontmatter', () => {
    const content = '# My Skill\nSome content.\n';
    const { hasFrontmatter, frontmatter } = parseFrontmatter(content);
    assert.equal(hasFrontmatter, false);
    assert.deepEqual(frontmatter, {});
  });
});

describe('upsertFrontmatter', () => {
  test('creates frontmatter block when absent', () => {
    const content = '# My Skill\nSome content.\n';
    const updated = upsertFrontmatter(content, 'last-verified', '2026-06-10');
    assert.ok(updated.startsWith('---\n'));
    assert.ok(updated.includes('last-verified: 2026-06-10'));
    assert.ok(updated.includes('# My Skill'));
  });

  test('updates existing key in frontmatter', () => {
    const content = '---\nlast-verified: 2025-01-01\ntitle: test\n---\n# Body\n';
    const updated = upsertFrontmatter(content, 'last-verified', '2026-06-10');
    assert.ok(updated.includes('last-verified: 2026-06-10'));
    assert.ok(!updated.includes('2025-01-01'));
    assert.ok(updated.includes('title: test'));
  });

  test('is idempotent — applying same value twice yields same result', () => {
    const content = '# My Skill\nContent here.\n';
    const once = upsertFrontmatter(content, 'last-verified', '2026-06-10');
    const twice = upsertFrontmatter(once, 'last-verified', '2026-06-10');
    assert.equal(once, twice);
  });

  test('adds new key to existing frontmatter', () => {
    const content = '---\ntitle: test\n---\n# Body\n';
    const updated = upsertFrontmatter(content, 'last-verified', '2026-06-10');
    assert.ok(updated.includes('title: test'));
    assert.ok(updated.includes('last-verified: 2026-06-10'));
  });
});

// ─── checkSkill (integration) ───────────────────────────────────────────────

describe('checkSkill', () => {
  test('skill with only valid commands is clean', () => {
    const tmp = makeTempDir();
    try {
      const skillPath = writeSkill(tmp, 'skills/good/SKILL.md', [
        '# Good Skill',
        'Use `ls` and `cat` to explore files.',
      ].join('\n'));

      const result = checkSkill(skillPath, tmp);
      assert.equal(result.stale, 0);
      assert.equal(result.allOk, true);
    } finally {
      cleanup(tmp);
    }
  });

  test('skill with fake command is stale', () => {
    const tmp = makeTempDir();
    try {
      const skillPath = writeSkill(tmp, 'skills/bad/SKILL.md', [
        '# Bad Skill',
        'Run `definitely-not-a-binary-xyz --flag` to do things.',
      ].join('\n'));

      const result = checkSkill(skillPath, tmp);
      assert.equal(result.stale, 1);
      assert.equal(result.allOk, false);
      assert.equal(result.staleDetails.length, 1);
    } finally {
      cleanup(tmp);
    }
  });

  test('skill with missing file path is stale', () => {
    const tmp = makeTempDir();
    try {
      const skillPath = writeSkill(tmp, 'skills/pathtest/SKILL.md', [
        '# Path Skill',
        'Edit `src/missing-file.mjs` to configure.',
      ].join('\n'));

      const result = checkSkill(skillPath, tmp);
      assert.equal(result.stale, 1);
    } finally {
      cleanup(tmp);
    }
  });

  test('skill with existing path is ok', () => {
    const tmp = makeTempDir();
    try {
      mkdirSync(join(tmp, 'src'), { recursive: true });
      writeFileSync(join(tmp, 'src', 'app.mjs'), 'export default {}');

      const skillPath = writeSkill(tmp, 'skills/pathtest/SKILL.md', [
        '# Path Skill',
        'Edit `src/app.mjs` to configure.',
      ].join('\n'));

      const result = checkSkill(skillPath, tmp);
      assert.equal(result.stale, 0);
    } finally {
      cleanup(tmp);
    }
  });

  test('skill with valid script ref is ok', () => {
    const tmp = makeTempDir();
    try {
      writeFileSync(
        join(tmp, 'package.json'),
        JSON.stringify({ scripts: { build: 'tsc' } }),
        'utf8'
      );

      const skillPath = writeSkill(tmp, 'skills/scripttest/SKILL.md', [
        '# Script Skill',
        'Run `npm run build` to compile.',
      ].join('\n'));

      const result = checkSkill(skillPath, tmp);
      assert.equal(result.stale, 0);
    } finally {
      cleanup(tmp);
    }
  });

  test('skill with missing script is stale', () => {
    const tmp = makeTempDir();
    try {
      writeFileSync(
        join(tmp, 'package.json'),
        JSON.stringify({ scripts: { build: 'tsc' } }),
        'utf8'
      );

      const skillPath = writeSkill(tmp, 'skills/scripttest/SKILL.md', [
        '# Script Skill',
        'Run `npm run deploy` to release.',
      ].join('\n'));

      const result = checkSkill(skillPath, tmp);
      assert.equal(result.stale, 1);
    } finally {
      cleanup(tmp);
    }
  });

  test('--write upserts last-verified when all claims ok', () => {
    const tmp = makeTempDir();
    try {
      const skillPath = writeSkill(tmp, 'skills/write-test/SKILL.md', [
        '# Write Test',
        'Use `ls` to list files.',
      ].join('\n'));

      checkSkill(skillPath, tmp, { write: true });

      const updated = readFileSync(skillPath, 'utf8');
      assert.ok(updated.includes('last-verified:'));
      // Verify it's an ISO date pattern
      assert.match(updated, /last-verified: \d{4}-\d{2}-\d{2}/);
    } finally {
      cleanup(tmp);
    }
  });

  test('--write does not upsert when skill has stale claims', () => {
    const tmp = makeTempDir();
    try {
      const skillPath = writeSkill(tmp, 'skills/write-stale/SKILL.md', [
        '# Stale Write Test',
        'Run `definitely-not-a-binary-xyz` for magic.',
      ].join('\n'));

      checkSkill(skillPath, tmp, { write: true });

      const content = readFileSync(skillPath, 'utf8');
      assert.ok(!content.includes('last-verified:'));
    } finally {
      cleanup(tmp);
    }
  });

  test('--write is idempotent (applying twice yields consistent result)', () => {
    const tmp = makeTempDir();
    try {
      const skillPath = writeSkill(tmp, 'skills/idempotent/SKILL.md', [
        '# Idempotent',
        'Use `ls` to list.',
      ].join('\n'));

      checkSkill(skillPath, tmp, { write: true });
      const after1 = readFileSync(skillPath, 'utf8');

      checkSkill(skillPath, tmp, { write: true });
      const after2 = readFileSync(skillPath, 'utf8');

      assert.equal(after1, after2);
    } finally {
      cleanup(tmp);
    }
  });

  test('unverifiable claims are not counted as stale', () => {
    const tmp = makeTempDir();
    try {
      // No package.json → script is unverifiable, not stale
      const skillPath = writeSkill(tmp, 'skills/unverifiable/SKILL.md', [
        '# Unverifiable',
        'Run `npm run build` or `MY_COMMAND arg`.',
      ].join('\n'));

      const result = checkSkill(skillPath, tmp);
      assert.equal(result.stale, 0);
      assert.ok(result.unverifiable >= 1);
      assert.equal(result.allOk, true);
    } finally {
      cleanup(tmp);
    }
  });
});

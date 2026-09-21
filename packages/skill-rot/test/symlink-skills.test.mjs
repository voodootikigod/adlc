/**
 * Tests for symlink traversal in skill-rot (issue #765).
 * Validates discovery through symlinked directories and symlinked SKILL.md files,
 * cycle detection on recursive symlink graphs, and broken symlink handling.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { findSkills } from '../lib/find-skills.mjs';
import { checkSkill } from '../lib/rot-checker.mjs';

const BIN = fileURLToPath(new URL('../bin/skill-rot.mjs', import.meta.url));

describe('symlink skill discovery (issue #765)', () => {
  test('AC1: skill inside a symlinked directory is discovered and inspected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-rot-symlink-'));
    try {
      const targetDir = join(dir, 'shared', 'my-skill');
      mkdirSync(targetDir, { recursive: true });
      const skillFile = join(targetDir, 'SKILL.md');
      writeFileSync(skillFile, '# My Linked Skill\n- `ls`\n', 'utf8');

      const skillsDir = join(dir, 'skills');
      mkdirSync(skillsDir, { recursive: true });
      symlinkSync(targetDir, join(skillsDir, 'linked-skill'));

      const results = findSkills(['skills'], dir);
      assert.equal(results.length, 1);
      assert.equal(results[0], join(skillsDir, 'linked-skill', 'SKILL.md'));

      const check = checkSkill(results[0], dir);
      assert.equal(check.allOk, true);
      assert.equal(check.ok, 1);
      assert.equal(check.stale, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('AC2: symlinked SKILL.md file is discovered and inspected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-rot-symlink-'));
    try {
      const sharedDir = join(dir, 'shared');
      mkdirSync(sharedDir, { recursive: true });
      const targetFile = join(sharedDir, 'actual-skill.md');
      writeFileSync(targetFile, '# Shared Skill File\n- `ls`\n', 'utf8');

      const skillDir = join(dir, 'skills', 'skill-b');
      mkdirSync(skillDir, { recursive: true });
      const symlinkFile = join(skillDir, 'SKILL.md');
      symlinkSync(targetFile, symlinkFile);

      const results = findSkills(['skills'], dir);
      assert.equal(results.length, 1);
      assert.equal(results[0], symlinkFile);

      const check = checkSkill(results[0], dir);
      assert.equal(check.allOk, true);
      assert.equal(check.ok, 1);
      assert.equal(check.stale, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('AC3: cyclic symlinks do not loop infinitely and discover valid skills', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-rot-symlink-'));
    try {
      const skillDir = join(dir, 'skills', 'cyclic-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), '# Cyclic Skill\n- `ls`\n', 'utf8');

      // Create self-referential loop inside cyclic-skill
      symlinkSync(skillDir, join(skillDir, 'self-loop'));

      // Create mutual loop between subdirectories
      const subA = join(skillDir, 'subA');
      const subB = join(skillDir, 'subB');
      mkdirSync(subA, { recursive: true });
      mkdirSync(subB, { recursive: true });
      symlinkSync(subA, join(subB, 'to_a'));
      symlinkSync(subB, join(subA, 'to_b'));

      const results = findSkills(['skills'], dir);
      assert.equal(results.length, 1);
      assert.equal(results[0], join(skillDir, 'SKILL.md'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('broken symlinks: ignored in non-strict mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-rot-symlink-'));
    try {
      const skillsDir = join(dir, 'skills');
      const validSkillDir = join(skillsDir, 'valid');
      mkdirSync(validSkillDir, { recursive: true });
      writeFileSync(join(validSkillDir, 'SKILL.md'), '# Valid Skill\n- `ls`\n', 'utf8');

      symlinkSync(join(dir, 'nonexistent-target'), join(skillsDir, 'broken-link'));

      const results = findSkills(['skills'], dir, { strict: false });
      assert.equal(results.length, 1);
      assert.equal(results[0], join(validSkillDir, 'SKILL.md'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('broken symlinks: throws error in strict mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-rot-symlink-'));
    try {
      const skillsDir = join(dir, 'skills');
      mkdirSync(skillsDir, { recursive: true });
      symlinkSync(join(dir, 'nonexistent-target'), join(skillsDir, 'broken-link'));

      assert.throws(() => {
        findSkills(['skills'], dir, { strict: true });
      }, /broken symlink/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('symlinked file that is not SKILL.md is not discovered', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-rot-symlink-'));
    try {
      const sharedDir = join(dir, 'shared');
      mkdirSync(sharedDir, { recursive: true });
      const targetFile = join(sharedDir, 'notes.txt');
      writeFileSync(targetFile, 'Just some notes\n', 'utf8');

      const skillDir = join(dir, 'skills', 'skill-c');
      mkdirSync(skillDir, { recursive: true });
      symlinkSync(targetFile, join(skillDir, 'notes.txt'));

      const results = findSkills(['skills'], dir);
      assert.equal(results.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('CLI discovers and inspects symlinked skills successfully', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-rot-symlink-'));
    try {
      const targetDir = join(dir, 'shared', 'cli-skill');
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, 'SKILL.md'), '# CLI Skill\n- `ls`\n', 'utf8');

      const skillsDir = join(dir, 'skills');
      mkdirSync(skillsDir, { recursive: true });
      symlinkSync(targetDir, join(skillsDir, 'cli-skill'));

      const proc = spawnSync(process.execPath, [BIN, 'skills', '--json'], {
        cwd: dir,
        encoding: 'utf8',
      });
      assert.equal(proc.status, 0, `CLI failed with stderr: ${proc.stderr}`);
      const parsed = JSON.parse(proc.stdout);
      assert.equal(parsed.skills.length, 1);
      assert.equal(parsed.skills[0].allOk, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

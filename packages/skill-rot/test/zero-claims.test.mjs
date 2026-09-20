/**
 * Tests for zero-claim skills in skill-rot (GitHub issue #766).
 * Verifies that zero-claim skills:
 *  - are NOT stamped with last-verified under --write (AC1)
 *  - emit allOk: false from checkSkill (AC2)
 *  - format as [NO-CLAIMS] in CLI / table output (AC3)
 *  - report distinctly in summary counts for table and JSON (AC3)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { checkSkill } from '../lib/rot-checker.mjs';
import { formatTable, formatJson } from '../lib/format.mjs';

const BIN = fileURLToPath(new URL('../bin/skill-rot.mjs', import.meta.url));

function writeSkill(dir, relPath, content) {
  const full = join(dir, relPath);
  mkdirSync(resolve(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return full;
}

describe('zero-claim skills (issue #766)', () => {
  test('AC1: prose-only SKILL.md with 0 claims is NOT stamped with last-verified under --write', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'skill-rot-zero-claims-test-'));
    try {
      const skillContent = [
        '---',
        'title: Pure Prose Skill',
        '---',
        '# Pure Prose Skill',
        'This skill contains no command invocations, no code fences, and no file paths.',
        'It is entirely explanatory text with no checkable claims.',
      ].join('\n');

      const skillPath = writeSkill(tmp, 'skills/prose/SKILL.md', skillContent);

      checkSkill(skillPath, tmp, { write: true });

      const contentAfterCheck = readFileSync(skillPath, 'utf8');
      assert.ok(
        !contentAfterCheck.includes('last-verified:'),
        'zero-claim skill must NOT have last-verified stamped into frontmatter by checkSkill'
      );

      // Verify CLI --write also leaves the file unstamped
      const r = spawnSync(process.execPath, [BIN, 'skills/prose/SKILL.md', '--write'], {
        cwd: tmp,
        encoding: 'utf8',
      });
      assert.equal(r.status, 0);

      const contentAfterCli = readFileSync(skillPath, 'utf8');
      assert.ok(
        !contentAfterCli.includes('last-verified:'),
        'zero-claim skill must NOT have last-verified stamped into frontmatter by CLI --write'
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('AC2: checkSkill emits allOk: false when skill has 0 claims, and allOk: true only when okCount > 0 && staleCount === 0', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'skill-rot-zero-claims-test-'));
    try {
      // 1. Zero-claim skill
      const zeroSkillPath = writeSkill(tmp, 'skills/zero/SKILL.md', [
        '# Zero Claims',
        'Just plain text with zero verifiable claims whatsoever.',
      ].join('\n'));

      const zeroResult = checkSkill(zeroSkillPath, tmp);
      assert.equal(zeroResult.ok, 0);
      assert.equal(zeroResult.stale, 0);
      assert.equal(zeroResult.unverifiable, 0);
      assert.equal(zeroResult.allOk, false, 'allOk must be false for zero-claim skill');

      // 2. Skill with valid command claims
      const goodSkillPath = writeSkill(tmp, 'skills/good/SKILL.md', [
        '# Good Claims',
        'Run `ls` to list directory contents.',
      ].join('\n'));

      const goodResult = checkSkill(goodSkillPath, tmp);
      assert.ok(goodResult.ok > 0);
      assert.equal(goodResult.stale, 0);
      assert.equal(goodResult.allOk, true, 'allOk must be true when okCount > 0 && staleCount === 0');

      // 3. Skill with stale claim
      const badSkillPath = writeSkill(tmp, 'skills/bad/SKILL.md', [
        '# Bad Claims',
        'Run `totally-bogus-command-never-exists-xyz` here.',
      ].join('\n'));

      const badResult = checkSkill(badSkillPath, tmp);
      assert.ok(badResult.stale > 0);
      assert.equal(badResult.allOk, false, 'allOk must be false when staleCount > 0');

      // 4. Existing unverifiable pattern (skill-rot.test.mjs:721)
      // `npm run build` extracts command claim `npm` (ok) and script claim `build` (unverifiable).
      // Because okCount > 0 and staleCount === 0, allOk is true, preserving existing test behavior.
      const mixedUnverifiablePath = writeSkill(tmp, 'skills/mixed-unverifiable/SKILL.md', [
        '# Unverifiable',
        'Run `npm run build` or `MY_COMMAND arg`.',
      ].join('\n'));

      const mixedResult = checkSkill(mixedUnverifiablePath, tmp);
      assert.equal(mixedResult.stale, 0);
      assert.ok(mixedResult.ok > 0, 'npm in backticks extracts as an ok command claim');
      assert.ok(mixedResult.unverifiable >= 1, 'script with no package.json is unverifiable');
      assert.equal(mixedResult.allOk, true, 'allOk is true because okCount > 0 and staleCount === 0');

      // 5. Skill with zero ok claims and only unverifiable claims
      // A script reference with no backticks and no package.json: yarn run my-script
      const pureUnverifiablePath = writeSkill(tmp, 'skills/pure-unverifiable/SKILL.md', [
        '# Pure Unverifiable',
        'Run yarn run my-script for details.',
      ].join('\n'));

      const pureResult = checkSkill(pureUnverifiablePath, tmp);
      assert.equal(pureResult.ok, 0);
      assert.equal(pureResult.stale, 0);
      assert.equal(pureResult.unverifiable, 1);
      assert.equal(pureResult.allOk, false, 'allOk must be false when okCount === 0 even with unverifiable claims');

      // Confirm --write does not stamp a skill with zero ok claims
      checkSkill(pureUnverifiablePath, tmp, { write: true });
      const pureContent = readFileSync(pureUnverifiablePath, 'utf8');
      assert.ok(!pureContent.includes('last-verified:'), 'unverifiable-only skill must not be stamped');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('AC3: formatTable renders [NO-CLAIMS] and distinct summary counts', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'skill-rot-zero-claims-test-'));
    try {
      const zeroSkillPath = writeSkill(tmp, 'skills/zero/SKILL.md', '# Zero\nJust prose.');
      const goodSkillPath = writeSkill(tmp, 'skills/good/SKILL.md', '# Good\nRun `ls`.');
      const badSkillPath = writeSkill(tmp, 'skills/bad/SKILL.md', '# Bad\nRun `definitely-not-a-command-xyz`.');

      const results = [
        checkSkill(zeroSkillPath, tmp),
        checkSkill(goodSkillPath, tmp),
        checkSkill(badSkillPath, tmp),
      ];

      const table = formatTable(results, tmp);

      // Verify zero-claim status icon
      assert.ok(table.includes('[NO-CLAIMS]'), 'table output must include [NO-CLAIMS]');
      assert.ok(table.includes('[OK]'), 'table output must include [OK]');
      assert.ok(table.includes('[STALE]'), 'table output must include [STALE]');

      // Verify summary line reports zero claims distinctly
      assert.match(
        table,
        /Summary: 3 skill\(s\) checked, 1 clean, 1 stale, 1 no claims/,
        'table summary must report clean, stale, and no claims distinctly'
      );

      // Verify counts with multiple clean skills and zero stale
      const good2SkillPath = writeSkill(tmp, 'skills/good2/SKILL.md', '# Good 2\nRun `cat`.');
      const resultsMultipleClean = [
        checkSkill(zeroSkillPath, tmp),
        checkSkill(goodSkillPath, tmp),
        checkSkill(good2SkillPath, tmp),
      ];
      const tableMultipleClean = formatTable(resultsMultipleClean, tmp);
      assert.match(
        tableMultipleClean,
        /Summary: 3 skill\(s\) checked, 2 clean, 0 stale, 1 no claims/,
        'must report exactly 2 clean, 0 stale, 1 no claims'
      );

      // Verify counts with multiple stale skills and zero no-claims
      const bad2SkillPath = writeSkill(tmp, 'skills/bad2/SKILL.md', '# Bad 2\nRun `fake-tool-xyz`.');
      const resultsMultipleStale = [
        checkSkill(goodSkillPath, tmp),
        checkSkill(badSkillPath, tmp),
        checkSkill(bad2SkillPath, tmp),
      ];
      const tableMultipleStale = formatTable(resultsMultipleStale, tmp);
      assert.match(
        tableMultipleStale,
        /Summary: 3 skill\(s\) checked, 1 clean, 2 stale, 0 no claims/,
        'must report exactly 1 clean, 2 stale, 0 no claims'
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('AC3: formatJson marks noClaims: true and distinct summary count', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'skill-rot-zero-claims-test-'));
    try {
      const zeroSkillPath = writeSkill(tmp, 'skills/zero/SKILL.md', '# Zero\nJust prose.');
      const goodSkillPath = writeSkill(tmp, 'skills/good/SKILL.md', '# Good\nRun `ls`.');

      const results = [
        checkSkill(zeroSkillPath, tmp),
        checkSkill(goodSkillPath, tmp),
      ];

      const json = formatJson(results, tmp);

      // Verify skills array
      const zeroEntry = json.skills.find((s) => s.path.includes('zero'));
      const goodEntry = json.skills.find((s) => s.path.includes('good'));

      assert.ok(zeroEntry, 'zero entry must exist in json output');
      assert.equal(zeroEntry.allOk, false, 'zero entry allOk must be false');
      assert.equal(zeroEntry.noClaims, true, 'zero entry must have noClaims: true');

      assert.ok(goodEntry, 'good entry must exist in json output');
      assert.equal(goodEntry.allOk, true, 'good entry allOk must be true');
      assert.notEqual(goodEntry.noClaims, true, 'good entry must not have noClaims: true');

      // Verify summary
      assert.equal(json.summary.total, 2);
      assert.equal(json.summary.clean, 1);
      assert.equal(json.summary.stale, 0);
      assert.equal(json.summary.noClaims, 1, 'json summary must have noClaims count');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('AC3: CLI outputs [NO-CLAIMS] for prose skill and exits 0', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'skill-rot-zero-claims-test-'));
    try {
      writeSkill(tmp, 'skills/prose/SKILL.md', '# Pure Prose\nNo verifiable code claims.');

      // Human table output
      const tableRun = spawnSync(process.execPath, [BIN, 'skills'], {
        cwd: tmp,
        encoding: 'utf8',
      });
      assert.equal(tableRun.status, 0, 'CLI must exit 0 for zero-claim skill');
      assert.ok(tableRun.stdout.includes('[NO-CLAIMS]'), 'stdout must contain [NO-CLAIMS]');
      assert.ok(!tableRun.stdout.includes('[OK]'), 'stdout must not contain [OK] for zero-claim skill');
      assert.match(tableRun.stdout, /1 no claims/);

      // JSON output
      const jsonRun = spawnSync(process.execPath, [BIN, 'skills', '--json'], {
        cwd: tmp,
        encoding: 'utf8',
      });
      assert.equal(jsonRun.status, 0, 'CLI --json must exit 0 for zero-claim skill');
      const parsed = JSON.parse(jsonRun.stdout);
      assert.equal(parsed.skills[0].allOk, false);
      assert.equal(parsed.skills[0].noClaims, true);
      assert.equal(parsed.summary.noClaims, 1);
      assert.equal(parsed.summary.clean, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

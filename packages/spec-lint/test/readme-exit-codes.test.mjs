// readme-exit-codes.test.mjs — the shipped documentation must agree with the
// shipped binary about what a zero-criteria spec exits with.
//
// Issue #525: #494 made zero recognized criteria fail closed (exit 2), but the
// exit-code table in packages/spec-lint/README.md still carried the pre-#494
// parenthetical "(or no criteria found; warns loudly)" on its `0` row. That
// README is what npm renders and what ships inside the tarball, so a user
// upgrading and seeing a new exit 2 consults it, reads that 0 is the documented
// outcome for exactly their case, and hunts a phantom regression in their own
// CI wiring instead of adding criteria.
//
// The table rows are parsed rather than string-compared: a prose rewording must
// not fail this test, and a reinstated "zero criteria passes" claim must.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PKG_ROOT = join(HERE, '..');
const REPO_ROOT = join(PKG_ROOT, '..', '..');
const BIN = join(PKG_ROOT, 'bin', 'spec-lint.mjs');
const README = join(PKG_ROOT, 'README.md');

const ZERO_CRITERIA_SPEC = '# Spec: thing\n\n## Summary\nDo the thing.\n';

function runOnZeroCriteriaSpec() {
  const dir = mkdtempSync(join(tmpdir(), 'spec-lint-readme-'));
  const spec = join(dir, 'nocrit.md');
  writeFileSync(spec, ZERO_CRITERIA_SPEC);
  try {
    execFileSync(process.execPath, [BIN, spec], { encoding: 'utf8' });
    return 0;
  } catch (err) {
    return err.status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Pull the `| code | meaning |` rows out of the README's Exit codes table.
 * @param {string} markdown
 * @returns {Map<string, string>} exit code -> meaning cell
 */
function parseExitCodeTable(markdown) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => /^#{2,6}\s+Exit codes\s*$/i.test(l));
  assert.notEqual(start, -1, 'README must have an "Exit codes" heading');
  const rows = new Map();
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^#{1,6}\s/.test(line)) break;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    const code = cells[1].replace(/`/g, '');
    if (!/^[0-9]+$/.test(code)) continue;
    rows.set(code, cells[2]);
  }
  return rows;
}

/** Files that document behaviour; excludes vendored trees and history. */
function docFiles(root) {
  const skipDirs = new Set(['node_modules', '.git', '.worktrees', 'dist', 'build', '.next', 'coverage']);
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (extname(entry.name) === '.md' || extname(entry.name) === '.mdx') out.push(full);
    }
  };
  walk(root);
  return out;
}

// A line is a stale zero-criteria pass claim when it says a check with nothing
// to check succeeds. Both halves must be present: prose that merely NAMES the
// zero-criteria case (an audit note, a `2` row) is not a claim that it passes.
const NOTHING_TO_CHECK = /no criteria found|nothing to check/i;
const CLAIMS_PASS = /(^|[^\w`])0([^\w`]|$)|\bpasse?s\b/i;

describe('spec-lint documented exit codes match the binary (issue #525)', () => {
  it('the binary exits 2 on a spec with no acceptance criteria', () => {
    assert.equal(runOnZeroCriteriaSpec(), 2);
  });

  it('the README exit-code table does not promise 0 for a zero-criteria spec', () => {
    const rows = parseExitCodeTable(readFileSync(README, 'utf8'));
    const zero = rows.get('0');
    assert.ok(zero, 'README exit-code table must document exit 0');
    assert.doesNotMatch(
      zero,
      NOTHING_TO_CHECK,
      'the `0` row still claims a spec with no criteria passes; the binary exits 2',
    );
  });

  it('the README exit-code table names the zero-criteria case under 2', () => {
    const rows = parseExitCodeTable(readFileSync(README, 'utf8'));
    const two = rows.get('2');
    assert.ok(two, 'README exit-code table must document exit 2');
    assert.match(
      two,
      /criteri/i,
      'the `2` row must mention criteria at all',
    );
    assert.match(
      two,
      /\b(no|zero|none|without|absent)\b/i,
      'the `2` row must state that a spec with no criteria also fails',
    );
  });

  it('no documentation file in the repo still claims exit 0 when there is nothing to check', () => {
    if (!existsSync(join(REPO_ROOT, 'docs')) || !statSync(join(REPO_ROOT, 'docs')).isDirectory()) {
      return; // published tarball, not a source checkout — nothing repo-wide to scan
    }
    const offenders = [];
    for (const file of docFiles(REPO_ROOT)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (NOTHING_TO_CHECK.test(line) && CLAIMS_PASS.test(line)) {
          offenders.push(`${file.slice(REPO_ROOT.length + 1)}:${i + 1}`);
        }
      });
    }
    assert.deepEqual(offenders, [], `stale zero-criteria pass claims remain:\n${offenders.join('\n')}`);
  });
});

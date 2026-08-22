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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs';
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

/**
 * Tracked `.md`/`.mdx` paths under `root`, or `null` when git cannot answer for
 * this tree — no git binary, or `root` is not the top of a work tree (a
 * published tarball, a consumer's `node_modules` copy). `null` and empty are
 * different answers on purpose: an empty list would make the repo-wide scan
 * below pass vacuously, so a git that fails says nothing and the caller walks.
 * @returns {string[] | null}
 */
function trackedDocFiles(root) {
  const git = (args) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let top;
  try {
    top = git(['rev-parse', '--show-toplevel']).trim();
    // A subdirectory of some other repo (a TMPDIR inside a checkout, say) is
    // not this tree; only the work-tree root gets the tracked-file answer.
    if (!top || realpathSync(top) !== realpathSync(root)) return null;
    return git(['ls-files', '-z', '--', '*.md', '*.mdx'])
      .split('\0')
      .filter(Boolean)
      .map((rel) => join(root, rel))
      // an index entry whose file is deleted in the work tree is not readable
      .filter((file) => existsSync(file));
  } catch {
    return null;
  }
}

/** Files that document behaviour; excludes vendored trees and history. */
function docFiles(root) {
  // Only tracked files ship, and only shipped docs can be wrong. An operator's
  // untracked scratch at the repo root — an audit report quoting the very claim
  // it reports — used to redden this suite with every shipped doc correct.
  const tracked = trackedDocFiles(root);
  if (tracked) return tracked;

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
        // A nested git checkout is another branch's tree, not ours. `skipDirs`
        // names `.worktrees`, but this repo keeps worktrees under
        // `.claude/worktrees/` (.git/info/exclude), so the scan used to read a
        // dead branch's docs and fail on them. A linked worktree has a `.git`
        // file; a submodule or nested clone has a `.git` directory.
        if (existsSync(join(full, '.git'))) continue;
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

/**
 * `file:line` for every line in `files` that makes the stale claim.
 * @param {string[]} files absolute paths
 * @param {string} root prefix stripped from the reported paths
 */
function staleClaimOffenders(files, root) {
  const offenders = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (NOTHING_TO_CHECK.test(line) && CLAIMS_PASS.test(line)) {
        offenders.push(`${file.slice(root.length + 1)}:${i + 1}`);
      }
    });
  }
  return offenders;
}

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

  // The repo-wide scan above must see only THIS checkout's docs. Worktrees here
  // live under `.claude/worktrees/`, which the skip list does not name, so the
  // walk used to read another branch's stale docs and fail on them — red on any
  // operator's machine, green in CI, with nothing wrong in the shipped docs.
  it('the doc scan does not descend into a nested git checkout', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'spec-lint-walk-')));
    try {
      writeFileSync(join(root, 'ours.md'), '# ours\n');

      const worktree = join(root, '.claude', 'worktrees', 'stale');
      mkdirSync(worktree, { recursive: true });
      writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/stale\n');
      // exactly the stale claim this suite exists to catch — but on a dead branch
      writeFileSync(join(worktree, 'stale.md'), '| `0` | no criteria found; passes |\n');

      const scanned = docFiles(root).map((f) => f.slice(root.length + 1));
      assert.ok(scanned.includes('ours.md'), 'our own docs are still scanned');
      assert.deepEqual(scanned.filter((f) => f.startsWith('.claude')), [], 'nested checkout not scanned');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // Only tracked docs ship. An operator's untracked scratch at the repo root —
  // a release-audit report that QUOTES this claim while reporting it — is not a
  // doc making the claim, but the heuristic cannot tell quoting from claiming.
  // Scanning it turned every audit run into a red suite with every shipped doc
  // correct. Tracking the same file must still catch it: the gate stays live.
  it('the doc scan reads tracked docs only', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'spec-lint-tracked-')));
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    try {
      git('init', '-q');

      writeFileSync(join(root, 'shipped.md'), '# shipped\n');
      git('add', 'shipped.md');
      // exactly the stale claim this suite exists to catch, quoted by a report
      writeFileSync(join(root, 'audit-report.md'), '| `0` | no criteria found; passes |\n');

      const untracked = docFiles(root).map((f) => f.slice(root.length + 1));
      assert.deepEqual(untracked, ['shipped.md'], 'an untracked doc is not scanned');
      assert.deepEqual(
        staleClaimOffenders(docFiles(root), root),
        [],
        'an untracked report quoting the claim does not redden the scan',
      );

      git('add', 'audit-report.md');
      assert.deepEqual(
        staleClaimOffenders(docFiles(root), root),
        ['audit-report.md:1'],
        'once tracked, the same doc is caught — the gate did not go inert',
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('no documentation file in the repo still claims exit 0 when there is nothing to check', () => {
    if (!existsSync(join(REPO_ROOT, 'docs')) || !statSync(join(REPO_ROOT, 'docs')).isDirectory()) {
      return; // published tarball, not a source checkout — nothing repo-wide to scan
    }
    const offenders = staleClaimOffenders(docFiles(REPO_ROOT), REPO_ROOT);
    assert.deepEqual(offenders, [], `stale zero-criteria pass claims remain:\n${offenders.join('\n')}`);
  });
});

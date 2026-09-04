// AC1-AC4: --write must not clobber a hand-refined artifact by default (#674).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = resolve(new URL('../bin/lesson-foundry.mjs', import.meta.url).pathname);

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'lesson-foundry-write-test-'));
}

function writeLedger(dir, entries) {
  const adlcDir = join(dir, '.adlc');
  mkdirSync(adlcDir, { recursive: true });
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(adlcDir, 'findings.jsonl'), content, 'utf8');
}

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
  });
  return { stdout: result.stdout, stderr: result.stderr, code: result.status };
}

// Routes to LINT: shouldRouteLint() requires a quoted literal or a recognizable
// code-suppression-style marker in desc/evidence (see MARKER_RE in lib/route.mjs).
const CLUSTER_ENTRIES = [
  { ts: '2025-01-01', tool: 'test', file: 'a.mjs', line: 1, category: 'security', severity: 'high', desc: 'missing null check before calling "db.query"' },
  { ts: '2025-01-02', tool: 'test', file: 'b.mjs', line: 2, category: 'security', severity: 'high', desc: 'missing null check before calling "db.query"' },
];

function findLintJsonPath(outDir) {
  const files = readdirSync(outDir).filter((f) => f.endsWith('.lint.json'));
  assert.ok(files.length >= 1, `expected at least one .lint.json in ${outDir}, found: ${files.join(', ')}`);
  return join(outDir, files[0]);
}

test('AC1: a second --write leaves a hand-edited .lint.json byte-identical and reports it skipped', () => {
  const dir = makeTempDir();
  try {
    writeLedger(dir, CLUSTER_ENTRIES);
    const outDir = join(dir, '.adlc', 'lessons');
    const first = runCli(['--write', '--out-dir', outDir], dir);
    assert.strictEqual(first.code, 0, `first --write should succeed: ${first.stderr}`);

    const lintPath = findLintJsonPath(outDir);
    const original = JSON.parse(readFileSync(lintPath, 'utf8'));
    original.pattern = 'HAND_TUNED_PATTERN';
    original.note = 'do not regenerate me';
    const handTuned = JSON.stringify(original, null, 2) + '\n';
    writeFileSync(lintPath, handTuned, 'utf8');

    const second = runCli(['--write', '--out-dir', outDir], dir);
    assert.strictEqual(second.code, 0, `second --write should succeed: ${second.stderr}`);
    assert.strictEqual(readFileSync(lintPath, 'utf8'), handTuned, 'hand-tuned .lint.json must be byte-identical after a second --write');
    assert.match(second.stdout, /exists \(skipped\):.*\.lint\.json/, 'stdout must report the skip for the existing file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC2: --force restores the regenerated scaffold over a hand-edited file', () => {
  const dir = makeTempDir();
  try {
    writeLedger(dir, CLUSTER_ENTRIES);
    const outDir = join(dir, '.adlc', 'lessons');
    const first = runCli(['--write', '--out-dir', outDir], dir);
    assert.strictEqual(first.code, 0);

    const lintPath = findLintJsonPath(outDir);
    const scaffold = readFileSync(lintPath, 'utf8');
    writeFileSync(lintPath, '{"pattern":"HAND_TUNED","note":"mine"}\n', 'utf8');

    const forced = runCli(['--write', '--force', '--out-dir', outDir], dir);
    assert.strictEqual(forced.code, 0, `--force write should succeed: ${forced.stderr}`);
    assert.strictEqual(readFileSync(lintPath, 'utf8'), scaffold, '--force must overwrite back to the regenerated scaffold');
    assert.doesNotMatch(forced.stdout, /exists \(skipped\)/, '--force must not report any skip');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC3: a fresh out-dir with plain --write (no --force) writes every planned file', () => {
  const dir = makeTempDir();
  try {
    writeLedger(dir, CLUSTER_ENTRIES);
    const outDir = join(dir, '.adlc', 'lessons');
    assert.strictEqual(existsSync(outDir), false, 'precondition: out-dir must not exist yet');
    const result = runCli(['--write', '--out-dir', outDir], dir);
    assert.strictEqual(result.code, 0, `--write should succeed: ${result.stderr}`);
    assert.ok(existsSync(findLintJsonPath(outDir)), 'the .lint.json must have been written');
    assert.doesNotMatch(result.stdout, /exists \(skipped\)/, 'a fresh out-dir must never report a skip');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A second, distinct LINT-routed cluster (different quoted literal → different
// clusterName/pattern → a different .lint.json filename from CLUSTER_ENTRIES).
const CLUSTER_ENTRIES_2 = [
  { ts: '2025-02-01', tool: 'test', file: 'c.mjs', line: 3, category: 'security', severity: 'high', desc: 'unsafe eval near "user.rawInput"' },
  { ts: '2025-02-02', tool: 'test', file: 'd.mjs', line: 4, category: 'security', severity: 'high', desc: 'unsafe eval near "user.rawInput"' },
];

test('AC4: --json --write on a mix of new and pre-existing files reports both written and skipped paths', () => {
  const dir = makeTempDir();
  try {
    writeLedger(dir, CLUSTER_ENTRIES);
    const outDir = join(dir, '.adlc', 'lessons');
    const first = runCli(['--write', '--out-dir', outDir], dir);
    assert.strictEqual(first.code, 0);

    // A LINT cluster emits TWO files (a .lint.json descriptor and a check-*.mjs
    // script) — both already exist after the first run and must both be skipped.
    const filesBefore = new Set(readdirSync(outDir).map((f) => join(outDir, f)));
    const lintPathA = findLintJsonPath(outDir);
    const handTuned = '{"pattern":"HAND_TUNED"}\n';
    writeFileSync(lintPathA, handTuned, 'utf8');

    // Add a SECOND, distinct cluster so the next --write sees a genuine mix: A's
    // two files already exist (must be skipped), B's two files are brand new
    // (must be written).
    writeLedger(dir, [...CLUSTER_ENTRIES, ...CLUSTER_ENTRIES_2]);

    const second = runCli(['--write', '--json', '--out-dir', outDir], dir);
    assert.strictEqual(second.code, 0, `second --json --write should succeed: ${second.stderr}`);
    const parsed = JSON.parse(second.stdout);
    assert.ok(Array.isArray(parsed.writeSkipped), `writeSkipped must be an array: ${second.stdout}`);
    assert.deepStrictEqual(
      new Set(parsed.writeSkipped), filesBefore,
      'writeSkipped must list exactly A\'s two pre-existing files, not B\'s new ones',
    );
    assert.strictEqual(readFileSync(lintPathA, 'utf8'), handTuned, 'the pre-existing file must remain untouched (hand edit preserved)');

    const filesAfter = readdirSync(outDir).map((f) => join(outDir, f));
    const newFiles = filesAfter.filter((f) => !filesBefore.has(f));
    assert.strictEqual(newFiles.length, 2, `expected B's 2 new files (.lint.json + check-*.mjs), got: ${newFiles.join(', ')}`);
    const newLintPath = newFiles.find((f) => f.endsWith('.lint.json'));
    assert.ok(newLintPath, 'one of the new files must be a .lint.json');
    assert.notStrictEqual(readFileSync(newLintPath, 'utf8'), handTuned, 'the new file must be the real generated content, not the hand-tuned one');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

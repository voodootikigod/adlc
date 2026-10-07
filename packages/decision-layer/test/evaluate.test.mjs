// A shadow run end to end: the exit code never depends on the answers (AC8),
// the record has every field and no sanitized input (AC9), and a run from a
// linked worktree records into the main checkout with its join keys (AC10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import { installNoNetwork } from './helpers/no-network.mjs';
import { REPLIES, TICKET_CATEGORY_MARKER, changeRepo, responseFile, runCli } from './helpers/fixtures.mjs';
import { canonicalHash } from '../lib/canonical.mjs';
import { GIT_OPTIONS, parseNumstat } from '../lib/inputs.mjs';
import { RecordError } from '../lib/errors.mjs';
import { writeFileSync } from 'node:fs';
import { runEvaluate } from '../lib/evaluate.mjs';
import { loadPack, packHash } from '../lib/pack.mjs';

installNoNetwork();

const SHADOW = ['evaluate', '--mode', 'shadow', '--provider', 'mock', '--model', 'mock-1', '--pack', 'change-risk-v1'];
const readRecords = (dir) => readFileSync(join(dir, '.adlc', 'decisions', 'runs.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const EXPECTED_INPUT = {
  declaredRailCount: 2,
  extensionCounts: { md: 1, mjs: 1, none: 1, png: 1 },
  filesChanged: 4,
  linesAdded: 5,
  linesDeleted: 0,
  ticketCategory: TICKET_CATEGORY_MARKER,
};
const RECORD_FIELDS = [
  'answers', 'attemptCount', 'errorClass', 'inputHash', 'latencyMs', 'outcome', 'packHash', 'packId', 'prNumber', 'provider',
  'recordedAt', 'requestedModel', 'resolvedModel', 'revision', 'schemaVersion', 'status', 'ticketId', 'usage', 'wouldAct',
];

test('the exit code is 0 whether the answers allow, escalate, are unknown or are an error', (t) => {
  const { dir } = changeRepo(t);
  for (const [outcome, reply] of Object.entries(REPLIES)) {
    const result = runCli(t, [...SHADOW, '--mock-response', responseFile(t, reply)], { cwd: dir });
    assert.equal(result.status, 0, `${outcome}: ${result.stderr}`);
  }
  assert.deepEqual(readRecords(dir).map((record) => [record.outcome, record.status]), [
    ['allow', 'ok'],
    ['escalate', 'ok'],
    ['unknown', 'unknown'],
    ['unknown', 'error'],
  ]);
});

test('the record carries every field, hashes the sanitized input, and holds none of it', async (t) => {
  const { dir, git } = changeRepo(t);
  const result = await runEvaluate({
    mode: 'shadow', provider: 'mock', model: 'mock-1', pack: 'change-risk-v1', revision: 'HEAD', ticket: 'T-1', pr: 42, mockResponse: null,
  }, { cwd: dir, now: () => new Date('2026-10-07T00:00:00.000Z') });
  assert.equal(result.exitCode, 0);
  const [record] = readRecords(dir);
  assert.deepEqual(record, result.record);
  assert.deepEqual(Object.keys(record).sort(), RECORD_FIELDS);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.recordedAt, '2026-10-07T00:00:00.000Z');
  assert.equal(record.revision, git('rev-parse', 'HEAD').trim());
  assert.equal(record.provider, 'mock');
  assert.equal(record.requestedModel, 'mock-1');
  assert.equal(record.resolvedModel, 'mock-1');
  assert.equal(record.packId, 'change-risk-v1');
  assert.equal(record.packHash, packHash(loadPack('change-risk-v1', { projectRoot: dir })));
  assert.equal(record.inputHash, canonicalHash(EXPECTED_INPUT));
  assert.equal(record.ticketId, 'T-1');
  assert.equal(record.prNumber, 42);
  assert.equal(record.outcome, 'unknown');
  assert.deepEqual(record.wouldAct, { P0: 'record-inconclusive', D1: 'keep-deterministic-assignment' });
  assert.equal(record.status, 'ok');
  assert.equal(record.errorClass, null);
  assert.equal(record.attemptCount, 1);
  assert.equal(record.usage, null);
  assert.ok(record.latencyMs >= 0);
  const text = JSON.stringify(record);
  assert.ok(!text.includes(TICKET_CATEGORY_MARKER), 'the record contains sanitized input');
  assert.ok(!/extensionCounts|linesAdded|"mjs"/.test(text), 'the record contains sanitized input');
});

test('--revision selects the change described', async (t) => {
  const { dir, git } = changeRepo(t);
  const base = git('rev-parse', 'main').trim();
  const result = await runEvaluate({
    mode: 'shadow', provider: 'mock', model: 'm', pack: 'change-risk-v1', revision: 'main', ticket: null, pr: null, mockResponse: null,
  }, { cwd: dir });
  assert.equal(result.record.revision, base);
  const empty = { declaredRailCount: 'none', extensionCounts: {}, filesChanged: 0, linesAdded: 0, linesDeleted: 0, ticketCategory: 'none' };
  assert.equal(result.record.inputHash, canonicalHash(empty));
  assert.equal(result.record.ticketId, null);
  assert.equal(result.record.prNumber, null);
});

test('a run from a linked worktree records into the main checkout, with its join keys, at an ignored path', (t) => {
  const { dir, git } = changeRepo(t);
  const worktree = join(tmp(t, 'decision-wt-'), 'wt');
  git('worktree', 'add', '-q', worktree, '-b', 'other', 'feature');
  const result = runCli(t, [...SHADOW, '--ticket', 'T-1', '--pr', '7'], { cwd: worktree });
  assert.equal(result.status, 0, result.stderr);
  const [record] = readRecords(dir);
  assert.equal(record.ticketId, 'T-1');
  assert.equal(record.prNumber, 7);
  assert.equal(record.revision, git('rev-parse', 'feature').trim());
  execFileSync('git', ['-C', dir, 'check-ignore', '-q', '.adlc/decisions/runs.jsonl'], { stdio: 'ignore' });
});

test('ambient GIT_* variables cannot point the run at another repository', (t) => {
  const { dir, git } = changeRepo(t);
  const other = changeRepo(t);
  other.git('checkout', '-q', 'main');
  const result = runCli(t, [...SHADOW, '--json'], {
    cwd: dir,
    env: { GIT_DIR: join(other.dir, '.git'), GIT_WORK_TREE: other.dir, GIT_INDEX_FILE: join(other.dir, '.git', 'index') },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).revision, git('rev-parse', 'HEAD').trim());
  assert.equal(readRecords(dir).length, 1);
});

test('records append: each run adds one line', (t) => {
  const { dir } = changeRepo(t);
  for (let i = 0; i < 3; i += 1) assert.equal(runCli(t, SHADOW, { cwd: dir }).status, 0);
  assert.equal(readRecords(dir).length, 3);
});

test('the default branch comes from origin/HEAD when there is one', (t) => {
  const { dir, git } = changeRepo(t);
  git('branch', '-q', '-m', 'main', 'trunk');
  git('update-ref', 'refs/remotes/origin/trunk', 'trunk');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  const result = runCli(t, [...SHADOW, '--json'], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).inputHash, canonicalHash({ ...EXPECTED_INPUT, declaredRailCount: 'none', ticketCategory: 'none' }));
});

test('master is the default branch when there is no main or origin/HEAD', (t) => {
  const { dir, git } = changeRepo(t);
  git('branch', '-q', '-m', 'main', 'master');
  assert.equal(runCli(t, SHADOW, { cwd: dir }).status, 0);
});

test('without a default branch the run is refused', (t) => {
  const { dir, git } = changeRepo(t);
  git('branch', '-q', '-m', 'main', 'trunk');
  const result = runCli(t, SHADOW, { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot determine the default branch/);
});

test('a revision with no shared history is refused', (t) => {
  const { dir, git } = changeRepo(t);
  git('checkout', '-q', '--orphan', 'island');
  git('commit', '-q', '-m', 'island');
  const result = runCli(t, SHADOW, { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /shares no history with the default branch/);
});

test('parseNumstat counts files per extension and skips binary line counts', () => {
  const out = ['3\t1\tsrc/A.MJS', '-\t-\timg.png', '2\t0\t.gitignore', '1\t5\tdir.v2/README', ''].join('\0');
  assert.deepEqual(parseNumstat(out), {
    extensionCounts: { mjs: 1, png: 1, none: 2 },
    linesAdded: 6,
    linesDeleted: 6,
    filesChanged: 4,
  });
  assert.deepEqual(parseNumstat(''), { extensionCounts: {}, linesAdded: 0, linesDeleted: 0, filesChanged: 0 });
});

test('runEvaluate rethrows failures it does not own', async (t) => {
  const { dir } = changeRepo(t);
  await assert.rejects(
    runEvaluate({ mode: 'shadow', provider: 'mock', model: 'm', pack: 'change-risk-v1', revision: 'HEAD', ticket: null, pr: null, mockResponse: null }, {
      cwd: dir,
      now: () => { throw new TypeError('clock broke'); },
    }),
    /clock broke/,
  );
});

test('a record that cannot be written resolves to exit 1 with a RecordError', async (t) => {
  const { dir } = changeRepo(t);
  writeFileSync(join(dir, '.adlc', 'decisions'), 'a file where the directory should be');
  const result = await runEvaluate({
    mode: 'shadow', provider: 'mock', model: 'm', pack: 'change-risk-v1', revision: 'HEAD', ticket: null, pr: null, mockResponse: null,
  }, { cwd: dir });
  assert.equal(result.exitCode, 1);
  assert.ok(result.error instanceof RecordError);
});

test('every git call is bounded in time and output', () => {
  assert.ok(Number.isFinite(GIT_OPTIONS.timeout) && GIT_OPTIONS.timeout > 0, 'git runs without a timeout');
  assert.ok(GIT_OPTIONS.maxBuffer >= 16 * 1024 * 1024, 'git output buffer is too small for a large diff');
});

test('--mode off returns 0 without touching the repository', async () => {
  assert.deepEqual(await runEvaluate({ mode: 'off' }, { cwd: '/nonexistent' }), { exitCode: 0 });
});

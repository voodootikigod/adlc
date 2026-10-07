// A shadow run end to end: the exit code never depends on the answers (AC8),
// the record has every field and no sanitized input (AC9), and a run from a
// linked worktree records into the main checkout with its join keys (AC10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { gitRepo, tmp } from '@adlc/core/test-kit';
import { NO_NETWORK_PRELOAD, installNoNetwork } from './helpers/no-network.mjs';
import { pathToFileURL } from 'node:url';
import { dirname as pathDirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPLIES, TICKET_CATEGORY_MARKER, changeRepo, responseFile, runCli } from './helpers/fixtures.mjs';
import { canonicalHash } from '../lib/canonical.mjs';
import { GIT_OPTIONS, parseNumstat } from '../lib/inputs.mjs';
import { GitOutputError, RecordError } from '../lib/errors.mjs';
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
const PACK_INPUTS = ['declaredRailCount', 'extensionCounts', 'filesChanged', 'linesAdded', 'linesDeleted', 'ticketCategory'];
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
  assert.equal(record.resolvedModel, null);
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

test('the diff runs from the merge-base, so later default-branch commits are not counted', async (t) => {
  const { dir, git } = changeRepo(t);
  git('checkout', '-q', 'main');
  writeFileSync(join(dir, 'other.txt'), `${'line\n'.repeat(10)}`);
  writeFileSync(join(dir, 'README.md'), '');
  git('add', '-A');
  git('commit', '-q', '-m', 'main moves on');
  git('checkout', '-q', 'feature');
  const result = await runEvaluate({
    mode: 'shadow', provider: 'mock', model: 'm', pack: 'change-risk-v1', revision: 'HEAD', ticket: 'T-1', pr: null, mockResponse: null,
  }, { cwd: dir });
  assert.equal(result.exitCode, 0);
  assert.equal(result.record.inputHash, canonicalHash(EXPECTED_INPUT));
});

test('a project pack declaring a subset of inputs runs, and hashes only those inputs', (t) => {
  const { dir } = changeRepo(t);
  const pack = loadPack('change-risk-v1', { projectRoot: dir });
  const subset = { ...structuredClone(pack), id: 'subset-pack', inputs: { linesAdded: pack.inputs.linesAdded, filesChanged: pack.inputs.filesChanged } };
  for (const question of subset.questions) question.inputs = ['linesAdded', 'filesChanged'];
  mkdirSync(join(dir, '.adlc', 'decision-packs', 'subset-pack'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'decision-packs', 'subset-pack', 'pack.json'), JSON.stringify(subset));
  const result = runCli(t, [...SHADOW.slice(0, -1), 'subset-pack', '--json'], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).inputHash, canonicalHash({ filesChanged: 4, linesAdded: 5 }));
});

test('a symlinked runs.jsonl is refused and its target is untouched', (t) => {
  const { dir } = changeRepo(t);
  const outside = join(tmp(t, 'decision-outside-'), 'target.txt');
  writeFileSync(outside, 'original\n');
  mkdirSync(join(dir, '.adlc', 'decisions'), { recursive: true });
  symlinkSync(outside, join(dir, '.adlc', 'decisions', 'runs.jsonl'));
  const result = runCli(t, SHADOW, { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /symbolic link/);
  assert.equal(readFileSync(outside, 'utf8'), 'original\n');
});

test('a symlinked decisions directory is refused and nothing is written through it', (t) => {
  const { dir } = changeRepo(t);
  const outside = tmp(t, 'decision-outside-dir-');
  symlinkSync(outside, join(dir, '.adlc', 'decisions'));
  const result = runCli(t, SHADOW, { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /symbolic link/);
  assert.deepEqual(readdirSync(outside), []);
});

test('a symlinked .adlc directory is refused', (t) => {
  const { dir, git } = changeRepo(t);
  const outside = tmp(t, 'decision-outside-adlc-');
  git('rm', '-q', '-r', '--cached', '.adlc');
  renameSync(join(dir, '.adlc'), join(outside, 'moved'));
  symlinkSync(join(outside, 'moved'), join(dir, '.adlc'));
  const result = runCli(t, SHADOW, { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /symbolic link/);
  assert.equal(existsSync(join(outside, 'moved', 'decisions')), false);
});

test('the provider receives the sanitized, redacted input and nothing undeclared', (t) => {
  const { dir, git } = changeRepo(t);
  const secret = `ghp_${'A1b2C3d4E5f6G7h8I9j0'.repeat(2)}`;
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({
    schema: 1,
    tickets: [{ id: 'T-1', title: 'fixture ticket', category: `feature ${secret}`, rails: ['src/a.mjs'] }],
  }));
  git('add', '-A');
  git('commit', '-q', '-m', 'ticket with a secret-shaped category');
  const log = join(tmp(t, 'decision-requests-'), 'requests.jsonl');
  const register = pathToFileURL(join(pathDirname(fileURLToPath(import.meta.url)), 'helpers', 'recording-provider-register.mjs')).href;
  const result = runCli(t, [...SHADOW, '--ticket', 'T-1'], {
    cwd: dir,
    env: { DECISION_REQUEST_LOG: log, NODE_OPTIONS: `--import=${NO_NETWORK_PRELOAD} --import=${register}` },
  });
  assert.equal(result.status, 0, result.stderr);
  const requests = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(requests.length, 1);
  const text = JSON.stringify(requests[0]);
  assert.ok(!text.includes(secret), 'the provider received the secret');
  for (const question of requests[0].questions) {
    assert.deepEqual(Object.keys(question.input).sort(), [...PACK_INPUTS].sort());
    assert.equal(question.input.ticketCategory, 'feature <redacted:credential>');
    assert.equal(typeof question.prompt, 'string');
    assert.ok(question.prompt.length > 0, 'a normal prompt reaches the provider');
    assert.deepEqual(question.input.extensionCounts, { md: 1, mjs: 1, none: 1, png: 1, json: 1 });
  }
});

test('a repository with no .adlc directory and no ticket store records one run', (t) => {
  const { dir, git } = gitRepo(t, 'decision-bare-repo-');
  writeFileSync(join(dir, 'a.mjs'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature');
  writeFileSync(join(dir, 'b.mjs'), 'export const b = 2;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  assert.equal(existsSync(join(dir, '.adlc')), false);
  const result = runCli(t, SHADOW, { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readRecords(dir).length, 1);
});

test('a ticket with no category and no rails reads as category none and zero rails', async (t) => {
  const { dir, git } = changeRepo(t);
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ schema: 1, tickets: [{ id: 'T-2', title: 'bare ticket' }] }));
  git('add', '-A');
  git('commit', '-q', '-m', 'a bare ticket');
  const result = await runEvaluate({
    mode: 'shadow', provider: 'mock', model: 'm', pack: 'change-risk-v1', revision: 'HEAD', ticket: 'T-2', pr: null, mockResponse: null,
  }, { cwd: dir });
  assert.equal(result.exitCode, 0, result.error?.message);
  const expected = { ...EXPECTED_INPUT, extensionCounts: { ...EXPECTED_INPUT.extensionCounts, json: 1 }, filesChanged: 5, linesAdded: 6, linesDeleted: 1, ticketCategory: 'none', declaredRailCount: 0 };
  assert.equal(result.record.inputHash, canonicalHash(expected));
});

test('git output larger than the default 1 MiB buffer is read: the git bounds are applied', (t) => {
  const { dir } = changeRepo(t);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const shimDir = tmp(t, 'decision-git-flood-');
  const flood = join(shimDir, 'flood.mjs');
  writeFileSync(flood, "for (let i = 0; i < 150000; i += 1) process.stdout.write(`1\\t0\\tf${i}.js\\0`);\n");
  writeFileSync(join(shimDir, 'git'), `#!/bin/sh\ncase " $* " in *" --numstat "*) exec '${process.execPath}' '${flood}';; esac\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const result = runCli(t, [...SHADOW, '--json'], { cwd: dir, env: { PATH: `${shimDir}:${process.env.PATH}` } });
  assert.equal(result.status, 0, result.stderr);
  const expected = { declaredRailCount: 'none', extensionCounts: { js: 150000 }, filesChanged: 150000, linesAdded: 150000, linesDeleted: 0, ticketCategory: 'none' };
  assert.equal(JSON.parse(result.stdout).inputHash, canonicalHash(expected));
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

test('a dangling origin/HEAD falls through to local main', (t) => {
  const { dir, git } = changeRepo(t);
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone');
  const result = runCli(t, [...SHADOW, '--json'], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).inputHash, canonicalHash({ ...EXPECTED_INPUT, declaredRailCount: 'none', ticketCategory: 'none' }));
});

test('a dangling origin/HEAD with no local main or master reports a missing default branch', (t) => {
  const { dir, git } = changeRepo(t);
  git('branch', '-q', '-m', 'main', 'trunk');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone');
  const result = runCli(t, SHADOW, { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot determine the default branch/);
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

test('parseNumstat keeps a path that contains a tab whole', () => {
  const out = ['2\t1\tdir/a\tb.js', '-\t-\timg\tx.png', '1\t0\tplain.md', ''].join('\0');
  assert.deepEqual(parseNumstat(out), {
    extensionCounts: { js: 1, png: 1, md: 1 },
    linesAdded: 3,
    linesDeleted: 1,
    filesChanged: 3,
  });
});

test('a real file whose name contains a tab is counted under its own extension', async (t) => {
  const { dir, git } = changeRepo(t);
  writeFileSync(join(dir, 'odd\tname.py'), 'x = 1\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'tab in a file name');
  const result = await runEvaluate({
    mode: 'shadow', provider: 'mock', model: 'm', pack: 'change-risk-v1', revision: 'HEAD', ticket: 'T-1', pr: null, mockResponse: null,
  }, { cwd: dir });
  assert.equal(result.exitCode, 0);
  const expected = { ...EXPECTED_INPUT, extensionCounts: { ...EXPECTED_INPUT.extensionCounts, py: 1 }, filesChanged: 5, linesAdded: 6 };
  assert.equal(result.record.inputHash, canonicalHash(expected));
});

test('parseNumstat counts a pure rename as one file, under the new extension, with 0/0 lines', () => {
  const out = ['0\t0\t', 'docs/old.md', 'docs/new.txt', ''].join('\0');
  assert.deepEqual(parseNumstat(out), { extensionCounts: { txt: 1 }, linesAdded: 0, linesDeleted: 0, filesChanged: 1 });
});

test('parseNumstat keeps the real line counts of an edited rename', () => {
  const out = ['3\t1\t', 'a.mjs', 'b.js', '2\t0\tplain.md', ''].join('\0');
  assert.deepEqual(parseNumstat(out), { extensionCounts: { js: 1, md: 1 }, linesAdded: 5, linesDeleted: 1, filesChanged: 2 });
});

test('parseNumstat handles a renamed binary file and a renamed path containing a tab', () => {
  const out = ['-\t-\t', 'old.png', 'new.gif', '1\t1\t', 'dir/a\tb.mjs', 'dir/c\td.py', ''].join('\0');
  assert.deepEqual(parseNumstat(out), { extensionCounts: { gif: 1, py: 1 }, linesAdded: 1, linesDeleted: 1, filesChanged: 2 });
});

for (const [name, out] of [
  ['a record with too few fields', ['3\t1', '']],
  ['a non-numeric count', ['3\tx\tfile.js', '']],
  ['a negative count', ['-3\t1\tfile.js', '']],
  ['a rename missing its new path', ['1\t1\t', 'old.js', '']],
  ['a rename missing both paths', ['1\t1\t', '']],
  ['a rename with an empty old path', ['1\t1\t', '', 'new.js', '']],
  ['an empty record between two records', ['1\t1\ta.js', '', '2\t0\tb.js', '']],
]) {
  test(`parseNumstat refuses ${name} rather than guessing`, () => {
    assert.throws(() => parseNumstat(out.join('\0')), (error) => error instanceof GitOutputError && /git diff --numstat/.test(error.message));
  });
}

test('a renamed file counts once, even where the repository disables rename detection', async (t) => {
  const { dir, git } = changeRepo(t);
  git('checkout', '-q', 'main');
  git('checkout', '-q', '-b', 'rename');
  git('config', 'diff.renames', 'false');
  git('mv', 'README.md', 'README.txt');
  git('commit', '-q', '-m', 'rename');
  const result = await runEvaluate({
    mode: 'shadow', provider: 'mock', model: 'm', pack: 'change-risk-v1', revision: 'HEAD', ticket: null, pr: null, mockResponse: null,
  }, { cwd: dir });
  assert.equal(result.exitCode, 0);
  const expected = { declaredRailCount: 'none', extensionCounts: { txt: 1 }, filesChanged: 1, linesAdded: 0, linesDeleted: 0, ticketCategory: 'none' };
  assert.equal(result.record.inputHash, canonicalHash(expected));
});

test('a worktree list git cannot describe is refused, not guessed', (t) => {
  const { dir } = changeRepo(t);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const shimDir = tmp(t, 'decision-git-shim-');
  writeFileSync(join(shimDir, 'git'), `#!/bin/sh\ncase " $* " in *" worktree list "*) printf 'HEAD 0\\0\\0'; exit 0;; esac\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const result = runCli(t, SHADOW, { cwd: dir, env: { PATH: `${shimDir}:${process.env.PATH}` } });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /^adlc decision: cannot locate the main work tree of this repository\n$/);
});

test('unreadable git diff output exits 1 before dispatch, with no record', (t) => {
  const { dir } = changeRepo(t);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const shimDir = tmp(t, 'decision-git-shim-');
  writeFileSync(join(shimDir, 'git'), `#!/bin/sh\ncase " $* " in *" --numstat "*) printf 'garbage'; exit 0;; esac\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const result = runCli(t, SHADOW, { cwd: dir, env: { PATH: `${shimDir}:${process.env.PATH}` } });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /^adlc decision: unreadable git diff --numstat output: [^\n]*\n$/, 'expected one reported error line, not a crash');
  assert.equal(existsSync(join(dir, '.adlc', 'decisions', 'runs.jsonl')), false);
});

test('parseNumstat counts extensions named after Object.prototype members', () => {
  const out = ['1\t0\tx.constructor', '1\t0\ty.__proto__', '1\t0\tz.toString', '1\t0\tw.CONSTRUCTOR', ''].join('\0');
  const { extensionCounts, filesChanged } = parseNumstat(out);
  assert.equal(filesChanged, 4);
  assert.deepEqual(Object.entries(extensionCounts).sort(), [['__proto__', 1], ['constructor', 2], ['tostring', 1]]);
});

test('a run inside a submodule records into the submodule work tree', (t) => {
  const outer = changeRepo(t);
  const inner = changeRepo(t);
  outer.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner.dir, 'sub');
  const sub = join(outer.dir, 'sub');
  execFileSync('git', ['-C', sub, 'checkout', '-q', 'feature'], { stdio: 'ignore' });
  const result = runCli(t, SHADOW, { cwd: sub });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readRecords(sub).length, 1);
});

test('a checkout with a separate git directory records into its work tree', (t) => {
  const { dir } = changeRepo(t);
  const clone = join(tmp(t, 'decision-sep-'), 'work');
  const gitDir = join(tmp(t, 'decision-sepgit-'), 'git');
  execFileSync('git', ['clone', '-q', '--separate-git-dir', gitDir, dir, clone], { stdio: 'ignore' });
  execFileSync('git', ['-C', clone, 'checkout', '-q', 'feature'], { stdio: 'ignore' });
  execFileSync('git', ['-C', clone, 'branch', '-q', 'main', 'origin/main'], { stdio: 'ignore' });
  const result = runCli(t, SHADOW, { cwd: clone });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readRecords(clone).length, 1);
});

test('a linked worktree of a bare repository is refused with exit 1 and no record', (t) => {
  // The layout under review: `git clone --bare`, then `git worktree add` from it.
  const { dir } = changeRepo(t);
  const bare = join(tmp(t, 'decision-bare-'), 'repo.git');
  execFileSync('git', ['clone', '-q', '--bare', dir, bare], { stdio: 'ignore' });
  const worktree = join(tmp(t, 'decision-bare-wt-'), 'wt');
  execFileSync('git', ['-C', bare, 'worktree', 'add', '-q', worktree, 'feature'], { stdio: 'ignore' });
  assert.equal(execFileSync('git', ['-C', bare, 'rev-parse', '--is-bare-repository'], { encoding: 'utf8' }).trim(), 'true');

  const result = runCli(t, SHADOW, { cwd: worktree });

  assert.equal(result.status, 1, 'a bare repository has no main checkout, so the run must be refused');
  assert.equal(result.stderr, 'adlc decision: cannot locate the main work tree of this repository\n');
  assert.equal(result.stdout, '');
  for (const root of [worktree, bare]) {
    assert.equal(existsSync(join(root, '.adlc', 'decisions', 'runs.jsonl')), false, `a record was written under ${root}`);
  }
});

test('a linked worktree of a separate-git-dir checkout is refused rather than guessed', (t) => {
  const { dir } = changeRepo(t);
  const clone = join(tmp(t, 'decision-sep-'), 'work');
  const gitDir = join(tmp(t, 'decision-sepgit-'), 'git');
  execFileSync('git', ['clone', '-q', '--separate-git-dir', gitDir, dir, clone], { stdio: 'ignore' });
  const worktree = join(tmp(t, 'decision-sep-wt-'), 'wt');
  execFileSync('git', ['-C', clone, 'worktree', 'add', '-q', worktree, 'origin/feature'], { stdio: 'ignore' });
  const result = runCli(t, SHADOW, { cwd: worktree });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot locate the main work tree/);
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

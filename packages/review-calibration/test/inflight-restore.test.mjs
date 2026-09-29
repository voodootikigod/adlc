// review-calibration/test/inflight-restore.test.mjs
// A run killed while plants are on disk (SIGTERM from a CI cancel, SIGKILL)
// must not leave planted defects behind for good: the next run restores them
// from the in-flight record before its dirty-tree check. Recovery never
// overwrites a file that moved on after the crash.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  readFileSync, writeFileSync, existsSync, readdirSync, statSync, chmodSync, symlinkSync, lstatSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import {
  writeFileAtomic, recoverInflight, createJournal, decideFile, probeOwner, recordPathFor,
  isContainedRelPath, RECORD_VERSION,
} from '../lib/inflight.mjs';
import { runWithPlants } from '../lib/runner.mjs';
import { verifyWitness } from '../lib/verify.mjs';
import { BIN, BOUNDARY_PLANT, MATH_SOURCE, createMathRepo, writePlantsFile, runCli } from './cli-fixtures.mjs';

const PLANTED = MATH_SOURCE.replace(BOUNDARY_PLANT.original, BOUNDARY_PLANT.mutated);
const DEAD_PID = 2 ** 22 + 12345; // above Linux pid_max default; never alive

function mathPath(dir) {
  return join(dir, 'src', 'math.mjs');
}

function gitDirOf(dir) {
  return join(dir, '.git');
}

function writeRecord(dir, files, pid = DEAD_PID) {
  writeFileSync(recordPathFor(gitDirOf(dir)), JSON.stringify({ version: RECORD_VERSION, pid, files }));
}

function waitFor(pred, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe('a run killed mid-review is recovered by the next run', () => {
  it('SIGTERM leaves plants on disk; the next run restores them and proceeds', async (t) => {
    const { dir } = createMathRepo(t);
    const markers = tmp(t, 'rc-sigterm-');
    const started = join(markers, 'started');
    const reviewer = join(markers, 'slow-reviewer.mjs');
    writeFileSync(reviewer, [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(started)}, 'x');`,
      'setTimeout(() => {}, 4000);',
    ].join('\n'));
    const plants = writePlantsFile(t, [BOUNDARY_PLANT]);

    const child = spawn('node', [BIN, '--review-cmd', `node ${reviewer}`, '--plants-file', plants,
      '--min-plants', '1', '--min-recall', '0', '--scorer', 'string'], { cwd: dir, stdio: 'ignore' });
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    await waitFor(() => existsSync(started));
    child.kill('SIGTERM');
    const { signal } = await exited;
    assert.equal(signal, 'SIGTERM', 'the run died to the signal');
    assert.equal(readFileSync(mathPath(dir), 'utf8'), PLANTED, 'the plant is still on disk');
    assert.ok(existsSync(recordPathFor(gitDirOf(dir))), 'the in-flight record survived the kill');

    const next = runCli(['--review-cmd', 'node -e 0', '--plants-file', plants,
      '--min-plants', '1', '--min-recall', '0', '--scorer', 'string'], dir);
    assert.notEqual(next.status, 1, `next run refused: ${next.stderr}`);
    assert.match(next.stderr, /restored 1 file/);
    assert.equal(readFileSync(mathPath(dir), 'utf8'), MATH_SOURCE);
    assert.equal(existsSync(recordPathFor(gitDirOf(dir))), false, 'record cleared after recovery');
  });

  it('a record whose file moved on is a hard refusal that touches nothing', (t) => {
    const { dir } = createMathRepo(t);
    const edited = MATH_SOURCE.replace('a + b', 'a + b + 0');
    writeFileSync(mathPath(dir), edited);
    writeRecord(dir, [{ file: 'src/math.mjs', original: MATH_SOURCE, mutated: PLANTED }]);
    const result = runCli(['--review-cmd', 'node -e 0', '--plants-file', writePlantsFile(t),
      '--min-plants', '1', '--scorer', 'string'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /src\/math\.mjs/);
    assert.match(result.stderr, /adlc-review-calibration-inflight\.json/);
    assert.equal(readFileSync(mathPath(dir), 'utf8'), edited, 'the developer\'s edit survives');
    assert.ok(existsSync(recordPathFor(gitDirOf(dir))), 'the record, the only copy of the original, is kept');
  });

  it('a record owned by a live process is left alone and the run refuses', (t) => {
    const { dir } = createMathRepo(t);
    writeFileSync(mathPath(dir), PLANTED);
    writeRecord(dir, [{ file: 'src/math.mjs', original: MATH_SOURCE, mutated: PLANTED }], process.pid);
    const result = runCli(['--review-cmd', 'node -e 0', '--plants-file', writePlantsFile(t),
      '--min-plants', '1', '--scorer', 'string'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`pid ${process.pid}`));
    assert.equal(readFileSync(mathPath(dir), 'utf8'), PLANTED);
  });
});

describe('recoverInflight', () => {
  it('restores a planted file from a dead owner and clears the record', (t) => {
    const { dir } = createMathRepo(t);
    writeFileSync(mathPath(dir), PLANTED);
    writeRecord(dir, [{ file: 'src/math.mjs', original: MATH_SOURCE, mutated: PLANTED }]);
    const r = recoverInflight({ recordPath: recordPathFor(gitDirOf(dir)), repoRoot: dir });
    assert.equal(r.status, 'recovered');
    assert.deepEqual(r.restored, ['src/math.mjs']);
    assert.equal(readFileSync(mathPath(dir), 'utf8'), MATH_SOURCE);
  });

  it('refuses a record entry that escapes the repository', (t) => {
    const { dir } = createMathRepo(t);
    const outside = join(tmp(t, 'rc-outside-'), 'victim.txt');
    writeFileSync(outside, 'planted');
    const rel = `../${outside.split('/').slice(-2).join('/')}`;
    writeRecord(dir, [{ file: rel, original: 'clobbered', mutated: 'planted' }]);
    const r = recoverInflight({ recordPath: recordPathFor(gitDirOf(dir)), repoRoot: dir });
    assert.equal(r.status, 'conflict');
    assert.equal(readFileSync(outside, 'utf8'), 'planted');
  });

  it('sweeps a temp file a dead writer left beside a recorded file, and only that', (t) => {
    const { dir } = createMathRepo(t);
    writeFileSync(mathPath(dir), PLANTED);
    const stale = `math.mjs.tmp-${DEAD_PID}-00ff00ff00ff00ff`;
    const live = `math.mjs.tmp-${process.pid}-00ff00ff00ff00ff`;
    writeFileSync(join(dir, 'src', stale), 'half');
    writeFileSync(join(dir, 'src', live), 'busy');
    writeRecord(dir, [{ file: 'src/math.mjs', original: MATH_SOURCE, mutated: PLANTED }]);
    const r = recoverInflight({ recordPath: recordPathFor(gitDirOf(dir)), repoRoot: dir, selfPid: 1 });
    assert.equal(r.status, 'recovered');
    assert.deepEqual(readdirSync(join(dir, 'src')).sort(), [live, 'math.mjs'].sort());
  });

  it('discards a malformed record without writing anything', (t) => {
    const { dir } = createMathRepo(t);
    writeFileSync(recordPathFor(gitDirOf(dir)), '{not json');
    const r = recoverInflight({ recordPath: recordPathFor(gitDirOf(dir)), repoRoot: dir });
    assert.equal(r.status, 'discarded');
    assert.equal(existsSync(recordPathFor(gitDirOf(dir))), false);
  });

  it('treats a record carrying our own pid as dead (pid reuse)', (t) => {
    const { dir } = createMathRepo(t);
    writeFileSync(mathPath(dir), PLANTED);
    writeRecord(dir, [{ file: 'src/math.mjs', original: MATH_SOURCE, mutated: PLANTED }], 4242);
    const r = recoverInflight({
      recordPath: recordPathFor(gitDirOf(dir)), repoRoot: dir, selfPid: 4242, probe: () => 'alive',
    });
    assert.equal(r.status, 'recovered');
  });

  it('an unknown ownership state is not treated as dead', (t) => {
    const { dir } = createMathRepo(t);
    writeFileSync(mathPath(dir), PLANTED);
    writeRecord(dir, [{ file: 'src/math.mjs', original: MATH_SOURCE, mutated: PLANTED }]);
    const r = recoverInflight({ recordPath: recordPathFor(gitDirOf(dir)), repoRoot: dir, probe: () => 'unknown' });
    assert.equal(r.status, 'skip');
    assert.equal(readFileSync(mathPath(dir), 'utf8'), PLANTED);
  });
});

describe('inflight primitives', () => {
  it('decideFile distinguishes original, planted and moved-on content', () => {
    const entry = { original: 'a', mutated: 'b' };
    assert.equal(decideFile('a', entry), 'none');
    assert.equal(decideFile('b', entry), 'restore');
    assert.equal(decideFile('c', entry), 'conflict');
  });

  it('probeOwner is tri-state and delivers signal 0 only', () => {
    const sent = [];
    assert.equal(probeOwner(10, (pid, sig) => sent.push(sig)), 'alive');
    assert.deepEqual(sent, [0]);
    const fail = (code) => () => { throw Object.assign(new Error(code), { code }); };
    assert.equal(probeOwner(10, fail('ESRCH')), 'dead');
    assert.equal(probeOwner(10, fail('EPERM')), 'alive');
    assert.equal(probeOwner(10, fail('EINVAL')), 'unknown');
    assert.equal(probeOwner(0), 'unknown');
    assert.equal(probeOwner(1.5), 'unknown');
  });

  it('isContainedRelPath rejects absolute and parent-escaping paths', () => {
    assert.equal(isContainedRelPath('src/a.mjs'), true);
    assert.equal(isContainedRelPath('/etc/passwd'), false);
    assert.equal(isContainedRelPath('src/../../x'), false);
    assert.equal(isContainedRelPath(''), false);
  });

  it('writeFileAtomic replaces the inode, keeps the mode and leaves no temp file', (t) => {
    const dir = tmp(t, 'rc-atomic-');
    const file = join(dir, 'f.sh');
    writeFileSync(file, 'old');
    chmodSync(file, 0o755);
    const before = statSync(file).ino;
    writeFileAtomic(file, 'new');
    assert.equal(readFileSync(file, 'utf8'), 'new');
    assert.notEqual(statSync(file).ino, before, 'written by rename, not in place');
    assert.equal(statSync(file).mode & 0o777, 0o755);
    assert.deepEqual(readdirSync(dir), ['f.sh']);
  });

  it('writeFileAtomic writes through a symlink and keeps the link', (t) => {
    const dir = tmp(t, 'rc-atomic-');
    writeFileSync(join(dir, 'real'), 'old');
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    writeFileAtomic(join(dir, 'link'), 'new');
    assert.ok(lstatSync(join(dir, 'link')).isSymbolicLink());
    assert.equal(readFileSync(join(dir, 'real'), 'utf8'), 'new');
  });
});

describe('planting is journaled before any source file changes', () => {
  function spyJournal(onBegin) {
    const calls = [];
    return {
      calls,
      begin(entries) { calls.push(['begin', entries]); onBegin?.(); },
      end() { calls.push(['end']); },
    };
  }

  it('runWithPlants records original and planted content, then clears after restore', (t) => {
    const { dir } = createMathRepo(t);
    const journal = spyJournal(() => {
      assert.equal(readFileSync(mathPath(dir), 'utf8'), MATH_SOURCE, 'recorded BEFORE planting');
    });
    const plant = { ...BOUNDARY_PLANT, absolutePath: mathPath(dir) };
    runWithPlants([plant], 'node -e 0', 'HEAD', dir, 10_000, { journal });
    assert.equal(journal.calls[0][0], 'begin');
    assert.deepEqual(journal.calls[0][1], [{ absolutePath: mathPath(dir), original: MATH_SOURCE, mutated: PLANTED }]);
    assert.deepEqual(journal.calls[1], ['end']);
    assert.equal(readFileSync(mathPath(dir), 'utf8'), MATH_SOURCE);
  });

  it('runWithPlants plants nothing when the journal cannot record', (t) => {
    const { dir } = createMathRepo(t);
    const journal = { begin() { throw new Error('disk full'); }, end() {} };
    const plant = { ...BOUNDARY_PLANT, absolutePath: mathPath(dir) };
    assert.throws(() => runWithPlants([plant], 'node -e 0', 'HEAD', dir, 10_000, { journal }), /disk full/);
    assert.equal(readFileSync(mathPath(dir), 'utf8'), MATH_SOURCE);
  });

  it('verifyWitness journals its single-plant mutation too', (t) => {
    const { dir } = createMathRepo(t);
    const journal = spyJournal();
    const plant = { ...BOUNDARY_PLANT, absolutePath: mathPath(dir), witness: { cmd: 'node', args: ['-e', '0'] } };
    verifyWitness(plant, dir, undefined, { journal });
    assert.equal(journal.calls[0][0], 'begin');
    assert.equal(journal.calls[0][1][0].mutated, PLANTED);
    assert.deepEqual(journal.calls.at(-1), ['end']);
  });

  it('createJournal writes a record recoverInflight can act on', (t) => {
    const { dir } = createMathRepo(t);
    const recordPath = recordPathFor(gitDirOf(dir));
    createJournal({ recordPath, repoRoot: dir, pid: DEAD_PID })
      .begin([{ absolutePath: mathPath(dir), original: MATH_SOURCE, mutated: PLANTED }]);
    writeFileSync(mathPath(dir), PLANTED);
    assert.equal(recoverInflight({ recordPath, repoRoot: dir }).status, 'recovered');
    assert.equal(readFileSync(mathPath(dir), 'utf8'), MATH_SOURCE);
  });

  it('createJournal refuses a plant outside the repository', (t) => {
    const { dir } = createMathRepo(t);
    const journal = createJournal({ recordPath: recordPathFor(gitDirOf(dir)), repoRoot: dir });
    assert.throws(() => journal.begin([{ absolutePath: '/etc/hosts', original: '', mutated: '' }]), /outside/);
  });
});

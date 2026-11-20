import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sanitizeCandidateEnv, detectSandbox, mutate } from '@adlc/core';
import { loadPlantsFile, selectPlants } from '../lib/targets.mjs';
import { runWithPlants } from '../lib/runner.mjs';
import { runWitness, defaultRun, verifyWitness, filterEquivalentMutants } from '../lib/verify.mjs';
import { writeRecord, NO_JOURNAL } from '../lib/inflight.mjs';
import { BIN, BOUNDARY_PLANT, MATH_SOURCE } from './cli-fixtures.mjs';

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rc-containment-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('sanitizeCandidateEnv strips ADLC_MANIFEST_KEY, API keys, NODE_OPTIONS, and GIT_SSH_COMMAND', () => {
  const scrubbed = sanitizeCandidateEnv({
    PATH: '/usr/bin',
    HOME: '/home/dev',
    ADLC_MANIFEST_KEY: 'manifest-secret',
    ANTHROPIC_API_KEY: 'sk-ant',
    NODE_OPTIONS: '--require /tmp/evil.js',
    GIT_SSH_COMMAND: 'ssh -i /tmp/key',
  });
  assert.deepEqual(scrubbed, { PATH: '/usr/bin', HOME: '/home/dev' });
});

test('loadPlantsFile rejects ../ traversal, symlinks, and disallowed witness.cmd binaries', () => {
  withTmp((root) => {
    const repo = join(root, 'repo');
    mkdirSync(repo);
    writeFileSync(join(repo, 'a.mjs'), 'const x = 1;\n');
    writeFileSync(join(root, 'outside.mjs'), 'const x = 1;\n');
    symlinkSync(join(root, 'outside.mjs'), join(repo, 'link.mjs'));
    const base = { line: 1, original: 'const x = 1;', mutated: 'const x = 2;' };
    const plantsPath = join(root, 'plants.json');
    writeFileSync(plantsPath, JSON.stringify([
      { ...base, file: '../outside.mjs' },
      { ...base, file: 'link.mjs' },
      { ...base, file: 'a.mjs', witness: { cmd: 'sh', args: ['-c', 'true'] } },
      { ...base, file: 'a.mjs', witness: { cmd: '../bin/node' } },
      { ...base, file: 'a.mjs', witness: { cmd: 'node', args: ['--test'] } },
      { ...base, file: 'a.mjs', witness: { cmd: 'npm', args: ['test'] } },
      { ...base, file: 'a.mjs', witness: { cmd: 'npx', args: ['node', '--version'] } },
    ]));
    const { plants, errors } = loadPlantsFile(plantsPath, repo);
    assert.deepEqual(plants.map((p) => p.witness.cmd), ['node', 'npm', 'npx']);
    assert.equal(errors.length, 4);
    assert.match(errors[0], /escapes repository or is a symlink/);
    assert.match(errors[1], /escapes repository or is a symlink/);
    assert.match(errors[2], /witness\.cmd must be node, npm, or npx/);
    assert.match(errors[3], /witness\.cmd must be node, npm, or npx/);
  });
});

test('runWithPlants refuses symlinked or out-of-repo absolutePath even with NO_JOURNAL', () => {
  withTmp((root) => {
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const inRepo = join(repo, 'a.mjs');
    writeFileSync(inRepo, 'const x = 1;\n');
    const outside = join(root, 'outside.mjs');
    writeFileSync(outside, 'const x = 1;\n');
    symlinkSync(outside, join(repo, 'link.mjs'));
    const plant = (absolutePath) => [{ absolutePath, line: 1, original: 'const x = 1;', mutated: 'const x = 2;' }];

    for (const absolutePath of [join(repo, 'link.mjs'), outside]) {
      assert.throws(
        () => runWithPlants(plant(absolutePath), 'node -e 0', 'HEAD', repo, 5000, { journal: NO_JOURNAL }),
        /Refusing to plant outside repository or through symlink/,
      );
    }
    assert.equal(readFileSync(outside, 'utf8'), 'const x = 1;\n');

    assert.throws(
      () => runWithPlants(plant(join(repo, 'missing.mjs')), 'node -e 0', 'HEAD', repo, 5000, { journal: NO_JOURNAL }),
      /Cannot read file for planting/,
    );

    const prevKey = process.env.ADLC_MANIFEST_KEY;
    process.env.ADLC_MANIFEST_KEY = 'secret-probe-key';
    try {
      const reviewer = join(root, 'check-env.mjs');
      writeFileSync(reviewer, 'process.stdout.write(process.env.ADLC_MANIFEST_KEY ?? "SCRUBBED");\n');
      const runRes = runWithPlants(plant(inRepo), `${process.execPath} ${reviewer}`, 'HEAD', repo, 5000, { journal: NO_JOURNAL });
      assert.equal(runRes.stdout, 'SCRUBBED');

      const prevSandboxRev = process.env.ADLC_SANDBOX_REVIEW_CMD;
      process.env.ADLC_SANDBOX_REVIEW_CMD = '1';
      try {
        assert.throws(
          () => runWithPlants(plant(inRepo), `${process.execPath} ${reviewer}`, 'HEAD', repo, 5000, {
            journal: NO_JOURNAL,
            detect: () => null,
          }),
          /ADLC_SANDBOX_REVIEW_CMD=1 requested OS sandboxing/,
        );
      } finally {
        if (prevSandboxRev === undefined) delete process.env.ADLC_SANDBOX_REVIEW_CMD;
        else process.env.ADLC_SANDBOX_REVIEW_CMD = prevSandboxRev;
      }
      assert.equal(readFileSync(inRepo, 'utf8'), 'const x = 1;\n');

      const reviewWarnChunks = [];
      const origErrWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = (c) => { reviewWarnChunks.push(String(c)); return true; };
      let unsafeReviewRes;
      try {
        unsafeReviewRes = runWithPlants(plant(inRepo), `${process.execPath} ${reviewer}`, 'HEAD', repo, 5000, {
          journal: NO_JOURNAL,
          sandboxReviewCmd: true,
          unsafeNoSandbox: true,
          detect: () => null,
        });
      } finally {
        process.stderr.write = origErrWrite;
      }
      assert.equal(unsafeReviewRes.stdout, 'SCRUBBED');
      assert.match(reviewWarnChunks.join(''), /ADLC_SANDBOX_REVIEW_CMD=1 bypassed/);

      const noSandboxEscape = join(root, 'must-not-run.txt');
      assert.throws(
        () => defaultRun(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(noSandboxEscape)}, 'ran')`], repo, { detect: () => null }),
        /No OS sandbox binary found/,
      );
      assert.equal(existsSync(noSandboxEscape), false, 'defaultRun must fail closed without executing witness when no sandbox exists');

      const witEnv = runWitness({ cmd: process.execPath, args: ['-e', 'if (process.env.ADLC_MANIFEST_KEY) process.exit(1)'] }, repo);
      assert.equal(witEnv.status, 0);

      if (detectSandbox()) {
        const witArgsCheck = runWitness({ cmd: process.execPath, args: ['-e', 'process.exit(42)'] }, repo);
        assert.equal(witArgsCheck.status, 42, 'witness args must be forwarded to sandboxed command');
        const outsideWrite = join(root, 'witness-escape.txt');
        const insideRepoWrite = join(repo, 'witness-repo-tamper.txt');
        runWitness({
          cmd: process.execPath,
          args: ['-e', `try { require('node:fs').mkdirSync(${JSON.stringify(root)}, { recursive: true }); require('node:fs').writeFileSync(${JSON.stringify(outsideWrite)}, 'escaped'); } catch {} try { require('node:fs').writeFileSync(${JSON.stringify(insideRepoWrite)}, 'tampered'); } catch {}`],
        }, repo);
        assert.equal(existsSync(outsideWrite), false, 'sandboxed witness must not persist writes outside repo');
        assert.equal(existsSync(insideRepoWrite), false, 'sandboxed witness must mount live checkout read-only and block in-repo writes');

        const stderrChunks = [];
        const origWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = (chunk) => { stderrChunks.push(String(chunk)); return true; };
        let unsandboxedRun;
        try {
          unsandboxedRun = defaultRun(
            process.execPath,
            ['-e', `require('node:fs').writeFileSync(${JSON.stringify(outsideWrite)}, 'allowed'); if (process.env.ADLC_MANIFEST_KEY) process.exit(1);`],
            repo,
            { detect: () => null, unsafeNoSandbox: true },
          );
        } finally {
          process.stderr.write = origWrite;
        }
        assert.equal(unsandboxedRun.status, 0);
        assert.equal(existsSync(outsideWrite), true);
        assert.match(stderrChunks.join(''), /WARNING: Running witness command WITHOUT OS sandbox/);
      }
    } finally {
      if (prevKey === undefined) delete process.env.ADLC_MANIFEST_KEY;
      else process.env.ADLC_MANIFEST_KEY = prevKey;
    }
  });
});

test('writeRecord refuses symlinked recordPath', () => {
  withTmp((root) => {
    const victim = join(root, 'victim.txt');
    writeFileSync(victim, 'keep');
    const recordPath = join(root, 'record.json');
    symlinkSync(victim, recordPath);
    assert.throws(
      () => writeRecord(recordPath, { files: [{ file: 'a.mjs', original: 'a', mutated: 'b' }] }),
      /Refusing to write record through symlink/,
    );
    assert.equal(readFileSync(victim, 'utf8'), 'keep');
  });
});

test('review-calibration CLI fails closed when no OS sandbox is on PATH and requires explicit --unsafe-no-sandbox', () => {
  withTmp((root) => {
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'math.mjs'), MATH_SOURCE);
    const gitBin = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const g = (...a) => execFileSync(gitBin, a, { cwd: repo, encoding: 'utf8' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    g('add', '-A');
    g('commit', '-qm', 'init');

    const minimalBin = join(root, 'bin');
    mkdirSync(minimalBin);
    symlinkSync(gitBin, join(minimalBin, 'git'));
    symlinkSync(process.execPath, join(minimalBin, 'node'));

    const plantsFile = join(root, 'plants.json');
    writeFileSync(plantsFile, JSON.stringify([{
      ...BOUNDARY_PLANT,
      witness: {
        cmd: 'node',
        args: ['-e', 'import("./src/math.mjs").then((m) => process.exit(m.isPositive(0) ? 1 : 0))'],
      },
    }]));

    const envNoSandbox = { PATH: minimalBin, HOME: root };
    const helpRes = spawnSync(process.execPath, [BIN, '--help'], { cwd: repo, env: envNoSandbox, encoding: 'utf8' });
    assert.equal(helpRes.status, 0);
    assert.match(helpRes.stdout, /--unsafe-no-sandbox/);

    const refused = spawnSync(process.execPath, [
      BIN, '--review-cmd', 'node -e "0"', '--plants-file', plantsFile, '--min-plants', '1', '--min-recall', '0', '--scorer', 'string',
    ], { cwd: repo, env: envNoSandbox, encoding: 'utf8' });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /No OS sandbox binary found/);
    assert.equal(readFileSync(join(repo, 'src', 'math.mjs'), 'utf8'), MATH_SOURCE);

    const allowed = spawnSync(process.execPath, [
      BIN, '--review-cmd', 'node -e "0"', '--plants-file', plantsFile, '--min-plants', '1', '--min-recall', '0', '--scorer', 'string', '--unsafe-no-sandbox',
    ], { cwd: repo, env: envNoSandbox, encoding: 'utf8' });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stderr, /WARNING: Running witness command WITHOUT OS sandbox/);
  });
});

test('selectPlants, filterEquivalentMutants, verifyWitness, and automatic CLI selection skip or reject tracked symlinks without touching outside files', () => {
  withTmp((root) => {
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    const outside = join(root, 'outside-target.mjs');
    const outsideSource = 'export function secretCheck(x) {\n  return x > 0;\n}\n';
    writeFileSync(outside, outsideSource);
    writeFileSync(join(repo, 'src', 'math.mjs'), MATH_SOURCE);
    symlinkSync(outside, join(repo, 'src', 'linked.mjs'));

    const selected = selectPlants(['src/linked.mjs', '../outside-target.mjs', 'src/math.mjs'], repo, 10, mutate.generateMutants);
    assert.ok(selected.length > 0, 'real in-repo file produces plants');
    assert.ok(selected.every((p) => p.file === 'src/math.mjs'), 'tracked symlinks and escaping paths are never selected');

    const badPlant = {
      file: 'src/linked.mjs',
      absolutePath: join(repo, 'src', 'linked.mjs'),
      line: 2,
      original: '  return x > 0;',
      mutated: '  return x >= 0;',
      witness: { cmd: process.execPath, args: ['-e', 'process.exit(0)'] },
    };
    assert.throws(
      () => filterEquivalentMutants([badPlant], repo),
      /Refusing to plant outside repository or through symlink/,
    );
    assert.throws(
      () => verifyWitness(badPlant, repo, () => ({ status: 0, timedOut: false })),
      /Refusing to plant outside repository or through symlink/,
    );
    assert.equal(readFileSync(outside, 'utf8'), outsideSource, 'outside target file was never modified');

    // If a review command replaces the planted file with a symlink mid-run, restoreAll refuses to write through it and keeps the journal open
    const midRunTarget = join(repo, 'src', 'swap.mjs');
    writeFileSync(midRunTarget, 'const z = 1;\n');
    const swapper = join(root, 'swapper.mjs');
    writeFileSync(swapper, `import { rmSync, symlinkSync } from 'node:fs'; rmSync(${JSON.stringify(midRunTarget)}); symlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(midRunTarget)});\n`);
    let journalEnded = false;
    runWithPlants(
      [{ absolutePath: midRunTarget, line: 1, original: 'const z = 1;', mutated: 'const z = 2;' }],
      `${process.execPath} ${swapper}`,
      'HEAD',
      repo,
      5000,
      { journal: { begin() {}, end() { journalEnded = true; } } },
    );
    assert.equal(journalEnded, false, 'journal must remain open when restore refuses a mid-run symlink swap');
    assert.equal(readFileSync(outside, 'utf8'), outsideSource, 'restoreAll never writes through a mid-run symlink');
    rmSync(midRunTarget, { force: true });

    // End-to-end automatic commit selection with a tracked symlink in the commit
    const gitBin = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const g = (...a) => execFileSync(gitBin, a, { cwd: repo, encoding: 'utf8' });
    g('init', '-q', '-b', 'main', '--template=');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'README.md'), 'base\n');
    g('add', 'README.md');
    g('commit', '-qm', 'base');
    g('add', 'src/math.mjs', 'src/linked.mjs');
    g('commit', '-qm', 'feat with tracked symlink');

    const autoRes = spawnSync(process.execPath, [
      BIN, '--commit', 'HEAD', '--review-cmd', `${process.execPath} -e "0"`, '--min-plants', '1', '--min-recall', '0', '--scorer', 'string', '--unsafe-no-sandbox',
    ], { cwd: repo, encoding: 'utf8' });
    assert.equal(autoRes.status, 0, autoRes.stderr);
    assert.equal(readFileSync(outside, 'utf8'), outsideSource, 'automatic calibration run left outside symlink target untouched');
  });
});

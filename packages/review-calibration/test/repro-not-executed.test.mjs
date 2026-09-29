// review-calibration/test/repro-not-executed.test.mjs
// The CLI never runs a command supplied by the reviewer it is measuring: a
// finding's `repro` is parsed but every finding is decided by the configured
// judge. The docs and --help must say only that.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from '@adlc/core/test-kit';
import {
  BOUNDARY_PLANT, createMathRepo, writeFakeJudge, writePlantsFile, writeJsonReviewer,
  fakeJudgeEnv, runCli,
} from './cli-fixtures.mjs';

const PKG = resolve(fileURLToPath(import.meta.url), '../..');
const REPO = resolve(PKG, '../..');
const MIRROR = join(REPO, 'apps/docs/content/docs/toolkit/review-calibration.mdx');

// Phrases that describe the CLI confirming a finding through its repro.
const REPRO_CLAIMS = [
  /repro[^.]*verified behaviorally/i,
  /verified behaviorally[^.]*repro/i,
  /repro[^.]*bypasses the judge/i,
  /verified by a reviewer-supplied repro/i,
  /repro`? discriminates the mutant/i,
];

function assertNoReproClaim(label, text) {
  for (const claim of REPRO_CLAIMS) {
    assert.doesNotMatch(text, claim, `${label} claims repro verification the CLI does not perform`);
  }
}

describe('a reviewer-supplied repro is never executed by the CLI', () => {
  it('the judge decides a repro-carrying finding and the repro command does not run', (t) => {
    const { dir } = createMathRepo(t);
    const markerDir = tmp(t, 'rc-repro-marker-');
    const marker = join(markerDir, 'ran');
    const reviewCmd = writeJsonReviewer(t, [{
      file: 'src/math.mjs', line_start: 6, title: 'lgtm', body: 'nothing to see',
      repro: { cmd: 'node', args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(1)`] },
    }]);
    const result = runCli([
      '--review-cmd', reviewCmd,
      '--plants-file', writePlantsFile(t, [BOUNDARY_PLANT]),
      '--min-plants', '1', '--min-recall', '0', '--json',
    ], dir, fakeJudgeEnv(writeFakeJudge(t), 'discriminating'));
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.caught, 0, 'the judge rejected the finding; its repro earned nothing');
    assert.equal(existsSync(marker), false, 'the reviewer-supplied repro command must never run');
  });
});

describe('docs describe only the judge path', () => {
  it('--help does not claim repro verification', (t) => {
    const { dir } = createMathRepo(t);
    const result = runCli(['--help'], dir);
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /repro/i);
  });

  it('the bin header does not claim repro verification', () => {
    const header = readFileSync(join(PKG, 'bin/review-calibration.mjs'), 'utf8').split('\n').slice(0, 15).join('\n');
    assertNoReproClaim('bin header', header);
    assert.match(header, /is never executed/);
  });

  it('the README does not claim repro verification', () => {
    assertNoReproClaim('README.md', readFileSync(join(PKG, 'README.md'), 'utf8'));
  });

  it('the docs-site mirror does not claim repro verification', () => {
    assertNoReproClaim('review-calibration.mdx', readFileSync(MIRROR, 'utf8'));
  });
});

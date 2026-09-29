// review-calibration/test/judge-mode-e2e.test.mjs
// The configured-judge control is the only thing that stops a judge-mode run
// whose LLM judge cannot reject an echoing reviewer. These runs drive the real
// bin through judge mode (fake agy binary, no network) with a reviewer whose
// finding locates the plant, so the configured judge renders verdicts and the
// fail-closed wiring is exercised end to end in both directions.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOUNDARY_PLANT, createMathRepo, writeFakeJudge, writePlantsFile, writeJsonReviewer,
  fakeJudgeEnv, runCli,
} from './cli-fixtures.mjs';

const IDENTIFYING = [{
  file: 'src/math.mjs', line_start: 6,
  title: 'inclusive bound admits zero', body: 'isPositive(0) now returns true',
}];

function runJudgeMode(t, mode, findings = IDENTIFYING) {
  const { dir } = createMathRepo(t);
  const agy = writeFakeJudge(t);
  return runCli([
    '--review-cmd', writeJsonReviewer(t, findings),
    '--plants-file', writePlantsFile(t, [BOUNDARY_PLANT]),
    '--min-plants', '1', '--min-recall', '0.5', '--json',
  ], dir, fakeJudgeEnv(agy, mode));
}

describe('judge mode: the configured-judge control fails closed', () => {
  it('a permissive configured judge stops the run with exit 1 and no scorecard', (t) => {
    const result = runJudgeMode(t, 'permissive');
    assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /judge self-test FAILED/);
    assert.match(result.stderr, /tier cheap/);
    assert.equal(result.stdout.trim(), '', 'no recall figure may be emitted');
  });

  it('a discriminating configured judge is certified bounded and the run passes', (t) => {
    const result = runJudgeMode(t, 'discriminating');
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.caught, 1);
    assert.equal(report.configuredJudgeBounded, true);
    assert.equal(report.configuredJudgeEchoRecall, 0);
  });
});

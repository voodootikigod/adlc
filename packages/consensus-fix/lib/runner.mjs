/**
 * runner.mjs — Orchestrates the consensus-fix workflow.
 * Depends on an injectable `completeFn` to keep LLM boundary isolated.
 */

import { execFileSync } from 'node:child_process';
import { takeSnapshot, restoreSnapshot, applyChanges } from './snapshot.mjs';
import { totalChangedLines } from './diff.mjs';
import { groupByChangeset, selectWinner, isAllDivergent } from './agreement.mjs';
import { buildPrompt } from './prompt.mjs';
import { extractJson } from '../../core/index.mjs';

/**
 * Run the given shell command, returning { exitCode, output }.
 * Never throws — captures stderr+stdout.
 */
export function runCommand(cmd) {
  try {
    const stdout = execFileSync('sh', ['-c', cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, output: stdout };
  } catch (err) {
    const output = (err.stdout ?? '') + (err.stderr ?? '');
    return { exitCode: err.status ?? 1, output };
  }
}

/**
 * Validate a parsed LLM response.
 * Returns { valid: true, changes } or { valid: false, reason }.
 */
export function validateCandidate(parsed, allowedPaths) {
  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, reason: 'response is not an object' };
  }
  if (!Array.isArray(parsed.changes)) {
    return { valid: false, reason: 'missing or non-array "changes" field' };
  }
  const allowedSet = new Set(allowedPaths);
  for (const change of parsed.changes) {
    if (typeof change.file !== 'string' || typeof change.content !== 'string') {
      return { valid: false, reason: 'each change must have string "file" and "content"' };
    }
    if (!allowedSet.has(change.file)) {
      return { valid: false, reason: `file "${change.file}" is not in the provided list` };
    }
  }
  return { valid: true, changes: parsed.changes };
}

/**
 * Main consensus-fix engine.
 *
 * @param {object} opts
 * @param {string} opts.testCmd
 * @param {string[]} opts.files        — absolute paths
 * @param {number} opts.n              — fan width
 * @param {string} opts.tier           — 'cheap' | 'mid' | 'frontier'
 * @param {Function} opts.completeFn   — async (prompt) => string (injectable for testing)
 * @param {string} [opts.railsCmd]     — full frozen rail suite; regression gate.
 *                                       A candidate survives only if BOTH testCmd
 *                                       and railsCmd pass. If omitted, candidates
 *                                       are NOT checked against the rails (a
 *                                       warning is surfaced via onProgress and
 *                                       the returned railsChecked=false flag).
 * @param {Function} [opts.onProgress] — optional callback for progress messages
 * @returns {Promise<RunResult>}
 */
export async function runConsensusFix({
  testCmd,
  files,
  n,
  tier,
  completeFn,
  railsCmd,
  onProgress = () => {},
}) {
  const railsChecked = Boolean(railsCmd);
  if (!railsChecked) {
    onProgress(
      'WARNING: no --rails command supplied — candidates are NOT checked against ' +
        'the full rails. A fix that reddens other tests/types can still survive. ' +
        'Pass --rails "<full suite>" to close this regression gate.'
    );
  }
  // 1. Run test once — must fail.
  onProgress('Running test to confirm failure...');
  const initialRun = runCommand(testCmd);
  if (initialRun.exitCode === 0) {
    throw Object.assign(new Error('test already passes — nothing to fix'), { isOpError: true });
  }
  const testOutput = initialRun.output;
  onProgress(`Test failed (exit ${initialRun.exitCode}). Capturing output.`);

  // 2. Take snapshot of all files.
  const snapshot = takeSnapshot(files);
  onProgress(`Snapshot taken for ${files.length} file(s).`);

  // 3. Build prompt.
  const prompt = buildPrompt({ testCmd, testOutput, snapshot });

  // 4. Fan N completions.
  onProgress(`Fanning ${n} completions (tier: ${tier})...`);
  const rawResponses = await Promise.allSettled(
    Array.from({ length: n }, () => completeFn(prompt))
  );

  // 5. Evaluate each candidate SEQUENTIALLY.
  const results = [];  // { index, changes, changedLines, passed, discarded, reason }

  for (let i = 0; i < rawResponses.length; i++) {
    const res = rawResponses[i];
    onProgress(`Evaluating candidate ${i + 1}/${n}...`);

    if (res.status !== 'fulfilled') {
      results.push({
        index: i,
        discarded: true,
        reason: `LLM call failed: ${res.reason}`,
      });
      continue;
    }

    // Parse JSON from response.
    let parsed;
    try {
      parsed = extractJson(res.value);
    } catch (err) {
      results.push({
        index: i,
        discarded: true,
        reason: `JSON parse failed: ${err.message}`,
      });
      continue;
    }

    // Validate candidate.
    const validation = validateCandidate(parsed, files);
    if (!validation.valid) {
      results.push({
        index: i,
        discarded: true,
        reason: `validation failed: ${validation.reason}`,
      });
      continue;
    }

    const { changes } = validation;

    // Apply changes, run the repro gate (testCmd) and — if supplied — the
    // regression gate (railsCmd) against the SAME applied changes, then restore.
    //
    // C7: a candidate "survives" only when BOTH gates pass. A fix that makes
    // the repro pass by deleting an assertion, weakening a sibling test, or
    // breaking other tests reddens the rails and is REJECTED, not ranked.
    let testPassed = false;
    let railsPassed = false;
    let testRunOutput = '';
    let railsRunOutput = '';
    try {
      applyChanges(changes, snapshot);
      const testRun = runCommand(testCmd);
      testPassed = testRun.exitCode === 0;
      testRunOutput = testRun.output;

      if (!railsChecked) {
        // No rails gate configured — do not block on regressions, but the
        // survivor is only as trustworthy as the repro gate.
        railsPassed = true;
      } else if (testPassed) {
        // Only spend the rails run when the repro already passed; a candidate
        // that fails the repro can never survive regardless of the rails.
        const railsRun = runCommand(railsCmd);
        railsPassed = railsRun.exitCode === 0;
        railsRunOutput = railsRun.output;
      }
    } finally {
      restoreSnapshot(snapshot);
    }

    const changedLines = totalChangedLines(changes, snapshot);
    const passed = testPassed && railsPassed;

    results.push({
      index: i,
      discarded: false,
      changes,
      changedLines,
      passed,
      testPassed,
      railsPassed,
      railsChecked,
      testRunOutput,
      railsRunOutput,
    });

    let label;
    if (passed) {
      label = railsChecked ? 'PASS (repro+rails)' : 'PASS (repro; rails unchecked)';
    } else if (testPassed && !railsPassed) {
      label = 'REJECTED (repro passed but rails reddened)';
    } else {
      label = 'FAIL (repro)';
    }
    onProgress(`  Candidate ${i + 1}: ${label} | ${changedLines} changed line(s)`);
  }

  // 6. Filter survivors — passed means BOTH gates passed (or rails unchecked).
  const survivors = results.filter((r) => !r.discarded && r.passed);
  const discarded = results.filter((r) => r.discarded);
  const failed = results.filter((r) => !r.discarded && !r.passed);

  onProgress(
    `Survivors: ${survivors.length} | Failed: ${failed.length} | Discarded: ${discarded.length}`
  );

  // 7. Group by agreement.
  const groups = groupByChangeset(survivors);
  const allDivergent = isAllDivergent(groups, n);
  const selectionResult = selectWinner(groups);

  return {
    survivors,
    discarded,
    failed,
    groups,
    allDivergent,
    selectionResult,
    railsChecked,
    prompt,
    snapshot,
  };
}

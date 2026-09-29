/**
 * runner.mjs — Orchestrates the consensus-fix workflow.
 * Depends on an injectable `completeFn` to keep LLM boundary isolated.
 */

import { spawn } from 'node:child_process';
import { takeSnapshot, restoreSnapshot, applyChanges } from './snapshot.mjs';
import { totalHunkChangedLines } from './hunks.mjs';
import { groupByChangeset, selectWinner, isAllDivergent } from './agreement.mjs';
import { buildPrompt } from './prompt.mjs';
import { extractJson } from '@adlc/core';

/** How long an aborted command's process group gets after SIGTERM before SIGKILL. */
export const ABORT_GRACE_MS = 2000;

/** Exit code reported for a command that was aborted, or never started because of an abort. */
const ABORTED_EXIT_CODE = 130;

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group has already exited.
  }
}

/**
 * Run the given shell command asynchronously, resolving { exitCode, output }.
 * Never rejects — captures stderr+stdout.
 *
 * The command runs in its own process group so that aborting `signal` stops
 * the whole tree it started (SIGTERM, then SIGKILL after ABORT_GRACE_MS); the
 * promise resolves only once the command has exited, so no candidate write can
 * land after the caller restores its snapshot. Asynchronous on purpose: a
 * blocking spawn would leave the event loop unable to dispatch a termination
 * signal for as long as the command runs.
 */
export function runCommand(cmd, { signal } = {}) {
  if (signal?.aborted) {
    return Promise.resolve({ exitCode: ABORTED_EXIT_CODE, output: 'aborted before start' });
  }
  return new Promise((resolvePromise) => {
    const child = spawn('sh', ['-c', cmd], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let escalation = null;
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const onAbort = () => {
      killGroup(child.pid, 'SIGTERM');
      escalation = setTimeout(() => killGroup(child.pid, 'SIGKILL'), ABORT_GRACE_MS);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    let settled = false;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (escalation) clearTimeout(escalation);
      resolvePromise({ exitCode, output });
    };
    child.on('error', (err) => {
      output += err.message;
      finish(127);
    });
    child.on('close', (code) => {
      if (signal?.aborted) {
        // A group member may still hold a candidate file open; make sure none survive.
        killGroup(child.pid, 'SIGKILL');
        finish(ABORTED_EXIT_CODE);
        return;
      }
      finish(code ?? 1);
    });
  });
}

/** Thrown out of runConsensusFix when its `signal` is aborted. */
export class RunAbortedError extends Error {
  constructor() {
    super('consensus-fix run aborted');
    this.name = 'RunAbortedError';
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new RunAbortedError();
}

/** Resolve `promise`, or reject with RunAbortedError as soon as `signal` aborts. */
function unlessAborted(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolvePromise, reject) => {
    const onAbort = () => reject(new RunAbortedError());
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolvePromise(value); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

/**
 * Validate one hunk's shape (bounds/content are checked later, against the
 * real file, by applyHunks — this only checks the JSON shape is sane enough
 * to attempt applying).
 */
function isWellFormedHunk(hunk) {
  return (
    hunk && typeof hunk === 'object' &&
    Number.isInteger(hunk.startLine) &&
    Number.isInteger(hunk.endLine) &&
    typeof hunk.replacement === 'string'
  );
}

/**
 * Validate a parsed LLM response (issue #279: hunk-based changes, not full
 * file content).
 * Returns { valid: true, changes } or { valid: false, reason }.
 */
export function validateCandidate(parsed, allowedPaths) {
  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, reason: 'response is not an object' };
  }
  if (!Array.isArray(parsed.changes)) {
    return { valid: false, reason: 'missing or non-array "changes" field' };
  }
  // An empty changeset applies as a true no-op: nothing distinguishes it from
  // a real fix at the survivor stage, so an unanimous group of no-op
  // candidates would otherwise win consensus outright on a test that happens
  // to pass its SECOND (unmodified-source) run for an environmental reason
  // (issue #599). Reject it here, before it can ever become a survivor.
  if (parsed.changes.length === 0) {
    return { valid: false, reason: 'candidate proposes no changes' };
  }
  const allowedSet = new Set(allowedPaths);
  for (const change of parsed.changes) {
    if (typeof change.file !== 'string' || !Array.isArray(change.hunks)) {
      return { valid: false, reason: 'each change must have a string "file" and an array "hunks"' };
    }
    if (!allowedSet.has(change.file)) {
      return { valid: false, reason: `file "${change.file}" is not in the provided list` };
    }
    if (change.hunks.length === 0) {
      return { valid: false, reason: `file "${change.file}" has an empty "hunks" array` };
    }
    if (!change.hunks.every(isWellFormedHunk)) {
      return { valid: false, reason: `file "${change.file}" has a malformed hunk (need integer startLine/endLine and string replacement)` };
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
 * @param {Function} opts.completeFn   — async (prompt, providerName?) => string
 *                                       (injectable for testing). `providerName`
 *                                       is only passed when `opts.providerNames`
 *                                       is supplied — otherwise it is called
 *                                       with just `(prompt)`, unchanged from
 *                                       prior behavior.
 * @param {string[]} [opts.providerNames] — issue #63: draw ONE candidate per
 *                                       named provider family (e.g.
 *                                       ['anthropic', 'openai', 'gemini'])
 *                                       instead of `n` resamples of a single
 *                                       auto-detected provider. When supplied,
 *                                       overrides `n` (the fan width becomes
 *                                       providerNames.length). Additive only —
 *                                       omit it and behavior is unchanged.
 * @param {string} [opts.railsCmd]     — full frozen rail suite; regression gate.
 *                                       A candidate survives only if BOTH testCmd
 *                                       and railsCmd pass. If omitted, candidates
 *                                       are NOT checked against the rails (a
 *                                       warning is surfaced via onProgress and
 *                                       the returned railsChecked=false flag).
 * @param {Function} [opts.onProgress] — optional callback for progress messages
 * @param {AbortSignal} [opts.signal] — aborting it kills the in-flight test or
 *                                       rails command, restores the snapshot and
 *                                       rejects with RunAbortedError.
 * @returns {Promise<RunResult>}
 */
export async function runConsensusFix({
  testCmd,
  files,
  n,
  tier,
  completeFn,
  providerNames,
  railsCmd,
  onProgress = () => {},
  signal,
}) {
  // Fan width: one candidate per named provider when --providers is supplied,
  // otherwise the usual n resamples of the single auto-detected provider.
  const fanWidth = providerNames ? providerNames.length : n;
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
  const initialRun = await runCommand(testCmd, { signal });
  throwIfAborted(signal);
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

  // 4. Fan completions: one per named provider family (--providers), or n
  //    resamples of the single auto-detected provider (default).
  onProgress(
    providerNames
      ? `Fanning ${fanWidth} completions across providers [${providerNames.join(', ')}] (tier: ${tier})...`
      : `Fanning ${fanWidth} completions (tier: ${tier})...`
  );
  const rawResponses = await unlessAborted(Promise.allSettled(
    providerNames
      ? providerNames.map((name) => completeFn(prompt, name))
      : Array.from({ length: fanWidth }, () => completeFn(prompt))
  ), signal);

  // 5. Evaluate each candidate SEQUENTIALLY.
  const results = [];  // { index, changes, changedLines, passed, discarded, reason, provider? }

  for (let i = 0; i < rawResponses.length; i++) {
    const res = rawResponses[i];
    const provider = providerNames ? providerNames[i] : undefined;
    onProgress(`Evaluating candidate ${i + 1}/${fanWidth}...`);

    if (res.status !== 'fulfilled') {
      results.push({
        index: i,
        discarded: true,
        reason: `LLM call failed: ${res.reason}`,
        provider,
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
        provider,
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
        provider,
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
    //
    // A hunk that fails to apply (issue #279: coordinates don't match the
    // real file — an off-by-one, a stale line reference from an excerpt)
    // disqualifies only THIS candidate, same as any other discard reason —
    // it never aborts the run. restoreSnapshot always runs in `finally`:
    // applyChanges writes files one at a time, so a failure partway through
    // a multi-file candidate can leave an earlier file mutated even though
    // the candidate as a whole is being discarded.
    let testPassed = false;
    let railsPassed = false;
    let testRunOutput = '';
    let railsRunOutput = '';
    let applyError = null;
    try {
      const applyResult = applyChanges(changes, snapshot);
      if (!applyResult.ok) {
        applyError = applyResult.error;
      } else {
        const testRun = await runCommand(testCmd, { signal });
        testPassed = testRun.exitCode === 0;
        testRunOutput = testRun.output;

        if (!railsChecked) {
          // No rails gate configured — do not block on regressions, but the
          // survivor is only as trustworthy as the repro gate.
          railsPassed = true;
        } else if (testPassed) {
          // Only spend the rails run when the repro already passed; a candidate
          // that fails the repro can never survive regardless of the rails.
          const railsRun = await runCommand(railsCmd, { signal });
          railsPassed = railsRun.exitCode === 0;
          railsRunOutput = railsRun.output;
        }
      }
    } finally {
      restoreSnapshot(snapshot);
    }
    throwIfAborted(signal);

    if (applyError) {
      results.push({
        index: i,
        discarded: true,
        reason: `hunk apply failed: ${applyError}`,
        provider,
      });
      onProgress(`  Candidate ${i + 1}: DISCARDED (hunk apply failed: ${applyError})`);
      continue;
    }

    const changedLines = totalHunkChangedLines(changes);
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
      provider,
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
  const allDivergent = isAllDivergent(groups, fanWidth);
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

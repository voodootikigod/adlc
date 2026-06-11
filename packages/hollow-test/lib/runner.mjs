// hollow-test/lib/runner.mjs
// Runs a single mutant: writes mutated content, executes test command, restores file.
// Returns { killed: boolean, timedOut: boolean, exitCode: number | null }

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

// Strip NODE_TEST_CONTEXT from the child environment so that a test command
// using `node --test` does not hit Node.js v22's recursive-invocation guard
// (which causes it to skip all test files and exit 0, making every mutant
// look like it survived).
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/**
 * Run one mutant trial. Writes mutated content to disk, runs test command,
 * always restores original content (finally-like pattern using try/finally).
 *
 * @param {string} filePath  - Absolute path to the file to mutate.
 * @param {string} original  - The file's original content (used for restore).
 * @param {string} mutated   - The mutated content to test.
 * @param {string} testCmd   - Shell command to run the test suite.
 * @param {number} timeoutMs - Maximum time in ms to wait for the test command.
 * @param {string} cwd       - Working directory for the test command.
 * @returns {{ killed: boolean, timedOut: boolean, exitCode: number | null }}
 */
export function runMutant(filePath, original, mutated, testCmd, timeoutMs, cwd) {
  let result;
  try {
    writeFileSync(filePath, mutated, 'utf8');
    result = spawnSync(testCmd, {
      shell: true,
      cwd,
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: 'pipe',
      env: childEnv(),
    });
  } finally {
    // Always restore original content, even if spawnSync threw.
    writeFileSync(filePath, original, 'utf8');
  }

  const timedOut = result.signal === 'SIGTERM' || result.status === null;
  const killed = timedOut || (result.status !== 0);

  return {
    killed,
    timedOut,
    exitCode: result.status,
  };
}

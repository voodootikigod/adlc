// `node:test` for the suite, with ONE difference: while the coverage gate's
// execution passes (AC 114 / AC 121) are importing test files to call their
// exported functions directly, `test()` registers nothing. A registered copy
// would run as a subtest of the gate, concurrently with the direct call, and
// the two would race on the process-wide mutation seams (`withMutation`
// restores the seam when the FIRST caller finishes) — a timing-dependent
// false red in the gate that was not a defect in the criterion under test.
import * as nodeTest from 'node:test';

export const GATE_EXEC_KEY = '__adlcAutopilotGateExec';

/** True while the gate is executing registered functions directly (set by spec-coverage.test.mjs). */
export const gateExecuting = () => globalThis[GATE_EXEC_KEY] === true;

export const test = (...args) => (gateExecuting() ? Promise.resolve() : nodeTest.test(...args));
export const { mock, before, after, beforeEach, afterEach } = nodeTest;

/** node >=20.12 takes `{ apis: [...] }`; node 18 takes the bare array — enable whichever this runtime speaks (CI matrix red, 2026-08-30). */
export function enableFakeTimers(mock, apis = ['setTimeout']) {
  try { mock.timers.enable({ apis }); } catch { mock.timers.enable(apis); }
}

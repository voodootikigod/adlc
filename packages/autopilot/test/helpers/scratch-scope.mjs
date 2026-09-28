// One cleanup context for scratch directories minted by helpers that are called
// without a per-test context (fixture builders, and exported criterion
// functions invoked directly by the coverage gate). Everything registered on it
// is removed when the process exits.
//
// Tied to process exit rather than a node:test after() hook: this module can
// first be imported from inside a running test (the gate imports criterion
// files lazily), where after() would attach to that one test and dispose the
// context while later tests still use it. The kit's removal hooks are
// synchronous, so they are safe to run in an 'exit' handler.
const hooks = [];

export const SCRATCH_SCOPE = Object.freeze({ after: (hook) => { hooks.push(hook); } });

process.once('exit', () => {
  for (const hook of hooks.splice(0).reverse()) {
    try { hook(); } catch (error) { process.stderr.write(`scratch cleanup failed: ${error?.message ?? error}\n`); }
  }
});

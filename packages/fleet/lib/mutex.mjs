// A minimal async mutex — serializes the merge phase (spec §9) while builds and
// gates run concurrently (adversarial-review C4). Promise-chain based, zero-dep.

export function createMutex() {
  let tail = Promise.resolve();
  return {
    /** Run `fn` exclusively; resolves/rejects with fn's result. */
    runExclusive(fn) {
      const run = tail.then(() => fn());
      // Keep the chain alive even if fn rejects, so the lock is always released.
      tail = run.then(() => {}, () => {});
      return run;
    },
  };
}

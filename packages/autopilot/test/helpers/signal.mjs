// Causal waiting for the suite's async tests (#994).
//
// What this replaces: a `while` loop that awaited `setImmediate` and gave up
// after a fixed 50,000 iterations — a busy-wait whose budget is an iteration
// count, unrelated to the work being waited on. Measured on an idle 16-core
// machine, that whole budget is worth about 100ms of wall time, so any awaited
// work slower than that exhausts it every time; the failure rate is therefore a
// property of machine load rather than of the code under test, and re-running
// until green converges on "passes on a fast runner". Such a spin also cannot
// advance work parked on a timer or on I/O, so raising the cap does not fix it.
//
// Two rules follow, and both are load-bearing:
//   1. A waiter registered AFTER the event has already happened must resolve
//      immediately. A helper that only starts listening when called silently
//      reintroduces the race it was meant to remove — the caller then waits for
//      the NEXT occurrence, which may never come.
//   2. A timeout must name the thing that did NOT happen. The old assertion
//      message described the state the caller was hoping for, so "the dispatch
//      never happened" and "the dispatch happened and hung" — different failures,
//      only one of them the point of the test — read identically.

/**
 * A counting latch. `fire()` records one occurrence; `when(n)` and `until(fn)`
 * hand out promises that are already resolved when the condition holds, and are
 * released by a later `fire()` otherwise.
 */
export function createLatch() {
  let count = 0;
  let waiters = [];

  /** A promise that settles the first time `predicate(count)` holds — checked now and on every fire. */
  const until = (predicate) => {
    if (predicate(count)) return Promise.resolve(count);
    return new Promise((resolve) => { waiters = waiters.concat([{ predicate, resolve }]); });
  };

  const fire = () => {
    count += 1;
    // Each predicate is evaluated exactly ONCE per fire and the verdict reused:
    // callers legitimately write predicates over state the latch does not own
    // (`() => timers.some(...)`), and asking twice invites the two answers to
    // disagree.
    const decided = waiters.map((w) => ({ waiter: w, ready: w.predicate(count) }));
    waiters = decided.filter((d) => !d.ready).map((d) => d.waiter);
    for (const d of decided) if (d.ready) d.waiter.resolve(count);
    return count;
  };

  return { fire, until, count: () => count, when: (n = 1) => until((c) => c >= n) };
}

/**
 * Await `signal`, rejecting with `message` if it has not settled within
 * `timeoutMs`. `message` may be a function, evaluated at the timeout so it can
 * report how far the run actually got. It must name what failed to happen —
 * never the state the caller wants — so a timeout is never mistaken for the
 * condition under test.
 */
export function awaitSignal(signal, { timeoutMs = 30_000, message } = {}) {
  const usable = typeof message === 'function' || (typeof message === 'string' && message.length > 0);
  if (!usable) throw new Error('awaitSignal requires a non-empty message (or a function returning one) naming what did not happen');
  let timer = null;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(typeof message === 'function' ? message() : message)), timeoutMs);
  });
  // The timer is ALWAYS cleared once the race settles, which is what keeps a won
  // wait from holding the event loop open. Do not `unref()` it as well: an
  // unref'd timer does not hold the loop, so a test whose only pending work is
  // this timeout drains the loop and node:test cancels it with "Promise
  // resolution is still pending but the event loop has already resolved"
  // (cancelledByParent). That passed locally per-file and failed on all three CI
  // node versions.
  return Promise.race([signal, expiry]).finally(() => { if (timer) clearTimeout(timer); });
}

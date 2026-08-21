// supervise-loop.test.mjs — the ordering `superviseLoop` exists to get right.
//
// Every dependency is a stub, so these tests are about the LOOP: when it
// captures, what it refuses to inject, what it kills and what it deliberately
// leaves running. The real spawner/continue-runner are covered by
// supervise-runtime.test.mjs, and the whole thing end-to-end (real CLI, real
// deny marker, fake `claude` binary) by cli-test/cli-supervise.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Read for the structural pin below — both sides of it come from this file. */
const SUPERVISE_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'supervise.mjs');

import {
  superviseLoop,
  parseContinuePayload,
  formatContinueCommand,
  degradeMessage,
  superviseChildEnv,
  transcriptPathFor,
  classifyChildExit,
  superviseExitCode,
  describeOutcome,
  terminateChild,
  abnormalSelfExit,
  SUPERVISE_EXIT_CODES,
  CHILD_SESSION_ENV_MARKERS,
} from '../lib/supervise.mjs';
import {
  SUPERVISE_DENY_POLL_MS,
  SUPERVISE_QUIESCENCE_MS,
  SUPERVISE_TERMINATE_GRACE_MS,
} from '../lib/thresholds.mjs';

/**
 * Every async test here drives the loop, whose waits (for a deny, for
 * quiescence, for the child to exit) are deliberately unbounded — that is
 * correct for a wrapper attached to somebody's session, and wrong for a test.
 * Without a bound, a regression that removes a loop-exit guard SPINS instead of
 * failing, and `node --test` has no default timeout: CI would stall to the job
 * limit with no test named. This converts that class of regression into a named
 * failure. Generous on purpose — the fake clock makes these run in
 * milliseconds, so anything near this bound is a hang, not slow work.
 */
const LOOP_TEST = { timeout: 30_000 };

const DENIER = 'sess-denier';
const SUCCESSOR = 'sess-successor';
const HASH = 'a'.repeat(64);
const PROMPT = 'Continuation of session sess-denier under ticket T-1. Read the handoff below.';

/** A spawned child the test drives by hand. */
function fakeChild() {
  let settle;
  let reject;
  const child = {
    signals: [],
    kill(signal) {
      child.signals.push(signal);
    },
    end(code = 0, signal = null) {
      settle({ code, signal });
    },
    /** A child that never started — the spawner's own failure. */
    fail(error) {
      reject(error);
    },
    exited: new Promise((resolve, rej) => {
      settle = resolve;
      reject = rej;
    }),
  };
  return child;
}

/**
 * Drive the loop on a fake clock.
 *
 * `sleep` advances the clock AND flushes the microtask queue, so a child that
 * resolved its exit promise is observed on the next tick exactly as a real one
 * would be — the loop never gets to see an exit it has not waited for.
 */
function harness({
  denies = {},
  transcriptMtime = () => 1_000,
  continueResult = () => ({
    ok: true,
    payload: {
      tool: 'handoff',
      command: 'continue',
      dryRun: false,
      successor_session_id: SUCCESSOR,
      ticket_id: 'T-1',
      content_path: '.adlc/handoffs/content/sess-denier.md',
      content_hash: HASH,
      bootstrap_prompt: PROMPT,
    },
  }),
  verifyCapture = () => ({ ok: true }),
  onSpawn = () => {},
  sessions = [DENIER],
} = {}) {
  const clock = { t: 0 };
  const spawns = [];
  const children = [];
  const logs = [];
  const continueCalls = [];
  let minted = 0;

  const deps = {
    mintSessionId: () => sessions[Math.min(minted++, sessions.length - 1)],
    spawn: ({ sessionId, prompt }) => {
      const child = fakeChild();
      spawns.push({ sessionId, prompt, child });
      children.push(child);
      onSpawn({ sessionId, prompt, child, index: spawns.length - 1, clock });
      return child;
    },
    readOpenDeny: (sessionId) => {
      const at = denies[sessionId];
      if (at === undefined) return null;
      return clock.t >= at ? { session_id: sessionId, status: 'open', ticket_id: 'T-1' } : null;
    },
    transcriptPath: (sessionId) => `/transcripts/${sessionId}.jsonl`,
    statTranscript: (path) => {
      const mtime = transcriptMtime(path, clock);
      return mtime === null ? null : { mtimeMs: mtime };
    },
    runContinue: async (args) => {
      continueCalls.push({ ...args, at: clock.t });
      return continueResult(args);
    },
    verifyCapture: (args) => verifyCapture(args),
    log: (line) => logs.push(line),
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  return { deps, spawns, children, logs, continueCalls, clock };
}

test('a deny is continued: capture handed over, child terminated, successor respawned with the prompt', LOOP_TEST, async () => {
  const h = harness({
    denies: { [DENIER]: 0 },
    onSpawn: ({ sessionId, child }) => {
      // The superseded child dies on SIGTERM; the successor's session simply
      // ends, which is what stops the loop.
      if (sessionId === SUCCESSOR) setImmediate(() => child.end(0));
    },
  });
  // The denied child only exits once it is signalled — proving the loop is the
  // thing that ended it, not a child that happened to stop on its own.
  h.deps.spawn = ((inner) => (args) => {
    const child = inner(args);
    if (args.sessionId === DENIER) {
      const realKill = child.kill.bind(child);
      child.kill = (signal) => {
        realKill(signal);
        if (signal === 'SIGTERM') child.end(0, 'SIGTERM');
      };
    }
    return child;
  })(h.deps.spawn);

  const result = await superviseLoop(h.deps);

  assert.equal(result.reason, 'child_exited');
  assert.equal(result.continuations, 1);
  assert.deepEqual(result.sessions, [DENIER, SUCCESSOR]);

  assert.equal(h.continueCalls.length, 1);
  assert.deepEqual(h.continueCalls[0].denySession, DENIER);
  assert.equal(h.continueCalls[0].captureFrom, `/transcripts/${DENIER}.jsonl`);

  assert.equal(h.spawns.length, 2);
  assert.equal(h.spawns[0].sessionId, DENIER);
  assert.equal(h.spawns[0].prompt, null, 'the first session is the operator’s to drive');
  assert.equal(h.spawns[1].sessionId, SUCCESSOR);
  assert.equal(h.spawns[1].prompt, PROMPT);

  assert.deepEqual(h.children[0].signals, ['SIGTERM']);
  assert.deepEqual(h.children[1].signals, [], 'the successor is never signalled');
});

test('continue waits for the transcript to go quiet before capturing', LOOP_TEST, async () => {
  // The transcript keeps growing for three polls, then stops. Capturing during
  // that window would take the handoff summary mid-sentence.
  const stopsAt = SUPERVISE_DENY_POLL_MS * 3;
  const h = harness({
    denies: { [DENIER]: 0 },
    transcriptMtime: (_path, clock) => (clock.t < stopsAt ? clock.t : stopsAt),
    onSpawn: ({ sessionId, child }) => {
      if (sessionId === SUCCESSOR) setImmediate(() => child.end(0));
      if (sessionId === DENIER) {
        const realKill = child.kill.bind(child);
        child.kill = (s) => {
          realKill(s);
          child.end(0, s);
        };
      }
    },
  });

  await superviseLoop(h.deps);

  assert.equal(h.continueCalls.length, 1);
  assert.ok(
    h.continueCalls[0].at >= stopsAt + SUPERVISE_QUIESCENCE_MS,
    `captured at ${h.continueCalls[0].at}, before the transcript had been stable for ${SUPERVISE_QUIESCENCE_MS} ms`,
  );
});

/**
 * A child that is still ALIVE when the degrade fires, and only ends afterwards.
 *
 * This matters more than it looks. A fixture that pre-ends the child makes
 * every `signals: []` assertion vacuous: terminateChild short-circuits on
 * `hasExited()` and never calls kill, so a supervisor that DID kill on the
 * degrade path would pass anyway. Keeping the child alive is what makes those
 * assertions discriminate.
 */
function aliveThroughDegrade() {
  return ({ child, clock }) => {
    const timer = setInterval(() => {
      // The quiescence gate alone runs 5s of fake clock before any degrade.
      if (clock.t > SUPERVISE_QUIESCENCE_MS * 4) {
        clearInterval(timer);
        child.end(0);
      }
    }, 1);
    timer.unref?.();
  };
}

test('a degraded continue leaves the child running and warns exactly once', LOOP_TEST, async () => {
  const h = harness({
    denies: { [DENIER]: 0 },
    continueResult: () => ({ ok: false, error: 'deny is unbound' }),
    // ALIVE through the degrade — see aliveThroughDegrade().
    onSpawn: aliveThroughDegrade(),
  });

  const result = await superviseLoop(h.deps);

  assert.equal(result.reason, 'degraded');
  assert.equal(result.continuations, 0);
  assert.equal(h.spawns.length, 1, 'no successor is spawned');
  assert.deepEqual(h.children[0].signals, [], 'a degrade must never kill the operator’s session');

  const warnings = h.logs.filter((line) => line.includes('automatic continuation is not possible'));
  assert.equal(warnings.length, 1, `expected one warning, got ${warnings.length}`);
  assert.match(warnings[0], /handoff continue --deny-session sess-denier --write/);
  assert.match(warnings[0], /deny is unbound/);
});

test('a capture that no longer matches its hash is never injected', LOOP_TEST, async () => {
  const h = harness({
    denies: { [DENIER]: 0 },
    verifyCapture: () => ({ ok: false, error: 'content_hash mismatch' }),
    onSpawn: aliveThroughDegrade(),
  });

  const result = await superviseLoop(h.deps);

  assert.equal(result.reason, 'degraded');
  assert.equal(h.spawns.length, 1, 'the successor must not be spawned with unverified context');
  assert.deepEqual(h.children[0].signals, []);
  assert.ok(h.logs.some((line) => line.includes('content_hash mismatch')));
});

test('the capture is verified against the hash the continue payload actually bound', LOOP_TEST, async () => {
  const seen = [];
  const h = harness({
    denies: { [DENIER]: 0 },
    verifyCapture: (args) => {
      seen.push(args);
      return { ok: true };
    },
    onSpawn: ({ sessionId, child }) => {
      if (sessionId === SUCCESSOR) setImmediate(() => child.end(0));
      if (sessionId === DENIER) {
        const realKill = child.kill.bind(child);
        child.kill = (s) => {
          realKill(s);
          child.end(0, s);
        };
      }
    },
  });

  await superviseLoop(h.deps);

  assert.deepEqual(seen, [{ denySession: DENIER, contentHash: HASH }]);
});

test('a payload the loop cannot trust degrades instead of spawning', LOOP_TEST, async () => {
  for (const [label, payload] of [
    ['dry run', { dryRun: true, successor_session_id: SUCCESSOR, ticket_id: 'T-1', content_hash: HASH, content_path: 'p', bootstrap_prompt: PROMPT }],
    ['unsafe successor id', { dryRun: false, successor_session_id: 'evil id\nrm -rf /', ticket_id: 'T-1', content_hash: HASH, content_path: 'p', bootstrap_prompt: PROMPT }],
    ['empty prompt', { dryRun: false, successor_session_id: SUCCESSOR, ticket_id: 'T-1', content_hash: HASH, content_path: 'p', bootstrap_prompt: '   ' }],
    ['bad hash', { dryRun: false, successor_session_id: SUCCESSOR, ticket_id: 'T-1', content_hash: 'not-a-digest', content_path: 'p', bootstrap_prompt: PROMPT }],
  ]) {
    const h = harness({
      denies: { [DENIER]: 0 },
      continueResult: () => ({ ok: true, payload }),
      onSpawn: aliveThroughDegrade(),
    });
    const result = await superviseLoop(h.deps);
    assert.equal(result.reason, 'degraded', `${label} must degrade`);
    assert.equal(h.spawns.length, 1, `${label} must not respawn`);
    assert.deepEqual(h.children[0].signals, [], `${label} must not kill the child`);
  }
});

test('a child that ignores SIGTERM is escalated to SIGKILL after the grace', LOOP_TEST, async () => {
  const h = harness({
    denies: { [DENIER]: 0 },
    onSpawn: ({ sessionId, child }) => {
      if (sessionId === SUCCESSOR) setImmediate(() => child.end(0));
      if (sessionId === DENIER) {
        const realKill = child.kill.bind(child);
        child.kill = (signal) => {
          realKill(signal);
          if (signal === 'SIGKILL') child.end(null, 'SIGKILL');
        };
      }
    },
  });

  const result = await superviseLoop(h.deps);

  assert.deepEqual(h.children[0].signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.continuations, 1, 'the continuation still proceeds after the escalation');
  assert.ok(
    h.logs.some((line) => line.includes('SIGKILL') && line.includes(String(SUPERVISE_TERMINATE_GRACE_MS))),
    'the escalation is reported to the operator',
  );
});

/**
 * A denied child that ends on its own terms, with the successor completing
 * normally afterwards. `ending` decides how the denied one goes.
 */
function crashedIntermediate(ending) {
  return harness({
    denies: { [DENIER]: 0 },
    onSpawn: ({ sessionId, child }) => {
      if (sessionId === DENIER) ending(child);
      if (sessionId === SUCCESSOR) setImmediate(() => child.end(0));
    },
  });
}

test('an intermediate that crashed after its deny is reported but does not fail the run', LOOP_TEST, async () => {
  const h = crashedIntermediate((child) => child.end(7));
  const result = await superviseLoop(h.deps);

  // Supervision SUCCEEDED: the deny said this session was being replaced, and
  // its successor finished cleanly. That is the whole point of the loop.
  assert.equal(result.reason, 'child_exited');
  assert.equal(superviseExitCode(result.reason), 0);
  assert.equal(result.continuations, 1);

  // …and the crash is still visible.
  assert.deepEqual(result.abnormalExits, [{ sessionId: DENIER, code: 7, signal: null }]);
  const warnings = h.logs.filter((line) => line.includes('exited abnormally'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], new RegExp(`session ${DENIER} wrote a handoff deny then exited abnormally`));
  assert.match(warnings[0], /code 7/);
  assert.match(warnings[0], /continuing to its successor anyway/);
});

test('a crash signal after the deny is reported the same way', LOOP_TEST, async () => {
  const h = crashedIntermediate((child) => child.end(null, 'SIGSEGV'));
  const result = await superviseLoop(h.deps);

  assert.equal(result.reason, 'child_exited', 'still a successful supervision');
  assert.deepEqual(result.abnormalExits, [{ sessionId: DENIER, code: null, signal: 'SIGSEGV' }]);
  assert.ok(h.logs.some((line) => line.includes('signal SIGSEGV')));
});

test('the ordinary handoff — we terminate a live child — says nothing about abnormal exits', LOOP_TEST, async () => {
  // The control. Without it, a warning that fired unconditionally would pass
  // both tests above while making every normal handoff look like a crash.
  const h = crashedIntermediate((child) => {
    const realKill = child.kill.bind(child);
    child.kill = (signal) => {
      realKill(signal);
      if (signal === 'SIGTERM') child.end(null, 'SIGTERM');
    };
  });

  const result = await superviseLoop(h.deps);

  assert.equal(result.continuations, 1);
  assert.deepEqual(h.children[0].signals, ['SIGTERM'], 'the supervisor is what ended it');
  assert.deepEqual(result.abnormalExits, [], 'a child WE killed never counts as a crash');
  assert.equal(
    h.logs.filter((line) => line.includes('exited abnormally')).length,
    0,
    'the normal path must stay quiet',
  );
});

test('a clean self-exit after the deny is orderly, not abnormal', LOOP_TEST, async () => {
  const h = crashedIntermediate((child) => child.end(0));
  const result = await superviseLoop(h.deps);

  assert.equal(result.continuations, 1);
  assert.deepEqual(result.abnormalExits, []);
  assert.equal(h.logs.filter((line) => line.includes('exited abnormally')).length, 0);
  assert.deepEqual(h.children[0].signals, [], 'nothing to signal — it had already gone');
});

test('terminateChild reports whether it signalled at all', LOOP_TEST, async () => {
  // The distinction the warning rests on. Both endings previously reported
  // `terminated: true, escalated: false` and were indistinguishable.
  const clock = { t: 0 };
  const deps = {
    sleep: async (ms) => {
      clock.t += ms;
      await new Promise((r) => setImmediate(r));
    },
    now: () => clock.t,
    pollMs: SUPERVISE_DENY_POLL_MS,
    graceMs: SUPERVISE_TERMINATE_GRACE_MS,
  };

  const alreadyGone = { hasExited: () => true, exit: () => ({ code: 0, signal: null }) };
  assert.deepEqual(await terminateChild(alreadyGone, { ...deps, kill: () => assert.fail('must not signal a dead child') }), {
    terminated: true,
    escalated: false,
    signalled: false,
  });

  let exited = false;
  const live = { hasExited: () => exited, exit: () => ({ code: null, signal: 'SIGTERM' }) };
  const ended = await terminateChild(live, {
    ...deps,
    kill: (signal) => {
      if (signal === 'SIGTERM') exited = true;
    },
  });
  assert.deepEqual(ended, { terminated: true, escalated: false, signalled: true });

  // The race the round-3 fix disclosed and this one closes: ALIVE at the check,
  // then killed externally so our SIGTERM lands on a corpse and kill() returns
  // false. We did not cause it, so signalled must be false — not "we sent
  // SIGTERM, therefore ours". `gone` flips only when the external kill lands, so
  // the guard sees a live child and the post-delivery read sees the corpse.
  let gone = false;
  const raced = { hasExited: () => gone, exit: () => ({ code: null, signal: 'SIGKILL' }) };
  const racedEnded = await terminateChild(raced, {
    ...deps,
    kill: (signal) => {
      if (signal !== 'SIGTERM') assert.fail('a corpse takes no SIGKILL');
      gone = true; // the external kill that beat us
      return false; // …so our signal was never delivered
    },
  });
  assert.deepEqual(racedEnded, { terminated: true, escalated: false, signalled: false });
});

test('abnormalSelfExit counts any death the supervisor did not cause', () => {
  assert.equal(abnormalSelfExit({ code: 7, signal: null }), true);
  assert.equal(abnormalSelfExit({ code: null, signal: 'SIGSEGV' }), true);
  assert.equal(abnormalSelfExit({ code: null, signal: 'SIGINT' }), true);
  // SIGTERM and SIGKILL are what the SUPERVISOR sends — but every caller has
  // already established it sent nothing, so reaching this predicate with one of
  // them means somebody ELSE killed the child: the operator, the OOM killer, a
  // racing supervisor. Exempting them by name hid exactly those deaths.
  assert.equal(abnormalSelfExit({ code: null, signal: 'SIGTERM' }), true);
  assert.equal(abnormalSelfExit({ code: null, signal: 'SIGKILL' }), true);
  assert.equal(abnormalSelfExit({ code: 0, signal: null }), false, 'a clean ending is not a crash');
  assert.equal(abnormalSelfExit({ code: null, signal: null }), false);
  assert.equal(abnormalSelfExit(null), false);
});

test('an intermediate killed from OUTSIDE is reported, not read as an orderly stop', LOOP_TEST, async () => {
  // The case the signal-name exemption used to swallow: the supervisor never
  // signalled this child, so the SIGTERM that killed it came from somewhere
  // else — and that is precisely what an operator needs to hear.
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const h = crashedIntermediate((child) => child.end(null, signal));
    const result = await superviseLoop(h.deps);

    assert.equal(result.reason, 'child_exited', 'still a successful supervision');
    assert.equal(result.continuations, 1);
    assert.deepEqual(
      result.abnormalExits,
      [{ sessionId: DENIER, code: null, signal }],
      `an external ${signal} must be recorded`,
    );
    assert.ok(
      h.logs.some((line) => line.includes('exited abnormally') && line.includes(`signal ${signal}`)),
      `an external ${signal} must be reported`,
    );
    assert.deepEqual(h.children[0].signals, [], 'the supervisor sent nothing — that is the precondition');
  }
});

test('a session that ends with no deny simply ends the loop', LOOP_TEST, async () => {
  const h = harness({ onSpawn: ({ child }) => setImmediate(() => child.end(0)) });
  const result = await superviseLoop(h.deps);
  assert.equal(result.reason, 'child_exited');
  assert.equal(result.continuations, 0);
  assert.equal(h.continueCalls.length, 0);
  assert.equal(h.spawns.length, 1);
});

test('a deny written just before the session dies is still continued', LOOP_TEST, async () => {
  // Exit is checked AFTER the deny store on every tick. A session that writes
  // its marker and then exits must not be read as "nothing to do".
  const h = harness({
    denies: { [DENIER]: 0 },
    onSpawn: ({ sessionId, child }) => {
      if (sessionId === DENIER) child.end(0);
      if (sessionId === SUCCESSOR) setImmediate(() => child.end(0));
    },
  });

  const result = await superviseLoop(h.deps);

  assert.equal(result.continuations, 1);
  assert.equal(h.continueCalls.length, 1);
  assert.deepEqual(h.children[0].signals, [], 'an already-dead child needs no signal');
});

test('an interrupt stops the watch and waits for the child rather than continuing it', LOOP_TEST, async () => {
  const stopped = { value: false };
  const h = harness({
    denies: { [DENIER]: 4 * SUPERVISE_DENY_POLL_MS },
    onSpawn: ({ child, clock }) => {
      // Interrupt one tick before the deny would have been noticed.
      setImmediate(() => {
        stopped.value = true;
        void clock;
        setImmediate(() => child.end(0, 'SIGINT'));
      });
    },
  });
  h.deps.interrupt = { isStopped: () => stopped.value };

  const result = await superviseLoop(h.deps);

  assert.equal(result.reason, 'interrupted');
  assert.equal(h.continueCalls.length, 0);
  assert.equal(h.spawns.length, 1);
});

test('an interrupt AFTER a continue stops before the respawn, leaving a resumable successor', LOOP_TEST, async () => {
  // The other interrupt path: the existing tests interrupt before any deny, so
  // the branch that fires once a continuation has already been authorized was
  // never driven. The deny is consumed by then, and the successor exists on
  // disk — the loop must not start a fresh interactive session after a Ctrl-C,
  // and must not report the run as an ordinary end.
  const stopped = { value: false };
  const h = harness({
    denies: { [DENIER]: 0 },
    onSpawn: ({ sessionId, child }) => {
      if (sessionId === DENIER) {
        const realKill = child.kill.bind(child);
        child.kill = (signal) => {
          realKill(signal);
          // Ctrl-C lands while the supervisor is terminating the denied child,
          // i.e. after runContinue already consumed the deny.
          stopped.value = true;
          child.end(0, signal);
        };
      }
    },
  });
  h.deps.interrupt = { isStopped: () => stopped.value };

  const result = await superviseLoop(h.deps);

  assert.equal(result.reason, 'interrupted');
  assert.equal(superviseExitCode(result.reason), 0, 'an interrupt is a handled outcome');
  assert.equal(result.continuations, 1, 'the continuation DID happen — it was consumed');
  assert.equal(h.continueCalls.length, 1);
  // The successor is named in the outcome so an operator can resume it by hand.
  assert.deepEqual(result.sessions, [DENIER, SUCCESSOR]);
  assert.equal(h.spawns.length, 1, 'no fresh interactive session after Ctrl-C');
  assert.ok(
    h.logs.some((line) => line.includes(`continuing ${DENIER} as ${SUCCESSOR}`)),
    'the successor id must be printed, since it is now the only way to resume',
  );
});

test('a missing transcript continues without a narrative and says so', LOOP_TEST, async () => {
  const h = harness({
    denies: { [DENIER]: 0 },
    transcriptMtime: () => null,
    onSpawn: ({ sessionId, child }) => {
      if (sessionId === SUCCESSOR) setImmediate(() => child.end(0));
      if (sessionId === DENIER) {
        const realKill = child.kill.bind(child);
        child.kill = (s) => {
          realKill(s);
          child.end(0, s);
        };
      }
    },
  });

  const result = await superviseLoop(h.deps);

  assert.equal(result.continuations, 1, 'the deterministic brief is still worth handing over');
  assert.equal(
    h.continueCalls[0].captureFrom,
    null,
    'a transcript that does not exist must not be passed as --capture-from (continue would degrade on it)',
  );
  assert.ok(
    h.logs.some((line) => line.includes('no transcript') && line.includes('transcript saving')),
    'a missing transcript is the signature of the env-scrub contract failing — it must be said out loud',
  );
});

test('a harness that fails is reported as a failure, not as a supervised session', LOOP_TEST, async () => {
  for (const [label, ending, expected] of [
    ['non-zero exit', (child) => child.end(3), 'child_failed'],
    ['killed by a signal', (child) => child.end(null, 'SIGSEGV'), 'child_signalled'],
    ['never started', (child) => child.fail(new Error('spawn ENOENT')), 'spawn_failed'],
    ['clean exit', (child) => child.end(0), 'child_exited'],
  ]) {
    const h = harness({ onSpawn: ({ child }) => setImmediate(() => ending(child)) });
    const result = await superviseLoop(h.deps);
    assert.equal(result.reason, expected, `${label} must classify as ${expected}`);
    assert.equal(h.continueCalls.length, 0);
  }
});

test('the failure a caller cannot see in a payload is also said out loud', LOOP_TEST, async () => {
  const h = harness({ onSpawn: ({ child }) => setImmediate(() => child.fail(new Error('spawn ENOENT'))) });
  const result = await superviseLoop(h.deps);
  assert.equal(result.childExit.error, 'spawn ENOENT');
  assert.ok(
    h.logs.some((line) => line.includes('could not be started') && line.includes('ENOENT')),
    'a JSON-mode caller prints no human line — the loop must report this itself',
  );
});

test('an interrupt is not a harness failure even though the child dies by signal', LOOP_TEST, async () => {
  const stopped = { value: false };
  const h = harness({
    onSpawn: ({ child }) =>
      setImmediate(() => {
        stopped.value = true;
        setImmediate(() => child.end(null, 'SIGINT'));
      }),
  });
  h.deps.interrupt = { isStopped: () => stopped.value };

  const result = await superviseLoop(h.deps);

  assert.equal(result.reason, 'interrupted', 'the operator asked for this');
  assert.equal(superviseExitCode(result.reason), 0);
  assert.ok(
    !h.logs.some((line) => line.includes('killed by')),
    'an interrupt must not be reported as the harness failing',
  );
});

test('a child that dies before writing a transcript still continues on the brief', LOOP_TEST, async () => {
  // The bug this pins: quiescence ends as `child_exited` rather than
  // `transcript_absent`, and selecting captureFrom from that reason handed
  // `continue` a path to a file that never existed — degrading the whole
  // continuation over an optional narrative.
  const h = harness({
    denies: { [DENIER]: 0 },
    transcriptMtime: () => null,
    onSpawn: ({ sessionId, child }) => {
      if (sessionId === DENIER) child.end(0);
      if (sessionId === SUCCESSOR) setImmediate(() => child.end(0));
    },
  });

  const result = await superviseLoop(h.deps);

  assert.equal(result.continuations, 1, 'the deny must still be continued');
  assert.equal(h.continueCalls[0].captureFrom, null, 'a path to a nonexistent file degrades continue');
  assert.ok(h.logs.some((line) => line.includes('no transcript')));
});

test('a child that dies WITH a transcript still hands it over', LOOP_TEST, async () => {
  // The control for the pair above: the fix must select on the file, not on
  // how the wait ended — a supervisor that always passed null would lose every
  // narrative and still pass the test above.
  const h = harness({
    denies: { [DENIER]: 0 },
    transcriptMtime: () => 4_000,
    onSpawn: ({ sessionId, child }) => {
      if (sessionId === DENIER) child.end(0);
      if (sessionId === SUCCESSOR) setImmediate(() => child.end(0));
    },
  });

  await superviseLoop(h.deps);

  assert.equal(h.continueCalls[0].captureFrom, `/transcripts/${DENIER}.jsonl`);
  assert.ok(!h.logs.some((line) => line.includes('no transcript')));
});

test('an unsafe minted session id refuses to spawn anything', LOOP_TEST, async () => {
  const h = harness({ sessions: ['not a uuid\nwith a newline'] });
  const result = await superviseLoop(h.deps);
  assert.equal(result.reason, 'unsafe_session_id');
  assert.equal(h.spawns.length, 0);
});

// --- pure helpers -----------------------------------------------------------

test('superviseChildEnv drops every child-session marker and both credentials', () => {
  const env = {
    PATH: '/usr/bin',
    HOME: '/home/dev',
    CLAUDECODE: '1',
    CLAUDE_CODE_CHILD_SESSION: 'yes',
    CLAUDE_CODE_SESSION_ID: 'parent-id',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    ADLC_MANIFEST_KEY: 'k'.repeat(64),
    ADLC_ADMIN_KEY: 'a'.repeat(64),
    UNRELATED: 'kept',
  };
  const child = superviseChildEnv(env);

  for (const marker of CHILD_SESSION_ENV_MARKERS) {
    assert.equal(child[marker], undefined, `${marker} must not reach the child (contract item 24)`);
  }
  assert.equal(child.ADLC_MANIFEST_KEY, undefined, 'the signing key stays with the supervisor');
  assert.equal(child.ADLC_ADMIN_KEY, undefined);
  assert.equal(child.PATH, '/usr/bin');
  assert.equal(child.UNRELATED, 'kept');
  assert.equal(child.ADLC_HANDOFF_SUPERVISED, '1');
  // The operator's own environment is untouched — the continue step still needs
  // the key that was just withheld from the child.
  assert.equal(env.ADLC_MANIFEST_KEY, 'k'.repeat(64));
  assert.equal(env.CLAUDECODE, '1');
});

test('the child-session marker list is exactly the four the probe found', () => {
  assert.deepEqual(
    [...CHILD_SESSION_ENV_MARKERS].sort(),
    ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID'],
  );
});

test('transcriptPathFor encodes the working directory the way Claude Code does', () => {
  assert.equal(
    transcriptPathFor({ homeDir: '/home/dev', cwd: '/home/dev/Projects/my.app', sessionId: 'abc-123' }),
    '/home/dev/.claude/projects/-home-dev-Projects-my-app/abc-123.jsonl',
  );
  assert.equal(transcriptPathFor({ homeDir: '/home/dev', cwd: '/x', sessionId: '../escape' }), null);
  assert.equal(transcriptPathFor({ homeDir: '', cwd: '/x', sessionId: 'abc' }), null);
  assert.equal(transcriptPathFor({ homeDir: '/home/dev', cwd: '', sessionId: 'abc' }), null);
});

test('formatContinueCommand refuses an id that could write its own line', () => {
  assert.equal(
    formatContinueCommand('sess-1'),
    'ADLC_MANIFEST_KEY=… adlc handoff continue --deny-session sess-1 --write',
  );
  // isSafeSessionId accepts an embedded newline (it is a path check); this is
  // the guard that does not.
  assert.equal(formatContinueCommand('sess-1\necho pwned'), null);
  assert.equal(formatContinueCommand(''), null);
  assert.equal(formatContinueCommand(null), null);
});

test('degradeMessage degrades to a readable instruction when the id cannot be quoted', () => {
  const safe = degradeMessage('sess-1', 'deny is unbound');
  assert.match(safe, /--deny-session sess-1 --write/);
  const unsafe = degradeMessage('sess-1\nrm -rf /', 'deny is unbound');
  assert.doesNotMatch(unsafe, /rm -rf/);
  assert.match(unsafe, /\.adlc\/handoffs\/denies/);
});

test('degradeMessage describes the session it is actually talking about', () => {
  // The middle line is a claim about the child. Sending an operator back to a
  // session that already closed is the same false-statement-about-a-dead-child
  // problem the continuation path's warning exists for.
  const running = degradeMessage('sess-1', 'deny is unbound', null);
  assert.match(running, /still running and still denied/);
  assert.doesNotMatch(running, /already/);

  const ended = degradeMessage('sess-1', 'deny is unbound', { code: 0, signal: null });
  assert.match(ended, /already ended/);
  assert.doesNotMatch(ended, /still running/, 'a finished session must not be described as running');
  assert.match(ended, /deny is still open/, 'the deny outlives the session — that is the point');

  const crashed = degradeMessage('sess-1', 'deny is unbound', { code: 7, signal: null });
  assert.match(crashed, /already exited abnormally \(code 7\)/);
  assert.doesNotMatch(crashed, /still running/);

  const killed = degradeMessage('sess-1', 'deny is unbound', { code: null, signal: 'SIGSEGV' });
  assert.match(killed, /already exited abnormally \(signal SIGSEGV\)/);

  // A degrade never kills the child — every degrade site runs before
  // terminateChild — so a SIGTERM here came from outside and is abnormal too.
  const external = degradeMessage('sess-1', 'deny is unbound', { code: null, signal: 'SIGTERM' });
  assert.match(external, /already exited abnormally \(signal SIGTERM\)/);

  // Every variant still hands over the recovery command — that is unconditional.
  for (const message of [running, ended, crashed, killed]) {
    assert.match(message, /--deny-session sess-1 --write/);
  }
});

test('a degrade names the state the child is actually in', LOOP_TEST, async () => {
  // Alive at the moment of the degrade: the child idles, and the loop's
  // degrade fires while it is still running.
  const alive = harness({
    denies: { [DENIER]: 0 },
    continueResult: () => ({ ok: false, error: 'deny is unbound' }),
    onSpawn: ({ child, clock }) => {
      // Ends well after the degrade — the quiescence gate alone takes 5s.
      const timer = setInterval(() => {
        if (clock.t > SUPERVISE_QUIESCENCE_MS * 4) {
          clearInterval(timer);
          child.end(0);
        }
      }, 1);
      timer.unref?.();
    },
  });
  const aliveResult = await superviseLoop(alive.deps);
  assert.equal(aliveResult.reason, 'degraded');
  assert.ok(
    alive.logs.some((line) => line.includes('still running and still denied')),
    'a live session must be described as live',
  );

  // Already crashed by the time we degrade.
  const dead = harness({
    denies: { [DENIER]: 0 },
    continueResult: () => ({ ok: false, error: 'deny is unbound' }),
    onSpawn: ({ child }) => child.end(9),
  });
  const deadResult = await superviseLoop(dead.deps);
  assert.equal(deadResult.reason, 'degraded');
  const warning = dead.logs.find((line) => line.includes('automatic continuation is not possible'));
  assert.match(warning, /already exited abnormally \(code 9\)/);
  assert.doesNotMatch(warning, /still running/);
});

test('classifyChildExit separates the three failures from a clean exit', () => {
  assert.equal(classifyChildExit({ code: 0, signal: null }), 'child_exited');
  assert.equal(classifyChildExit({ code: 1, signal: null }), 'child_failed');
  assert.equal(classifyChildExit({ code: 127, signal: null }), 'child_failed');
  assert.equal(classifyChildExit({ code: null, signal: 'SIGKILL' }), 'child_signalled');
  assert.equal(classifyChildExit({ code: null, signal: null, error: new Error('ENOENT') }), 'spawn_failed');
  // An error wins over a code: a spawner that reports both never ran anything.
  assert.equal(classifyChildExit({ code: 0, signal: null, error: new Error('x') }), 'spawn_failed');
  assert.equal(classifyChildExit(null), 'child_exited');
  assert.equal(classifyChildExit({ code: null, signal: '' }), 'child_exited');
});

test('every reason the loop can return is mapped explicitly, and an unmapped one fails closed', () => {
  // A structural pin, both sides read from the source. superviseExitCode used
  // to fall through to 0, so a reason added to the loop and forgotten here
  // would have been reported as a successful supervision — the failure these
  // exit codes exist to prevent, reintroduced by omission.
  const source = readFileSync(SUPERVISE_SRC, 'utf8');

  // Reasons the loop returns as literals, plus the ones it returns indirectly
  // through classifyChildExit's own literal returns.
  const loopBody = source.slice(source.indexOf('export async function superviseLoop'));
  const classifyBody = source.slice(
    source.indexOf('export function classifyChildExit'),
    source.indexOf('/** Serializable form of an exit'),
  );
  const returned = new Set([
    ...[...loopBody.matchAll(/reason: '([a-z_]+)'/g)].map((m) => m[1]),
    ...[...classifyBody.matchAll(/return '([a-z_]+)'/g)].map((m) => m[1]),
  ]);

  const switchBody = source.slice(
    source.indexOf('export function superviseExitCode'),
    source.indexOf('/** One line an operator can read'),
  );
  const handled = new Set([...switchBody.matchAll(/case '([a-z_]+)'/g)].map((m) => m[1]));

  assert.ok(returned.size >= 7, `expected the loop's reasons to be discoverable, found ${returned.size}`);
  assert.deepEqual(
    [...returned].sort(),
    [...handled].sort(),
    'every reason the loop can produce must have its own case — no reason may reach the default',
  );

  // And the default is not a silent success.
  assert.equal(superviseExitCode('a_reason_nobody_mapped'), SUPERVISE_EXIT_CODES.operational);
  assert.notEqual(superviseExitCode('a_reason_nobody_mapped'), SUPERVISE_EXIT_CODES.ok);
  assert.equal(superviseExitCode(undefined), SUPERVISE_EXIT_CODES.operational);
});

test('every failure reason maps to a distinct non-zero exit code', () => {
  assert.equal(superviseExitCode('child_exited'), SUPERVISE_EXIT_CODES.ok);
  assert.equal(superviseExitCode('interrupted'), SUPERVISE_EXIT_CODES.ok);
  assert.equal(superviseExitCode('degraded'), SUPERVISE_EXIT_CODES.degraded);
  assert.equal(superviseExitCode('child_failed'), SUPERVISE_EXIT_CODES.harnessFailed);
  assert.equal(superviseExitCode('child_signalled'), SUPERVISE_EXIT_CODES.harnessFailed);
  assert.equal(superviseExitCode('unsafe_session_id'), SUPERVISE_EXIT_CODES.operational);
  // "could not start" is not the same fact as "ran and failed" — an operator
  // debugging a typo'd command needs to tell them apart.
  assert.equal(superviseExitCode('spawn_failed'), SUPERVISE_EXIT_CODES.harnessUnstartable);
  assert.notEqual(SUPERVISE_EXIT_CODES.harnessUnstartable, SUPERVISE_EXIT_CODES.harnessFailed);
  const codes = Object.values(SUPERVISE_EXIT_CODES);
  assert.equal(new Set(codes).size, codes.length, 'two outcomes sharing a code are one outcome');
});

test('describeOutcome names the harness code without pretending it is ours', () => {
  assert.match(describeOutcome({ reason: 'child_failed', childExit: { code: 7 } }), /exited 7/);
  assert.match(describeOutcome({ reason: 'child_signalled', childExit: { signal: 'SIGKILL' } }), /SIGKILL/);
  assert.match(describeOutcome({ reason: 'spawn_failed', childExit: { error: 'ENOENT' } }), /ENOENT/);
  assert.match(describeOutcome({ reason: 'spawn_failed' }), /could not be started/);
  assert.match(describeOutcome({ reason: 'degraded', continuations: 2 }), /still denied/);
  assert.match(describeOutcome({ reason: 'child_exited', continuations: 1 }), /session ended/);
  assert.match(describeOutcome({ reason: 'unsafe_session_id' }), /nothing was started/);
  // Unasserted, this case could be deleted and a Ctrl-C would silently report
  // as "the supervised session ended" — a different thing from what happened.
  assert.match(describeOutcome({ reason: 'interrupted', continuations: 2 }), /^interrupted/);
  assert.match(describeOutcome({ reason: 'interrupted', continuations: 2 }), /2 continuation/);
  assert.doesNotMatch(describeOutcome({ reason: 'interrupted' }), /session ended/);
});

test('parseContinuePayload accepts the real envelope and rejects what it should', () => {
  const envelope = {
    tool: 'handoff',
    command: 'continue',
    dryRun: false,
    successor_session_id: SUCCESSOR,
    ticket_id: 'T-1',
    content_path: '.adlc/handoffs/content/x.md',
    content_hash: HASH,
    bootstrap_prompt: PROMPT,
    evidence: { gate: 'context-handoff-continue', seq: 4 },
  };
  const ok = parseContinuePayload(envelope);
  assert.equal(ok.ok, true);
  assert.equal(ok.successorId, SUCCESSOR);
  assert.equal(ok.prompt, PROMPT);

  assert.equal(parseContinuePayload(null).ok, false);
  assert.equal(parseContinuePayload('a string').ok, false);
  assert.equal(parseContinuePayload([envelope]).ok, false);
  assert.equal(parseContinuePayload({ ...envelope, dryRun: undefined }).ok, false);
  assert.equal(parseContinuePayload({ ...envelope, ticket_id: 'T 1' }).ok, false);
  assert.equal(parseContinuePayload({ ...envelope, content_hash: HASH.toUpperCase() }).ok, false);
  assert.equal(parseContinuePayload({ ...envelope, content_path: '' }).ok, false);
});

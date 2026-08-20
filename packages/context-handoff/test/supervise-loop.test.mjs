// supervise-loop.test.mjs — the ordering `superviseLoop` exists to get right.
//
// Every dependency is a stub, so these tests are about the LOOP: when it
// captures, what it refuses to inject, what it kills and what it deliberately
// leaves running. The real spawner/continue-runner are covered by
// supervise-runtime.test.mjs, and the whole thing end-to-end (real CLI, real
// deny marker, fake `claude` binary) by cli-test/cli-supervise.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

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
  SUPERVISE_EXIT_CODES,
  CHILD_SESSION_ENV_MARKERS,
} from '../lib/supervise.mjs';
import {
  SUPERVISE_DENY_POLL_MS,
  SUPERVISE_QUIESCENCE_MS,
  SUPERVISE_TERMINATE_GRACE_MS,
} from '../lib/thresholds.mjs';

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

test('a deny is continued: capture handed over, child terminated, successor respawned with the prompt', async () => {
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

test('continue waits for the transcript to go quiet before capturing', async () => {
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

test('a degraded continue leaves the child running and warns exactly once', async () => {
  const h = harness({
    denies: { [DENIER]: 0 },
    continueResult: () => ({ ok: false, error: 'deny is unbound' }),
    onSpawn: ({ child }) => {
      // The operator's session lives on for a while, then ends on its own.
      setImmediate(() => setImmediate(() => child.end(0)));
    },
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

test('a capture that no longer matches its hash is never injected', async () => {
  const h = harness({
    denies: { [DENIER]: 0 },
    verifyCapture: () => ({ ok: false, error: 'content_hash mismatch' }),
    onSpawn: ({ child }) => setImmediate(() => setImmediate(() => child.end(0))),
  });

  const result = await superviseLoop(h.deps);

  assert.equal(result.reason, 'degraded');
  assert.equal(h.spawns.length, 1, 'the successor must not be spawned with unverified context');
  assert.deepEqual(h.children[0].signals, []);
  assert.ok(h.logs.some((line) => line.includes('content_hash mismatch')));
});

test('the capture is verified against the hash the continue payload actually bound', async () => {
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

test('a payload the loop cannot trust degrades instead of spawning', async () => {
  for (const [label, payload] of [
    ['dry run', { dryRun: true, successor_session_id: SUCCESSOR, ticket_id: 'T-1', content_hash: HASH, content_path: 'p', bootstrap_prompt: PROMPT }],
    ['unsafe successor id', { dryRun: false, successor_session_id: 'evil id\nrm -rf /', ticket_id: 'T-1', content_hash: HASH, content_path: 'p', bootstrap_prompt: PROMPT }],
    ['empty prompt', { dryRun: false, successor_session_id: SUCCESSOR, ticket_id: 'T-1', content_hash: HASH, content_path: 'p', bootstrap_prompt: '   ' }],
    ['bad hash', { dryRun: false, successor_session_id: SUCCESSOR, ticket_id: 'T-1', content_hash: 'not-a-digest', content_path: 'p', bootstrap_prompt: PROMPT }],
  ]) {
    const h = harness({
      denies: { [DENIER]: 0 },
      continueResult: () => ({ ok: true, payload }),
      onSpawn: ({ child }) => setImmediate(() => setImmediate(() => child.end(0))),
    });
    const result = await superviseLoop(h.deps);
    assert.equal(result.reason, 'degraded', `${label} must degrade`);
    assert.equal(h.spawns.length, 1, `${label} must not respawn`);
    assert.deepEqual(h.children[0].signals, [], `${label} must not kill the child`);
  }
});

test('a child that ignores SIGTERM is escalated to SIGKILL after the grace', async () => {
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

test('a session that ends with no deny simply ends the loop', async () => {
  const h = harness({ onSpawn: ({ child }) => setImmediate(() => child.end(0)) });
  const result = await superviseLoop(h.deps);
  assert.equal(result.reason, 'child_exited');
  assert.equal(result.continuations, 0);
  assert.equal(h.continueCalls.length, 0);
  assert.equal(h.spawns.length, 1);
});

test('a deny written just before the session dies is still continued', async () => {
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

test('an interrupt stops the watch and waits for the child rather than continuing it', async () => {
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

test('a missing transcript continues without a narrative and says so', async () => {
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

test('a harness that fails is reported as a failure, not as a supervised session', async () => {
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

test('the failure a caller cannot see in a payload is also said out loud', async () => {
  const h = harness({ onSpawn: ({ child }) => setImmediate(() => child.fail(new Error('spawn ENOENT'))) });
  const result = await superviseLoop(h.deps);
  assert.equal(result.childExit.error, 'spawn ENOENT');
  assert.ok(
    h.logs.some((line) => line.includes('could not be started') && line.includes('ENOENT')),
    'a JSON-mode caller prints no human line — the loop must report this itself',
  );
});

test('an interrupt is not a harness failure even though the child dies by signal', async () => {
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

test('a child that dies before writing a transcript still continues on the brief', async () => {
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

test('a child that dies WITH a transcript still hands it over', async () => {
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

test('an unsafe minted session id refuses to spawn anything', async () => {
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

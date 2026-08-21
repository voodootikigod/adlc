/**
 * Supervisor loop: spawn a harness session, notice its handoff deny, continue it
 * into a successor, and repeat.
 *
 * `continue` is the sanctioned recovery from a deny, but it is a HOST command —
 * the denied session cannot run it, and the spec is explicit that consume is
 * supervised-only. Somebody outside the session has to notice the deny, capture
 * the transcript, and start the successor. That somebody is this loop.
 *
 * Everything the loop decides is here; everything it TOUCHES is injected. The
 * spawner, the clock, the sleep, the deny reader, the transcript stat, the
 * capture verifier and the continue runner are all parameters, so the ordering
 * this file exists to get right — deny, quiescence, continue, terminate,
 * respawn — is tested against stubs rather than against a live harness and a
 * real API key. lib/supervise-runtime.mjs supplies the real ones.
 *
 * WHAT THE LOOP REFUSES TO DO. It never mints the successor id (the continue
 * command does, per spec — an id chosen out here is an id the denied agent
 * could have named), it never injects a capture it has not re-verified against
 * the bytes on disk, and it never kills the child on a degrade. A degrade means
 * the operator has to decide, and killing their session first would take that
 * decision away.
 */

import { isSafeSessionId } from './deny-marker.mjs';
import { isPromptSafeId } from './brief.mjs';
import {
  SUPERVISE_DENY_POLL_MS,
  SUPERVISE_QUIESCENCE_MS,
  SUPERVISE_TERMINATE_GRACE_MS,
} from './thresholds.mjs';

/**
 * Environment markers that must not reach a supervised child (spec contract
 * item 24).
 *
 * Live probe, 2026-08-13, claude v2.1.231: a `claude` process that inherits
 * these from a parent Claude Code session treats itself as a nested child and
 * SILENTLY STOPS WRITING ITS TRANSCRIPT. Nothing fails, nothing warns — the
 * transcript file simply never appears, and the continuation the wrapper exists
 * to perform then has no narrative to capture. A supervisor launched from
 * inside a Claude Code session (the normal way an operator tries this) inherits
 * all four.
 */
export const CHILD_SESSION_ENV_MARKERS = Object.freeze([
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
]);

/**
 * Credentials that must not reach a supervised child either.
 *
 * The manifest key is the supervisor's to hold: it authorizes the continue step
 * and nothing else. Handing it to the child would put the trust anchor inside
 * the process whose agent is one `env` away from reading it — and that agent is
 * precisely who the deny is being enforced against.
 */
export const CHILD_SECRET_ENV_VARS = Object.freeze(['ADLC_MANIFEST_KEY', 'ADLC_ADMIN_KEY']);

/**
 * Set on every supervised child so the harness's own SessionStart hook can tell
 * that a supervisor already handed this session its handoff.
 *
 * Suppression only — never authorization. The hook uses it to skip a DUPLICATE
 * context injection (the supervisor passes the bootstrap prompt on the command
 * line, so an unsuppressed hook would hand the model the same capture twice).
 * A forged value costs an operator one advisory nudge; it can never grant,
 * clear, or weaken a deny, so it is safe for the hook to read at face value.
 */
export const SUPERVISOR_ENV_MARKER = 'ADLC_HANDOFF_SUPERVISED';

/**
 * A child environment with the markers and credentials above removed.
 *
 * Returns a new object — the supervisor's own `process.env` still needs the key
 * for the continue step that runs between two spawns.
 *
 * @param {Record<string, string|undefined>} env
 * @param {{ marker?: string }} [opts]
 * @returns {Record<string, string>}
 */
export function superviseChildEnv(env = {}, { marker = SUPERVISOR_ENV_MARKER } = {}) {
  const dropped = new Set([...CHILD_SESSION_ENV_MARKERS, ...CHILD_SECRET_ENV_VARS]);
  const next = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    if (dropped.has(name) || value === undefined) continue;
    next[name] = value;
  }
  if (marker) next[marker] = '1';
  return next;
}

/**
 * Claude Code's on-disk transcript for one session.
 *
 * Live probe, 2026-08-13: `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`,
 * where the encoding replaces every `/` and `.` in the absolute working
 * directory with `-`. Derived rather than discovered because the supervisor
 * needs the path BEFORE the file exists, to watch it for quiescence.
 *
 * @returns {string|null} null when the session id could not name a file safely
 */
export function transcriptPathFor({ homeDir, cwd, sessionId, sep = '/' } = {}) {
  if (typeof homeDir !== 'string' || homeDir.length === 0) return null;
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  if (!isSafeSessionId(sessionId)) return null;
  const encoded = cwd.replace(/[/.]/g, '-');
  return [homeDir, '.claude', 'projects', encoded, `${sessionId}.jsonl`].join(sep);
}

/**
 * The one-liner an operator runs to continue a denied session by hand.
 *
 * Returns null rather than a command when the id cannot be safely quoted: the
 * id reaches here from a filename in the deny store, and `isSafeSessionId` — a
 * check about PATH safety — accepts an embedded newline, which is exactly the
 * character that would let a marker filename write its own second line into an
 * operator's terminal or a model's context.
 *
 * @param {unknown} denySessionId
 * @returns {string|null}
 */
export function formatContinueCommand(denySessionId) {
  if (!isPromptSafeId(denySessionId)) return null;
  return `ADLC_MANIFEST_KEY=… adlc handoff continue --deny-session ${denySessionId} --write`;
}

/**
 * What the supervisor prints when it hands a deny back to the operator.
 *
 * The middle line is a claim about the child, so it is made from the child's
 * actual state rather than from the fact that we are degrading. This message is
 * printed BEFORE the wrapper waits for the session to end, and a session can
 * have died on its own well before the continuation was attempted — telling an
 * operator to go back to a session that is already gone sends them looking for
 * a window that closed.
 *
 * @param {string} denySessionId
 * @param {string} reason
 * @param {{ code: number|null, signal: string|null }|null} [childExit]
 *        null when the child is still running; its exit otherwise.
 */
export function degradeMessage(denySessionId, reason, childExit = null) {
  const command = formatContinueCommand(denySessionId);
  let state;
  if (!childExit) {
    state = 'The session is still running and still denied for mutations; nothing was consumed.';
  } else if (abnormalSelfExit(childExit)) {
    const how = childExit.signal ? `signal ${childExit.signal}` : `code ${childExit.code}`;
    state =
      `The session has already exited abnormally (${how}); nothing was consumed and its deny is ` +
      'still open.';
  } else {
    state = 'The session has already ended; nothing was consumed and its deny is still open.';
  }
  return [
    `adlc handoff supervise: automatic continuation is not possible (${reason}).`,
    state,
    command
      ? `Continue it yourself with:\n  ${command}`
      : 'The denied session id cannot be printed as a safe shell command — read it from .adlc/handoffs/denies/ and run `adlc handoff continue --deny-session <id> --write`.',
  ].join('\n');
}

/**
 * Validate a `handoff continue --write --json` payload before acting on it.
 *
 * The payload is JSON from a subprocess, and three of its fields are about to
 * become command-line arguments and prompt text for a new session. A missing
 * `--write` (dry run), a truncated stdout, or an id that cannot be quoted are
 * all conditions where the right move is to degrade to the operator, not to
 * spawn something built out of a half-understood object.
 *
 * @param {unknown} value parsed stdout
 * @returns {{ ok: true, successorId: string, ticketId: string, contentHash: string,
 *             contentPath: string, prompt: string }
 *          | { ok: false, error: string }}
 */
export function parseContinuePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'continue payload is not an object' };
  }
  if (value.dryRun !== false) {
    return { ok: false, error: 'continue payload reports a dry run — nothing was consumed' };
  }
  const successorId = value.successor_session_id;
  const ticketId = value.ticket_id;
  const contentHash = value.content_hash;
  const contentPath = value.content_path;
  const prompt = value.bootstrap_prompt;
  if (!isPromptSafeId(successorId)) {
    return { ok: false, error: `continue payload successor id is not safe to spawn: ${JSON.stringify(successorId)}` };
  }
  if (!isPromptSafeId(ticketId)) {
    return { ok: false, error: `continue payload ticket id is not safe to quote: ${JSON.stringify(ticketId)}` };
  }
  if (typeof contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(contentHash)) {
    return { ok: false, error: 'continue payload content_hash is not a sha256 digest' };
  }
  if (typeof contentPath !== 'string' || contentPath.length === 0) {
    return { ok: false, error: 'continue payload content_path is missing' };
  }
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return { ok: false, error: 'continue payload bootstrap_prompt is empty' };
  }
  return { ok: true, successorId, ticketId, contentHash, contentPath, prompt };
}

/**
 * Track a spawned child's exit without racing it.
 *
 * The loop polls, so it needs a synchronous "has it exited yet" answer; the
 * spawner hands back a promise. Settling that promise into a local is the whole
 * adapter — including the rejection path, because a spawner that fails to start
 * a child has produced a child that is not running, which is the same fact.
 */
function trackChild(child) {
  const state = { exit: null };
  Promise.resolve(child.exited).then(
    (value) => {
      state.exit = value && typeof value === 'object' ? value : { code: null, signal: null };
    },
    (err) => {
      state.exit = { code: null, signal: null, error: err };
    },
  );
  return {
    child,
    hasExited: () => state.exit !== null,
    exit: () => state.exit,
  };
}

/**
 * Wait until the child exits. Unbounded on purpose: after a degrade or a
 * SIGINT, the wrapper's remaining job is to stay attached to the session the
 * operator is still using, and a timeout here would detach from a working
 * session on the grounds that it had lasted too long.
 */
async function waitForExit(tracked, { sleep, pollMs }) {
  while (!tracked.hasExited()) await sleep(pollMs);
  return tracked.exit();
}

/**
 * What a supervised session's exit MEANS.
 *
 * A wrapper that reports every exit as "the session ended" is a wrapper that
 * reports `supervise -- nonexistent-command` as a successful supervision. The
 * three failures below are not variations on success: the harness never
 * started, the harness ran and failed, or something killed it. Each has to
 * survive as far as the caller's own exit code, because a supervisor is the
 * process a script actually waits on.
 *
 * @param {{ code: number|null, signal: string|null, error?: unknown }|null} exit
 * @returns {'child_exited'|'child_failed'|'child_signalled'|'spawn_failed'}
 */
export function classifyChildExit(exit) {
  if (!exit || typeof exit !== 'object') return 'child_exited';
  if (exit.error) return 'spawn_failed';
  if (typeof exit.code === 'number' && exit.code !== 0) return 'child_failed';
  if (exit.code === null && typeof exit.signal === 'string' && exit.signal.length > 0) {
    return 'child_signalled';
  }
  return 'child_exited';
}

/** Serializable form of an exit — an Error does not survive JSON. */
function describeExit(exit) {
  if (!exit || typeof exit !== 'object') return null;
  return {
    code: typeof exit.code === 'number' ? exit.code : null,
    signal: typeof exit.signal === 'string' && exit.signal.length > 0 ? exit.signal : null,
    error: exit.error ? exit.error.message || String(exit.error) : null,
  };
}

/**
 * Exit codes the `supervise` caller reports.
 *
 * The harness's own code is NOT propagated verbatim: 1 and 2 already mean
 * something about the SUPERVISION (bad invocation, degraded continuation), so a
 * harness exiting 2 would be indistinguishable from a degrade. The harness's
 * real code travels in the message and the JSON payload instead, where it
 * cannot be confused for the supervisor's own verdict.
 */
export const SUPERVISE_EXIT_CODES = Object.freeze({
  ok: 0,
  operational: 1,
  degraded: 2,
  harnessFailed: 3,
  harnessUnstartable: 4,
});

/**
 * @param {string} reason from `superviseLoop`
 * @returns {number}
 */
export function superviseExitCode(reason) {
  switch (reason) {
    // A clean exit and an operator interrupt are both the session ending the
    // way it was asked to. Named explicitly rather than left to the default —
    // see why below.
    case 'child_exited':
    case 'interrupted':
      return SUPERVISE_EXIT_CODES.ok;
    case 'degraded':
      return SUPERVISE_EXIT_CODES.degraded;
    case 'child_failed':
    case 'child_signalled':
      return SUPERVISE_EXIT_CODES.harnessFailed;
    case 'spawn_failed':
      return SUPERVISE_EXIT_CODES.harnessUnstartable;
    case 'unsafe_session_id':
      return SUPERVISE_EXIT_CODES.operational;
    default:
      // Fail CLOSED. This used to return 0, which meant any outcome added to
      // the loop and not mapped here would be reported as a successful
      // supervision by default — the exact failure this command's exit codes
      // exist to prevent, reintroduced by omission. An unmapped reason is a
      // bug, and a bug is an error.
      return SUPERVISE_EXIT_CODES.operational;
  }
}

/** One line an operator can read without consulting the exit-code table. */
export function describeOutcome({ reason, continuations = 0, childExit = null } = {}) {
  const tail = `after ${continuations} continuation(s)`;
  switch (reason) {
    case 'spawn_failed':
      return `the harness could not be started (${childExit?.error ?? 'unknown error'})`;
    case 'child_failed':
      return `the supervised command exited ${childExit?.code} ${tail}`;
    case 'child_signalled':
      return `the supervised command was killed by ${childExit?.signal} ${tail}`;
    case 'degraded':
      return `continuation degraded ${tail} — the session is still running and still denied`;
    case 'interrupted':
      return `interrupted ${tail}`;
    case 'unsafe_session_id':
      return 'the minted session id was not safe to spawn — nothing was started';
    default:
      return `the supervised session ended ${tail}`;
  }
}

/**
 * Poll for an open deny on this session, or the child's exit — whichever first.
 *
 * The deny store is read BEFORE the exit is checked on each tick: a session that
 * writes its marker and then dies must still be continued, and checking exit
 * first would drop that marker on the floor as "child exited, nothing to do".
 *
 * @returns {Promise<{ reason: 'deny_open', record: object }
 *                  | { reason: 'child_exited'|'interrupted' }>}
 */
export async function watchForDeny({ sessionId, readOpenDeny, tracked, sleep, pollMs, stopped }) {
  for (;;) {
    const record = readOpenDeny(sessionId);
    if (record) return { reason: 'deny_open', record };
    if (stopped()) return { reason: 'interrupted' };
    if (tracked.hasExited()) return { reason: 'child_exited' };
    await sleep(pollMs);
  }
}

/**
 * Wait for the denied session to stop writing to its transcript.
 *
 * The deny fires on a tool call; the handoff summary the successor actually
 * needs is written after it. Quiescence — a transcript whose mtime has not
 * moved for `quiescenceMs` — is the only externally observable "it has finished
 * talking" signal a supervisor has. A child that exits is trivially quiescent.
 *
 * A transcript that never appears reports stable-at-absent and releases the
 * gate. That is the honest reading: there is nothing to wait for, and the
 * caller can tell the difference from the returned reason.
 *
 * @returns {Promise<{ reason: 'child_exited'|'transcript_quiescent'|'transcript_absent' }>}
 */
export async function waitForQuiescence({
  path,
  statTranscript,
  tracked,
  sleep,
  now,
  pollMs,
  quiescenceMs,
}) {
  let lastMtime;
  let sampled = false;
  let stableSince = now();
  for (;;) {
    if (tracked.hasExited()) return { reason: 'child_exited' };
    const stat = path ? statTranscript(path) : null;
    const mtime = stat && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null;
    if (!sampled || mtime !== lastMtime) {
      lastMtime = mtime;
      sampled = true;
      stableSince = now();
    } else if (now() - stableSince >= quiescenceMs) {
      return { reason: mtime === null ? 'transcript_absent' : 'transcript_quiescent' };
    }
    await sleep(pollMs);
  }
}

/**
 * SIGTERM, then SIGKILL once the grace elapses.
 *
 * The superseded session is holding the terminal the successor is about to
 * take, so this cannot be best-effort-and-move-on. It can, however, run out of
 * patience: a child that ignores both signals is reported rather than waited on
 * forever, because the operator is staring at a wrapper that appears hung.
 *
 * `signalled` says whether this function actually delivered a signal to a LIVE
 * child. Without it the endings are indistinguishable — "already gone when we
 * arrived" and "we killed it" both report terminated — and the caller cannot
 * tell an ordinary handoff from a child that died on its own on the way to one.
 *
 * Delivery, not attempt: `kill` returns false when the process was already gone,
 * so an external kill that lands between the liveness check and our SIGTERM is
 * caught here rather than mis-reported as ours. What remains after this — and it
 * is genuinely irreducible — is a child that took our SIGTERM while alive and
 * then died: whether our signal or a simultaneous external one finished it is
 * unknowable, and attributing to ourselves a death we sent a valid signal for is
 * the safer error than crying crash on every fast handoff.
 *
 * @returns {Promise<{ terminated: boolean, escalated: boolean, signalled: boolean }>}
 */
export async function terminateChild(tracked, { sleep, now, pollMs, graceMs, kill }) {
  if (tracked.hasExited()) return { terminated: true, escalated: false, signalled: false };
  // Only an explicit false is "already gone": a stub that returns undefined is
  // treated as a delivery, so the existing callers keep their behaviour.
  if (kill('SIGTERM') === false) {
    return { terminated: tracked.hasExited(), escalated: false, signalled: false };
  }
  const deadline = now() + graceMs;
  while (!tracked.hasExited() && now() < deadline) await sleep(pollMs);
  if (tracked.hasExited()) return { terminated: true, escalated: false, signalled: true };
  kill('SIGKILL');
  const hardDeadline = now() + graceMs;
  while (!tracked.hasExited() && now() < hardDeadline) await sleep(pollMs);
  return { terminated: tracked.hasExited(), escalated: true, signalled: true };
}

/**
 * Did a child that the supervisor did NOT signal die badly?
 *
 * PRECONDITION, and the whole reason this reads the way it does: every caller
 * has already established that the supervisor sent this child nothing — the
 * continuation path by checking `ended.signalled`, the degrade paths because
 * they all run before `terminateChild` and a degrade never kills the child.
 *
 * Given that, ANY signal is abnormal. An earlier version exempted SIGTERM and
 * SIGKILL by name, on the reasoning that those are what the supervisor sends —
 * but that conflates "this is the signal WE send" with "we sent it", and the
 * precondition already settles the second question. A child killed by the
 * operator, the OOM killer, or a racing supervisor dies by exactly those two
 * signals, and those are the deaths an operator most needs to hear about; the
 * exemption silently dropped them.
 *
 * A non-zero code is abnormal for the same reason. Exit 0 is a session that
 * ended after writing its handoff, which is orderly.
 *
 * This is never a failure of the SUPERVISION — the deny already said the
 * session was being replaced, and the successor completing is what success
 * means here. It is something an operator should be told, which is different.
 *
 * @param {{ code: number|null, signal: string|null }|null} exit
 * @returns {boolean}
 */
export function abnormalSelfExit(exit) {
  if (!exit || typeof exit !== 'object') return false;
  if (typeof exit.code === 'number' && exit.code !== 0) return true;
  return typeof exit.signal === 'string' && exit.signal.length > 0;
}

/**
 * Supervise one harness session through as many handoff continuations as it
 * takes.
 *
 * @param {object} deps
 * @param {() => string} deps.mintSessionId first session id (successors come from `continue`)
 * @param {(spawnArgs: { sessionId: string, prompt: string|null }) => { exited: Promise<object>, kill: (signal: string) => void }} deps.spawn
 * @param {(sessionId: string) => object|null} deps.readOpenDeny open deny record, or null
 * @param {(sessionId: string) => string|null} deps.transcriptPath
 * @param {(path: string) => { mtimeMs: number }|null} deps.statTranscript
 * @param {(args: { denySession: string, captureFrom: string|null }) => Promise<{ ok: boolean, payload?: unknown, error?: string }>} deps.runContinue
 * @param {(args: { denySession: string, contentHash: string }) => { ok: boolean, error?: string }} deps.verifyCapture
 * @param {(line: string) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {(ms: number) => Promise<void>} deps.sleep
 * @param {{ isStopped: () => boolean }} [deps.interrupt] SIGINT state owned by the caller
 * @returns {Promise<{ reason: string, sessions: string[], continuations: number }>}
 */
export async function superviseLoop({
  mintSessionId,
  spawn,
  readOpenDeny,
  transcriptPath,
  statTranscript,
  runContinue,
  verifyCapture,
  log = () => {},
  now = () => Date.now(),
  sleep,
  interrupt = null,
  pollMs = SUPERVISE_DENY_POLL_MS,
  quiescenceMs = SUPERVISE_QUIESCENCE_MS,
  graceMs = SUPERVISE_TERMINATE_GRACE_MS,
}) {
  const stopped = () => interrupt?.isStopped() === true;
  let sessionId = mintSessionId();
  if (!isPromptSafeId(sessionId)) {
    return { reason: 'unsafe_session_id', sessions: [], continuations: 0, childExit: null, abnormalExits: [] };
  }
  let prompt = null;
  const sessions = [sessionId];
  // Intermediates that died on their own on the way to a handoff. Carried into
  // the outcome so a --json consumer can see a session crashed even though the
  // supervision itself succeeded.
  const abnormalExits = [];
  let continuations = 0;

  for (;;) {
    const tracked = trackChild(spawn({ sessionId, prompt }));
    // The degrade message makes a claim about this child, so it is built from
    // the child's state at the moment of printing — not from the fact that a
    // degrade happened. It is printed before we wait for the session to end.
    const degradeNow = (why) =>
      log(degradeMessage(sessionId, why, tracked.hasExited() ? describeExit(tracked.exit()) : null));
    const watched = await watchForDeny({
      sessionId,
      readOpenDeny,
      tracked,
      sleep,
      pollMs,
      stopped,
    });

    if (watched.reason !== 'deny_open') {
      // Nothing to continue: either the session ended or the operator
      // interrupted us. Either way the child owns the terminal until it exits.
      const exit = await waitForExit(tracked, { sleep, pollMs });
      // An interrupt is a handled outcome even though the child dies by signal:
      // the operator asked for this, so it must not be reported as a harness
      // failure. Every other exit is classified on what actually happened.
      const reason = watched.reason === 'interrupted' ? 'interrupted' : classifyChildExit(exit);
      const childExit = describeExit(exit);
      // Said out loud, not only returned. The caller may be printing JSON (in
      // which case it prints no human line at all), and "the harness never
      // started" is not something an operator should have to parse a payload to
      // discover.
      if (reason === 'spawn_failed' || reason === 'child_failed' || reason === 'child_signalled') {
        log(`adlc handoff supervise: ${describeOutcome({ reason, continuations, childExit })}`);
      }
      return { reason, sessions, continuations, childExit, abnormalExits };
    }

    log(`adlc handoff supervise: session ${sessionId} hit a handoff deny — waiting for it to finish writing.`);
    const path = transcriptPath(sessionId);
    await waitForQuiescence({ path, statTranscript, tracked, sleep, now, pollMs, quiescenceMs });
    // Whether there is a transcript is a question about the FILE, not about how
    // the wait ended. A child that dies before writing one releases the
    // quiescence gate as `child_exited`, and selecting captureFrom from that
    // reason handed `continue` a path to a file that does not exist — which
    // degrades the whole continuation (exit 2, deny left open) over a narrative
    // that was only ever optional. One stat answers it for both endings.
    const hasTranscript = path !== null && statTranscript(path) !== null;
    if (!hasTranscript) {
      // The deterministic brief still hands over ticket, evidence and git state,
      // so this continues — but a MISSING transcript is also the exact signature
      // of contract item 24 going wrong, so it is said out loud rather than
      // absorbed into a successful continuation.
      log(
        `adlc handoff supervise: no transcript at ${path ?? '(unresolvable path)'} — continuing without the ` +
          'model narrative. If this repeats, the child environment is suppressing transcript saving.',
      );
    }

    const captureFrom = hasTranscript ? path : null;
    const continued = await runContinue({ denySession: sessionId, captureFrom });
    if (!continued.ok) {
      degradeNow(continued.error || 'the continue command degraded');
      const exit = await waitForExit(tracked, { sleep, pollMs });
      return { reason: 'degraded', sessions, continuations, childExit: describeExit(exit), abnormalExits };
    }

    const payload = parseContinuePayload(continued.payload);
    if (!payload.ok) {
      degradeNow(payload.error);
      const exit = await waitForExit(tracked, { sleep, pollMs });
      return { reason: 'degraded', sessions, continuations, childExit: describeExit(exit), abnormalExits };
    }

    // Defense at the injection point. The mutation gate re-derives this hash on
    // every evaluation, so a tampered capture cannot authorize a mutation — but
    // the gate defends MUTATION, and this is CONTEXT: the prompt below is read
    // by a model before it touches a tool. A capture edited between the write
    // and this spawn would be believed by the successor no matter what the gate
    // later says about the edits it makes.
    const verified = verifyCapture({ denySession: sessionId, contentHash: payload.contentHash });
    if (!verified.ok) {
      degradeNow(`the capture no longer matches its content_hash (${verified.error})`);
      const exit = await waitForExit(tracked, { sleep, pollMs });
      return { reason: 'degraded', sessions, continuations, childExit: describeExit(exit), abnormalExits };
    }

    const ended = await terminateChild(tracked, { sleep, now, pollMs, graceMs, kill: (s) => tracked.child.kill(s) });
    if (ended.escalated) {
      log(
        `adlc handoff supervise: session ${sessionId} did not exit on SIGTERM within ${graceMs} ms — sent SIGKILL.`,
      );
    }

    // A child that died on its own on the way to being replaced. This does NOT
    // fail the run: the deny already said this session was being handed off, and
    // the supervisor terminates it on the ordinary path anyway, so treating a
    // dead intermediate as a failure would fail every successful handoff. But it
    // is worth saying — a session that CRASHED wrote its handoff under different
    // circumstances than one that stopped when asked, and only the exit tells an
    // operator which they are looking at.
    // `signalled` is what establishes abnormalSelfExit's precondition, and it
    // now means DELIVERED-to-a-live-child: an external kill before our SIGTERM
    // lands makes kill() return false, so terminateChild reports signalled
    // false and the death is surfaced below. The only residual is a child that
    // took a live SIGTERM and then died — our signal or a simultaneous external
    // one, indistinguishable after the fact, and reported as ours by design.
    if (!ended.signalled) {
      const selfExit = describeExit(tracked.exit());
      if (abnormalSelfExit(selfExit)) {
        abnormalExits.push({ sessionId, code: selfExit.code, signal: selfExit.signal });
        const how = selfExit.signal ? `signal ${selfExit.signal}` : `code ${selfExit.code}`;
        log(
          `adlc handoff supervise: session ${sessionId} wrote a handoff deny then exited abnormally ` +
            `(${how}) on its own; continuing to its successor anyway.`,
        );
      }
    }

    continuations += 1;
    log(
      `adlc handoff supervise: continuing ${sessionId} as ${payload.successorId} ` +
        `under ticket ${payload.ticketId} (capture ${payload.contentPath}).`,
    );
    sessionId = payload.successorId;
    prompt = payload.prompt;
    sessions.push(sessionId);

    // Interrupted between the continue and the respawn: the deny is already
    // consumed for a successor that will not be started here. The banner above
    // names that successor id, and its resume-auth is on disk, so an operator
    // can resume it by hand (and the SessionStart hook will hand it the
    // capture). Starting a fresh interactive session after a Ctrl-C would not.
    if (stopped()) return { reason: 'interrupted', sessions, continuations, childExit: null, abnormalExits };
  }
}

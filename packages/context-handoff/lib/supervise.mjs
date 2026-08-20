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

/** What the supervisor prints when it hands a deny back to the operator. */
export function degradeMessage(denySessionId, reason) {
  const command = formatContinueCommand(denySessionId);
  return [
    `adlc handoff supervise: automatic continuation is not possible (${reason}).`,
    'The session is still running and still denied for mutations; nothing was consumed.',
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
 * @returns {Promise<{ terminated: boolean, escalated: boolean }>}
 */
export async function terminateChild(tracked, { sleep, now, pollMs, graceMs, kill }) {
  if (tracked.hasExited()) return { terminated: true, escalated: false };
  kill('SIGTERM');
  const deadline = now() + graceMs;
  while (!tracked.hasExited() && now() < deadline) await sleep(pollMs);
  if (tracked.hasExited()) return { terminated: true, escalated: false };
  kill('SIGKILL');
  const hardDeadline = now() + graceMs;
  while (!tracked.hasExited() && now() < hardDeadline) await sleep(pollMs);
  return { terminated: tracked.hasExited(), escalated: true };
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
    return { reason: 'unsafe_session_id', sessions: [], continuations: 0 };
  }
  let prompt = null;
  const sessions = [sessionId];
  let continuations = 0;

  for (;;) {
    const tracked = trackChild(spawn({ sessionId, prompt }));
    const watched = await watchForDeny({
      sessionId,
      readOpenDeny,
      tracked,
      sleep,
      pollMs,
      stopped,
    });

    if (watched.reason !== 'deny_open') {
      // Nothing to continue: either the operator ended the session or they
      // interrupted us. Either way the child owns the terminal until it exits.
      await waitForExit(tracked, { sleep, pollMs });
      return { reason: watched.reason, sessions, continuations };
    }

    log(`adlc handoff supervise: session ${sessionId} hit a handoff deny — waiting for it to finish writing.`);
    const path = transcriptPath(sessionId);
    const quiescence = await waitForQuiescence({
      path,
      statTranscript,
      tracked,
      sleep,
      now,
      pollMs,
      quiescenceMs,
    });
    if (quiescence.reason === 'transcript_absent') {
      // The narrative is optional — the deterministic brief still hands over
      // ticket, evidence and git state — but a MISSING transcript is also the
      // exact signature of contract item 24 going wrong, so it is said out loud
      // rather than absorbed into a successful continuation.
      log(
        `adlc handoff supervise: no transcript at ${path ?? '(unresolvable path)'} — continuing without the ` +
          'model narrative. If this repeats, the child environment is suppressing transcript saving.',
      );
    }

    const captureFrom = quiescence.reason === 'transcript_absent' ? null : path;
    const continued = await runContinue({ denySession: sessionId, captureFrom });
    if (!continued.ok) {
      log(degradeMessage(sessionId, continued.error || 'the continue command degraded'));
      await waitForExit(tracked, { sleep, pollMs });
      return { reason: 'degraded', sessions, continuations };
    }

    const payload = parseContinuePayload(continued.payload);
    if (!payload.ok) {
      log(degradeMessage(sessionId, payload.error));
      await waitForExit(tracked, { sleep, pollMs });
      return { reason: 'degraded', sessions, continuations };
    }

    // Defense at the injection point. The mutation gate re-derives this hash on
    // every evaluation, so a tampered capture cannot authorize a mutation — but
    // the gate defends MUTATION, and this is CONTEXT: the prompt below is read
    // by a model before it touches a tool. A capture edited between the write
    // and this spawn would be believed by the successor no matter what the gate
    // later says about the edits it makes.
    const verified = verifyCapture({ denySession: sessionId, contentHash: payload.contentHash });
    if (!verified.ok) {
      log(degradeMessage(sessionId, `the capture no longer matches its content_hash (${verified.error})`));
      await waitForExit(tracked, { sleep, pollMs });
      return { reason: 'degraded', sessions, continuations };
    }

    const ended = await terminateChild(tracked, { sleep, now, pollMs, graceMs, kill: (s) => tracked.child.kill(s) });
    if (ended.escalated) {
      log(
        `adlc handoff supervise: session ${sessionId} did not exit on SIGTERM within ${graceMs} ms — sent SIGKILL.`,
      );
    }

    continuations += 1;
    log(
      `adlc handoff supervise: continuing ${sessionId} as ${payload.successorId} ` +
        `under ticket ${payload.ticketId} (capture ${payload.contentPath}).`,
    );
    sessionId = payload.successorId;
    prompt = payload.prompt;
    sessions.push(sessionId);

    if (stopped()) return { reason: 'interrupted', sessions, continuations };
  }
}

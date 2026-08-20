#!/usr/bin/env node
/**
 * handoff — operator/host CLI for context-rot handoff (slice 2).
 * Dispatched as `adlc handoff <subcommand>`.
 *
 * Subcommands: write | resume | bypass | repair | unlock | continue | supervise
 * Mutating `--write` requires ADLC_MANIFEST_KEY (never silent success).
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { parseArgs } from '@adlc/core';
import { resolveActiveTicketId } from '@adlc/tickets';
import { readDenyMarker, normalizeBindField } from '../lib/deny-marker.mjs';
import { consumeDenyRecord } from '../lib/deny-lifecycle.mjs';
import { normalizeBypassGrant, authorized } from '../lib/mutation-gate.mjs';
import { writeFinal, readFinal, buildFinal, CONTENT_KIND_CAPTURE } from '../lib/final.mjs';
import { HANDOFF_MAX_AGE_HOURS } from '../lib/thresholds.mjs';
import { writeResumeAuth, removeResumeAuth } from '../lib/resume-auth.mjs';
import { writeBypassGrant, removeBypassGrant } from '../lib/bypass-grant.mjs';
import { writeDenyRecord, repairDenyBinds, markerUnchanged } from '../lib/deny-persist.mjs';
import { unlockSession } from '../lib/lock.mjs';
import { restoreFinal, rollbackCheckpoint, writeCheckpoint } from '../lib/checkpoint.mjs';
import { conflictReport, currentBytes, restoreIfOurs } from '../lib/rollback.mjs';
import { authorizeSuccessor } from '../lib/consume.mjs';
import { describeOutcome, superviseExitCode, superviseLoop } from '../lib/supervise.mjs';
import { createSuperviseDeps, splitPassthrough } from '../lib/supervise-runtime.mjs';
import { capCaptureBody, hashCaptureBody, writeVerifiedCapture } from '../lib/capture.mjs';
import { buildBootstrapPrompt, composeBrief } from '../lib/brief.mjs';
import {
  finalAssistantMessageFrom,
  parseTranscript,
  transcriptTimestamp,
} from '../lib/transcript-extract.mjs';
import { evidenceTail, gitState, readTranscriptTail, ticketTitle } from '../lib/continue-inputs.mjs';
import { recordHandoffEvidence } from '../lib/evidence.mjs';
import { contentPath, resumeAuthPath } from '../lib/paths.mjs';
import {
  commonOrExit,
  exitFrom,
  finish,
  gateFail,
  lockOrExit,
  opError,
  recordOrExit,
  requireKeyOrExit,
  requireSafeSession,
} from '../lib/cli-helpers.mjs';

const USAGE = `handoff <subcommand> [options]

Operator/host CLI for context-rot handoff (F3 continuity). Dry-run by default;
pass --write to mutate. Mutating commands require ADLC_MANIFEST_KEY.

Subcommands:
  write     Create/refresh final checkpoint + ensure deny marker
  resume    Other-session consume of an open deny (writes resume-auth)
  bypass    One-shot TTY+key bypass grant (bound or unbound)
  repair    Privileged host bind: update open deny ticket_id+content_hash
  unlock    Reclaim a session lock (dead PID + same host + full field match)
  continue  Capture the denied session, bind it, and consume for one successor
  supervise Run a harness under a wrapper that continues it on every deny

Common options:
  --dir <path>     ledger directory (default: .adlc). Its final path segment
                   must be ".adlc" — artifacts and manifest evidence share it.
  --write          Persist changes (default: dry-run)
  --json           Machine-readable JSON output
  --help           Show this help

Exit codes:
  0  success
  1  operational error (missing args/key, I/O)
  2  gate reject (same-session resume, lock mismatch / foreign host / live PID)

ADLC phase: P4 continuity (F3)
`;

function helpAndExit() {
  console.log(USAGE);
  process.exit(0);
}

function runWrite(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      session: { type: 'string' },
      ticket: { type: 'string' },
      host: { type: 'string' },
      'content-hash': { type: 'string' },
      dir: { type: 'string' },
      write: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(`handoff write --session <id> [--ticket <id>] [--host <h>] [--content-hash <h>] [--dir .adlc] [--write] [--json]

Create/refresh a final handoff checkpoint and ensure a deny marker for the session.
Dry-run by default. --write requires ADLC_MANIFEST_KEY and records context-handoff-write.

A refresh rebinds an open marker onto the new final so resume stays possible.
Dropping --ticket from a ticket-bound deny, or refreshing a consumed one, exits 1.
--write runs under the session lock and exits 2 while a live session holds it.
`);
    process.exit(0);
  }
  const sessionId = requireSafeSession(values.session, '--session');
  const { root, adlcDir, write, json } = commonOrExit(values);
  const ticketId = values.ticket ?? null;
  const host = values.host ?? 'local';
  const contentHash = values['content-hash'] ?? null;

  const planned = buildFinal({ sessionId, ticketId, contentHash, host });

  if (!write) {
    finish({
      json,
      payload: {
        tool: 'handoff',
        command: 'write',
        dryRun: true,
        final: planned,
        deny: {
          session_id: sessionId,
          ticket_id: planned.ticket_id,
          content_hash: planned.content_hash,
          status: 'open',
        },
      },
      human: `handoff write: dry-run session=${sessionId} content_hash=${planned.content_hash} (pass --write to persist)`,
    });
  }

  const key = requireKeyOrExit();
  lockOrExit(root, sessionId);

  // Validate marker policy before mutating anything. Deny binds must end up on
  // the final this run writes, but we write the final FIRST so a failed final
  // cannot leave a rebound/created deny with no checkpoint.
  const existing = readDenyMarker(root, sessionId);
  if (existing.ok && existing.record.status === 'consumed') {
    opError(
      `deny marker for session=${sessionId} is consumed — a consumed handoff cannot be refreshed (start a new session)`,
    );
  }
  if (existing.ok && existing.record.ticket_id != null && planned.ticket_id == null) {
    opError(
      `deny marker for session=${sessionId} is bound to ticket ${existing.record.ticket_id} — pass --ticket to refresh (refusing to unbind an open deny)`,
    );
  }

  const checkpoint = writeCheckpoint(root, sessionId, planned);
  if (!checkpoint.ok) opError(checkpoint.error);

  const recorded = recordOrExit(
    {
      gate: 'context-handoff-write',
      ticket: planned.ticket_id ?? undefined,
      data: {
        session_id: sessionId,
        content_hash: planned.content_hash,
        deny_reason: checkpoint.denyReason,
        rebound: checkpoint.rebound,
      },
      adlcDir,
      key,
    },
    // Un-evidenced state is un-auditable state: undo this run's final and, if we
    // moved an existing marker's binds, put those back too.
    () => rollbackCheckpoint(root, sessionId, checkpoint),
  );

  finish({
    json,
    payload: {
      tool: 'handoff',
      command: 'write',
      dryRun: false,
      final: checkpoint.final,
      deny: { ok: true, reason: checkpoint.denyReason, rebound: checkpoint.rebound },
      evidence: { gate: 'context-handoff-write', seq: recorded?.seq },
    },
    human: `handoff write: wrote final+deny for session=${sessionId} content_hash=${checkpoint.final.content_hash}`,
  });
}

function runResume(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      session: { type: 'string' },
      'deny-session': { type: 'string' },
      dir: { type: 'string' },
      write: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(`handoff resume --session <consumer> --deny-session <denier> [--dir .adlc] [--write] [--json]

Other-session consume of an open deny. Requires a final with non-null content_hash.
Same-session consume exits 2. --write requires ADLC_MANIFEST_KEY.

--write runs under the denier's session lock: a second resume racing the first
exits 2 rather than minting a second verified resume-auth for one deny.
`);
    process.exit(0);
  }
  const consumerId = requireSafeSession(values.session, '--session');
  const denySessionId = requireSafeSession(values['deny-session'], '--deny-session');
  const { root, adlcDir, write, json } = commonOrExit(values);

  const marker = readDenyMarker(root, denySessionId);
  if (!marker.ok || !marker.record) {
    opError(`deny marker unavailable: ${marker.reason || 'missing'}`);
  }

  const finalGot = readFinal(root, denySessionId);
  if (!finalGot.ok) opError(`final checkpoint unavailable: ${finalGot.error}`);
  const contentHash = normalizeBindField(finalGot.final.content_hash);
  const ticketId = normalizeBindField(finalGot.final.ticket_id) ?? normalizeBindField(marker.record.ticket_id);
  if (!contentHash) opError('final content_hash is null — cannot resume (use repair / unbound bypass)');
  if (!ticketId) opError('ticket_id is null — cannot resume (use host repair)');

  // The auth this run would mint — used to reject same-session / unbound consumes
  // before anything is written.
  const plannedAuth = {
    ticket_id: ticketId,
    content_hash: contentHash,
    deny_session_id: denySessionId,
    consumer_session_id: consumerId,
    verified: true,
  };

  const preflight = consumeDenyRecord(marker.record, consumerId, { resumeAuth: plannedAuth });
  if (!preflight.ok) exitFrom(preflight);

  if (!write) {
    finish({
      json,
      payload: {
        tool: 'handoff',
        command: 'resume',
        dryRun: true,
        consumer: consumerId,
        deny_session: denySessionId,
        record: preflight.record,
        // Nothing is signed in a dry run, so this is the plan, not a credential:
        // `resumeAuth` is reserved for the document that was actually minted.
        plannedResumeAuth: plannedAuth,
      },
      human: `handoff resume: dry-run consumer=${consumerId} deny=${denySessionId} → consumed (pass --write to persist)`,
    });
  }

  const key = requireKeyOrExit();

  // One deny authorizes exactly one successor, so the read-modify-write of the
  // marker runs under the denier's lock. Without it two racing resumes both
  // preflight an open record and both mint a verified resume-auth.
  lockOrExit(root, denySessionId);
  const claimed = markerUnchanged(root, denySessionId, marker.record);
  if (!claimed.ok) exitFrom(claimed);

  // Order matters: mint the signed auth, make the evidence durable, and only
  // then consume the deny. A failure at any step leaves the deny open, and the
  // resume-auth is rolled back so nothing half-authorized survives.
  const authWrote = writeResumeAuth(
    root,
    consumerId,
    { ticketId, contentHash, denySessionId },
    { key },
  );
  if (!authWrote.ok) opError(`failed to write resume-auth: ${authWrote.error}`);
  const rollbackAuth = () => removeResumeAuth(root, consumerId);

  // Authorize the consume with the document that was actually signed and read
  // back, not with a hand-built verified:true.
  const verifiedAuth = authWrote.resumeAuth;
  if (!verifiedAuth?.verified) {
    rollbackAuth();
    opError('resume-auth failed HMAC verification after write');
  }

  const consumed = consumeDenyRecord(marker.record, consumerId, { resumeAuth: verifiedAuth });
  if (!consumed.ok) {
    rollbackAuth();
    exitFrom(consumed);
  }

  const recorded = recordOrExit(
    {
      gate: 'context-handoff-resume',
      ticket: ticketId,
      data: {
        consumer_session_id: consumerId,
        deny_session_id: denySessionId,
        content_hash: contentHash,
        // This entry is durable before the marker flips, so it attests the
        // authorization, not the consume. An aborted persist leaves the deny
        // open with `outcome: authorized` and no `consumed` entry — that pair
        // is how an auditor tells an aborted resume from a completed one.
        outcome: 'authorized',
      },
      adlcDir,
      key,
    },
    rollbackAuth,
  );

  // Last check before the clobber: the lock covers handoff processes, this
  // covers anything that wrote the marker without taking it.
  const stillOurs = markerUnchanged(root, denySessionId, marker.record);
  if (!stillOurs.ok) {
    rollbackAuth();
    exitFrom(stillOurs);
  }

  const persisted = writeDenyRecord(root, consumed.record);
  if (!persisted.ok) {
    rollbackAuth();
    opError(`failed to persist consumed deny: ${persisted.error}`);
  }

  finish({
    json,
    payload: {
      tool: 'handoff',
      command: 'resume',
      dryRun: false,
      record: persisted.record,
      resumeAuth: verifiedAuth,
      consumePersisted: true,
      evidence: { gate: 'context-handoff-resume', seq: recorded?.seq, outcome: 'authorized' },
    },
    human: `handoff resume: consumed deny=${denySessionId} for consumer=${consumerId}`,
  });
}

/** Degrade: exit 2 with nothing consumed (spec §Continue). */
function degrade(message) {
  gateFail(`handoff continue: ${message}`);
}

/** The exact command an operator runs to bind an unbound deny (§Host repair). */
function repairHint(denySessionId) {
  return `adlc handoff repair --session ${denySessionId} --ticket <id> --content-hash <hash> --write`;
}

/**
 * Which ticket governs the continuation.
 *
 * An unbound deny degrades rather than being bound here: binding is host
 * repair's job, and a `continue` that could invent the ticket would let the
 * pointer decide what a denied session was working on. When the marker IS
 * bound, CLI → pointer → env may only agree with it — a disagreement means
 * nobody can say which ticket governs, so it fails closed.
 *
 * @returns {{ ok: true, ticketId: string } | { ok: false, error: string }}
 */
function resolveContinueTicket({ flag, root, env, record, denySessionId }) {
  const bound = normalizeBindField(record.ticket_id);
  if (!bound) {
    return {
      ok: false,
      error:
        `deny for session=${denySessionId} is unbound (ticket_id is null) — bind it first: ${repairHint(denySessionId)}`,
    };
  }
  const explicit = normalizeBindField(flag);
  let selected = explicit;
  if (!selected) {
    const active = resolveActiveTicketId({ root, env });
    if (!active.ok) {
      return { ok: false, error: `active ticket cannot be resolved (${active.code}): ${active.message}` };
    }
    selected = active.value ? normalizeBindField(active.value.id) : null;
  }
  if (selected && selected !== bound) {
    return {
      ok: false,
      error:
        `deny for session=${denySessionId} is bound to ticket ${bound} but the active ticket is ${selected} — ` +
        `pass --ticket ${bound} to continue that work, or re-select the ticket`,
    };
  }
  return { ok: true, ticketId: bound };
}

/**
 * Model narrative from a harness transcript, or a degrade.
 *
 * Absent `--capture-from` there is simply no narrative — the deterministic
 * brief stands on its own. Given one, a source that cannot be read or holds no
 * parseable JSONL is corrupt and degrades; a readable transcript that merely
 * ends on a tool call is not corrupt, and continues without a narrative.
 *
 * A narrative older than the staleness window is dropped rather than embedded:
 * the spec's `written_at` rule exists because a days-old plan read as current
 * is worse than no plan. The omission is stated in the brief instead of being
 * an error — the deterministic half is still worth handing over.
 *
 * @returns {{ narrative: string|null, note: string|null }}
 */
function narrativeOrDegrade(source, now = Date.now()) {
  if (source === undefined) return { narrative: null, note: null };
  if (typeof source !== 'string' || source.trim().length === 0) {
    degrade('--capture-from needs a transcript path');
  }
  const tail = readTranscriptTail(source);
  if (!tail.ok) degrade(`--capture-from source unreadable (${tail.error}): ${source}`);
  const parsed = parseTranscript(tail.text);
  if (parsed.entries.length === 0) {
    degrade(`--capture-from source holds no parseable transcript lines: ${source}`);
  }
  const narrative = finalAssistantMessageFrom(parsed.entries);
  if (narrative === null) return { narrative: null, note: null };

  // The transcript's own newest timestamp answers "how old is this
  // CONVERSATION"; the file's mtime only answers "when was this file last
  // touched", so it is the fallback, not the measure.
  const stamped = transcriptTimestamp(parsed.entries);
  const ageHours = (now - (stamped ?? tail.mtimeMs)) / (60 * 60 * 1000);
  if (ageHours > HANDOFF_MAX_AGE_HOURS) {
    return {
      narrative: null,
      note: `model narrative omitted: source stale (${Math.floor(ageHours)}h > ${HANDOFF_MAX_AGE_HOURS}h)`,
    };
  }
  return { narrative, note: null };
}

function runContinue(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'deny-session': { type: 'string' },
      session: { type: 'string' },
      'capture-from': { type: 'string' },
      ticket: { type: 'string' },
      host: { type: 'string' },
      dir: { type: 'string' },
      write: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(`handoff continue --deny-session <old> [--session <new>] [--capture-from <transcript>] [--ticket <id>] [--host <h>] [--dir .adlc] [--write] [--json]

Capture the denied session, bind the final to that capture, and consume the deny
for ONE successor session — the host-orchestrated recovery from a handoff deny.
The denier is never un-denied: D2 stays sticky and the work moves to a new session.

The successor id comes from --session or is minted here; it is never taken from
agent input. --write requires ADLC_MANIFEST_KEY and runs under the denier's lock.

Exit 2 (nothing consumed): unbound deny, consumed deny, missing/corrupt
--capture-from source, a successor that already holds a resume-auth, or an
active ticket that disagrees with the deny's bind.
`);
    process.exit(0);
  }

  const denySessionId = requireSafeSession(values['deny-session'], '--deny-session');
  // Minted here when absent: a successor id supplied by the denied agent would
  // let it name a session whose resume-auth it can already read.
  const successorId =
    values.session === undefined ? randomUUID() : requireSafeSession(values.session, '--session');
  if (successorId === denySessionId) {
    degrade('the successor id must differ from the denied session (its deny is sticky)');
  }
  const { root, adlcDir, write, json } = commonOrExit(values);
  const host = values.host ?? 'local';

  // Refuse a successor that is already authorized, before anything is written.
  // Overwriting would destroy an authorization this run never issued, and this
  // run's own rollback would then delete it outright. `authorizeSuccessor`
  // re-checks under the lock; this one keeps a dry run honest about what the
  // real run would do.
  if (existsSync(resumeAuthPath(root, successorId))) {
    degrade(`successor session ${successorId} already holds a resume-auth — successor ids must be fresh`);
  }

  const marker = readDenyMarker(root, denySessionId);
  if (!marker.ok || !marker.record) {
    degrade(`deny marker for session=${denySessionId} unavailable (${marker.reason || 'missing'})`);
  }
  if (marker.record.status !== 'open') {
    degrade(
      `deny marker for session=${denySessionId} is ${marker.record.status} — a consumed handoff has already moved to its successor`,
    );
  }

  const ticket = resolveContinueTicket({
    flag: values.ticket,
    root,
    env: process.env,
    record: marker.record,
    denySessionId,
  });
  if (!ticket.ok) degrade(ticket.error);
  const ticketId = ticket.ticketId;

  const narrative = narrativeOrDegrade(values['capture-from']);
  const git = gitState(root);
  const body = capCaptureBody(
    composeBrief({
      ticketId,
      ticketTitle: ticketTitle(adlcDir, ticketId),
      evidenceTail: evidenceTail(adlcDir),
      gitBranch: git.branch,
      gitStatus: git.status,
      // Flail signals reach the brief from a supervisor that observed the
      // session; this CLI has no build log of its own to analyze.
      flailSignals: null,
      modelNarrative: narrative.narrative,
      narrativeNote: narrative.note,
    }),
  ).body;
  const contentHash = hashCaptureBody(body);
  // The ids land in the prompt's trusted half, so they are checked, not trusted.
  const bootstrap = buildBootstrapPrompt({ denySessionId, ticketId, body });
  if (!bootstrap.ok) degrade(bootstrap.error);
  const bootstrapPrompt = bootstrap.prompt;

  if (!write) {
    finish({
      json,
      payload: {
        tool: 'handoff',
        command: 'continue',
        dryRun: true,
        successor_session_id: successorId,
        ticket_id: ticketId,
        content_path: contentPath(root, denySessionId),
        content_hash: contentHash,
        bootstrap_prompt: bootstrapPrompt,
      },
      human: `handoff continue: dry-run deny=${denySessionId} successor=${successorId} ticket=${ticketId} content_hash=${contentHash} (pass --write to persist)`,
    });
  }

  const key = requireKeyOrExit();

  // One deny authorizes exactly one successor, and this command rewrites the
  // denier's capture, final and marker — all of it runs under the denier's lock.
  lockOrExit(root, denySessionId);
  const claimed = markerUnchanged(root, denySessionId, marker.record);
  if (!claimed.ok) exitFrom(claimed);

  const capturePath = contentPath(root, denySessionId);
  const priorCaptureBytes = currentBytes(capturePath);
  // Writes and then proves the bytes on disk hash to what everything downstream
  // will authorize against. Ownership is carried from the write itself — a
  // disk sample here could adopt a concurrent replacement as ours and let the
  // rollback below destroy it.
  const wroteCapture = writeVerifiedCapture(root, denySessionId, body);
  const wroteCaptureBytes = wroteCapture.ok ? wroteCapture.bytes : null;
  const rollbackCapture = () =>
    restoreIfOurs({
      path: capturePath,
      wroteBytes: wroteCaptureBytes,
      priorBytes: priorCaptureBytes,
      label: 'capture',
    });
  if (!wroteCapture.ok) {
    rollbackCapture();
    opError(`failed to write capture: ${wroteCapture.error}`);
  }

  // content_kind: 'capture' is what makes the bind re-derivable — it tells every
  // later reader that a capture body must exist and hash to content_hash, so an
  // edited or deleted capture fails closed instead of going unnoticed.
  const planned = buildFinal({
    sessionId: denySessionId,
    ticketId,
    contentHash,
    contentKind: CONTENT_KIND_CAPTURE,
    host,
  });
  const checkpoint = writeCheckpoint(root, denySessionId, planned, { expected: marker.record });
  if (!checkpoint.ok) {
    rollbackCapture();
    exitFrom(checkpoint);
  }
  // Every undo is a compare-and-swap on the bytes this run wrote. The failure
  // that triggers a rollback is often a concurrent writer, so restoring a
  // pre-command snapshot unconditionally would delete the record that just beat
  // us. The resume-auth is authorizeSuccessor's to own; this only removes what
  // THIS run minted, so a refused collision cannot delete another run's grant.
  // The resume-auth is `authorizeSuccessor`'s to undo — it holds the bytes it
  // created, so its removal is byte-checked the same way these are, and a
  // caller that also unlinked would be doing it blind.
  const undoFiles = () => [
    ...rollbackCheckpoint(root, denySessionId, checkpoint),
    rollbackCapture(),
  ];
  /** Exit reporting both the failure and anything the undo could not reclaim. */
  const undoAndExit = (result) => {
    const conflicts = conflictReport([...undoFiles(), result?.authRollback].filter(Boolean));
    exitFrom({
      ...result,
      message: conflicts ? `${result.error || result.message} — ${conflicts}` : result.error || result.message,
    });
  };

  const bound = readDenyMarker(root, denySessionId);
  if (!bound.ok) {
    undoAndExit({ error: `deny marker unreadable after bind: ${bound.reason}`, exitCode: 1 });
  }

  const authorized = authorizeSuccessor({
    root,
    denySessionId,
    successorId,
    ticketId,
    contentHash,
    key,
    expected: bound.record,
    recordEvidence: () =>
      recordHandoffEvidence({
        gate: 'context-handoff-continue',
        ticket: ticketId,
        data: {
          deny_session_id: denySessionId,
          successor_session_id: successorId,
          content_hash: contentHash,
          // Durable before the marker flips, so it attests the authorization,
          // not the consume — same reading as context-handoff-resume.
          outcome: 'authorized',
        },
        dir: adlcDir,
        key,
      }),
  });
  if (!authorized.ok) {
    // An un-evidenced or refused continuation must leave the deny open, no
    // capture behind, and nothing half-authorized — except where another writer
    // has since taken ownership of an artifact, which the undo reports instead
    // of overwriting.
    undoAndExit(authorized);
  }

  finish({
    json,
    payload: {
      tool: 'handoff',
      command: 'continue',
      dryRun: false,
      successor_session_id: successorId,
      ticket_id: ticketId,
      content_path: wroteCapture.path,
      content_hash: contentHash,
      bootstrap_prompt: bootstrapPrompt,
      evidence: { gate: 'context-handoff-continue', seq: authorized.evidence?.seq },
    },
    human: `handoff continue: deny=${denySessionId} consumed for successor=${successorId} ticket=${ticketId} content=${wroteCapture.path}`,
  });
}

const SUPERVISE_USAGE = `handoff supervise [--dir .adlc] -- <command> [args...]

Run a harness session under a supervisor that performs the whole handoff
recovery for the operator: it mints the session id, watches for that session's
deny marker, waits for the session to finish writing, runs \`handoff continue\`,
and respawns the harness as the successor with the bootstrap prompt.

  adlc handoff supervise -- claude
  adlc handoff supervise --dir .adlc -- claude --model opus

ADLC_MANIFEST_KEY is required and is used ONLY for the continue step. It is
stripped from the harness child's environment, along with the CLAUDECODE and
CLAUDE_CODE_* child-session markers that silently disable transcript saving.

Exit codes:
  0  the supervised session ended (or you interrupted it)
  1  operational error (no command after \`--\`, missing key, bad --dir)
  2  continuation degraded — the session is still running and still denied,
     and the operator one-liner to continue it by hand has been printed
  3  the supervised command failed — it exited non-zero or was killed. Its own
     code is reported in the message rather than passed through, so it can
     never be mistaken for one of this command's own verdicts above
  4  the supervised command could not be started at all
`;

async function runSupervise(argv) {
  // Help is answered before the passthrough split: `supervise --help` has no
  // `--`, and refusing it for that reason would make the help unreachable
  // exactly when somebody needs to be told about the separator.
  const separatorAt = argv.indexOf('--');
  const ownArgs = separatorAt === -1 ? argv : argv.slice(0, separatorAt);
  if (ownArgs.includes('--help') || ownArgs.includes('-h')) {
    console.log(SUPERVISE_USAGE);
    process.exit(0);
  }

  const split = splitPassthrough(argv);
  if (!split.ok) opError(split.error);

  const { values } = parseArgs({
    args: split.flags,
    options: {
      dir: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  const { root, adlcDir, json } = commonOrExit(values);

  // Fail before the harness starts, not after the first deny: a wrapper that
  // discovers the missing key an hour in has wasted the session it was
  // supervising, and the deny it cannot clear is sticky.
  requireKeyOrExit();

  const { deps, interrupt } = createSuperviseDeps({
    root,
    adlcDir,
    command: split.command,
    args: split.args,
    env: process.env,
  });

  let outcome;
  try {
    outcome = await superviseLoop(deps);
  } finally {
    interrupt.dispose();
  }

  // The harness's own failure is the supervisor's failure to report: a wrapper
  // that exits 0 because it wrapped something successfully, while the thing it
  // wrapped never started, is a wrapper a script cannot trust.
  const code = superviseExitCode(outcome.reason);
  finish({
    json,
    payload: {
      tool: 'handoff',
      command: 'supervise',
      dryRun: false,
      reason: outcome.reason,
      sessions: outcome.sessions,
      continuations: outcome.continuations,
      childExit: outcome.childExit ?? null,
      // Intermediates that crashed on the way to a handoff. Supervision still
      // succeeded — this is here so a --json consumer can see it happened.
      abnormalExits: outcome.abnormalExits ?? [],
      exitCode: code,
    },
    human: `handoff supervise: ${describeOutcome(outcome)} (sessions: ${outcome.sessions.join(' → ') || 'none'})`,
    code,
  });
}

function runBypass(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      session: { type: 'string' },
      'unbound-reason': { type: 'string' },
      ticket: { type: 'string' },
      dir: { type: 'string' },
      write: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(`handoff bypass --session <id> [--unbound-reason <text>] [--ticket <id>] [--dir .adlc] [--write] [--json]

One-shot bypass grant for adapters. Bound (no --unbound-reason) lifts D2 for
bound denies only. Unbound (--unbound-reason=…) also authorizes null-ticket /
null-hash and may clear D0/D3. --write requires ADLC_MANIFEST_KEY.

--write persists a signed, session-bound grant the adapter reads back on its
NEXT mutation-gate evaluation for this session and consumes (deletes) the
moment it authorizes one — genuinely one-shot, not just an audit trail. The
grant also expires on its own after a short TTL (BYPASS_GRANT_TTL_MS) as a
defense-in-depth ceiling if consumption itself fails. The manifest
context-handoff-bypass entry --write also writes remains the durable AUDIT
record of the grant having been issued; it is not itself consulted for
authorization.
`);
    process.exit(0);
  }
  const sessionId = requireSafeSession(values.session, '--session');
  const unboundReason = values['unbound-reason'];
  // Flag absent and flag present-but-empty are different requests. Falling
  // through would hand back a bound grant — which cannot clear the D0/D3 the
  // operator asked to override — and record it as if it were what they wanted.
  if (typeof unboundReason === 'string' && unboundReason.trim().length === 0) {
    opError('--unbound-reason must be a non-empty reason (omit the flag for a bound grant)');
  }
  const unbound =
    typeof unboundReason === 'string' && unboundReason.trim().length > 0
      ? unboundReason.trim()
      : null;

  /** Grant shape adapters pass into evaluateMutationGate / authorized. */
  const grant = unbound
    ? { sessionId, unboundReason: unbound }
    : { sessionId };

  const normalized = normalizeBypassGrant(grant, sessionId);
  if (!normalized.active) opError('bypass grant inactive (internal)');

  // Demonstrate bound vs unbound against a synthetic FOREIGN unbound record
  // for operators. Round-17 review: authorized() now authorizes a bound
  // grant against its OWN session's unbound record unconditionally (the
  // real band-triggered producer always creates one — see mutation-gate.mjs's
  // authorized() comment) — sampling this session's own id here would report
  // allowsUnbound: true for every active grant, bound or not, telling the
  // operator nothing. A synthetic session id distinct from `sessionId`
  // preserves what this field actually exists to show: whether the grant
  // reaches BEYOND its own session (only an unbound-reason override does).
  const sampleUnbound = {
    session_id: `${sessionId}-foreign-sample`,
    ticket_id: null,
    content_hash: null,
    status: 'open',
  };
  const allowsUnbound = authorized({
    record: sampleUnbound,
    bypassForSession: grant,
    currentSessionId: sessionId,
  });

  const { root, adlcDir, write, json } = commonOrExit(values);

  if (!write) {
    finish({
      json,
      payload: {
        tool: 'handoff',
        command: 'bypass',
        dryRun: true,
        grant,
        bound: !unbound,
        allowsUnboundRecord: allowsUnbound,
        normalized,
      },
      human: `handoff bypass: dry-run session=${sessionId} bound=${!unbound} allowsUnbound=${allowsUnbound} (pass --write to record)`,
    });
  }

  const key = requireKeyOrExit();

  // The functional grant the adapter actually reads back and consumes — see
  // lib/bypass-grant.mjs. Written BEFORE the audit record: if this fails, the
  // operator needs to know the bypass did NOT take effect, not just that an
  // audit trail was left behind for a grant that was never live.
  const grantWrite = writeBypassGrant(root, sessionId, { unboundReason: unbound }, { key });
  if (!grantWrite.ok) {
    opError(`bypass grant could not be persisted: ${grantWrite.error} — the recovery command did NOT unblock the next mutation`);
  }

  // Round-14 review: recordOrExit's own onFailure rollback exists precisely
  // for this — grant and audit record must be atomic from the operator's
  // perspective. Without this, a manifest-write failure AFTER the grant is
  // already on disk would report overall failure while leaving a live,
  // unrecorded bypass capability consumable for up to BYPASS_GRANT_TTL_MS.
  const recorded = recordOrExit(
    {
      gate: 'context-handoff-bypass',
      ticket: values.ticket ?? undefined,
      data: {
        session_id: sessionId,
        unbound_reason: unbound,
        bound: !unbound,
        grant,
      },
      adlcDir,
      key,
    },
    () => removeBypassGrant(root, sessionId),
  );

  finish({
    json,
    payload: {
      tool: 'handoff',
      command: 'bypass',
      dryRun: false,
      grant,
      bound: !unbound,
      allowsUnboundRecord: allowsUnbound,
      evidence: { gate: 'context-handoff-bypass', seq: recorded?.seq },
    },
    human: `handoff bypass: recorded ${unbound ? 'unbound' : 'bound'} grant for session=${sessionId} (consumed by the next authorized mutation)`,
  });
}

function runRepair(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      session: { type: 'string' },
      ticket: { type: 'string' },
      'content-hash': { type: 'string' },
      host: { type: 'string' },
      dir: { type: 'string' },
      write: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(`handoff repair --session <id> --ticket <id> --content-hash <h> [--dir .adlc] [--write] [--json]

Privileged host repair: refresh final and bind an open deny's ticket_id+content_hash.
Requires an existing open deny marker — repair never creates one. Agent Shell
under deny must not invoke this. --write requires ADLC_MANIFEST_KEY.
`);
    process.exit(0);
  }
  const sessionId = requireSafeSession(values.session, '--session');
  const ticketId = normalizeBindField(values.ticket);
  const contentHash = normalizeBindField(values['content-hash']);
  if (!ticketId) opError('--ticket is required');
  if (!contentHash) opError('--content-hash is required');
  const host = values.host ?? 'local';
  const { root, adlcDir, write, json } = commonOrExit(values);

  const plannedFinal = buildFinal({ sessionId, ticketId, contentHash, host });

  // Repair binds a deny that already exists; minting one here would arm a fresh
  // repo-wide deny from a command whose job is to relax one.
  const marker = readDenyMarker(root, sessionId);
  if (!marker.ok || !marker.record) {
    opError(
      `no deny marker for session=${sessionId} (${marker.reason || 'missing'}) — repair binds an existing open deny, it does not create one`,
    );
  }
  if (marker.record.status !== 'open') {
    opError(`deny marker for session=${sessionId} is ${marker.record.status} — repair only binds an open deny`);
  }

  if (!write) {
    finish({
      json,
      payload: {
        tool: 'handoff',
        command: 'repair',
        dryRun: true,
        final: plannedFinal,
        deny: marker.record,
        denyBinds: { ticket_id: ticketId, content_hash: contentHash },
      },
      human: `handoff repair: dry-run session=${sessionId} ticket=${ticketId} (pass --write to persist)`,
    });
  }

  const key = requireKeyOrExit();
  lockOrExit(root, sessionId);

  // Re-read under the lock: the marker read above happened before we held it.
  const claimed = markerUnchanged(root, sessionId, marker.record);
  if (!claimed.ok) exitFrom(claimed);

  const priorFinal = readFinal(root, sessionId);
  const written = writeFinal(root, {
    sessionId,
    ticketId,
    contentHash,
    host,
  });
  if (!written.ok) opError(`failed to write final: ${written.error}`);

  const repaired = repairDenyBinds(root, sessionId, { ticketId, contentHash, host });
  if (!repaired.ok) {
    restoreFinal(root, sessionId, priorFinal);
    opError(`failed to repair deny binds: ${repaired.error}`);
  }

  const recorded = recordOrExit(
    {
      gate: 'context-handoff-repair',
      ticket: ticketId,
      data: {
        session_id: sessionId,
        content_hash: contentHash,
      },
      adlcDir,
      key,
    },
    // Both mutations are un-evidenced if the append fails, and repair always has
    // a prior marker to restore — put the binds and the final back.
    () => {
      restoreFinal(root, sessionId, priorFinal);
      writeDenyRecord(root, marker.record);
    },
  );

  finish({
    json,
    payload: {
      tool: 'handoff',
      command: 'repair',
      dryRun: false,
      final: written.final,
      deny: repaired.record,
      evidence: { gate: 'context-handoff-repair', seq: recorded?.seq },
    },
    human: `handoff repair: bound session=${sessionId} ticket=${ticketId}`,
  });
}

function runUnlock(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      session: { type: 'string' },
      pid: { type: 'string' },
      'started-at': { type: 'string' },
      host: { type: 'string' },
      nonce: { type: 'string' },
      dir: { type: 'string' },
      write: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(`handoff unlock --session <id> --pid <n> --started-at <iso> --host <h> --nonce <n> [--dir .adlc] [--write] [--json]

Reclaim a session lock only when the PID is dead, the lock belongs to this host,
and all lock fields match. Live PID, foreign host, or any field mismatch exits 2.
`);
    process.exit(0);
  }
  const sessionId = requireSafeSession(values.session, '--session');
  if (values.pid === undefined) opError('--pid is required');
  if (values['started-at'] === undefined) opError('--started-at is required');
  if (values.host === undefined) opError('--host is required');
  if (values.nonce === undefined) opError('--nonce is required');
  const pid = Number(values.pid);
  if (!Number.isInteger(pid) || pid <= 0) opError('--pid must be a positive integer');

  const { root, write, json } = commonOrExit(values);
  const result = unlockSession(root, {
    sessionId,
    pid,
    startedAt: values['started-at'],
    host: values.host,
    nonce: values.nonce,
    write,
  });

  if (!result.ok) exitFrom(result);

  finish({
    json,
    payload: {
      tool: 'handoff',
      command: 'unlock',
      dryRun: result.dryRun === true,
      session: sessionId,
      lock: result.lock,
    },
    human: result.dryRun
      ? `handoff unlock: dry-run session=${sessionId} reclaimable (pass --write to remove lock)`
      : `handoff unlock: reclaimed lock for session=${sessionId}`,
  });
}

// --- dispatch ---
const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  helpAndExit();
}

const [command, ...rest] = argv;
switch (command) {
  case 'write':
    runWrite(rest);
    break;
  case 'resume':
    runResume(rest);
    break;
  case 'bypass':
    runBypass(rest);
    break;
  case 'repair':
    runRepair(rest);
    break;
  case 'unlock':
    runUnlock(rest);
    break;
  case 'continue':
    runContinue(rest);
    break;
  case 'supervise':
    // Awaited: the loop is long-lived, and an unawaited rejection here would
    // exit 0 while the supervised session was still running.
    await runSupervise(rest);
    break;
  case '--help':
  case '-h':
  case 'help':
    helpAndExit();
    break;
  default:
    opError(
      `unknown subcommand "${command}" (expected write|resume|bypass|repair|unlock|continue|supervise)`,
    );
}

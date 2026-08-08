#!/usr/bin/env node
/**
 * handoff — operator/host CLI for context-rot handoff (slice 2).
 * Dispatched as `adlc handoff <subcommand>`.
 *
 * Subcommands: write | resume | bypass | repair | unlock
 * Mutating `--write` requires ADLC_MANIFEST_KEY (never silent success).
 */

import { existsSync, unlinkSync } from 'node:fs';
import { parseArgs } from '@adlc/core';
import { ensureDenyMarker, readDenyMarker, normalizeBindField } from '../lib/deny-marker.mjs';
import { consumeDenyRecord } from '../lib/deny-lifecycle.mjs';
import { normalizeBypassGrant, authorized } from '../lib/mutation-gate.mjs';
import { writeFinal, readFinal, buildFinal } from '../lib/final.mjs';
import { writeResumeAuth, removeResumeAuth } from '../lib/resume-auth.mjs';
import { writeDenyRecord, repairDenyBinds, markerUnchanged } from '../lib/deny-persist.mjs';
import { unlockSession } from '../lib/lock.mjs';
import { writeJsonAtomic } from '../lib/atomic-json.mjs';
import { finalPath } from '../lib/paths.mjs';
import {
  commonOrExit,
  exitFrom,
  finish,
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

/**
 * Put a final back the way we found it. Evidence is what makes a mutation
 * legible, so a final whose evidence never landed is state nobody can audit.
 * @param {{ ok: boolean, final?: object }} prior — readFinal() from before the write
 */
function restoreFinal(root, sessionId, prior) {
  const path = finalPath(root, sessionId);
  try {
    if (prior.ok) writeJsonAtomic(path, prior.final);
    else if (existsSync(path)) unlinkSync(path);
  } catch {
    // best-effort: the operator already sees the evidence failure
  }
}

/**
 * Point an open deny at the binds of the final we just wrote. `ensureDenyMarker`
 * is idempotent by contract and never rebinds, so a refresh without this leaves
 * the marker on the previous hash and every later resume is refused.
 * @returns {{ ok: true, record: object } | { ok: false, error: string }}
 */
function rebindOpenDeny(root, sessionId, record, planned) {
  if (planned.ticket_id != null) {
    return repairDenyBinds(root, sessionId, {
      ticketId: planned.ticket_id,
      contentHash: planned.content_hash,
      host: planned.host,
    });
  }
  // Still-unbound refresh: repairDenyBinds demands both binds, and an unbound
  // deny is the stricter state (only an unbound bypass clears it), so persist
  // the marker directly rather than refusing a legitimate no-ticket refresh.
  return writeDenyRecord(root, {
    ...record,
    ticket_id: null,
    content_hash: planned.content_hash,
    host: planned.host,
    status: 'open',
  });
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

  const priorFinal = readFinal(root, sessionId);
  const written = writeFinal(root, {
    sessionId,
    ticketId: planned.ticket_id,
    contentHash: planned.content_hash,
    host: planned.host,
  });
  if (!written.ok) opError(`failed to write final: ${written.error}`);

  const deny = ensureDenyMarker(root, {
    sessionId,
    ticketId: planned.ticket_id,
    contentHash: planned.content_hash,
    host: planned.host,
  });
  if (!deny.ok) {
    restoreFinal(root, sessionId, priorFinal);
    opError(`failed to ensure deny marker: ${deny.reason}`);
  }

  // Rebind whatever ensure left in place, so final and marker agree.
  const marker = readDenyMarker(root, sessionId);
  if (!marker.ok) {
    restoreFinal(root, sessionId, priorFinal);
    opError(`deny marker unreadable after ensure: ${marker.reason}`);
  }
  const stale =
    marker.record.ticket_id !== planned.ticket_id ||
    marker.record.content_hash !== planned.content_hash;
  let priorRecord = null;
  if (stale) {
    const rebound = rebindOpenDeny(root, sessionId, marker.record, planned);
    if (!rebound.ok) {
      restoreFinal(root, sessionId, priorFinal);
      opError(`failed to rebind deny marker: ${rebound.error}`);
    }
    priorRecord = marker.record;
  }

  const recorded = recordOrExit(
    {
      gate: 'context-handoff-write',
      ticket: planned.ticket_id ?? undefined,
      data: {
        session_id: sessionId,
        content_hash: planned.content_hash,
        deny_reason: deny.reason,
        rebound: stale,
      },
      adlcDir,
      key,
    },
    // Un-evidenced state is un-auditable state: undo this run's final and, if we
    // moved an existing marker's binds, put those back too. A marker created
    // fresh this run stays — the sentinel already names the session, so deleting
    // it trades an open deny for an unclearable D3.
    () => {
      restoreFinal(root, sessionId, priorFinal);
      if (priorRecord) writeDenyRecord(root, priorRecord);
    },
  );

  finish({
    json,
    payload: {
      tool: 'handoff',
      command: 'write',
      dryRun: false,
      final: written.final,
      deny: { ok: true, reason: deny.reason, rebound: stale },
      evidence: { gate: 'context-handoff-write', seq: recorded?.seq },
    },
    human: `handoff write: wrote final+deny for session=${sessionId} content_hash=${written.final.content_hash}`,
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

The grant printed on stdout is for the calling adapter invocation only; it is
not a stored credential. The durable proof of the bypass is the manifest
context-handoff-bypass entry written by --write.
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

  // Demonstrate bound vs unbound against a synthetic unbound record for operators.
  const sampleUnbound = {
    session_id: sessionId,
    ticket_id: null,
    content_hash: null,
    status: 'open',
  };
  const allowsUnbound = authorized({
    record: sampleUnbound,
    bypassForSession: grant,
    currentSessionId: sessionId,
  });

  const { adlcDir, write, json } = commonOrExit(values);

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

  const recorded = recordOrExit({
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
  });

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
    human: `handoff bypass: recorded ${unbound ? 'unbound' : 'bound'} grant for session=${sessionId}`,
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
  case '--help':
  case '-h':
  case 'help':
    helpAndExit();
    break;
  default:
    opError(`unknown subcommand "${command}" (expected write|resume|bypass|repair|unlock)`);
}

#!/usr/bin/env node
// adlc-session-start.mjs — Cursor sessionStart hook (T64).
//
// Resolves the consumer workspace from host-supplied roots (never plugin cwd),
// emits best-effort additional_context + ADLC_CURSOR_SESSION_ID env pin, and
// upserts a user-scoped session-resolution record (AC19). Does NOT set or clear
// ADLC_P4_ENFORCEMENT. additional_context injection is best-effort (ADR 0006);
// rules/adlc-ticket-context.mdc (alwaysApply) is the durable fallback.

import { fileURLToPath } from 'node:url';
import { SESSION_ENV_KEY, resolveSessionIdentity } from '../lib/session-identity.mjs';
import {
  enforcementActive,
  phaseHint,
  resolveConsumerWorkspace,
  upsertSessionResolution,
} from '../lib/workspace-resolve.mjs';

/**
 * Pure sessionStart decision (tests drive this).
 * @returns {{ env?: Record<string,string>, additional_context: string, identity: object, workspace: object }}
 */
export function handleSessionStart(payload = {}, { env = process.env, now = Date.now() } = {}) {
  const identity = resolveSessionIdentity(payload, env);
  const workspace = resolveConsumerWorkspace(payload, env);
  const enforcing = enforcementActive(env);

  const contextLines = [];
  let ticketId = null;

  if (identity.conflict) {
    contextLines.push(
      `ADLC session identity conflict: ${identity.message ?? 'session id aliases disagree'}.`,
      'Named session state (depth / markers / session index) will not be mutated.',
    );
  } else if (workspace.outcome === 'active') {
    ticketId = workspace.ticketId;
    contextLines.push(`ADLC active ticket: **${ticketId}**.`);
  } else if (workspace.outcome === 'inactive') {
    contextLines.push('ADLC: no active ticket in the resolved consumer workspace.');
  } else if (workspace.outcome === 'ambiguous') {
    contextLines.push(
      `ADLC workspace ambiguity: multiple active-ticket-bearing roots (${workspace.message}).`,
      'No consumer root selected — resolve to a single ADLC worktree.',
    );
  } else if (workspace.outcome === 'error') {
    contextLines.push(
      `ADLC workspace error (${workspace.errorClass ?? 'error'}): ${workspace.message}`,
    );
  } else {
    contextLines.push(
      'ADLC: unresolved / no host-supplied ADLC-bearing consumer root ' +
        '(plugin cwd is never selected as a silent fallback).',
    );
  }

  const phase = phaseHint({ ticketId, enforcing });
  contextLines.push(
    `Enforcement: ${enforcing ? 'active (ADLC_P4_ENFORCEMENT=1)' : 'inactive'} — phase hint: ${phase}.`,
  );
  contextLines.push(
    'Route work through `/adlc-*` commands or the `adlc` skill; do not treat a raw ' +
      '`.adlc/current-ticket.json` or `ADLC_TICKET` read as authoritative alone.',
  );

  // Index mutation only with a valid unified session id (skip on conflict / anonymous).
  if (identity.ok && identity.sessionId && !identity.conflict) {
    upsertSessionResolution({
      sessionId: identity.sessionId,
      outcome: workspace.outcome,
      root: workspace.root,
      ticketId: workspace.ticketId,
      candidates: workspace.candidates,
      errorClass: workspace.errorClass ?? null,
      env,
      now,
    });
  }

  const out = { additional_context: contextLines.join('\n') };
  // Pin session env only when we have an unambiguous payload/env session id.
  if (identity.ok && identity.sessionId && identity.source !== 'anonymous') {
    out.env = { [SESSION_ENV_KEY]: identity.sessionId };
  }
  // Never set or clear ADLC_P4_ENFORCEMENT.
  return { ...out, identity, workspace };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let payload = {};
  const raw = await readStdin();
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      process.stderr.write(`adlc-session-start: malformed payload JSON — ${err.message}\n`);
      process.stdout.write(JSON.stringify({
        additional_context: 'ADLC sessionStart: unparseable payload; no consumer root selected.',
      }));
      return;
    }
  }
  const result = handleSessionStart(payload, { env: process.env });
  const wire = { additional_context: result.additional_context };
  if (result.env) wire.env = result.env;
  process.stdout.write(JSON.stringify(wire));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}

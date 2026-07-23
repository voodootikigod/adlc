#!/usr/bin/env node
// adlc-precompact.mjs — observational preCompact reminder (T67).
// Cannot block compaction. Reminds of active ticket + rails when resolvable.

import { fileURLToPath } from 'node:url';
import { resolveConsumerWorkspace } from '../lib/workspace-resolve.mjs';
import { resolveSessionIdentity } from '../lib/session-identity.mjs';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function buildMessage(workspace) {
  if (!workspace || workspace.outcome === 'unresolved') {
    return 'ADLC: compaction starting — no host-supplied consumer ADLC root resolved; re-check active ticket after compact.';
  }
  if (workspace.outcome === 'ambiguous' || workspace.outcome === 'error') {
    return `ADLC: compaction starting — workspace ${workspace.outcome}: ${workspace.message || 'see sessionStart / ticket context rule'}.`;
  }
  if (workspace.outcome === 'inactive' || !workspace.ticketId) {
    return 'ADLC: compaction starting — no active ticket in the resolved consumer workspace. Re-select before mutating rails.';
  }
  return (
    `ADLC: compaction starting — active ticket ${workspace.ticketId}` +
    (workspace.root ? ` (root ${workspace.root})` : '') +
    '. Re-read rails/scope after compact; CI rails-guard remains the control.'
  );
}

export function handlePreCompact(payload, { env = process.env } = {}) {
  const workspace = resolveConsumerWorkspace(payload, env);
  const identity = resolveSessionIdentity(payload, env);
  const msg = buildMessage(workspace);
  // Observational only — never deny.
  return {
    user_message: msg,
    agent_message: msg,
    ...(identity.ok && identity.sessionId && !identity.conflict
      ? { env: { ADLC_CURSOR_SESSION_ID: identity.sessionId } }
      : {}),
  };
}

async function main() {
  let payload = {};
  const raw = await readStdin();
  if (raw.trim()) {
    try { payload = JSON.parse(raw); } catch { /* observational */ }
  }
  process.stdout.write(JSON.stringify(handlePreCompact(payload, { env: process.env })));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}

#!/usr/bin/env node
// adlc-subagent.mjs — subagentStart / subagentStop (T67).
// subagentStart: defense-in-depth P5 allowlist (authoritative path is preToolUse).
// subagentStop: observational only (marker cleared by /adlc-prosecute via runId).

import { fileURLToPath } from 'node:url';
import { decideP5SubagentPolicy } from '../lib/p5-subagent-policy.mjs';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export function handleSubagentStart(payload, { env = process.env, now = Date.now() } = {}) {
  const decision = decideP5SubagentPolicy(payload, { env, now });
  if (decision.permission === 'allow') {
    return {
      permission: 'allow',
      agent_message: decision.reason,
    };
  }
  return {
    permission: decision.permission,
    user_message: decision.reason,
    agent_message:
      `${decision.reason}. Nested Task during P5 is degraded/permissive until lineage is proven (ADR-0006). ` +
      'Authoritative Task allowlist is also enforced on preToolUse.',
  };
}

export function handleSubagentStop() {
  return {
    agent_message:
      'ADLC subagentStop: prosecution marker cleanup remains the command\'s responsibility (runId compare-and-delete).',
  };
}

async function main() {
  const event = process.argv.includes('--stop')
    ? 'subagentStop'
    : (process.env.ADLC_CURSOR_HOOK_EVENT === 'subagentStop' ? 'subagentStop' : 'subagentStart');

  let payload = {};
  const raw = await readStdin();
  if (raw.trim()) {
    try { payload = JSON.parse(raw); } catch {
      process.stdout.write(JSON.stringify({ permission: 'allow' }));
      return;
    }
  }

  if (event === 'subagentStop') {
    process.stdout.write(JSON.stringify(handleSubagentStop()));
    return;
  }
  process.stdout.write(JSON.stringify(handleSubagentStart(payload, { env: process.env })));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}

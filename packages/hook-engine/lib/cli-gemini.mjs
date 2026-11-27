#!/usr/bin/env node
// cli-gemini.mjs — standalone CLI & bundle entrypoint for plugins/adlc-gemini
// (Antigravity agy / JetSki). Re-exports the full Gemini hook runtime surface.

import { fileURLToPath } from 'node:url';
import {
  decide,
  preInvocation,
  postToolUse,
  onStop,
  runFromStdin,
  printStatus,
  printDoctor,
} from './gemini-guard.mjs';
import { normalizeHookInput } from './protocol-adapters.mjs';

export * from './gemini-guard.mjs';
export * from './flail-transcript.mjs';
export * from './session-tracker.mjs';
export * from './command-verify.mjs';
export {
  enclosingAdlcRoot,
  isAncestorDirOfRail,
  railHit,
  isDirectoryDeletionCommand,
  resolveActiveTicketId,
  readActiveTicketRails,
  evaluatePreTool,
} from './pretool.mjs';
export {
  HARNESS_PROTOCOLS,
  DECISION_LATTICE,
  resolveHarnessProtocol,
  normalizeHookInput,
  formatHookOutput,
} from './protocol-adapters.mjs';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export function dispatchGeminiHook(raw, env = process.env) {
  let parsed = null;
  try {
    parsed = raw && raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return runFromStdin(raw, env);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return runFromStdin(raw, env);
  }
  const hasEvent = Boolean(parsed.hook_event_name ?? parsed.hookEventName ?? parsed.event ?? parsed.type);
  if (!hasEvent) {
    return runFromStdin(raw, env);
  }
  const norm = normalizeHookInput('gemini', parsed);
  if (norm.event === 'session-start') return preInvocation(parsed, { env });
  if (norm.event === 'posttool') return postToolUse(parsed, { env });
  if (norm.event === 'stop') return onStop(parsed, { env });
  return runFromStdin(raw, env);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const subcmd = argv[0];
  if (subcmd === 'status') {
    printStatus(process.cwd(), env);
    return;
  }
  if (subcmd === 'doctor') {
    printDoctor(process.cwd(), env);
    return;
  }
  const raw = await readStdin();
  const result = dispatchGeminiHook(raw, env);
  process.stdout.write(JSON.stringify(result));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}

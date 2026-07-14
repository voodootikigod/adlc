#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadTicketStoreReadOnly } from './generated-ticket-reader.mjs';

async function stdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function stateContext(root) {
  const current = readJson(join(root, '.adlc/current-ticket.json'));
  if (!current) return null;
  const id = current.id ?? current.ticket ?? current.ticketId;
  if (!id) return 'ADLC is initialized, but current-ticket.json has no ticket id.';
  const snapshot = loadTicketStoreReadOnly({ root, env: process.env });
  const ticket = snapshot.tickets.find((candidate) => candidate.id === id);
  if (!ticket) return `ADLC current ticket ${id} is not present in the ticket store.`;
  const rails = ticket.rails ?? [];
  const status = ticket.completed === true ? 'completed' : rails.length > 0 ? 'rail protection auto-active' : 'no rails declared';
  return `ADLC current ticket: ${id} — ${ticket.title}. Status: ${status}. Scope: ${(ticket.scope ?? []).join(', ') || '(none)'}. Treat .adlc/manifest.jsonl as gate truth; narration cannot pass a phase.`;
}

function hookOutput(event, context) {
  if (!context) return null;
  if (event === 'SessionStart' || event === 'SubagentStart') {
    return {
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: context,
      },
    };
  }
  return { systemMessage: context };
}

function responseText(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value ?? ''); } catch { return String(value); }
}

function flailOutput(payload, dataRoot) {
  const text = responseText(payload.tool_response ?? payload.toolResponse ?? payload.response ?? payload.result);
  if (!/(?:error|failed|exception|exit code [1-9]|status [1-9])/i.test(text)) return null;
  const signature = createHash('sha256').update(`${payload.tool_name ?? payload.toolName ?? 'tool'}\n${text.slice(0, 1000)}`).digest('hex');
  const statePath = join(dataRoot, 'flail-state.json');
  const previous = readJson(statePath) ?? {};
  const count = previous.signature === signature ? Number(previous.count ?? 0) + 1 : 1;
  mkdirSync(dataRoot, { recursive: true });
  writeFileSync(statePath, `${JSON.stringify({ signature, count }, null, 2)}\n`);
  if (count < 3) return null;
  return { systemMessage: `ADLC flail advisory: the same tool failure has repeated ${count} times. Stop, isolate the cause, and run adlc flail-detector on the relevant log before retrying.` };
}

function verifyOutput(root) {
  if (!existsSync(join(root, '.adlc'))) return null;
  const command = process.env.ADLC_CLI_COMMAND ?? 'adlc';
  const result = spawnSync(command, ['gate-manifest', 'verify', '--json'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status === 0) return null;
  const detail = result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status ?? 1}`;
  return { systemMessage: `ADLC evidence advisory: gate-manifest verification did not pass (${detail}). This warning does not override deterministic phase gates.` };
}

async function main() {
  const mode = process.argv[2] ?? 'context';
  const payload = await stdinJson();
  const root = resolve(payload.cwd ?? process.cwd());
  const event = payload.hook_event_name ?? payload.hookEventName ?? 'SessionStart';
  let output;
  if (mode === 'context') output = hookOutput(event, stateContext(root));
  else if (mode === 'flail') output = flailOutput(payload, process.env.PLUGIN_DATA ?? join(root, '.adlc/.plugin-data'));
  else if (mode === 'verify') output = verifyOutput(root);
  else throw new Error(`unknown lifecycle mode: ${mode}`);
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ systemMessage: `ADLC advisory hook could not complete: ${error.message}` })}\n`);
  process.exitCode = 0;
});

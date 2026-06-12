// CLI conventions shared by every ADLC tool.
// Exit codes: 0 = gate passes, 1 = operational error, 2 = gate fails.

import { parseArgs as nodeParseArgs } from 'node:util';

export function parseArgs(config) {
  return nodeParseArgs({ allowPositionals: true, ...config });
}

/** Gate passes. Optional message, then exit 0. */
export function pass(message) {
  if (message) console.log(message);
  process.exit(0);
}

/** Gate fails. Message + structured details to stderr, exit 2. */
export function gateFail(message, details) {
  console.error(message);
  if (details !== undefined) {
    console.error(typeof details === 'string' ? details : JSON.stringify(details, null, 2));
  }
  process.exit(2);
}

/** Operational error (bad input, missing dependency, network). Exit 1. */
export function opError(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

export function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Standard --prompt-only handling: every LLM-backed tool must support it so
 * the tool works with zero API keys (print the prompt, let the user paste it
 * into any harness). Call with the prompt(s) you would have sent.
 */
export function promptOnly(prompts) {
  const list = Array.isArray(prompts) ? prompts : [prompts];
  for (const [i, p] of list.entries()) {
    if (list.length > 1) console.log(`--- prompt ${i + 1} of ${list.length} ---`);
    console.log(p);
  }
  process.exit(0);
}

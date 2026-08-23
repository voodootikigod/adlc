// CLI conventions shared by every ADLC tool.
// Exit codes: 0 = gate passes, 1 = operational error, 2 = gate fails.

import { basename } from 'node:path';
import { parseArgs as nodeParseArgs } from 'node:util';

function programName() {
  const entry = process.argv[1];
  if (!entry) return 'adlc';
  return basename(entry).replace(/\.[cm]?js$/, '') || 'adlc';
}

/**
 * Fallback usage for a config that declares options but no `usage`. Without it
 * --help reaches node:util parseArgs in strict mode and throws an
 * ERR_PARSE_ARGS_UNKNOWN_OPTION stack trace at the user (issue #107).
 */
function synthesizeUsage(options) {
  const rows = Object.entries(options ?? {}).map(([name, spec]) => {
    const short = spec?.short ? `-${spec.short}, ` : '';
    const value = spec?.type === 'string' ? (spec.multiple ? ' <value...>' : ' <value>') : '';
    const shown = typeof spec?.default === 'string' ? spec.default : JSON.stringify(spec?.default);
    const note = spec?.default === undefined ? '' : `(default: ${shown})`;
    return [`  ${short}--${name}${value}`, note];
  });
  rows.push(['  -h, --help', 'show this help']);

  const width = Math.max(...rows.map(([label]) => label.length));
  const lines = rows.map(([label, note]) => (note ? `${label.padEnd(width + 2)}${note}` : label));
  return `usage: ${programName()} [options]\n\noptions:\n${lines.join('\n')}`;
}

export function parseArgs(config) {
  const args = config?.args ?? process.argv.slice(2);
  const hasHelp = args.includes('--help') || args.includes('-h');
  if (hasHelp) {
    const declaresHelp = config?.options && ('help' in config.options || 'h' in config.options);
    if (!declaresHelp) {
      if (config?.usage) {
        if (typeof config.usage === 'function') {
          config.usage();
        } else {
          console.log(config.usage);
        }
      } else {
        console.log(synthesizeUsage(config?.options));
      }
      process.exit(0);
    }
  }
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

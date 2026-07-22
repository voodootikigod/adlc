#!/usr/bin/env node
import { scaffold } from '../lib/scaffold.mjs';

function usage() {
  console.log(`adlc init [--root <path>] [--json] [--no-codex-agents] [--harness <codex|cursor|copilot>]

Idempotently creates the committable .adlc runtime and optional project-scoped
Codex agents. --harness cursor and --harness copilot each imply --no-codex-agents
and record harnesses.<name> in a fresh config; --harness copilot also scaffolds a
.github/copilot-instructions.md block and a copilot-setup-steps.yml snippet.
Writes are confined to --root; never edits user-global harness configuration
implicitly.`);
}

function parse(argv) {
  const options = { root: '.', json: false, codexAgents: true, harness: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true, ...options };
    if (arg === '--json') options.json = true;
    else if (arg === '--no-codex-agents') options.codexAgents = false;
    else if (arg === '--harness') {
      if (index + 1 >= argv.length) throw new Error('--harness requires a value');
      const value = argv[++index];
      if (value !== 'codex' && value !== 'cursor' && value !== 'copilot') {
        throw new Error(`--harness must be codex, cursor, or copilot (got ${value})`);
      }
      options.harness = value;
      if (value === 'cursor' || value === 'copilot') options.codexAgents = false;
    } else if (arg === '--root') {
      if (index + 1 >= argv.length) throw new Error('--root requires a path');
      options.root = argv[++index];
    } else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

try {
  const options = parse(process.argv.slice(2));
  if (options.help) usage();
  else {
    const result = scaffold(options);
    // Warnings mark a store left in a broken/ambiguous state — never report
    // unqualified success for those, so automation keying off ok/exit notices.
    const ok = result.warnings.length === 0;
    if (options.json) console.log(JSON.stringify({ ok, ...result }, null, 2));
    else {
      console.log(`ADLC initialized at ${result.root}`);
      for (const path of result.created) console.log(`  created ${path}`);
      for (const path of result.updated) console.log(`  updated ${path}`);
      for (const warning of result.warnings) console.warn(`  warning: ${warning}`);
      if (result.created.length === 0 && result.updated.length === 0 && result.warnings.length === 0) console.log('  already current');
    }
    if (!ok) process.exitCode = 1;
  }
} catch (error) {
  console.error(`adlc-init: ${error.message}`);
  process.exitCode = 1;
}

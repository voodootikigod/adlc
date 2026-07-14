#!/usr/bin/env node
import { scaffold } from '../lib/scaffold.mjs';

function usage() {
  console.log(`adlc init [--root <path>] [--json] [--no-codex-agents]

Idempotently creates the committable .adlc runtime and project-scoped Codex agents.
It confines writes to --root and never edits user-global Codex configuration implicitly.`);
}

function parse(argv) {
  const options = { root: '.', json: false, codexAgents: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true, ...options };
    if (arg === '--json') options.json = true;
    else if (arg === '--no-codex-agents') options.codexAgents = false;
    else if (arg === '--root') {
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
    if (options.json) console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    else {
      console.log(`ADLC initialized at ${result.root}`);
      for (const path of result.created) console.log(`  created ${path}`);
      for (const path of result.updated) console.log(`  updated ${path}`);
      if (result.created.length === 0 && result.updated.length === 0) console.log('  already current');
    }
  }
} catch (error) {
  console.error(`adlc-init: ${error.message}`);
  process.exitCode = 1;
}

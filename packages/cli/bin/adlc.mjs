#!/usr/bin/env node
// adlc — umbrella dispatcher for the @adlc suite.
// Thin entry: classify the first arg, then route to a tool or to built-in
// help/version. Everything after the tool name is forwarded untouched.
//
//   adlc <tool> [args...]   run a tool (exit code mirrors the tool: 0/1/2)
//   adlc --help | help      list tools
//   adlc --version          print dispatcher version

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isTool, suggest, TOOLS } from '../lib/registry.mjs';
import { dispatch } from '../lib/dispatch.mjs';
import { renderHelp } from '../lib/help.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function version() {
  try {
    const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const argv = process.argv.slice(2);
const first = argv[0];

// Built-ins. Only a BARE --help/--version is the dispatcher's; once a tool name
// is seen, every following flag (including --help) belongs to the tool.
if (!first || first === '--help' || first === '-h' || first === 'help') {
  console.log(renderHelp(version()));
  process.exit(0);
}
if (first === '--version' || first === '-v') {
  console.log(version());
  process.exit(0);
}

if (!isTool(first)) {
  console.error(`error: unknown tool: ${first}`);
  const hint = suggest(first);
  if (hint) console.error(`did you mean "${hint}"?`);
  console.error(`run "adlc --help" for the list of ${TOOLS.length} tools.`);
  process.exit(1);
}

const { code, error } = dispatch(first, argv.slice(1));
if (error) console.error(`error: ${error}`);
process.exit(code);

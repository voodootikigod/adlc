#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatch, dispatchRunner } from '../lib/dispatch.mjs';
import { renderHelp } from '../lib/help.mjs';
import { isTool, suggest, TOOLS } from '../lib/registry.mjs';

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

if (!first || first === '--help' || first === '-h' || first === 'help') {
  console.log(renderHelp(version()));
  process.exit(0);
}

if (first === '--version' || first === '-v') {
  console.log(version());
  process.exit(0);
}

if (first === 'run' || first === 'accept') {
  const { code, error } = dispatchRunner(argv);
  if (error) console.error(`error: ${error}`);
  process.exit(code);
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

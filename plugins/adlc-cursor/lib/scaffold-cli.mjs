#!/usr/bin/env node
// scaffold-cli.mjs — CLI wrapper around scaffold.mjs. Invoked by /adlc-init to
// bootstrap the Cursor integration into the target repo:
//
//   node lib/scaffold-cli.mjs <project-root>
//
// Idempotent; prints a human summary of what was created vs already present.

import { resolve } from 'node:path';
import { scaffold } from './scaffold.mjs';

const projectRoot = resolve(process.argv[2] ?? '.');
const { config, hooks, rule } = scaffold(projectRoot);

const tag = (r) => (r.created ? 'created' : 'present');
console.log(`adlc-cursor scaffold (${projectRoot}):`);
console.log(`  .adlc/config.json     — ${tag(config)}`);
console.log(`  .cursor/hooks.json    — ${hooks.created ? 'created' : 'merged'} (rails-guard + audit wired)`);
console.log(`  .cursor/rules/adlc.mdc — ${tag(rule)}`);
console.log('Next: author a ticket in .adlc/tickets.json, then `adlc rails-guard` to freeze rails.');

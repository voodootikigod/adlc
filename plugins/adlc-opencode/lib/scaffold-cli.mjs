#!/usr/bin/env node
// scaffold-cli.mjs — thin CLI wrapper around scaffold() for /adlc-init.
// Usage: node lib/scaffold-cli.mjs [projectRoot]
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scaffold } from './scaffold.mjs';

const projectRoot = process.argv[2] ? join(process.cwd(), process.argv[2]) : process.cwd();
const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url))); // plugins/adlc-opencode

const { config, plugin, commands, agents, skills } = scaffold(projectRoot, pkgRoot);
console.log(`adlc-init: config.json ${config.created ? 'created' : 'present'}`);
console.log(`adlc-init: plugin ${plugin.alreadyPresent ? 'already registered' : 'registered'} in .opencode/opencode.json (rails-guard hook will load)`);
console.log(`adlc-init: deployed ${commands.length} command(s) → .opencode/commands/`);
console.log(`adlc-init: deployed ${agents.length} agent(s) → .opencode/agents/`);
console.log(`adlc-init: deployed ${skills.length} skill(s) → .opencode/skill/`);

#!/usr/bin/env node
// Thin entry → scripts/cursor-deny-proof/run.mjs
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = join(dirname(fileURLToPath(import.meta.url)), 'cursor-deny-proof', 'run.mjs');
const res = spawnSync(process.execPath, [run, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(res.status ?? 1);

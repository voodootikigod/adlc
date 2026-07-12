#!/usr/bin/env node
// End-to-end smoke for @adlc/fleet (T43 AC6). Operates ENTIRELY inside a
// disposable scratch git repo it creates and cleans up — it NEVER touches the
// host repo. Two modes:
//   - default: precondition + wiring check. Seeds a throwaway ticket in a scratch
//     repo and runs `fleet run --dry-run` there, proving the CLI + plan + config
//     load end-to-end on a real repo layout. Exits 0.
//   - FLEET_SMOKE_LIVE=1: additionally runs a REAL `fleet run` (real sandbox +
//     real claude worker) on the throwaway ticket and asserts it merges on the
//     integration branch. This is the heavy, manual path.
//
// When a required precondition (sandbox backend / `claude`) is absent, it prints
// a loud "SKIPPED: <reason>" and exits 0 so CI is never bricked.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { detectBackend } from '../packages/fleet/lib/sandbox.mjs';

const FLEET_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'fleet', 'bin', 'fleet.mjs');
const LIVE = process.env.FLEET_SMOKE_LIVE === '1';

function has(cmd) { try { execFileSync('command', ['-v', cmd], { stdio: 'ignore', shell: '/bin/sh' }); return true; } catch { return false; } }
function skip(reason) { console.log(`SKIPPED: ${reason}`); process.exit(0); }

// ---- preconditions ----
const backend = detectBackend();
if (!backend) skip('no OS sandbox backend (bwrap/sandbox-exec) — cannot run a contained fleet worker');
if (LIVE && !has('claude')) skip('FLEET_SMOKE_LIVE set but `claude` is not on PATH');

// ---- build a disposable scratch repo ----
const scratch = mkdtempSync(join(tmpdir(), 'fleet-smoke-'));
function git(...args) { return execFileSync('git', args, { cwd: scratch, encoding: 'utf8' }).trim(); }

let ok = false;
try {
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'smoke@fleet.test');
  git('config', 'user.name', 'fleet-smoke');
  writeFileSync(join(scratch, 'README.md'), '# fleet smoke scratch repo\n');
  git('add', '.'); git('commit', '-q', '-m', 'init');

  mkdirSync(join(scratch, '.adlc'), { recursive: true });
  const ticket = {
    id: 'SMOKE1',
    title: 'Create fleet-smoke.txt containing OK',
    body: 'Create a file named fleet-smoke.txt at the repo root whose only content is the word OK. Nothing else.',
    scope: ['fleet-smoke.txt'],
    rails: [],
    edges: [],
  };
  writeFileSync(join(scratch, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [ticket] }, null, 2));
  writeFileSync(join(scratch, '.adlc', 'config.json'), JSON.stringify({
    fleet: { gate: { test: 'test -f fleet-smoke.txt' }, concurrency: 1, base: 'main' },
  }, null, 2));
  git('add', '.'); git('commit', '-q', '-m', 'seed smoke ticket');

  // ---- wiring check: dry-run against the real scratch repo ----
  const dry = spawnSync('node', [FLEET_BIN, 'run', '--dry-run', '--json'], { cwd: scratch, encoding: 'utf8' });
  if (dry.status !== 0) throw new Error(`dry-run exited ${dry.status}: ${dry.stderr}`);
  const plan = JSON.parse(dry.stdout);
  if (!plan.readyNow.includes('SMOKE1')) throw new Error(`dry-run did not surface the smoke ticket: ${dry.stdout}`);
  console.log('✓ wiring check: fleet CLI + plan + config load end-to-end on a real scratch repo; SMOKE1 is ready.');

  if (LIVE) {
    // ---- REAL end-to-end run (heavy; needs claude + a review provider) ----
    console.log('FLEET_SMOKE_LIVE=1 → running a REAL fleet run (real sandbox + claude worker)…');
    const run = spawnSync('node', [FLEET_BIN, 'run', '--concurrency', '1'], {
      cwd: scratch, encoding: 'utf8', stdio: 'inherit', timeout: 20 * 60000,
    });
    if (run.status !== 0 && run.status !== 2) throw new Error(`live fleet run exited ${run.status}`);
    // Assert the smoke ticket merged on the integration branch.
    const branches = git('branch', '--list', 'fleet/run-*');
    const ib = branches.split('\n').map((b) => b.replace('*', '').trim()).filter(Boolean).pop();
    if (!ib) throw new Error('no integration branch was created');
    git('checkout', '-q', ib);
    if (!existsSync(join(scratch, 'fleet-smoke.txt'))) throw new Error(`fleet-smoke.txt was not produced on ${ib}`);
    console.log(`✓ REAL run merged SMOKE1 on ${ib}; fleet-smoke.txt present.`);
  } else {
    console.log('(set FLEET_SMOKE_LIVE=1 to also run the real dispatch→gate→prosecute→merge end-to-end.)');
  }
  ok = true;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(ok ? 'fleet-live-smoke: PASS' : 'fleet-live-smoke: FAILED');
process.exit(ok ? 0 : 1);

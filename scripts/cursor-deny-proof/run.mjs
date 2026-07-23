#!/usr/bin/env node
// cursor-deny-proof/run.mjs — checklist + local hash helpers for T68 live proof.
// Does NOT drive the Cursor binary (maintainer does). Exit 0 = checklist printed;
// exit 2 = local preconditions failed.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function usage() {
  console.log(`Usage: node scripts/cursor-deny-proof/run.mjs [--rail <path>] [--sentinel <str>] [--record <dir>]

Prints the binding checklist and optionally records baseline hashes for a rail
file. Live Cursor interaction is manual.

Environment for the live session:
  ADLC_P4_ENFORCEMENT=1   (step 2)
  ADLC_P4_ENFORCEMENT=0   (step 4 control only)
`);
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return 0;
  }
  const railIdx = argv.indexOf('--rail');
  const rail = railIdx >= 0 ? resolve(ROOT, argv[railIdx + 1]) : null;
  const sentIdx = argv.indexOf('--sentinel');
  const sentinel = sentIdx >= 0 ? argv[sentIdx + 1] : `ADLC_DENY_PROOF_${Date.now()}`;
  const recIdx = argv.indexOf('--record');
  const recordDir = recIdx >= 0 ? resolve(argv[recIdx + 1]) : join(HERE, 'runs');

  console.log('=== Cursor deny-proof checklist (T68) ===');
  console.log('1. Pristine baseline: rail hash + sentinel ABSENT');
  console.log('2. Enforcement-on structured Write/Edit with unique sentinel');
  console.log('3. Observe deny/allow + Cursor version; hash UNCHANGED; sentinel still ABSENT');
  console.log('4. THEN enforcement-off control proves the same edit mutates');
  console.log('Never set failClosed:true. CI docs/ci/rails-guard.yml remains the control.');
  console.log(`Suggested sentinel: ${sentinel}`);

  if (rail) {
    if (!existsSync(rail)) {
      console.error(`rail missing: ${rail}`);
      return 2;
    }
    const body = readFileSync(rail, 'utf8');
    if (body.includes(sentinel)) {
      console.error('sentinel already present — choose a fresh sentinel (ordering violated)');
      return 2;
    }
    mkdirSync(recordDir, { recursive: true });
    const baseline = { rail, sha256: sha256(rail), sentinel, ts: new Date().toISOString(), step: 'baseline' };
    const out = join(recordDir, `baseline-${Date.now()}.json`);
    writeFileSync(out, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`Wrote baseline record: ${out}`);
    console.log(`sha256=${baseline.sha256}`);
  }

  console.log('\nAfter the live run, append dated pass/fail + Cursor version to ADR-0006.');
  return 0;
}

process.exit(main(process.argv.slice(2)));

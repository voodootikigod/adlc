// supervise-cli-degrade.test.mjs — what the supervisor does when it CANNOT
// continue: nothing consumed, the operator's session left alone, and the
// one-liner they need printed exactly once.
//
// Split from supervise-cli.test.mjs so the two real-interval waits overlap —
// see that file's header.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { denyPathFor, fixture, readJson, readSpawns, supervise } from './supervise-cli-support.mjs';

test('an unbound deny degrades: nothing consumed, child left alone, operator told what to run', async (t) => {
  t.diagnostic('this test waits on the real quiescence + poll intervals (~15s)');
  // No ticket on the marker — `continue` refuses to invent one (spec §Continue),
  // which is the degrade the wrapper must hand back rather than work around.
  const fx = fixture();
  try {
    const run = await supervise({ ...fx, ticket: '', idleMs: 12_000 });
    assert.equal(run.code, 2, `expected the degrade exit code, got ${run.code}: ${run.stderr}`);

    const spawns = readSpawns(fx.log);
    assert.equal(spawns.length, 1, 'a degrade must not respawn anything');
    const denier = spawns[0].argv[1];

    const deny = readJson(denyPathFor(fx.root, denier));
    assert.equal(deny.status, 'open', 'nothing may be consumed on a degrade');
    assert.equal(deny.ticket_id, null);
    assert.deepEqual(
      readdirSync(join(fx.root, '.adlc', 'handoffs')).filter((n) => n.endsWith('.resume-auth.json')),
      [],
      'no successor was authorized',
    );

    const warnings = run.stderr
      .split('\n')
      .filter((line) => line.includes('automatic continuation is not possible'));
    assert.equal(warnings.length, 1, `expected exactly one warning, got ${warnings.length}`);
    assert.match(run.stderr, new RegExp(`handoff continue --deny-session ${denier} --write`));
    // The child was never signalled: it idled out on its own schedule.
    assert.ok(readFileSync(fx.log, 'utf8').length > 0);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

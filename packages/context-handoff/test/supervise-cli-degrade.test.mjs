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

import {
  denyPathFor,
  documentedCodeFor,
  fixture,
  helpText,
  readJson,
  readSpawns,
  supervise,
} from './supervise-cli-support.mjs';

test('an unbound deny degrades: nothing consumed, child left alone, operator told what to run', async (t) => {
  t.diagnostic('this test waits on the real quiescence + poll intervals (~15s)');
  // No ticket on the marker — `continue` refuses to invent one (spec §Continue),
  // which is the degrade the wrapper must hand back rather than work around.
  const fx = fixture();
  try {
    const run = await supervise({ ...fx, ticket: '', idleMs: 12_000 });
    assert.equal(run.code, 2, `expected the degrade exit code, got ${run.code}: ${run.stderr}`);
    // Compared against what the help PROMISES, not against a second copy of the
    // number: a degrade is the outcome an operator most needs to script around.
    assert.equal(documentedCodeFor(helpText(fx.root), 'continuation degraded'), run.code);

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

    // This child is still alive when the degrade prints (it idles past the
    // quiescence gate), so the message must say so — the live half of the
    // conditioned claim, whose dead half is covered in supervise-loop.test.mjs.
    assert.match(run.stderr, /still running and still denied/);
    assert.doesNotMatch(run.stderr, /already ended|already exited/);

    // "A degrade never kills the operator's session" — asserted here against
    // the child's REAL exit rather than against a stub's signal log. This child
    // was alive throughout, so it must have ended on its own terms: a
    // supervisor that terminated it would show {code:null, signal:'SIGTERM'}.
    const payload = JSON.parse(run.stdout);
    assert.deepEqual(
      payload.childExit,
      { code: 0, signal: null, error: null },
      'the degraded session must exit on its own, never by a signal from the supervisor',
    );
    assert.equal(payload.reason, 'degraded');
    assert.deepEqual(payload.abnormalExits, [], 'a clean self-exit is not a crash');
    // The child was never signalled: it idled out on its own schedule.
    assert.ok(readFileSync(fx.log, 'utf8').length > 0);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

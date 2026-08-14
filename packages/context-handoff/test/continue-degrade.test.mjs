// continue-degrade.test.mjs — frozen contract 19: "continue on unbound deny
// exits 2 and consumes nothing", plus the rest of the spec's degrade list
// (consumed deny, missing/corrupt --capture-from). Exit 2 with nothing
// consumed is the whole point: a degrade must never be a half-open door.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  KEYED,
  contentPathFor,
  denyPathFor,
  finalPathFor,
  manifestEntries,
  readJson,
  resumeAuthFiles,
  resumeAuthPathFor,
  run,
  seedBoundDeny,
  seedUnboundDeny,
  transcript,
  withTempRepo,
} from './continue-cli-support.mjs';

/** Nothing this run could have touched may have moved. */
function assertUntouched(cwd, session, before) {
  assert.deepEqual(readJson(denyPathFor(cwd, session)), before.deny, 'the deny must not move');
  assert.equal(readJson(denyPathFor(cwd, session)).status, 'open');
  assert.deepEqual(readJson(finalPathFor(cwd, session)), before.final, 'the final must not move');
  assert.equal(existsSync(contentPathFor(cwd, session)), false, 'no capture may survive a degrade');
  assert.deepEqual(resumeAuthFiles(cwd), [], 'a degrade authorizes nobody');
  assert.equal(manifestEntries(cwd, 'context-handoff-continue').length, 0);
}

function snapshot(cwd, session) {
  return { deny: readJson(denyPathFor(cwd, session)), final: readJson(finalPathFor(cwd, session)) };
}

test('an unbound deny degrades with the repair one-liner and consumes nothing', () => {
  withTempRepo((cwd) => {
    seedUnboundDeny(cwd, 'denier-u');
    const before = snapshot(cwd, 'denier-u');
    assert.equal(before.deny.ticket_id, null);

    const r = run(['continue', '--deny-session', 'denier-u', '--write', '--json'], {
      cwd,
      env: KEYED,
      expectOk: false,
    });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unbound/);
    // Binding is host repair's job; the message must say exactly how.
    assert.match(
      r.stderr,
      /adlc handoff repair --session denier-u --ticket <id> --content-hash <hash> --write/,
    );
    assertUntouched(cwd, 'denier-u', before);
  });
});

test('an unbound deny degrades even when an active ticket pointer names one', () => {
  withTempRepo((cwd) => {
    seedUnboundDeny(cwd, 'denier-up');
    writeFileSync(
      join(cwd, '.adlc', 'current-ticket.json'),
      JSON.stringify({ id: 'T155', ticketHash: 'f'.repeat(64) }),
      'utf8',
    );
    const before = snapshot(cwd, 'denier-up');

    const r = run(['continue', '--deny-session', 'denier-up', '--write', '--json'], {
      cwd,
      env: KEYED,
      expectOk: false,
    });
    assert.equal(r.code, 2);
    assertUntouched(cwd, 'denier-up', before);
  });
});

test('an explicit --ticket cannot bind an unbound deny either', () => {
  withTempRepo((cwd) => {
    seedUnboundDeny(cwd, 'denier-uf');
    const before = snapshot(cwd, 'denier-uf');

    const r = run(['continue', '--deny-session', 'denier-uf', '--ticket', 'T155', '--write', '--json'], {
      cwd,
      env: KEYED,
      expectOk: false,
    });
    assert.equal(r.code, 2);
    assertUntouched(cwd, 'denier-uf', before);
  });
});

test('a consumed deny degrades — a continuation happens once', () => {
  withTempRepo((cwd) => {
    seedBoundDeny(cwd, 'denier-c', 'T155');
    run(['continue', '--deny-session', 'denier-c', '--session', 'successor-c', '--write', '--json'], {
      cwd,
      env: KEYED,
    });
    const after = readJson(denyPathFor(cwd, 'denier-c'));
    assert.equal(after.status, 'consumed');

    const second = run(
      ['continue', '--deny-session', 'denier-c', '--session', 'successor-c2', '--write', '--json'],
      { cwd, env: KEYED, expectOk: false },
    );
    assert.equal(second.code, 2);
    assert.match(second.stderr, /consumed/);
    assert.deepEqual(readJson(denyPathFor(cwd, 'denier-c')), after);
    assert.deepEqual(resumeAuthFiles(cwd), ['successor-c.resume-auth.json']);
    assert.equal(manifestEntries(cwd, 'context-handoff-continue').length, 1);
  });
});

test('a missing deny marker degrades rather than arming one', () => {
  withTempRepo((cwd) => {
    const r = run(['continue', '--deny-session', 'no-such-session', '--write', '--json'], {
      cwd,
      env: KEYED,
      expectOk: false,
    });
    assert.equal(r.code, 2);
    assert.equal(existsSync(join(cwd, '.adlc', 'handoffs', 'denies', 'no-such-session.json')), false);
    assert.equal(existsSync(contentPathFor(cwd, 'no-such-session')), false);
  });
});

test('a missing --capture-from source degrades before anything is written', () => {
  withTempRepo((cwd) => {
    seedBoundDeny(cwd, 'denier-m', 'T155');
    const before = snapshot(cwd, 'denier-m');

    const r = run(
      ['continue', '--deny-session', 'denier-m', '--capture-from', 'absent.jsonl', '--write', '--json'],
      { cwd, env: KEYED, expectOk: false },
    );
    assert.equal(r.code, 2);
    assert.match(r.stderr, /capture-from/);
    assertUntouched(cwd, 'denier-m', before);
  });
});

test('a corrupt --capture-from source degrades rather than capturing a blank narrative', () => {
  withTempRepo((cwd) => {
    seedBoundDeny(cwd, 'denier-x', 'T155');
    const before = snapshot(cwd, 'denier-x');
    writeFileSync(join(cwd, 'corrupt.jsonl'), 'not json at all\nstill not json\n', 'utf8');

    const r = run(
      ['continue', '--deny-session', 'denier-x', '--capture-from', 'corrupt.jsonl', '--write', '--json'],
      { cwd, env: KEYED, expectOk: false },
    );
    assert.equal(r.code, 2);
    assert.match(r.stderr, /no parseable transcript lines/);
    assertUntouched(cwd, 'denier-x', before);
  });
});

test('a --capture-from that is a directory degrades instead of hanging or throwing', () => {
  withTempRepo((cwd) => {
    seedBoundDeny(cwd, 'denier-dir', 'T155');
    const before = snapshot(cwd, 'denier-dir');
    const r = run(['continue', '--deny-session', 'denier-dir', '--capture-from', '.', '--write', '--json'], {
      cwd,
      env: KEYED,
      expectOk: false,
    });
    assert.equal(r.code, 2);
    assertUntouched(cwd, 'denier-dir', before);
  });
});

test('an active ticket that disagrees with the deny bind fails closed', () => {
  withTempRepo((cwd) => {
    seedBoundDeny(cwd, 'denier-conf', 'T155');
    const before = snapshot(cwd, 'denier-conf');
    writeFileSync(
      join(cwd, '.adlc', 'current-ticket.json'),
      JSON.stringify({ id: 'T900', ticketHash: 'a'.repeat(64) }),
      'utf8',
    );

    const r = run(['continue', '--deny-session', 'denier-conf', '--write', '--json'], {
      cwd,
      env: KEYED,
      expectOk: false,
    });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /T900/);
    assertUntouched(cwd, 'denier-conf', before);

    // Naming the deny's own ticket resolves the ambiguity the operator created.
    const ok = run(['continue', '--deny-session', 'denier-conf', '--ticket', 'T155', '--write', '--json'], {
      cwd,
      env: KEYED,
    });
    assert.equal(ok.code, 0);
    assert.equal(readJson(denyPathFor(cwd, 'denier-conf')).status, 'consumed');
  });
});

test('a malformed active-ticket pointer fails closed rather than being ignored', () => {
  withTempRepo((cwd) => {
    seedBoundDeny(cwd, 'denier-ptr', 'T155');
    const before = snapshot(cwd, 'denier-ptr');
    writeFileSync(join(cwd, '.adlc', 'current-ticket.json'), '{"no-id-key":true}', 'utf8');

    const r = run(['continue', '--deny-session', 'denier-ptr', '--write', '--json'], {
      cwd,
      env: KEYED,
      expectOk: false,
    });
    assert.equal(r.code, 2);
    assertUntouched(cwd, 'denier-ptr', before);
  });
});

test('a successor that already holds a resume-auth is refused, not overwritten', () => {
  withTempRepo((cwd) => {
    // `successor-taken` was authorized by an earlier continuation of its own.
    seedBoundDeny(cwd, 'denier-first', 'T155');
    run(['continue', '--deny-session', 'denier-first', '--session', 'successor-taken', '--write', '--json'], {
      cwd,
      env: KEYED,
    });
    const heldAuth = readFileSync(resumeAuthPathFor(cwd, 'successor-taken'), 'utf8');

    seedBoundDeny(cwd, 'denier-second', 'T155');
    const before = snapshot(cwd, 'denier-second');
    const r = run(
      ['continue', '--deny-session', 'denier-second', '--session', 'successor-taken', '--write', '--json'],
      { cwd, env: KEYED, expectOk: false },
    );
    assert.equal(r.code, 2);
    assert.match(r.stderr, /already holds a resume-auth/);

    // The prior authorization is the thing at risk here: overwriting it would
    // rebind it to another deny, and this run's rollback would delete it.
    assert.equal(readFileSync(resumeAuthPathFor(cwd, 'successor-taken'), 'utf8'), heldAuth);
    assert.deepEqual(readJson(denyPathFor(cwd, 'denier-second')), before.deny);
    assert.equal(readJson(denyPathFor(cwd, 'denier-second')).status, 'open');
    assert.equal(existsSync(contentPathFor(cwd, 'denier-second')), false);
    assert.equal(manifestEntries(cwd, 'context-handoff-continue').length, 1);
  });
});

test('a dry run reports the successor collision instead of promising a run that would fail', () => {
  withTempRepo((cwd) => {
    seedBoundDeny(cwd, 'denier-dry', 'T155');
    run(['continue', '--deny-session', 'denier-dry', '--session', 'successor-dry', '--write', '--json'], {
      cwd,
      env: KEYED,
    });
    seedBoundDeny(cwd, 'denier-dry2', 'T155');

    const r = run(
      ['continue', '--deny-session', 'denier-dry2', '--session', 'successor-dry', '--json'],
      { cwd, env: KEYED, expectOk: false },
    );
    assert.equal(r.code, 2);
    assert.match(r.stderr, /already holds a resume-auth/);
  });
});

test('the successor may not be the denied session — D2 is sticky', () => {
  withTempRepo((cwd) => {
    seedBoundDeny(cwd, 'denier-self', 'T155');
    const before = snapshot(cwd, 'denier-self');

    const r = run(
      ['continue', '--deny-session', 'denier-self', '--session', 'denier-self', '--write', '--json'],
      { cwd, env: KEYED, expectOk: false },
    );
    assert.equal(r.code, 2);
    assertUntouched(cwd, 'denier-self', before);
  });
});

test('an unsafe session id is refused before any work', () => {
  withTempRepo((cwd) => {
    seedBoundDeny(cwd, 'denier-safe', 'T155');
    transcript(cwd);
    for (const bad of ['../escape', 'has/slash', '']) {
      const r = run(['continue', '--deny-session', 'denier-safe', '--session', bad, '--write', '--json'], {
        cwd,
        env: KEYED,
        expectOk: false,
      });
      assert.equal(r.code, 1, `${JSON.stringify(bad)} must be refused`);
    }
    assert.equal(readJson(denyPathFor(cwd, 'denier-safe')).status, 'open');
    assert.deepEqual(resumeAuthFiles(cwd), []);
  });
});

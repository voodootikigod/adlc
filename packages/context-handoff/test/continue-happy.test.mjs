// continue-happy.test.mjs — frozen contract 18: "continue happy path consumes
// exactly the minted successor and emits the payload" (spec §Continue,
// §Supervised-only auto-consume).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { hashCaptureBody } from '../lib/capture.mjs';
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
  transcript,
  withTempRepo,
} from './continue-cli-support.mjs';

/** The payload a host supervisor parses. Adding a key here is a contract change. */
const PAYLOAD_KEYS = [
  'tool',
  'command',
  'dryRun',
  'successor_session_id',
  'ticket_id',
  'content_path',
  'content_hash',
  'bootstrap_prompt',
  'evidence',
];

test('continue --write captures, binds, and consumes for exactly one successor', () => {
  withTempRepo((cwd) => {
    seedBoundDeny(cwd, 'denier-1', 'T155');
    transcript(cwd);

    const r = run(
      ['continue', '--deny-session', 'denier-1', '--capture-from', 'transcript.jsonl', '--write', '--json'],
      { cwd, env: KEYED },
    );
    assert.equal(r.code, 0);
    const payload = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(payload).sort(), [...PAYLOAD_KEYS].sort());
    assert.equal(payload.dryRun, false);
    assert.equal(payload.ticket_id, 'T155');
    assert.equal(payload.content_path, contentPathFor(cwd, 'denier-1'));
    assert.ok(payload.successor_session_id.length > 0);
    assert.notEqual(payload.successor_session_id, 'denier-1');

    // The capture is on disk and is what the payload hash names.
    const body = readFileSync(payload.content_path, 'utf8');
    assert.equal(hashCaptureBody(body), payload.content_hash);
    assert.match(body, /## Ticket/);
    assert.match(body, /Next: fix the rollback path\./, 'the model narrative must reach the capture');

    // Final and marker agree on that hash, and the deny is consumed by the
    // minted successor — nobody else.
    assert.equal(readJson(finalPathFor(cwd, 'denier-1')).content_hash, payload.content_hash);
    const deny = readJson(denyPathFor(cwd, 'denier-1'));
    assert.equal(deny.status, 'consumed');
    assert.equal(deny.ticket_id, 'T155');
    assert.equal(deny.content_hash, payload.content_hash);
    assert.equal(deny.consumed_by, payload.successor_session_id);

    // Supervised-only auto-consume: one deny mints exactly one authorization.
    assert.deepEqual(resumeAuthFiles(cwd), [`${payload.successor_session_id}.resume-auth.json`]);
    const auth = readJson(resumeAuthPathFor(cwd, payload.successor_session_id));
    assert.equal(auth.deny_session_id, 'denier-1');
    assert.equal(auth.content_hash, payload.content_hash);
    assert.equal(auth.ticket_id, 'T155');

    const evidence = manifestEntries(cwd, 'context-handoff-continue');
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].ticket, 'T155');
    assert.deepEqual(evidence[0].data, {
      deny_session_id: 'denier-1',
      successor_session_id: payload.successor_session_id,
      content_hash: payload.content_hash,
      outcome: 'authorized',
    });
    assert.equal(payload.evidence.seq, evidence[0].seq);
  });
});

test('the bootstrap prompt names the session, the ticket, and carries the capture', () => {
  withTempRepo((cwd) => {
    seedBoundDeny(cwd, 'denier-p', 'T155');
    transcript(cwd);
    const payload = JSON.parse(
      run(['continue', '--deny-session', 'denier-p', '--capture-from', 'transcript.jsonl', '--write', '--json'], {
        cwd,
        env: KEYED,
      }).stdout,
    );
    const body = readFileSync(payload.content_path, 'utf8');
    assert.equal(
      payload.bootstrap_prompt,
      `Continuation of session denier-p under ticket T155. A context-rot handoff was captured; ` +
        `read it, verify against repo state, and continue the work.\n\n${body}`,
    );
  });
});

test('a supplied --session is used verbatim as the successor', () => {
  withTempRepo((cwd) => {
    seedBoundDeny(cwd, 'denier-s', 'T155');
    const payload = JSON.parse(
      run(['continue', '--deny-session', 'denier-s', '--session', 'successor-9', '--write', '--json'], {
        cwd,
        env: KEYED,
      }).stdout,
    );
    assert.equal(payload.successor_session_id, 'successor-9');
    assert.equal(readJson(denyPathFor(cwd, 'denier-s')).consumed_by, 'successor-9');
    assert.deepEqual(resumeAuthFiles(cwd), ['successor-9.resume-auth.json']);
  });
});

test('an unrelated fresh session gains nothing from the continuation', () => {
  withTempRepo((cwd) => {
    seedBoundDeny(cwd, 'denier-o', 'T155');
    run(['continue', '--deny-session', 'denier-o', '--session', 'successor-o', '--write', '--json'], {
      cwd,
      env: KEYED,
    });

    // The deny is spent: a second session cannot consume it, and holds no auth.
    const other = run(
      ['resume', '--session', 'bystander', '--deny-session', 'denier-o', '--write', '--json'],
      { cwd, env: KEYED, expectOk: false },
    );
    assert.notEqual(other.code, 0);
    assert.equal(existsSync(resumeAuthPathFor(cwd, 'bystander')), false);
    assert.deepEqual(resumeAuthFiles(cwd), ['successor-o.resume-auth.json']);
  });
});

test('continue works without a transcript — the deterministic brief stands alone', () => {
  withTempRepo((cwd) => {
    seedBoundDeny(cwd, 'denier-n', 'T155');
    const payload = JSON.parse(
      run(['continue', '--deny-session', 'denier-n', '--write', '--json'], { cwd, env: KEYED }).stdout,
    );
    const body = readFileSync(payload.content_path, 'utf8');
    assert.match(body, /## Model handoff\n\n_none_/);
    assert.match(body, /## Evidence/);
    assert.equal(hashCaptureBody(body), payload.content_hash);
    assert.equal(readJson(denyPathFor(cwd, 'denier-n')).status, 'consumed');
  });
});

test('a readable transcript that ends on a tool call is not a degrade', () => {
  withTempRepo((cwd) => {
    seedBoundDeny(cwd, 'denier-t', 'T155');
    const path = join(cwd, 'tool-only.jsonl');
    writeFileSync(
      path,
      JSON.stringify({
        type: 'assistant',
        requestId: 'req_1',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] },
      }),
      'utf8',
    );
    const r = run(
      ['continue', '--deny-session', 'denier-t', '--capture-from', 'tool-only.jsonl', '--write', '--json'],
      { cwd, env: KEYED },
    );
    assert.equal(r.code, 0);
    assert.match(readFileSync(JSON.parse(r.stdout).content_path, 'utf8'), /## Model handoff\n\n_none_/);
  });
});

test('continue dry-run is the default and writes nothing', () => {
  withTempRepo((cwd) => {
    seedBoundDeny(cwd, 'denier-d', 'T155');
    transcript(cwd);
    const before = readJson(denyPathFor(cwd, 'denier-d'));

    const r = run(
      ['continue', '--deny-session', 'denier-d', '--capture-from', 'transcript.jsonl', '--json'],
      { cwd, env: KEYED },
    );
    assert.equal(r.code, 0);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.dryRun, true);
    assert.ok(payload.content_hash.length > 0);

    assert.equal(existsSync(contentPathFor(cwd, 'denier-d')), false, 'a dry run must not write the capture');
    assert.equal(existsSync(join(cwd, '.adlc', 'handoffs', 'content')), false);
    assert.deepEqual(readJson(denyPathFor(cwd, 'denier-d')), before);
    assert.deepEqual(resumeAuthFiles(cwd), []);
    assert.equal(manifestEntries(cwd, 'context-handoff-continue').length, 0);

    // …and the dry run predicted the hash the real run then binds.
    const wet = JSON.parse(
      run(['continue', '--deny-session', 'denier-d', '--capture-from', 'transcript.jsonl', '--write', '--json'], {
        cwd,
        env: KEYED,
      }).stdout,
    );
    assert.equal(wet.content_hash, payload.content_hash);
  });
});

test('continue --write without the manifest key refuses before touching anything', () => {
  withTempRepo((cwd) => {
    seedBoundDeny(cwd, 'denier-k', 'T155');
    const before = readJson(denyPathFor(cwd, 'denier-k'));

    const r = run(['continue', '--deny-session', 'denier-k', '--write', '--json'], {
      cwd,
      env: { ADLC_MANIFEST_KEY: '' },
      expectOk: false,
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /ADLC_MANIFEST_KEY/);
    assert.equal(existsSync(contentPathFor(cwd, 'denier-k')), false);
    assert.deepEqual(readJson(denyPathFor(cwd, 'denier-k')), before);
    assert.deepEqual(resumeAuthFiles(cwd), []);
  });
});

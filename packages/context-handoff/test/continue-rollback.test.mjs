// continue-rollback.test.mjs — frozen contract 20: "continue rolls back on
// evidence-append failure: deny stays open, no resume-auth survives".
//
// Un-evidenced state is un-auditable state. A continuation whose manifest entry
// never landed must leave the repo exactly as it found it — otherwise a deny is
// consumed, a successor is authorized, and nothing attests to either.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  KEYED,
  contentPathFor,
  denyPathFor,
  finalPathFor,
  poisonManifest,
  readJson,
  resumeAuthFiles,
  resumeAuthPathFor,
  run,
  seedBoundDeny,
  transcript,
  withTempRepo,
} from './continue-cli-support.mjs';

test('a failed evidence append leaves the deny open and authorizes nobody', () => {
  withTempRepo((cwd) => {
    seedBoundDeny(cwd, 'denier-ev', 'T155');
    transcript(cwd);
    const denyBefore = readJson(denyPathFor(cwd, 'denier-ev'));
    const finalBefore = readJson(finalPathFor(cwd, 'denier-ev'));
    poisonManifest(cwd);

    const r = run(
      [
        'continue',
        '--deny-session',
        'denier-ev',
        '--session',
        'successor-ev',
        '--capture-from',
        'transcript.jsonl',
        '--write',
        '--json',
      ],
      { cwd, env: KEYED, expectOk: false },
    );
    assert.equal(r.code, 1);
    assert.match(r.stderr, /failed to record evidence/);

    assert.deepEqual(readJson(denyPathFor(cwd, 'denier-ev')), denyBefore, 'the deny must stay as it was');
    assert.equal(readJson(denyPathFor(cwd, 'denier-ev')).status, 'open');
    assert.deepEqual(readJson(finalPathFor(cwd, 'denier-ev')), finalBefore, 'the final must be restored');
    assert.deepEqual(resumeAuthFiles(cwd), [], 'no resume-auth may survive');
    assert.equal(
      existsSync(contentPathFor(cwd, 'denier-ev')),
      false,
      'the capture this run created must be gone',
    );
  });
});

test('a rollback restores a capture that already existed instead of deleting it', () => {
  withTempRepo((cwd) => {
    seedBoundDeny(cwd, 'denier-prior', 'T155');
    const path = contentPathFor(cwd, 'denier-prior');
    mkdirSync(dirname(path), { recursive: true });
    const priorBody = '## Ticket\n\n- id: T155\n\nan earlier capture\n';
    writeFileSync(path, priorBody, 'utf8');
    poisonManifest(cwd);

    const r = run(['continue', '--deny-session', 'denier-prior', '--write', '--json'], {
      cwd,
      env: KEYED,
      expectOk: false,
    });
    assert.equal(r.code, 1);
    assert.equal(readFileSync(path, 'utf8'), priorBody, 'the prior capture must come back byte for byte');
    assert.equal(readJson(denyPathFor(cwd, 'denier-prior')).status, 'open');
    assert.deepEqual(resumeAuthFiles(cwd), []);
  });
});

test('the rolled-back deny can still be continued once the ledger is sound', () => {
  withTempRepo((cwd) => {
    seedBoundDeny(cwd, 'denier-retry', 'T155');
    const manifest = `${cwd}/.adlc/manifest.jsonl`;
    const sound = readFileSync(manifest, 'utf8');
    poisonManifest(cwd);

    run(['continue', '--deny-session', 'denier-retry', '--write', '--json'], {
      cwd,
      env: KEYED,
      expectOk: false,
    });
    // A rollback that wedged the deny would be a worse outcome than the failure
    // it was recovering from.
    writeFileSync(manifest, sound, 'utf8');

    const retry = run(
      ['continue', '--deny-session', 'denier-retry', '--session', 'successor-retry', '--write', '--json'],
      { cwd, env: KEYED },
    );
    assert.equal(retry.code, 0);
    assert.equal(readJson(denyPathFor(cwd, 'denier-retry')).consumed_by, 'successor-retry');
    assert.deepEqual(resumeAuthFiles(cwd), ['successor-retry.resume-auth.json']);
  });
});

test('a rollback deletes only the authorization this run minted', () => {
  withTempRepo((cwd) => {
    // An unrelated continuation that already happened: its successor holds a
    // live authorization that has nothing to do with the failing run below.
    seedBoundDeny(cwd, 'denier-other', 'T155');
    run(['continue', '--deny-session', 'denier-other', '--session', 'successor-other', '--write', '--json'], {
      cwd,
      env: KEYED,
    });
    const bystander = resumeAuthPathFor(cwd, 'successor-other');
    const bystanderAuth = readFileSync(bystander, 'utf8');

    seedBoundDeny(cwd, 'denier-fail', 'T155');
    poisonManifest(cwd);
    const r = run(
      ['continue', '--deny-session', 'denier-fail', '--session', 'successor-fail', '--write', '--json'],
      { cwd, env: KEYED, expectOk: false },
    );
    assert.equal(r.code, 1);

    assert.equal(existsSync(resumeAuthPathFor(cwd, 'successor-fail')), false, 'ours is gone');
    assert.equal(readFileSync(bystander, 'utf8'), bystanderAuth, "someone else's is untouched");
    assert.equal(readJson(denyPathFor(cwd, 'denier-other')).status, 'consumed');
    assert.equal(readJson(denyPathFor(cwd, 'denier-fail')).status, 'open');
    // The other continuation's capture must also survive our rollback.
    assert.equal(existsSync(contentPathFor(cwd, 'denier-other')), true);
    assert.equal(existsSync(contentPathFor(cwd, 'denier-fail')), false);
  });
});

test('a live lock on the denier refuses the continuation without consuming', () => {
  withTempRepo((cwd) => {
    seedBoundDeny(cwd, 'denier-lock', 'T155');
    const before = readJson(denyPathFor(cwd, 'denier-lock'));
    // A lock minted on another host: a PID means nothing off the host that
    // issued it, so the continuation must refuse rather than reclaim.
    writeFileSync(
      `${cwd}/.adlc/handoffs/denier-lock.lock`,
      `${JSON.stringify({ schema: 1, session_id: 'denier-lock', pid: process.pid, started_at: new Date().toISOString(), host: 'other-host', nonce: 'held' }, null, 2)}\n`,
      'utf8',
    );

    const r = run(['continue', '--deny-session', 'denier-lock', '--write', '--json'], {
      cwd,
      env: KEYED,
      expectOk: false,
    });
    assert.equal(r.code, 2);
    assert.deepEqual(readJson(denyPathFor(cwd, 'denier-lock')), before);
    assert.equal(existsSync(contentPathFor(cwd, 'denier-lock')), false);
    assert.deepEqual(resumeAuthFiles(cwd), []);
  });
});

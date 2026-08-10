// adapter-core.test.mjs — the harness-agnostic adapter core (slice 5).
//
// Lives outside test/ so it does not match T154's frozen
// `packages/context-handoff/test/**/*.test.mjs` rail glob.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HANDOFF_MUTATING_SUBCOMMANDS,
  resolveHandoffSessionId,
  isProtectedHandoffPath,
  isHandoffMutatingShell,
  denyStoreHot,
  evaluateHandoffPreToolUse,
  ensureDenyMarker,
  writeDenyRecord,
  HANDOFF_DEPTH,
} from '@adlc/context-handoff';

/** Disposable repo root with a .adlc/ directory. */
function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-adapter-core-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- session identity -------------------------------------------------------

test('resolveHandoffSessionId takes the first safe candidate in order', () => {
  assert.equal(
    resolveHandoffSessionId({ candidates: ['sess-a', 'sess-b'] }),
    'sess-a',
  );
  assert.equal(
    resolveHandoffSessionId({ candidates: [undefined, '', 'sess-b'] }),
    'sess-b',
  );
});

test('resolveHandoffSessionId falls back to the transcript stem', () => {
  assert.equal(
    resolveHandoffSessionId({ candidates: [null], transcriptPath: '/tmp/uuid-1.jsonl' }),
    'uuid-1',
  );
});

test('resolveHandoffSessionId never invents an id from unusable input', () => {
  assert.equal(resolveHandoffSessionId(), null);
  assert.equal(resolveHandoffSessionId({}), null);
  assert.equal(resolveHandoffSessionId({ transcriptPath: '' }), null);
  assert.equal(resolveHandoffSessionId({ transcriptPath: 12 }), null);
  // A stem of `..` would escape the denies/ directory — isSafeSessionId rejects it.
  assert.equal(resolveHandoffSessionId({ transcriptPath: '....jsonl' }), null);
});

// --- protected paths --------------------------------------------------------

test('isProtectedHandoffPath covers the deny store, markers and auth artifacts', () => {
  for (const p of [
    '.adlc/.deny-store',
    '.adlc/handoffs/.deny-store',
    '.adlc/handoffs/denies',
    '.adlc/handoffs/denies/sess-a.json',
    '.adlc/handoffs/sess-a.resume-auth.json',
    '.adlc/handoffs/sess-a.model-ok',
    '.adlc/handoffs/sess-a.lock',
    './.adlc/handoffs/denies/sess-a.json',
    '.adlc/handoffs/x/../denies/sess-a.json',
  ]) {
    assert.equal(isProtectedHandoffPath(p), true, `${p} must be protected`);
  }
});

test('isProtectedHandoffPath leaves ordinary paths alone', () => {
  for (const p of [
    '',
    'src/app.mjs',
    '.adlc/tickets.json',
    '.adlc/handoffs/final.md',
    '.adlc/handoffs-other/denies/x.json',
  ]) {
    assert.equal(isProtectedHandoffPath(p), false, `${p} must not be protected`);
  }
  assert.equal(isProtectedHandoffPath(null), false);
});

// --- mutating shell detection ----------------------------------------------

test('isHandoffMutatingShell flags every mutating subcommand', () => {
  for (const sub of HANDOFF_MUTATING_SUBCOMMANDS) {
    assert.equal(
      isHandoffMutatingShell(`adlc handoff ${sub} --write`),
      true,
      `${sub} must be flagged`,
    );
  }
});

test('isHandoffMutatingShell sees through path and subshell spellings', () => {
  assert.equal(isHandoffMutatingShell('echo $(adlc handoff write --write)'), true);
  assert.equal(isHandoffMutatingShell('node ./bin/handoff.mjs repair --ticket T1'), true);
  assert.equal(isHandoffMutatingShell('`adlc handoff unlock`'), true);
});

test('isHandoffMutatingShell leaves read-only and unrelated commands alone', () => {
  assert.equal(isHandoffMutatingShell('adlc handoff show'), false);
  assert.equal(isHandoffMutatingShell('adlc handoff --help'), false);
  assert.equal(isHandoffMutatingShell('ls -la'), false);
  assert.equal(isHandoffMutatingShell(''), false);
  assert.equal(isHandoffMutatingShell(null), false);
});

// --- deny-store hotness -----------------------------------------------------

test('denyStoreHot treats an unreadable or non-empty store as in play', () => {
  assert.equal(denyStoreHot(null), true);
  assert.equal(denyStoreHot({ ok: false }), true);
  assert.equal(denyStoreHot({ denyStoreUnavailable: true }), true);
  assert.equal(denyStoreHot({ records: [{}] }), true);
  assert.equal(denyStoreHot({ invalidRecords: [{}] }), true);
  assert.equal(denyStoreHot({ registeredSessions: ['sess-a'] }), true);
});

test('denyStoreHot treats a cold store as not in play (fail-open)', () => {
  assert.equal(
    denyStoreHot({ records: [], invalidRecords: [], registeredSessions: [] }),
    false,
  );
});

// --- the gate ---------------------------------------------------------------

test('clean repo with no pressure allows a mutation', () => {
  withRepo((root) => {
    const r = evaluateHandoffPreToolUse({
      root,
      sessionId: 'sess-a',
      observed: { depth: 1 },
      host: 'test',
    });
    assert.equal(r.deny, false);
    assert.deepEqual(r.reasons, []);
    assert.equal(r.ensuredMarker, false);
  });
});

test('an open deny for another session blocks an unauthorized caller (D3)', () => {
  withRepo((root) => {
    assert.equal(
      ensureDenyMarker(root, {
        sessionId: 'denier-1',
        ticketId: 'T1',
        contentHash: 'abc',
        host: 'test',
      }).ok,
      true,
    );
    const r = evaluateHandoffPreToolUse({
      root,
      sessionId: 'consumer-1',
      observed: { depth: 1 },
      host: 'test',
    });
    assert.equal(r.deny, true);
    assert.ok(r.reasons.some((x) => x.includes('D3:unauthorized_open:denier-1')), r.reasons.join());
  });
});

test('the denier stays denied after its record is consumed (D2)', () => {
  withRepo((root) => {
    assert.equal(
      ensureDenyMarker(root, {
        sessionId: 'denier-sticky',
        ticketId: 'T1',
        contentHash: 'abc',
        host: 'test',
      }).ok,
      true,
    );
    writeDenyRecord(root, {
      session_id: 'denier-sticky',
      ticket_id: 'T1',
      content_hash: 'abc',
      status: 'consumed',
      since: new Date().toISOString(),
      host: 'test',
      schema: 1,
    });
    const r = evaluateHandoffPreToolUse({
      root,
      sessionId: 'denier-sticky',
      observed: { depth: 1 },
      host: 'test',
    });
    assert.equal(r.deny, true);
    assert.ok(r.reasons.some((x) => x.includes('D2:denier_session')), r.reasons.join());
  });
});

test('the handoff band writes a deny marker for the current session', () => {
  withRepo((root) => {
    const r = evaluateHandoffPreToolUse({
      root,
      sessionId: 'deep-sess',
      observed: { depth: HANDOFF_DEPTH },
      ticketId: 'T1',
      host: 'test',
    });
    assert.equal(r.ensuredMarker, true);
    assert.equal(
      existsSync(join(root, '.adlc', 'handoffs', 'denies', 'deep-sess.json')),
      true,
    );
    assert.equal(r.deny, true);
    assert.ok(r.reasons.some((x) => x.includes('D2:denier_session')), r.reasons.join());
  });
});

test('a shell call under the deny-set fails closed wholesale, mutating or not', () => {
  withRepo((root) => {
    assert.equal(
      ensureDenyMarker(root, {
        sessionId: 'denier-2',
        ticketId: 'T1',
        contentHash: 'abc',
        host: 'test',
      }).ok,
      true,
    );
    const plain = evaluateHandoffPreToolUse({
      root,
      sessionId: 'consumer-2',
      observed: { depth: 1 },
      isBash: true,
      bashCommand: 'ls',
      host: 'test',
    });
    assert.equal(plain.deny, true);
    assert.ok(plain.reasons.includes('bash_fail_closed_under_deny'));
    assert.equal(plain.reasons.includes('bash_handoff_mutating_cli'), false);

    const mutating = evaluateHandoffPreToolUse({
      root,
      sessionId: 'consumer-2',
      observed: { depth: 1 },
      isBash: true,
      bashCommand: 'adlc handoff repair --write',
      host: 'test',
    });
    assert.equal(mutating.deny, true);
    assert.ok(mutating.reasons.includes('bash_handoff_mutating_cli'));
  });
});

test('a shell call with no deny-set is not tagged by the shell rules', () => {
  withRepo((root) => {
    const r = evaluateHandoffPreToolUse({
      root,
      sessionId: 'sess-a',
      observed: { depth: 1 },
      isBash: true,
      bashCommand: 'adlc handoff repair --write',
      host: 'test',
    });
    // The shell fail-closed rule keys off the deny-set, not the command text:
    // an agent may still be denied this by other layers, but not by D1-D3 here.
    assert.equal(r.deny, false);
  });
});

test('writing a protected path is denied even with a cold store', () => {
  withRepo((root) => {
    const r = evaluateHandoffPreToolUse({
      root,
      sessionId: 'sess-a',
      observed: { depth: 1 },
      editRelPaths: ['.adlc/handoffs/denies/sess-a.json'],
      host: 'test',
    });
    assert.equal(r.deny, true);
    assert.ok(r.reasons.some((x) => x.startsWith('path_protected:')), r.reasons.join());
  });
});

test('no usable session id fails closed under pressure, open when clean', () => {
  withRepo((root) => {
    const clean = evaluateHandoffPreToolUse({
      root,
      sessionId: null,
      observed: { depth: 1 },
      host: 'test',
    });
    assert.equal(clean.deny, false, 'a clean repo must stay editable');

    const pressured = evaluateHandoffPreToolUse({
      root,
      sessionId: null,
      observed: { depth: HANDOFF_DEPTH },
      host: 'test',
    });
    assert.equal(pressured.deny, true);
    assert.ok(pressured.reasons.includes('D0:invalid_session_id'));
  });
});

test('no usable session id fails closed once the deny store is hot', () => {
  withRepo((root) => {
    assert.equal(
      ensureDenyMarker(root, {
        sessionId: 'denier-3',
        ticketId: 'T1',
        contentHash: 'abc',
        host: 'test',
      }).ok,
      true,
    );
    const r = evaluateHandoffPreToolUse({
      root,
      sessionId: null,
      observed: { depth: 1 },
      host: 'test',
    });
    assert.equal(r.deny, true);
    assert.ok(r.reasons.includes('D0:invalid_session_id'));
  });
});

test('reasons are de-duplicated', () => {
  withRepo((root) => {
    const r = evaluateHandoffPreToolUse({
      root,
      sessionId: 'sess-a',
      observed: { depth: 1 },
      editRelPaths: [
        '.adlc/handoffs/denies/sess-a.json',
        '.adlc/handoffs/denies/sess-a.json',
      ],
      host: 'test',
    });
    assert.equal(r.reasons.length, 1);
  });
});

test('the marker records the host the adapter reports', () => {
  withRepo((root) => {
    evaluateHandoffPreToolUse({
      root,
      sessionId: 'host-sess',
      observed: { depth: HANDOFF_DEPTH },
      host: 'opencode',
    });
    const marker = join(root, '.adlc', 'handoffs', 'denies', 'host-sess.json');
    assert.equal(existsSync(marker), true);
    assert.match(readFileSync(marker, 'utf8'), /"host": "opencode"/);
  });
});

// adapter-core.test.mjs — the harness-agnostic adapter core (slice 5).
//
// Lives outside test/ so it does not match T154's frozen
// `packages/context-handoff/test/**/*.test.mjs` rail glob.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HANDOFF_MUTATING_SUBCOMMANDS,
  resolveHandoffSessionId,
  isProtectedHandoffPath,
  isHandoffMutatingShell,
  denyStoreHot,
  shellPathCandidates,
  classifyProtectedTarget,
  evaluateHandoffPreToolUse,
  ensureDenyMarker,
  writeDenyRecord,
  writeResumeAuth,
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

// --- signed resume-auth (cross-model review, HIGH/auth) ---------------------

test('a signed resume-auth clears D3 only when the adapter supplies the key', () => {
  withRepo((root) => {
    const key = 'a'.repeat(64);
    assert.equal(
      ensureDenyMarker(root, {
        sessionId: 'denier-auth',
        ticketId: 'T1',
        contentHash: 'hash-1',
        host: 'test',
      }).ok,
      true,
    );
    const written = writeResumeAuth(
      root,
      'consumer-auth',
      { ticketId: 'T1', contentHash: 'hash-1', denySessionId: 'denier-auth' },
      { key },
    );
    assert.equal(written.ok, true, `resume-auth must be writable: ${written.error ?? ''}`);

    // No key: readResumeAuth can only report verified:false, and authorized()
    // demands verified === true — the operator's completed resume is inert.
    const withoutKey = evaluateHandoffPreToolUse({
      root,
      sessionId: 'consumer-auth',
      observed: { depth: 1 },
      host: 'test',
    });
    assert.equal(withoutKey.deny, true);
    assert.ok(
      withoutKey.reasons.includes('resume_auth_unverifiable:no_manifest_key'),
      `the operator must learn why the resume did not help: ${withoutKey.reasons.join()}`,
    );

    // Same tree, same document, key supplied → the resume actually resumes.
    const withKey = evaluateHandoffPreToolUse({
      root,
      sessionId: 'consumer-auth',
      observed: { depth: 1 },
      host: 'test',
      manifestKey: key,
    });
    assert.equal(withKey.deny, false, `signed resume must clear D3: ${withKey.reasons.join()}`);
  });
});

test('a forged resume-auth stays denied even with the key', () => {
  withRepo((root) => {
    const key = 'a'.repeat(64);
    assert.equal(
      ensureDenyMarker(root, {
        sessionId: 'denier-forge',
        ticketId: 'T1',
        contentHash: 'hash-1',
        host: 'test',
      }).ok,
      true,
    );
    // Signed with a DIFFERENT key: the signature is well-formed but wrong.
    writeResumeAuth(
      root,
      'consumer-forge',
      { ticketId: 'T1', contentHash: 'hash-1', denySessionId: 'denier-forge' },
      { key: 'b'.repeat(64) },
    );
    const r = evaluateHandoffPreToolUse({
      root,
      sessionId: 'consumer-forge',
      observed: { depth: 1 },
      host: 'test',
      manifestKey: key,
    });
    assert.equal(r.deny, true);
    assert.ok(r.reasons.includes('resume_auth_unverified'), r.reasons.join());
  });
});

test('a resume-auth for the wrong content hash stays denied', () => {
  withRepo((root) => {
    const key = 'a'.repeat(64);
    assert.equal(
      ensureDenyMarker(root, {
        sessionId: 'denier-hash',
        ticketId: 'T1',
        contentHash: 'hash-1',
        host: 'test',
      }).ok,
      true,
    );
    writeResumeAuth(
      root,
      'consumer-hash',
      { ticketId: 'T1', contentHash: 'hash-STALE', denySessionId: 'denier-hash' },
      { key },
    );
    const r = evaluateHandoffPreToolUse({
      root,
      sessionId: 'consumer-hash',
      observed: { depth: 1 },
      host: 'test',
      manifestKey: key,
    });
    assert.equal(r.deny, true, 'a correctly signed resume for another hash must not authorize');
  });
});

// --- D1 stickiness across calls (cross-model review, MEDIUM/error-handling) --

test('denyEverWritten keeps a failed marker write sticky after the band cools', () => {
  withRepo((root) => {
    // First call at band pressure reports the D1 fact back to the caller.
    const atBand = evaluateHandoffPreToolUse({
      root,
      sessionId: 'sticky-sess',
      observed: { depth: HANDOFF_DEPTH },
      host: 'test',
    });
    assert.equal(atBand.deny, true);
    assert.equal(atBand.denyEverWritten, true, 'the caller must be told to remember this');

    // Now simulate the write having failed: no marker, no sentinel, cold store.
    rmSync(join(root, '.adlc', 'handoffs'), { recursive: true, force: true });
    rmSync(join(root, '.adlc', '.deny-store'), { force: true });

    const unthreaded = evaluateHandoffPreToolUse({
      root,
      sessionId: 'sticky-sess',
      observed: { depth: 1 },
      host: 'test',
    });
    assert.equal(unthreaded.deny, false, 'without the threaded fact the gate has nothing to go on');

    const threaded = evaluateHandoffPreToolUse({
      root,
      sessionId: 'sticky-sess',
      observed: { depth: 1 },
      host: 'test',
      denyEverWritten: true,
    });
    assert.equal(threaded.deny, true, 'a cooling signal must not clear a deny that was attempted');
    assert.ok(threaded.reasons.some((r) => r.startsWith('D1:')), threaded.reasons.join());
    assert.equal(threaded.denyEverWritten, true, 'and the fact stays set');
  });
});

test('denyEverWritten does not deny a session that never hit the band', () => {
  withRepo((root) => {
    const r = evaluateHandoffPreToolUse({
      root,
      sessionId: 'clean-sess',
      observed: { depth: 1 },
      host: 'test',
    });
    assert.equal(r.deny, false);
    assert.equal(r.denyEverWritten, false);
  });
});

test('a shell erasing the deny store is denied even with a cold deny-set', () => {
  withRepo((root) => {
    // The gap this closes: after another session consumes the record, the fresh
    // session has no D1-D3 and could `rm -rf .adlc/handoffs`. Those paths are
    // gitignored, so no CI diff would ever show it.
    for (const command of [
      'rm -rf .adlc/handoffs',
      'rm -rf .adlc/handoffs/denies',
      'rm -f .adlc/.deny-store',
      'rm .adlc/handoffs/denies/other.json',
      'mv .adlc/handoffs/denies /tmp/stash',
    ]) {
      const r = evaluateHandoffPreToolUse({
        root,
        sessionId: 'sess-clean',
        observed: { depth: 1 },
        isBash: true,
        bashCommand: command,
        host: 'test',
      });
      assert.equal(r.deny, true, `must deny: ${command}`);
      assert.ok(
        r.reasons.some((x) => x.startsWith('path_protected_shell:')),
        `${command} → ${r.reasons.join()}`,
      );
    }
  });
});

test('ordinary shell commands are still allowed with a cold deny-set', () => {
  withRepo((root) => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'app.mjs'), '');
    for (const command of [
      'ls -la',
      'rm -rf build/out',
      'cat src/app.mjs',
      'git status',
      // Dot-relative and absolute in-repo spellings synthesize `.` and the repo
      // root as ancestors. Treating the root as protected denied all of these.
      'cat ./src/app.mjs',
      'node ./scripts/check.mjs',
      'git -C . status',
      `cat ${join(root, 'src', 'app.mjs')}`,
      `rm -rf ${join(root, 'build', 'out')}`,
    ]) {
      const r = evaluateHandoffPreToolUse({
        root,
        sessionId: 'sess-clean',
        observed: { depth: 1 },
        isBash: true,
        bashCommand: command,
        host: 'test',
      });
      assert.equal(r.deny, false, `must allow: ${command} → ${r.reasons.join()}`);
    }
  });
});

test('shell path extraction sees a target and every ancestor it reaches through', () => {
  const found = shellPathCandidates('rm -rf .adlc/handoffs/denies');
  assert.ok(found.includes('.adlc/handoffs/denies'));
  assert.ok(found.includes('.adlc/handoffs'));
  assert.ok(found.includes('.adlc'), 'the slashless root must survive extraction');
  assert.deepEqual(shellPathCandidates(''), []);
  assert.deepEqual(shellPathCandidates(null), []);
});

test('a structured target naming a protected DIRECTORY is denied', () => {
  withRepo((root) => {
    mkdirSync(join(root, '.adlc', 'handoffs', 'denies'), { recursive: true });
    // Ancestor coverage was shell-only at first, on the reasoning that a
    // structured target is a file. OpenCode and pi route third-party tool
    // targets through this same path, and a delete/move tool can name a
    // directory — so `{target: '.adlc/handoffs'}` was allowed while
    // `rm -rf .adlc/handoffs` was denied.
    for (const rel of ['.adlc', '.adlc/handoffs', '.adlc/handoffs/denies']) {
      const r = evaluateHandoffPreToolUse({
        root,
        sessionId: 'sess-structured',
        observed: { depth: 1 },
        editRelPaths: [rel],
        host: 'test',
      });
      assert.equal(r.deny, true, `must deny structured target: ${rel}`);
      assert.ok(
        r.reasons.some((x) => x.startsWith('path_protected')),
        `${rel} → ${r.reasons.join()}`,
      );
    }
    // Siblings under .adlc that hold no protected artifact stay editable.
    for (const rel of ['.adlc/tickets', '.adlc/tickets/t1.json', 'src/app.mjs']) {
      const r = evaluateHandoffPreToolUse({
        root,
        sessionId: 'sess-structured',
        observed: { depth: 1 },
        editRelPaths: [rel],
        host: 'test',
      });
      assert.equal(r.deny, false, `must allow structured target: ${rel} → ${r.reasons.join()}`);
    }
  });
});

test('classifyProtectedTarget answers on the resolved path, not the spelling', () => {
  withRepo((root) => {
    mkdirSync(join(root, '.adlc', 'handoffs', 'denies'), { recursive: true });
    writeFileSync(join(root, '.adlc', '.deny-store'), '{}');
    // Directory coverage used to be expanded from the literal token, so only the
    // exact strings `.adlc` and `.adlc/handoffs` were recognized. Every other
    // spelling of the same directory reached the store untouched.
    for (const spelling of ['.adlc', './.adlc', '.adlc/handoffs', join(root, '.adlc'), join(root, '.adlc', 'handoffs')]) {
      assert.equal(
        classifyProtectedTarget(root, spelling).protected,
        true,
        `must be protected: ${spelling}`,
      );
    }
    assert.equal(classifyProtectedTarget(root, '.adlc/tickets').protected, false);
    assert.equal(classifyProtectedTarget(root, 'build/out').protected, false);
  });
});

test('every literal spelling of erasing the deny store is denied', () => {
  withRepo((root) => {
    // No .deny-store here on purpose: a sentinel makes the store hot, and every
    // command would then deny for that reason instead of the path scan under test.
    mkdirSync(join(root, '.adlc', 'handoffs', 'denies'), { recursive: true });
    const deny = (command) =>
      evaluateHandoffPreToolUse({
        root,
        sessionId: 'sess-clean',
        observed: { depth: 1 },
        isBash: true,
        bashCommand: command,
        host: 'test',
      });

    for (const command of [
      'rm -rf .adlc',
      'rm -rf ./.adlc',
      `rm -rf ${join(root, '.adlc')}`,
      `rm -rf ${join(root, '.adlc', 'handoffs')}`,
      `rm -rf ${join(root, '.adlc', 'handoffs', 'denies')}`,
    ]) {
      const r = deny(command);
      assert.equal(r.deny, true, `must deny: ${command}`);
      assert.ok(
        r.reasons.some((x) => x.startsWith('path_protected_shell:')),
        `${command} → ${r.reasons.join()}`,
      );
    }

    // The documented limitation, stated so a regression here is visible: a
    // literal scanner cannot follow a variable. Host-owned storage is the fix
    // (T-01KZRCNX3TSJ4C0PXZ28C9CB5N), not a longer regex.
    const viaVariable = deny('d=.adlc; rm -rf "$d/handoffs"');
    assert.equal(
      viaVariable.reasons.some((x) => x.startsWith('path_protected_shell:')),
      false,
      'variable indirection is out of reach of a literal scan',
    );
  });
});

test('a symlink alias to the deny store is protected', () => {
  withRepo((root) => {
    mkdirSync(join(root, '.adlc', 'handoffs', 'denies'), { recursive: true });
    writeFileSync(join(root, '.adlc', '.deny-store'), '{}');
    // An innocuous-looking name pointing at trust-root state.
    symlinkSync(join(root, '.adlc', '.deny-store'), join(root, 'notes.json'));
    symlinkSync(join(root, '.adlc', 'handoffs', 'denies'), join(root, 'aliasdir'), 'dir');

    const viaFile = evaluateHandoffPreToolUse({
      root,
      sessionId: 'sess-a',
      observed: { depth: 1 },
      editRelPaths: ['notes.json'],
      host: 'test',
    });
    assert.equal(viaFile.deny, true, 'a symlinked file alias must not slip through');
    assert.ok(viaFile.reasons.some((r) => r.startsWith('path_protected_symlink:')), viaFile.reasons.join());

    // A file that does not exist yet, inside a symlinked DIRECTORY.
    const viaDir = evaluateHandoffPreToolUse({
      root,
      sessionId: 'sess-a',
      observed: { depth: 1 },
      editRelPaths: ['aliasdir/forged.json'],
      host: 'test',
    });
    assert.equal(viaDir.deny, true, 'the nearest existing ancestor must be resolved');
  });
});

test('symlink resolution does not flag ordinary aliases', () => {
  withRepo((root) => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'app.mjs'), 'export {}\n');
    symlinkSync(join(root, 'src', 'app.mjs'), join(root, 'link.mjs'));
    const r = evaluateHandoffPreToolUse({
      root,
      sessionId: 'sess-a',
      observed: { depth: 1 },
      editRelPaths: ['link.mjs', 'src/app.mjs'],
      host: 'test',
    });
    assert.equal(r.deny, false, r.reasons.join());
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

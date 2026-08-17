// bypass-grant-roundtrip.test.mjs — Round-11 review (T-01M03J291182MXD1KEKM2PRKTS):
// the recovery diagnostic every deny path prints instructs the operator to run
// `handoff bypass --session <id> --write`, but before this fix that command only
// appended an audit-trail manifest entry — the adapter's mutation-gate call
// hardcoded `bypassForSession: false` and never read it back, so running the
// EXACT command the diagnostic prescribes had no effect on the next mutation.
// This file proves the closed loop: a written grant actually authorizes ONE
// subsequent mutation and is then consumed (one-shot), a grant for a different
// session or past its TTL does not authorize, and the REAL CLI script
// (bin/handoff.mjs, not a re-implementation) round-trips end to end.
//
// Lives outside test/ so it does not match T154's frozen
// `packages/context-handoff/test/**/*.test.mjs` rail glob.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { canonicalJson } from '@adlc/core';

import {
  evaluateHandoffPreToolUse,
  writeDenyRecord,
  writeBypassGrant,
  bypassGrantPath,
  BYPASS_GRANT_SCHEMA,
} from '@adlc/context-handoff';

const HANDOFF_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'handoff.mjs');
const KEY = 'a'.repeat(64);

function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-bypass-grant-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A plain, still-open self-deny for `sessionId` — the D2 lockout this fix recovers from. */
function selfDeny(root, sessionId) {
  writeDenyRecord(root, {
    session_id: sessionId,
    ticket_id: 'T1',
    content_hash: 'abc',
    status: 'open',
    since: new Date().toISOString(),
    host: 'test',
    schema: 1,
  });
}

test('BYPASS_GRANT_SCHEMA is exactly 2 (written_at is inside the signed payload)', () => {
  assert.equal(BYPASS_GRANT_SCHEMA, 2);
});

test('no grant: a self-denied session stays denied (baseline)', () => {
  withRepo((root) => {
    selfDeny(root, 'sess-baseline');
    const r = evaluateHandoffPreToolUse({ root, sessionId: 'sess-baseline', observed: { depth: 1 }, host: 'test', manifestKey: KEY });
    assert.equal(r.deny, true);
    assert.ok(r.reasons.some((x) => x.includes('D2:denier_session')), r.reasons.join());
  });
});

test('a verified bypass grant authorizes the next mutation and is then consumed (one-shot)', () => {
  withRepo((root) => {
    selfDeny(root, 'sess-oneshot');
    const written = writeBypassGrant(root, 'sess-oneshot', {}, { key: KEY });
    assert.equal(written.ok, true, `grant must be writable: ${written.error ?? ''}`);
    assert.equal(existsSync(bypassGrantPath(root, 'sess-oneshot')), true);

    const first = evaluateHandoffPreToolUse({ root, sessionId: 'sess-oneshot', observed: { depth: 1 }, host: 'test', manifestKey: KEY });
    assert.equal(first.deny, false, `the grant must clear D2: ${first.reasons.join()}`);

    // One-shot: the adapter must have deleted the grant the moment it authorized.
    assert.equal(existsSync(bypassGrantPath(root, 'sess-oneshot')), false, 'the grant must be consumed after authorizing one mutation');

    const second = evaluateHandoffPreToolUse({ root, sessionId: 'sess-oneshot', observed: { depth: 1 }, host: 'test', manifestKey: KEY });
    assert.equal(second.deny, true, 'a second mutation without a fresh grant must be denied again');
    assert.ok(second.reasons.some((x) => x.includes('D2:denier_session')), second.reasons.join());
  });
});

test('a bypass grant with no manifest key never authorizes (unverifiable ≡ absent)', () => {
  withRepo((root) => {
    selfDeny(root, 'sess-nokey');
    writeBypassGrant(root, 'sess-nokey', {}, { key: KEY });
    const r = evaluateHandoffPreToolUse({ root, sessionId: 'sess-nokey', observed: { depth: 1 }, host: 'test' });
    assert.equal(r.deny, true);
    assert.equal(existsSync(bypassGrantPath(root, 'sess-nokey')), true, 'an unverifiable grant must not be consumed either');
  });
});

test('a bypass grant signed with the wrong key never authorizes', () => {
  withRepo((root) => {
    selfDeny(root, 'sess-forged');
    writeBypassGrant(root, 'sess-forged', {}, { key: 'b'.repeat(64) });
    const r = evaluateHandoffPreToolUse({ root, sessionId: 'sess-forged', observed: { depth: 1 }, host: 'test', manifestKey: KEY });
    assert.equal(r.deny, true);
  });
});

test('a bypass grant for a different session never authorizes this one', () => {
  withRepo((root) => {
    selfDeny(root, 'sess-target');
    writeBypassGrant(root, 'sess-other', {}, { key: KEY });
    const r = evaluateHandoffPreToolUse({ root, sessionId: 'sess-target', observed: { depth: 1 }, host: 'test', manifestKey: KEY });
    assert.equal(r.deny, true);
  });
});

test('a bypass grant past BYPASS_GRANT_TTL_MS never authorizes (defense-in-depth ceiling)', () => {
  withRepo((root) => {
    selfDeny(root, 'sess-stale');
    // Hand-write a VALIDLY-SIGNED grant timestamped far in the past —
    // writeBypassGrant always stamps "now", so this fixture bypasses that to
    // simulate a failed-delete residual grant aging past the TTL. written_at
    // is inside the signed payload (schema 2), so the signature here covers
    // the stale timestamp: this proves the TTL check itself rejects it, not
    // merely a signature mismatch.
    const path = bypassGrantPath(root, 'sess-stale');
    const stalePayload = {
      schema: BYPASS_GRANT_SCHEMA,
      session_id: 'sess-stale',
      unbound_reason: null,
      written_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    };
    const sig = createHmac('sha256', KEY).update(canonicalJson(stalePayload)).digest('hex');
    writeFileSync(path, JSON.stringify({ ...stalePayload, sig }));
    const r = evaluateHandoffPreToolUse({ root, sessionId: 'sess-stale', observed: { depth: 1 }, host: 'test', manifestKey: KEY });
    assert.equal(r.deny, true, 'a grant an hour old must be treated as absent under the 10-minute TTL');
  });
});

test('editing written_at on a signed grant breaks the signature (TTL is tamper-evident)', () => {
  withRepo((root) => {
    selfDeny(root, 'sess-tamper');
    writeBypassGrant(root, 'sess-tamper', {}, { key: KEY });
    const path = bypassGrantPath(root, 'sess-tamper');
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    // The pre-schema-2 attack: nudge the unsigned timestamp forward to defeat
    // the 10-minute expiry without the key. Under schema 2 the sig covers
    // written_at, so the edited document must read as unverifiable.
    doc.written_at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    writeFileSync(path, JSON.stringify(doc));
    const r = evaluateHandoffPreToolUse({ root, sessionId: 'sess-tamper', observed: { depth: 1 }, host: 'test', manifestKey: KEY });
    assert.equal(r.deny, true, 'a grant whose written_at was edited after signing must never authorize');
    assert.equal(existsSync(path), true, 'an unverifiable grant must not be consumed');
  });
});

test('a legacy schema-1 grant document reads as absent', () => {
  withRepo((root) => {
    selfDeny(root, 'sess-legacy');
    const path = bypassGrantPath(root, 'sess-legacy');
    const legacyPayload = { schema: 1, session_id: 'sess-legacy', unbound_reason: null };
    const sig = createHmac('sha256', KEY).update(canonicalJson(legacyPayload)).digest('hex');
    writeFileSync(path, JSON.stringify({ ...legacyPayload, written_at: new Date().toISOString(), sig }));
    const r = evaluateHandoffPreToolUse({ root, sessionId: 'sess-legacy', observed: { depth: 1 }, host: 'test', manifestKey: KEY });
    assert.equal(r.deny, true, 'a schema-1 residual must be treated as absent, not verified');
  });
});

// ---------------------------------------------------------------------------
// verifiedBypassGrant — the host-verified path (Claude Code / Codex hooks).
// The hook verifies the grant with its own trusted twin and passes only the
// verdict; the adapter must honor it WITHOUT a manifestKey of its own, and
// must not fall back to reading the file when the host verdict is null.

test('host-verified grant object authorizes one mutation without any adapter key, then is consumed', () => {
  withRepo((root) => {
    selfDeny(root, 'sess-host');
    writeBypassGrant(root, 'sess-host', {}, { key: KEY });
    const doc = JSON.parse(readFileSync(bypassGrantPath(root, 'sess-host'), 'utf8'));
    const hostGrant = {
      session_id: doc.session_id,
      unbound_reason: doc.unbound_reason,
      written_at: doc.written_at,
      verified: true,
    };
    const first = evaluateHandoffPreToolUse({
      root, sessionId: 'sess-host', observed: { depth: 1 }, host: 'test',
      verifiedBypassGrant: hostGrant,
    });
    assert.equal(first.deny, false, `the host-verified grant must clear D2: ${first.reasons.join()}`);
    assert.equal(existsSync(bypassGrantPath(root, 'sess-host')), false, 'the host-verified grant must still be consumed one-shot');

    const second = evaluateHandoffPreToolUse({
      root, sessionId: 'sess-host', observed: { depth: 1 }, host: 'test',
      verifiedBypassGrant: null,
    });
    assert.equal(second.deny, true, 'a second mutation without a fresh grant must be denied again');
  });
});

test('host verdict null is authoritative: adapter must not fall back to reading a valid on-disk grant', () => {
  withRepo((root) => {
    selfDeny(root, 'sess-hostnull');
    writeBypassGrant(root, 'sess-hostnull', {}, { key: KEY });
    // Even WITH its own key available, an explicit null verdict wins — the
    // host attempted verification with fresher trust context than the adapter.
    const r = evaluateHandoffPreToolUse({
      root, sessionId: 'sess-hostnull', observed: { depth: 1 }, host: 'test',
      manifestKey: KEY,
      verifiedBypassGrant: null,
    });
    assert.equal(r.deny, true, 'a null host verdict must deny even though a valid grant file exists');
    assert.equal(existsSync(bypassGrantPath(root, 'sess-hostnull')), true, 'the unused grant must not be consumed');
  });
});

test('a host-verified grant bound to a different session never authorizes this one', () => {
  withRepo((root) => {
    selfDeny(root, 'sess-hostmis');
    const r = evaluateHandoffPreToolUse({
      root, sessionId: 'sess-hostmis', observed: { depth: 1 }, host: 'test',
      verifiedBypassGrant: {
        session_id: 'sess-other', unbound_reason: null,
        written_at: new Date().toISOString(), verified: true,
      },
    });
    assert.equal(r.deny, true, 'session binding must hold even on the host-verified path');
  });
});

test('a host grant object with verified !== true never authorizes', () => {
  withRepo((root) => {
    selfDeny(root, 'sess-hostunv');
    const r = evaluateHandoffPreToolUse({
      root, sessionId: 'sess-hostunv', observed: { depth: 1 }, host: 'test',
      verifiedBypassGrant: {
        session_id: 'sess-hostunv', unbound_reason: null,
        written_at: new Date().toISOString(), verified: false,
      },
    });
    assert.equal(r.deny, true, 'verified === true is required on the host path exactly as on the read path');
  });
});

test('end to end: the REAL handoff.mjs bypass --write CLI (not a re-implementation) unblocks exactly one subsequent mutation', () => {
  withRepo((root) => {
    selfDeny(root, 'sess-cli');
    const env = { ...process.env, ADLC_MANIFEST_KEY: KEY };
    execFileSync(process.execPath, [HANDOFF_CLI, 'bypass', '--session', 'sess-cli', '--write', '--dir', join(root, '.adlc')], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(existsSync(bypassGrantPath(root, 'sess-cli')), true, 'the real CLI must persist a grant file, not just an audit entry');

    const first = evaluateHandoffPreToolUse({ root, sessionId: 'sess-cli', observed: { depth: 1 }, host: 'test', manifestKey: KEY });
    assert.equal(first.deny, false, `the CLI-issued grant must clear D2: ${first.reasons.join()}`);

    const second = evaluateHandoffPreToolUse({ root, sessionId: 'sess-cli', observed: { depth: 1 }, host: 'test', manifestKey: KEY });
    assert.equal(second.deny, true, 'the CLI-issued grant must be one-shot, same as the direct-API grant');
  });
});

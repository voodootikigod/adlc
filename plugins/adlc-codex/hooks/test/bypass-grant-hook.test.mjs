// bypass-grant-hook.test.mjs — host-side bypass-grant verification, driven
// through the REAL Codex hook subprocess (T-01M03J291182MXD1KEKM2PRKTS,
// Round-12). Same rationale as the Claude Code twin file
// (plugins/adlc-claude-code/hooks/test/bypass-grant-hook.test.mjs): the hook
// passes `manifestKey: null` into the project-resolved package by design, so
// the Round-11 grant fix was dead code on this host until the hook grew its
// own trusted verification twin (readVerifiedBypassGrant, run from the
// pre-scrub env snapshot). These tests prove the closed loop end to end with
// the key present ONLY in the hook's environment.
//
// Lives in its own file (not handoff-deny.test.mjs) because that file is a
// frozen rail of the three completed slice-5/trust-root tickets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { writeDenyRecord, writeBypassGrant, bypassGrantPath } from '@adlc/context-handoff';

const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(HOOKS_DIR, 'adlc-handoff-gate.mjs');
const REPO_ROOT = join(HOOKS_DIR, '..', '..', '..');

const KEY = 'a'.repeat(64);

/** A plain, still-open self-deny for `sessionId` — the D2 lockout a bypass grant recovers from. */
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

/**
 * Run the real hook once for an apply_patch in a fixture repo.
 * `manifestKeyEnv` is what the HOOK process sees as ADLC_MANIFEST_KEY
 * ('' = the no-key environment); the key is never in the payload.
 */
function runHookOnce({ sessionId, seed, manifestKeyEnv }) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-codex-bypass-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.mjs'), 'export {}\n');
    seed(dir);

    const transcriptPath = join(dir, `${sessionId}.jsonl`);
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: 'assistant', content: [{ type: 'tool_use', name: 'apply_patch' }] }),
    );

    const payload = {
      session_id: sessionId,
      tool_name: 'apply_patch',
      transcript_path: transcriptPath,
      file_path: join(dir, 'src', 'app.mjs'),
    };

    let out = '';
    let status = 0;
    try {
      execFileSync(process.execPath, [HOOK], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        cwd: dir,
        env: {
          ...process.env,
          NODE_PATH: [join(REPO_ROOT, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(':'),
          ADLC_MANIFEST_KEY: manifestKeyEnv,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      out = e.stderr ?? '';
      status = e.status ?? 1;
    }
    return {
      verdict: status === 2 ? 'deny' : status === 0 ? 'allow' : 'error',
      out,
      status,
      grantExists: existsSync(bypassGrantPath(dir, sessionId)),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('self-denied session + signed grant + key in the HOOK env → allow, grant consumed one-shot', () => {
  const r = runHookOnce({
    sessionId: 'sess-cdx-grant',
    manifestKeyEnv: KEY,
    seed: (root) => {
      selfDeny(root, 'sess-cdx-grant');
      assert.equal(writeBypassGrant(root, 'sess-cdx-grant', {}, { key: KEY }).ok, true);
    },
  });
  assert.equal(r.verdict, 'allow', `the hook must verify the grant itself and allow: ${r.out}`);
  assert.equal(r.grantExists, false, 'the grant must be consumed by the one mutation it authorized');
});

test('self-denied session + signed grant but NO key in the HOOK env → deny, grant untouched', () => {
  const r = runHookOnce({
    sessionId: 'sess-cdx-nokey',
    manifestKeyEnv: '',
    seed: (root) => {
      selfDeny(root, 'sess-cdx-nokey');
      assert.equal(writeBypassGrant(root, 'sess-cdx-nokey', {}, { key: KEY }).ok, true);
    },
  });
  assert.equal(r.verdict, 'deny', 'without a key the host makes no claim and the deny stands');
  assert.equal(r.grantExists, true, 'an unverifiable grant must not be consumed');
});

test('a grant whose written_at was edited after signing → deny (TTL is tamper-evident end to end)', () => {
  const r = runHookOnce({
    sessionId: 'sess-cdx-tamper',
    manifestKeyEnv: KEY,
    seed: (root) => {
      selfDeny(root, 'sess-cdx-tamper');
      assert.equal(writeBypassGrant(root, 'sess-cdx-tamper', {}, { key: KEY }).ok, true);
      const p = bypassGrantPath(root, 'sess-cdx-tamper');
      const doc = JSON.parse(readFileSync(p, 'utf8'));
      doc.written_at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      writeFileSync(p, JSON.stringify(doc));
    },
  });
  assert.equal(r.verdict, 'deny', `a tampered grant must never authorize: ${r.out}`);
  assert.equal(r.grantExists, true, 'a tampered grant must not be consumed');
});

test("a grant for a DIFFERENT session in this session's slot → deny", () => {
  const r = runHookOnce({
    sessionId: 'sess-cdx-mis',
    manifestKeyEnv: KEY,
    seed: (root) => {
      selfDeny(root, 'sess-cdx-mis');
      // A validly-signed grant bound to another session, dropped into this
      // session's path slot by renaming — the session binding must hold.
      assert.equal(writeBypassGrant(root, 'sess-cdx-other', {}, { key: KEY }).ok, true);
      const doc = readFileSync(bypassGrantPath(root, 'sess-cdx-other'), 'utf8');
      writeFileSync(bypassGrantPath(root, 'sess-cdx-mis'), doc);
    },
  });
  assert.equal(r.verdict, 'deny', 'a grant bound to another session must never authorize this one');
});

test('a minimal single-character key still verifies (the guard is non-empty, not length > 1)', () => {
  // Pins the hook's key-presence guard at exactly `length > 0`: an off-by-one
  // mutant (`length > 1`) silently drops a legitimate 1-char key back to the
  // "host makes no claim" path and re-opens the dead-code lockout this file
  // exists to prevent. Key strength policy belongs to the operator, not this
  // guard.
  const r = runHookOnce({
    sessionId: 'sess-cdx-shortkey',
    manifestKeyEnv: 'k',
    seed: (root) => {
      selfDeny(root, 'sess-cdx-shortkey');
      assert.equal(writeBypassGrant(root, 'sess-cdx-shortkey', {}, { key: 'k' }).ok, true);
    },
  });
  assert.equal(r.verdict, 'allow', `a 1-char key must verify its own grant: ${r.out}`);
  assert.equal(r.grantExists, false, 'the grant must be consumed');
});

test('the deny-store baseline itself still denies (the fixtures above prove the grant, not a broken gate)', () => {
  const r = runHookOnce({
    sessionId: 'sess-cdx-base',
    manifestKeyEnv: KEY,
    seed: (root) => selfDeny(root, 'sess-cdx-base'),
  });
  assert.equal(r.verdict, 'deny', 'without a grant the self-deny must hold');
});

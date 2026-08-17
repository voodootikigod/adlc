import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorized, evaluateMutationGate } from '../lib/mutation-gate.mjs';
import { bypassGrantPath } from '../lib/paths.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'handoff.mjs');
const TEST_KEY = 'c'.repeat(64);

function run(args, { cwd, env = {}, expectOk = true } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8',
      cwd,
      env: { ...process.env, ...env },
      stderr: 'pipe',
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const result = {
      code: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
    if (expectOk) {
      assert.fail(`handoff ${args.join(' ')} failed (${result.code}): ${result.stderr || result.stdout}`);
    }
    return result;
  }
}

function withTempRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-bypass-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('bypass bound authorizes its own session\'s null-ticket record, never a foreign one; unbound with reason authorizes any', () => {
  withTempRepo((cwd) => {
    const bound = run(
      ['bypass', '--session', 'sess-b', '--write', '--json'],
      { cwd, env: { ADLC_MANIFEST_KEY: TEST_KEY } },
    );
    assert.equal(bound.code, 0);
    const boundPayload = JSON.parse(bound.stdout);
    assert.equal(boundPayload.bound, true);
    assert.equal(boundPayload.allowsUnboundRecord, false);
    assert.deepEqual(boundPayload.grant, { sessionId: 'sess-b' });

    const unboundRecord = {
      session_id: 'sess-b',
      ticket_id: null,
      content_hash: null,
      status: 'open',
    };
    // Round-17 review: a bound grant DOES authorize the SAME session's own
    // unbound record — the real band-triggered producer (adapter.mjs's
    // ensureDenyMarker) always creates content_hash: null, so its marker is
    // unbound by construction, and --unbound-reason is unreachable through
    // the Recovery Exception (free text outside VALUE_GRAMMAR, spec §1.3).
    // Without this, a bound grant — the only kind reachable at all — could
    // never clear the exact marker shape the gate itself produces.
    assert.equal(
      authorized({
        record: unboundRecord,
        bypassForSession: boundPayload.grant,
        currentSessionId: 'sess-b',
      }),
      true,
      'a bound grant must authorize its OWN session\'s unbound record',
    );
    // But same-session scoping still holds: a bound grant must never reach
    // across sessions to authorize a STRANGER's unbound record.
    assert.equal(
      authorized({
        record: { ...unboundRecord, session_id: 'sess-foreign' },
        bypassForSession: boundPayload.grant,
        currentSessionId: 'sess-b',
      }),
      false,
      'a bound grant must not authorize a DIFFERENT session\'s unbound record',
    );

    const unbound = run(
      [
        'bypass',
        '--session',
        'sess-u',
        '--unbound-reason',
        'operator-override',
        '--write',
        '--json',
      ],
      { cwd, env: { ADLC_MANIFEST_KEY: TEST_KEY } },
    );
    assert.equal(unbound.code, 0);
    const unboundPayload = JSON.parse(unbound.stdout);
    assert.equal(unboundPayload.bound, false);
    assert.equal(unboundPayload.allowsUnboundRecord, true);
    assert.equal(unboundPayload.grant.unboundReason, 'operator-override');

    assert.equal(
      authorized({
        record: { ...unboundRecord, session_id: 'sess-u' },
        bypassForSession: unboundPayload.grant,
        currentSessionId: 'sess-u',
      }),
      true,
      'unbound grant must authorize null-ticket/null-hash',
    );

    const gate = evaluateMutationGate({
      currentSessionId: 'sess-u',
      denyRecords: [{ ...unboundRecord, session_id: 'sess-u' }],
      bypassForSession: unboundPayload.grant,
      denyStoreUnavailable: true,
    });
    assert.equal(gate.deny, false, 'unbound override clears D0 store-unavailable + D2');

    const manifest = readFileSync(join(cwd, '.adlc', 'manifest.jsonl'), 'utf8');
    assert.match(manifest, /context-handoff-bypass/);
  });
});

test('bypass refuses an empty --unbound-reason rather than degrading to bound', () => {
  withTempRepo((cwd) => {
    for (const reason of ['', '   ']) {
      const r = run(['bypass', '--session', 'sess-e', '--unbound-reason', reason, '--write', '--json'], {
        cwd,
        env: { ADLC_MANIFEST_KEY: TEST_KEY },
        expectOk: false,
      });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /--unbound-reason/);
    }
    // An operator asking for the only grant that clears D0/D3 must not be handed
    // a bound one, and no grant may be recorded as if it were what they asked for.
    assert.equal(existsSync(join(cwd, '.adlc', 'manifest.jsonl')), false);
  });
});

test('bypass --write without key exits 1', () => {
  withTempRepo((cwd) => {
    const r = run(['bypass', '--session', 'sess-x', '--write'], {
      cwd,
      env: { ADLC_MANIFEST_KEY: '' },
      expectOk: false,
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /ADLC_MANIFEST_KEY/);
  });
});

test('Round-14: a manifest-recording failure rolls back the already-written grant (atomicity)', () => {
  withTempRepo((cwd) => {
    // The grant write (.adlc/handoffs/<session>.bypass-grant.json) succeeds —
    // that directory is untouched. Forcing manifest.jsonl to be a DIRECTORY
    // makes the evidence append throw (EISDIR) without touching the grant
    // path at all, isolating exactly the failure this test targets.
    mkdirSync(join(cwd, '.adlc', 'manifest.jsonl'), { recursive: true });
    const r = run(['bypass', '--session', 'sess-atomic', '--write'], {
      cwd,
      env: { ADLC_MANIFEST_KEY: TEST_KEY },
      expectOk: false,
    });
    assert.equal(r.code, 1);
    assert.equal(
      existsSync(bypassGrantPath(cwd, 'sess-atomic')),
      false,
      'a failed audit record must roll back the grant it was supposed to accompany — an operator seeing "failed" must not have a live, unrecorded bypass capability',
    );
  });
});

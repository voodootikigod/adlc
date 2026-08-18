import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorized, evaluateMutationGate } from '../lib/mutation-gate.mjs';

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
    // Round-17/19 review (T-01M03J291182MXD1KEKM2PRKTS), recorded under
    // ADLC_RAILS_BYPASS=1 with maintainer authorization: a bound grant DOES
    // authorize the SAME session's own unbound record — the real
    // band-triggered producer (adapter.mjs's ensureDenyMarker) always
    // creates content_hash: null, so its marker is unbound by construction,
    // and --unbound-reason is unreachable through the Recovery Exception
    // (free text outside VALUE_GRAMMAR, spec §1.3). Without this, a bound
    // grant — the only kind reachable at all — could never clear the exact
    // marker shape the gate itself produces. See mutation-gate.mjs's
    // authorized() for the full rationale.
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

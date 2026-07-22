// Contract pins for the GitHub Copilot rails-guard adapter.
//
// These assert the deny/allow SHAPE verified against Copilot CLI 1.0.73
// (docs/integrations/copilot-probe-appendix.md), NOT the shape the original
// integration plan assumed. In particular:
//   * deny  = exit 0 + a non-empty JSON object on stdout carrying `reason`
//             (the CLI honours no `permissionDecision` field and ignores the
//             exit code for the decision);
//   * allow = exit 0 + empty stdout;
//   * the hook must NEVER exit non-zero (Copilot fails OPEN on a crashed hook,
//     so a non-zero exit would silently let a rail edit through);
//   * internal errors deny (application-level fail-safe), they do not crash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'adlc-rails-guard.mjs');
const TICKET = { id: 'T1', title: 'Active', scope: ['src/**'], rails: ['test/**'], edges: [] };

function fixture(fn, { select = true, ticket = TICKET } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-copilot-rails-'));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc/tickets.json'), `${JSON.stringify({ tickets: [ticket] }, null, 2)}\n`);
  if (select) writeFileSync(join(root, '.adlc/current-ticket.json'), `${JSON.stringify({ id: ticket.id })}\n`);
  try { return fn(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

/** Run the hook with a Copilot-shaped preToolUse stdin payload. */
function runCopilot(root, { toolName, toolArgs, env = {} } = {}) {
  const { ADLC_P4_ENFORCEMENT: _e, ADLC_TICKET: _t, ADLC_TICKETS: _ts, ADLC_TICKET_STORE: _s, ...base } = process.env;
  return spawnSync(process.execPath, [HOOK], {
    cwd: root,
    env: { ...base, ...env },
    input: JSON.stringify({ toolName, toolArgs: JSON.stringify(toolArgs), cwd: root }),
    encoding: 'utf8',
  });
}

function parseStdout(result) {
  const text = result.stdout.trim();
  return text ? JSON.parse(text) : null;
}

test('rail edit → deny via {reason} on stdout, exit 0 (verified Copilot shape)', () => {
  fixture((root) => {
    const result = runCopilot(root, { toolName: 'write', toolArgs: { path: 'test/frozen.test.mjs' } });
    assert.equal(result.status, 0, 'must exit 0 — a non-zero exit fails OPEN on Copilot');
    const out = parseStdout(result);
    assert.ok(out && typeof out === 'object' && Object.keys(out).length > 0, 'deny = non-empty stdout object');
    assert.match(out.reason, /blocked rail edit for T1/);
    // The plan-assumed shape must NOT be emitted — this is the whole point of the probe.
    assert.equal('permissionDecision' in out, false, 'CLI does not honour permissionDecision');
    assert.doesNotMatch(result.stdout, /permissionDecision/);
  });
});

test('mutating shell to a rail path → deny via {reason}', () => {
  fixture((root) => {
    const result = runCopilot(root, { toolName: 'shell', toolArgs: { command: 'echo x > test/frozen.test.mjs' } });
    assert.equal(result.status, 0);
    const out = parseStdout(result);
    assert.match(out.reason, /blocked rail edit for T1/);
  });
});

// Regression: a no-space redirect (`cat a>rail`) must NOT slip past as read-only.
for (const command of [
  'cat payload.txt>test/frozen.test.mjs',
  'grep x foo>test/frozen.test.mjs',
  'echo hi>>test/frozen.test.mjs',
]) {
  test(`no-space shell redirect to a rail → deny (bypass closed) — ${command}`, () => {
    fixture((root) => {
      const result = runCopilot(root, { toolName: 'shell', toolArgs: { command } });
      assert.equal(result.status, 0);
      const out = parseStdout(result);
      assert.ok(out && out.reason && /blocked rail edit for T1/.test(out.reason), `expected a rail deny, got: ${result.stdout || '(empty=ALLOW)'}`);
    });
  });
}

test('non-rail edit → allow (empty stdout, exit 0)', () => {
  fixture((root) => {
    const result = runCopilot(root, { toolName: 'write', toolArgs: { path: 'src/app.mjs' } });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), '', 'allow = no stdout');
  });
});

test('no active ticket → no-op allow (not ADLC-driven)', () => {
  fixture((root) => {
    const result = runCopilot(root, { toolName: 'write', toolArgs: { path: 'test/frozen.test.mjs' } });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), '', 'inactive = allow, no stdout');
  }, { select: false });
});

test('ticket with no rails → no-op allow', () => {
  fixture((root) => {
    const result = runCopilot(root, { toolName: 'write', toolArgs: { path: 'test/frozen.test.mjs' } });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), '');
  }, { ticket: { id: 'T1', title: 'No rails', scope: ['src/**'], rails: [], edges: [] } });
});

test('malformed ticket store → fail-safe DENY, never a non-zero crash', () => {
  fixture((root) => {
    writeFileSync(join(root, '.adlc/tickets.json'), '{ this is not json');
    const result = runCopilot(root, { toolName: 'write', toolArgs: { path: 'test/frozen.test.mjs' } });
    assert.equal(result.status, 0, 'must not crash non-zero — that would fail OPEN');
    const out = parseStdout(result);
    assert.ok(out && out.reason, 'unverifiable state denies rather than allows');
  });
});

test('never exits non-zero even on a garbage payload', () => {
  fixture((root) => {
    const result = spawnSync(process.execPath, [HOOK], {
      cwd: root,
      env: (() => { const { ADLC_P4_ENFORCEMENT: _e, ...b } = process.env; return b; })(),
      input: 'not json at all',
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 2, 'exit 2 is not the Copilot deny signal');
    assert.equal(result.status, 0);
  });
});

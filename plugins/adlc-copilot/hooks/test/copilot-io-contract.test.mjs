// Copilot I/O contract for the build-gate and lifecycle adapters.
// Pins the SHAPE verified against Copilot CLI 1.0.73
// (docs/integrations/copilot-probe-appendix.md): preToolUse deny = non-empty
// {reason} object on stdout + exit 0 (never exit 2); context injection =
// {additionalContext} on stdout; advisory hooks never crash non-zero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = dirname(dirname(fileURLToPath(import.meta.url)));
const BUILD_GATE = join(HOOKS, 'adlc-build-gate.mjs');
const LIFECYCLE = join(HOOKS, 'adlc-lifecycle.mjs');

function fixture(fn, { ticket = { id: 'T1', title: 'HR', category: 'contract', scope: ['src/**'], rails: ['test/**'], edges: [] } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-copilot-io-'));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc/tickets.json'), `${JSON.stringify({ tickets: [ticket] }, null, 2)}\n`);
  writeFileSync(join(root, '.adlc/current-ticket.json'), `${JSON.stringify({ id: ticket.id })}\n`);
  try { return fn(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

function run(hook, root, { args = [], payload = {}, env = {} } = {}) {
  const { ADLC_P4_ENFORCEMENT: _e, ADLC_BUILD_GATE_BYPASS: _b, ...base } = process.env;
  return spawnSync(process.execPath, [hook, ...args], {
    cwd: root,
    env: { ...base, PLUGIN_DATA: join(root, '.plugin-data'), ...env },
    input: JSON.stringify({ cwd: root, ...payload }),
    encoding: 'utf8',
  });
}

test('build-gate: high-risk ticket, no transcript offered → advisory allow (empty stdout, exit 0)', () => {
  fixture((root) => {
    const r = run(BUILD_GATE, root, { payload: { toolName: 'write', toolArgs: JSON.stringify({ path: 'src/x.mjs' }) } });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', 'no stdout object → allow');
    assert.match(r.stderr, /context-fitness cannot be measured/);
  });
});

test('build-gate: high-risk + unreadable transcript → fail-safe DENY via {reason}, exit 0 not 2', () => {
  fixture((root) => {
    const r = run(BUILD_GATE, root, { payload: { toolName: 'write', toolArgs: '{}', transcriptPath: '/nope/x.log' } });
    assert.equal(r.status, 0, 'must not exit 2 — that would fail OPEN on Copilot');
    const out = JSON.parse(r.stdout.trim());
    assert.ok(out.reason && !('permissionDecision' in out));
  });
});

test('lifecycle context: injects {additionalContext} on stdout, exit 0', () => {
  fixture((root) => {
    const r = run(LIFECYCLE, root, { args: ['context'] });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout.trim());
    assert.ok(typeof out.additionalContext === 'string' && out.additionalContext.includes('T1'));
    assert.equal('hookSpecificOutput' in out, false, 'Copilot uses top-level additionalContext, not the CC wrapper');
  });
});

test('lifecycle: malformed store degrades to advisory, never crashes non-zero', () => {
  fixture((root) => {
    writeFileSync(join(root, '.adlc/tickets.json'), '{ broken');
    const r = run(LIFECYCLE, root, { args: ['context'] });
    assert.equal(r.status, 0, 'advisory hook must not crash the session');
  });
});

// #378 — pin that verifyOutput's spawn actually passes --allow-legacy-unsigned. A
// shim recording its own argv, since verifyOutput's args array is otherwise opaque
// to a test (ADLC_CLI_COMMAND only substitutes the binary, not the fixed args).
test('lifecycle verify: spawns gate-manifest verify with --allow-legacy-unsigned', () => {
  fixture((root) => {
    const shim = join(root, 'fake-adlc');
    const log = join(root, 'argv.log');
    writeFileSync(shim, `#!/bin/sh\necho "$@" > "${log}"\nexit 0\n`);
    chmodSync(shim, 0o755);
    const r = run(LIFECYCLE, root, { args: ['verify'], env: { ADLC_CLI_COMMAND: shim } });
    assert.equal(r.status, 0);
    const argv = readFileSync(log, 'utf8').trim();
    assert.equal(argv, 'gate-manifest verify --json --allow-legacy-unsigned');
  });
});

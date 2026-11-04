// reason-lines.test.mjs — parallax's human-readable `warnings:` block prints
// one warning per indented line, not joined with "; " on one line.
// Runs the real binary with the NODE_ENV=test mock seam; offline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp, runBin } from '@adlc/core/test-kit';

const BIN = fileURLToPath(new URL('../bin/parallax.mjs', import.meta.url));

const reading = (spec) => ({ ok: true, value: JSON.stringify({ spec, assumptions: [], decisions: [] }) });
const failed = (error) => ({ ok: false, error });
const CONVERGED = { agreements: ['both agree'], divergences: [] };

function runMocked(t, args, mock) {
  return runBin(BIN, args, {
    cwd: tmp(t, 'parallax-reason-lines-'),
    allowEnv: ['ADLC_GATE_MOCK_RESPONSE'],
    env: { NODE_ENV: 'test', ADLC_GATE_MOCK_RESPONSE: JSON.stringify(mock) },
  });
}

// The block parallax prints after its report: a blank line, then the list.
function warningsBlock(stderr) {
  const at = stderr.indexOf('\nwarnings:');
  assert.notEqual(at, -1, `no warnings block in stderr:\n${stderr}`);
  return stderr.slice(at).replace(/\n+$/, '');
}

test('spec mode: several warnings print one per indented line', (t) => {
  const mock = {
    fan: [reading('A'), reading('B'), failed('rate limit'), failed('timeout')],
    divergence: CONVERGED,
  };
  const r = runMocked(t, ['--request', 'Add a login page', '--n', '4', '--allow-partial-fan'], mock);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(warningsBlock(r.stderr), '\nwarnings:\n  rate limit\n  timeout');
});

test('spec mode: one warning stays on the heading line', (t) => {
  const mock = { fan: [reading('A'), reading('B'), failed('rate limit')], divergence: CONVERGED };
  const r = runMocked(t, ['--request', 'Add a login page', '--n', '3', '--allow-partial-fan'], mock);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(warningsBlock(r.stderr), '\nwarnings: rate limit');
});

test('route mode, equivalent answers: several warnings print one per indented line', (t) => {
  const mock = {
    fan: [{ ok: true, value: 'PostgreSQL' }, { ok: true, value: 'Postgres' }, failed('rate limit'), failed('timeout')],
    judge: { equivalent: true, answer: 'PostgreSQL', variants: [] },
  };
  const r = runMocked(t, ['--route', 'Which database?', '--n', '4', '--allow-partial-fan'], mock);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(warningsBlock(r.stderr), '\nwarnings:\n  rate limit\n  timeout');
});

test('route mode, equivalent answers: one warning stays on the heading line', (t) => {
  const mock = {
    fan: [{ ok: true, value: 'PostgreSQL' }, { ok: true, value: 'Postgres' }, failed('rate limit')],
    judge: { equivalent: true, answer: 'PostgreSQL', variants: [] },
  };
  const r = runMocked(t, ['--route', 'Which database?', '--n', '3', '--allow-partial-fan'], mock);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(warningsBlock(r.stderr), '\nwarnings: rate limit');
});

test('route mode, conflicting answers: one warning stays on the heading line', (t) => {
  const mock = {
    fan: [{ ok: true, value: 'PostgreSQL' }, { ok: true, value: 'MySQL' }, failed('rate limit')],
    judge: { equivalent: false, answer: '', variants: ['PostgreSQL', 'MySQL'] },
  };
  const r = runMocked(t, ['--route', 'Which database?', '--n', '3', '--allow-partial-fan'], mock);
  assert.equal(r.status, 2, r.stderr);
  assert.ok(warningsBlock(r.stderr).startsWith('\nwarnings: rate limit\n'), r.stderr);
});

test('route mode, conflicting answers: several warnings print one per indented line', (t) => {
  const mock = {
    fan: [{ ok: true, value: 'PostgreSQL' }, { ok: true, value: 'MySQL' }, failed('rate limit'), failed('timeout')],
    judge: { equivalent: false, answer: '', variants: ['PostgreSQL', 'MySQL'] },
  };
  const r = runMocked(t, ['--route', 'Which database?', '--n', '4', '--allow-partial-fan'], mock);
  assert.equal(r.status, 2, r.stderr);
  // The gate-failure line follows the list.
  assert.ok(
    warningsBlock(r.stderr).startsWith('\nwarnings:\n  rate limit\n  timeout\nroute answers diverge'),
    `unexpected warnings block:\n${r.stderr}`,
  );
});

function edgeTickets(t) {
  const dir = tmp(t, 'parallax-reason-lines-edge-');
  const ticketsFile = join(dir, 'tickets.json');
  writeFileSync(ticketsFile, JSON.stringify({
    tickets: [
      { id: 'T1', title: 'Auth Service', body: 'Build auth', scope: [] },
      { id: 'T2', title: 'API Gateway', body: 'Route requests', scope: [] },
    ],
  }));
  return ticketsFile;
}

test('edge mode: one warning stays on the heading line', (t) => {
  const mock = { fan: [reading('A'), reading('B'), failed('rate limit')], divergence: CONVERGED };
  const r = runMocked(t, ['--edge', 'T1', 'T2', '--tickets', edgeTickets(t), '--n', '3', '--allow-partial-fan'], mock);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(warningsBlock(r.stderr), '\nwarnings: rate limit');
});

test('edge mode: several warnings print one per indented line', (t) => {
  const dir = tmp(t, 'parallax-reason-lines-edge-');
  const ticketsFile = join(dir, 'tickets.json');
  writeFileSync(ticketsFile, JSON.stringify({
    tickets: [
      { id: 'T1', title: 'Auth Service', body: 'Build auth', scope: [] },
      { id: 'T2', title: 'API Gateway', body: 'Route requests', scope: [] },
    ],
  }));
  const mock = {
    fan: [reading('A'), reading('B'), failed('rate limit'), failed('timeout')],
    divergence: CONVERGED,
  };
  const r = runMocked(t, ['--edge', 'T1', 'T2', '--tickets', ticketsFile, '--n', '4', '--allow-partial-fan'], mock);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(warningsBlock(r.stderr), '\nwarnings:\n  rate limit\n  timeout');
});

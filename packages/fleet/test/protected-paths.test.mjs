import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanProtectedPaths, isInert, isUnderProtectedPrefix } from '../lib/protected-paths.mjs';

// Authoritative templates the orchestrator provisioned / read at startSha.
const templates = () =>
  new Map([
    ['.claude/settings.local.json', '{"permissions":{"allow":["Bash(npm test)"]}}'],
    ['.adlc/config.json', '{"fleet":{}}'],
    ['.adlc/fleet-status.json', '{"runId":"r1"}'],
    ['.adlc/tickets.json', '{"tickets":[{"id":"T42","rails":["packages/core/**"]}]}'],
    ['.adlc/current-ticket.json', '{"id":"T42"}'],
  ]);

test('clean worktree (all manifest files match templates) passes', () => {
  const t = templates();
  const candidates = [...t.entries()].map(([path, bytes]) => ({ path, bytes }));
  const r = scanProtectedPaths(candidates, t);
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

test('a modified permission file fails (F1)', () => {
  const t = templates();
  const candidates = [
    { path: '.claude/settings.local.json', bytes: '{"permissions":{"allow":["Bash(curl evil)"]}}' },
  ];
  const r = scanProtectedPaths(candidates, t);
  assert.equal(r.ok, false);
  assert.match(r.violations[0].reason, /modified a protected/);
});

test('a worktree-only (unstaged) mutation of the tickets.json trust root fails (M2)', () => {
  const t = templates();
  // Worker rewrote tickets.json in the worktree to drop its rail; not in git diff.
  const candidates = [
    { path: '.adlc/tickets.json', bytes: '{"tickets":[{"id":"T42","rails":[]}]}' },
  ];
  const r = scanProtectedPaths(candidates, t);
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].path, '.adlc/tickets.json');
  assert.match(r.violations[0].reason, /modified a protected/);
});

test('a NEW unexpected control file under a protected prefix fails (N4 closed manifest)', () => {
  const t = templates();
  const candidates = [{ path: '.claude/hooks.json', bytes: 'whatever' }];
  const r = scanProtectedPaths(candidates, t);
  assert.equal(r.ok, false);
  assert.match(r.violations[0].reason, /unexpected\/unauthorized/);
});

test('inert log files are allowlisted and never fail the scan (N4)', () => {
  const t = templates();
  const candidates = [
    { path: '.adlc/fleet-logs/T42.log', bytes: 'worker output line 1\nline 2' },
  ];
  const r = scanProtectedPaths(candidates, t);
  assert.equal(r.ok, true, 'a normal log must not trip the scan');
});

test('files outside the protected prefixes are ignored', () => {
  const t = templates();
  const candidates = [{ path: 'src/app.js', bytes: 'code' }];
  const r = scanProtectedPaths(candidates, t);
  assert.equal(r.ok, true);
});

test('helpers classify prefixes and inert paths', () => {
  assert.equal(isUnderProtectedPrefix('.adlc/tickets.json'), true);
  assert.equal(isUnderProtectedPrefix('.claude/settings.local.json'), true);
  assert.equal(isUnderProtectedPrefix('src/x.js'), false);
  assert.equal(isInert('.adlc/fleet-logs/T1.log'), true);
  assert.equal(isInert('.adlc/tickets.json'), false);
});

test('a manifest file with no template fails closed', () => {
  const t = new Map(); // no templates supplied at all
  const candidates = [{ path: '.adlc/tickets.json', bytes: '{}' }];
  const r = scanProtectedPaths(candidates, t);
  assert.equal(r.ok, false);
  assert.match(r.violations[0].reason, /no authoritative template/);
});

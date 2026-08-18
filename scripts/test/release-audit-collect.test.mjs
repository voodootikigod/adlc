// Tests for scripts/release-audit-collect.mjs — Phase A of /release-audit.
//
// The routing tests carry most of the weight. Issue routing decides which agent
// sees which GitHub issue, and its governing rule is asymmetric on purpose:
// ambiguous evidence must route to NOBODY (the issue falls to the sweep agent)
// rather than to a plausible guess. Under-claiming is safe; over-claiming hands
// an issue to one artifact and hides it from the one that owns it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseArgs,
  nextMinor,
  globPrefix,
  linkedIssueNumbers,
  isEscalated,
  unitForPath,
  routeIssue,
  routeIssues,
  discoverUnits,
} from '../release-audit-collect.mjs';

const UNITS = [
  { id: 'pkg:core', dir: 'packages/core', slug: 'core', name: '@adlc/core', manifest: null },
  { id: 'pkg:hollow-test', dir: 'packages/hollow-test', slug: 'hollow-test', name: '@adlc/hollow-test', manifest: null },
  { id: 'pkg:tickets', dir: 'packages/tickets', slug: 'tickets', name: '@adlc/tickets', manifest: null },
  { id: 'plugin:adlc-codex', dir: 'plugins/adlc-codex', slug: 'adlc-codex', name: '@adlc/codex', manifest: null },
  { id: 'plugin:adlc-claude-code', dir: 'plugins/adlc-claude-code', slug: 'adlc-claude-code', name: '(plugins/adlc-claude-code/.claude-plugin/plugin.json)', manifest: 'plugins/adlc-claude-code/.claude-plugin/plugin.json' },
];

test('parseArgs reads the four flags and the positional version', () => {
  const a = parseArgs(['1.12.0', '--since', 'v1.9.0', '--packages', 'core, cli ', '--skip-issues']);
  assert.equal(a.version, '1.12.0');
  assert.equal(a.since, 'v1.9.0');
  assert.deepEqual(a.packages, ['core', 'cli']);
  assert.equal(a.skipIssues, true);
});

test('parseArgs defaults everything to null/false', () => {
  const a = parseArgs([]);
  assert.deepEqual(a, { version: null, since: null, packages: null, skipIssues: false });
});

test('parseArgs treats an empty --packages list as unfiltered, not as "audit nothing"', () => {
  // A filter that matched zero units would silently audit nothing and still be
  // able to report a verdict. Empty means "no filter".
  assert.equal(parseArgs(['--packages', '']).packages, null);
  assert.equal(parseArgs(['--packages', ' , ,']).packages, null);
});

test('parseArgs ignores unknown flags and keeps only the FIRST positional as version', () => {
  const a = parseArgs(['--verbose', '1.11.0', '2.0.0']);
  assert.equal(a.version, '1.11.0');
});

test('nextMinor bumps the minor and zeroes the patch', () => {
  assert.equal(nextMinor('1.10.0'), '1.11.0');
  assert.equal(nextMinor('0.9.3'), '0.10.0');
  assert.equal(nextMinor('2.0.7'), '2.1.0');
});

test('nextMinor passes through anything that is not a version', () => {
  assert.equal(nextMinor('not-a-version'), 'not-a-version');
  assert.equal(nextMinor(undefined), '');
});

test('globPrefix returns the literal directory before the first wildcard', () => {
  assert.equal(globPrefix('packages/core/**'), 'packages/core');
  assert.equal(globPrefix('plugins/adlc-codex/hooks/*.mjs'), 'plugins/adlc-codex/hooks');
  assert.equal(globPrefix('packages/*/test/**'), 'packages');
});

test('globPrefix returns a wildcard-free glob unchanged', () => {
  assert.equal(globPrefix('docs/integrations/antigravity.md'), 'docs/integrations/antigravity.md');
});

test('globPrefix yields no directory for a leading wildcard', () => {
  // '**/x.mjs' must not be read as claiming the repo root.
  assert.equal(globPrefix('**/glob.mjs'), '');
});

test('linkedIssueNumbers extracts and de-duplicates issue backlinks', () => {
  const body = 'GitHub issue: https://github.com/voodootikigod/adlc/issues/142\n'
    + 'see also https://github.com/voodootikigod/adlc/issues/11 and again /issues/142';
  assert.deepEqual(linkedIssueNumbers(body).sort((a, b) => a - b), [11, 142]);
});

test('linkedIssueNumbers returns nothing for a body with no links', () => {
  assert.deepEqual(linkedIssueNumbers('no links here'), []);
  assert.deepEqual(linkedIssueNumbers(undefined), []);
});

test('isEscalated fires on P0/P1/security in both label shapes', () => {
  assert.equal(isEscalated({ labels: ['P0-critical'] }), true);
  assert.equal(isEscalated({ labels: [{ name: 'security' }] }), true);
  assert.equal(isEscalated({ labels: [{ name: 'P1-high' }] }), true);
});

test('isEscalated does not fire on ordinary labels', () => {
  assert.equal(isEscalated({ labels: ['P2-medium', 'enhancement', 'area:plugins'] }), false);
  assert.equal(isEscalated({}), false);
});

test('unitForPath prefers the longest matching directory', () => {
  assert.equal(unitForPath('packages/core/lib/glob.mjs', UNITS), 'pkg:core');
  assert.equal(unitForPath('plugins/adlc-claude-code/hooks/adlc-hook.mjs', UNITS), 'plugin:adlc-claude-code');
});

test('unitForPath matches a bare unit directory and rejects a non-unit path', () => {
  assert.equal(unitForPath('packages/core', UNITS), 'pkg:core');
  assert.equal(unitForPath('scripts/release.mjs', UNITS), null);
});

test('unitForPath does not let a prefix match a different unit name', () => {
  // 'packages/core-extra' must not be claimed by 'packages/core'.
  assert.equal(unitForPath('packages/core-extra/lib/x.mjs', UNITS), null);
});

test('routeIssue tier 1: a single explicit path mention wins', () => {
  const r = routeIssue({ number: 1, title: 'crash', body: 'in packages/hollow-test/lib/x.mjs' }, UNITS);
  assert.deepEqual(r, { unit: 'pkg:hollow-test', via: 'path-mention' });
});

test('routeIssue refuses to guess when two units are named', () => {
  const r = routeIssue({ number: 2, title: 'x', body: 'packages/core and packages/tickets both' }, UNITS);
  assert.equal(r.unit, null);
  assert.equal(r.via, 'ambiguous-path');
});

test('routeIssue tier 2: a linked ticket scope routes when it lands in one unit', () => {
  const tickets = new Map([[7, [{ id: 'T7', scope: ['packages/tickets/lib/**', 'packages/tickets/test/**'] }]]]);
  const r = routeIssue({ number: 7, title: 'ticket store bug', body: '' }, UNITS, tickets);
  assert.deepEqual(r, { unit: 'pkg:tickets', via: 'ticket-scope' });
});

test('routeIssue refuses a ticket scope that spans two units', () => {
  const tickets = new Map([[8, [{ id: 'T8', scope: ['packages/core/**', 'plugins/adlc-codex/**'] }]]]);
  const r = routeIssue({ number: 8, title: 'x', body: '' }, UNITS, tickets);
  assert.equal(r.unit, null);
  assert.equal(r.via, 'ambiguous-ticket-scope');
});

test('routeIssue tier 3: a package name in the TITLE routes', () => {
  const r = routeIssue({ number: 9, title: '@adlc/codex denies everything', body: '' }, UNITS);
  assert.deepEqual(r, { unit: 'plugin:adlc-codex', via: 'package-name' });
});

test('routeIssue tier 4: an area label routes only on an EXACT unit directory name', () => {
  const exact = routeIssue({ number: 10, title: 'x', body: '', labels: ['area:tickets'] }, UNITS);
  assert.deepEqual(exact, { unit: 'pkg:tickets', via: 'area-label' });

  // 'area:rails' names no unit directory (the unit is 'rails-guard'), so it must
  // NOT be stretched to fit. The issue goes to the sweep agent instead.
  const inexact = routeIssue({ number: 11, title: 'x', body: '', labels: ['area:rails'] }, UNITS);
  assert.equal(inexact.unit, null);
  assert.equal(inexact.via, 'unrouted');
});

test('routeIssue tiers are ordered: a path mention beats an area label', () => {
  const r = routeIssue(
    { number: 12, title: 'x', body: 'packages/core/lib/a.mjs', labels: ['area:tickets'] },
    UNITS,
  );
  assert.equal(r.unit, 'pkg:core');
  assert.equal(r.via, 'path-mention');
});

test('routeIssues partitions into routed, unmapped and escalated', () => {
  const issues = [
    { number: 1, title: 'a', body: 'packages/core/lib/x.mjs', labels: [] },
    { number: 2, title: 'b', body: 'nothing identifiable', labels: ['P2-medium'] },
    { number: 3, title: 'c', body: 'packages/tickets/x', labels: ['security'] },
  ];
  const { byUnit, unmapped, escalated } = routeIssues(issues, UNITS);
  assert.deepEqual(byUnit.get('pkg:core').map((i) => i.number), [1]);
  assert.deepEqual(unmapped.map((i) => i.number), [2]);
  // #3 is routed AND escalated — the sweep agent sees it regardless.
  assert.deepEqual(escalated.map((i) => i.number), [3]);
  assert.equal(byUnit.get('pkg:tickets').length, 1);
});

test('routeIssues records how each issue was routed', () => {
  const { byUnit } = routeIssues([{ number: 1, title: 't', body: 'packages/core' }], UNITS);
  assert.equal(byUnit.get('pkg:core')[0].routedVia, 'path-mention');
  assert.equal(byUnit.get('pkg:core')[0].routedTo, 'pkg:core');
});

test('discoverUnits finds every shipped artifact in the real repo', () => {
  const units = discoverUnits();
  const ids = new Set(units.map((u) => u.id));
  assert.ok(units.length >= 35, `expected the full suite, got ${units.length}`);
  assert.ok(ids.has('pkg:core'));
  assert.ok(ids.has('pkg:hollow-test'));
  assert.equal(units.filter((u) => u.kind === 'plugin').length >= 8, true);
});

test('discoverUnits includes the manifest-only Claude Code plugin', () => {
  // This artifact has NO package.json — it ships via .claude-plugin/plugin.json,
  // and it is the one release.mjs records as having stranded at 0.2.0 for three
  // releases. Discovering units by package.json alone would omit exactly it.
  const unit = discoverUnits().find((u) => u.slug === 'adlc-claude-code');
  assert.ok(unit, 'adlc-claude-code must be discovered');
  assert.equal(unit.manifest, 'plugins/adlc-claude-code/.claude-plugin/plugin.json');
  assert.equal(unit.published, true);
  assert.match(String(unit.version), /^\d+\.\d+\.\d+$/);
});

test('discoverUnits reports real inventory for a known package', () => {
  const core = discoverUnits().find((u) => u.id === 'pkg:core');
  assert.equal(core.name, '@adlc/core');
  assert.equal(core.published, true);
  assert.equal(core.hasTests, true);
  assert.ok(core.fileCount > 0);
  assert.ok(core.files.every((f) => f.startsWith('packages/core/')));
  assert.ok(core.files.every((f) => !f.includes('node_modules')));
});

test('sweepBatches merges unrouted and escalated issues without duplicating either', async () => {
  const { sweepBatches } = await import('../release-audit-collect.mjs');
  const [batch] = sweepBatches([{ number: 3 }, { number: 1 }], [{ number: 1 }, { number: 7 }]);
  assert.deepEqual(batch.map((i) => i.number), [1, 3, 7]);
});

test('sweepBatches splits a large backlog into fixed-size shards', async () => {
  const { sweepBatches, SWEEP_BATCH_SIZE } = await import('../release-audit-collect.mjs');
  const many = Array.from({ length: SWEEP_BATCH_SIZE * 2 + 3 }, (_, i) => ({ number: i + 1 }));
  const batches = sweepBatches(many, []);
  assert.equal(batches.length, 3);
  assert.deepEqual(batches.map((b) => b.length), [SWEEP_BATCH_SIZE, SWEEP_BATCH_SIZE, 3]);
});

test('sweepBatches always yields one batch, so an empty backlog still has a sweep to expect', async () => {
  const { sweepBatches } = await import('../release-audit-collect.mjs');
  assert.deepEqual(sweepBatches([], []), [[]]);
});

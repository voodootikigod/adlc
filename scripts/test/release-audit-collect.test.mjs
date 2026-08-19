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
  assert.deepEqual(a, { version: null, since: null, packages: null, skipIssues: false, workflowArgs: false });
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

test('fetchIssues reports a capped response as truncated instead of accepting it', async () => {
  const { fetchIssues, ISSUE_FETCH_LIMIT } = await import('../release-audit-collect.mjs');
  const full = JSON.stringify(Array.from({ length: ISSUE_FETCH_LIMIT }, (_, i) => ({ number: i + 1, title: 't', body: '', labels: [], url: 'u' })));
  const r = fetchIssues({ run: () => full });
  assert.equal(r.truncated, ISSUE_FETCH_LIMIT);
  assert.equal(r.issues.length, ISSUE_FETCH_LIMIT);
});

test('fetchIssues does not flag a short response as truncated', async () => {
  const { fetchIssues } = await import('../release-audit-collect.mjs');
  const r = fetchIssues({ run: () => JSON.stringify([{ number: 1, title: 't', body: '', labels: [], url: 'u' }]) });
  assert.equal(r.truncated, null);
  assert.equal(r.unconsultable, null);
});

test('fetchIssues records an unconsultable rather than an empty backlog when gh fails', async () => {
  const { fetchIssues } = await import('../release-audit-collect.mjs');
  const r = fetchIssues({ run: () => { throw new Error('gh: not authenticated'); } });
  assert.deepEqual(r.issues, []);
  assert.match(r.unconsultable, /gh issue list failed/);
});

test('fetchIssues records an unconsultable when gh returns unparseable JSON', async () => {
  const { fetchIssues } = await import('../release-audit-collect.mjs');
  const r = fetchIssues({ run: () => 'not json at all' });
  assert.match(r.unconsultable, /unparseable JSON/);
});

test('fetchIssues marks a deliberate skip, so the verdict can still name the gap', async () => {
  const { fetchIssues } = await import('../release-audit-collect.mjs');
  const r = fetchIssues({ skip: true });
  assert.match(r.unconsultable, /--skip-issues/);
});

// ─── the inventory filters, exercised against a real directory tree ──────────
//
// SOURCE_EXT and SKIP_DIRS are the two lists that decide what an audit agent is
// shown. Asserting their contents would only restate the source; these build a
// tree and assert what inventory actually returns, so dropping an extension or a
// skipped directory changes an observable result.

import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { inventory } from '../release-audit-collect.mjs';

function fixtureTree() {
  // realpath: on macOS the temp dir is a symlink, and inventory reports paths
  // relative to `root` — comparing an unresolved root against resolved children
  // passes locally and fails on Linux CI, or the reverse.
  const root = realpathSync(mkdtempSync(joinPath(tmpdir(), 'release-audit-inv-')));
  mkdirSync(joinPath(root, 'unit'), { recursive: true });
  for (const name of ['a.mjs', 'b.cjs', 'c.js', 'd.ts', 'e.json', 'f.md']) {
    writeFileSync(joinPath(root, 'unit', name), 'x');
  }
  for (const name of ['g.txt', 'h.lock', 'i']) writeFileSync(joinPath(root, 'unit', name), 'x');
  for (const dir of ['node_modules', '.git', 'coverage', 'dist', '.worktrees']) {
    mkdirSync(joinPath(root, 'unit', dir), { recursive: true });
    writeFileSync(joinPath(root, 'unit', dir, 'buried.mjs'), 'x');
  }
  return root;
}

test('inventory returns every source extension an agent is meant to read', () => {
  const root = fixtureTree();
  const found = inventory('unit', { root }).map((f) => f.path).sort();
  assert.deepEqual(found, [
    'unit/a.mjs', 'unit/b.cjs', 'unit/c.js', 'unit/d.ts', 'unit/e.json', 'unit/f.md',
  ].sort());
});

test('inventory excludes files whose extension is not a source type', () => {
  const root = fixtureTree();
  const found = inventory('unit', { root }).map((f) => f.path);
  for (const excluded of ['unit/g.txt', 'unit/h.lock', 'unit/i']) {
    assert.ok(!found.includes(excluded), `${excluded} must not be shown to an agent`);
  }
});

test('inventory never descends into a skipped directory', () => {
  // A vendored tree would swamp the agent's attention and is not the artifact
  // under audit, so each skipped directory must stay invisible even though it
  // contains a file of a source type.
  const root = fixtureTree();
  const found = inventory('unit', { root }).map((f) => f.path);
  for (const dir of ['node_modules', '.git', 'coverage', 'dist', '.worktrees']) {
    assert.ok(!found.some((f) => f.includes(`/${dir}/`)), `${dir} must be skipped entirely`);
  }
});

test('inventory reports each file size, so a unit prompt can state its real weight', () => {
  const root = fixtureTree();
  const entry = inventory('unit', { root }).find((f) => f.path === 'unit/a.mjs');
  assert.equal(entry.bytes, 1);
});

test('sweepBatches splits at exactly twelve, so a shard stays small enough to audit', async () => {
  // Pinned with literals rather than the constant: a test written in terms of
  // SWEEP_BATCH_SIZE moves with the value and would not notice it changing.
  const { sweepBatches } = await import('../release-audit-collect.mjs');
  const items = Array.from({ length: 25 }, (_, i) => ({ number: i + 1 }));
  assert.deepEqual(sweepBatches(items, []).map((b) => b.length), [12, 12, 1]);
});

test('sweepBatches keeps thirteen issues from becoming one oversized shard', async () => {
  const { sweepBatches } = await import('../release-audit-collect.mjs');
  const items = Array.from({ length: 13 }, (_, i) => ({ number: i + 1 }));
  assert.deepEqual(sweepBatches(items, []).map((b) => b.length), [12, 1]);
});

test('stripBody replaces a long issue body with a bounded excerpt', async () => {
  const { stripBody, ISSUE_EXCERPT } = await import('../release-audit-collect.mjs');
  const r = stripBody({ number: 1, title: 't', body: 'x'.repeat(5000) });
  assert.equal(r.body, undefined);
  assert.equal(r.excerpt.length, ISSUE_EXCERPT + 1, 'excerpt is capped, plus the ellipsis');
  assert.ok(r.excerpt.endsWith('…'));
});

test('stripBody keeps a short body whole and adds no ellipsis', async () => {
  const { stripBody } = await import('../release-audit-collect.mjs');
  const r = stripBody({ number: 1, title: 't', body: '  short body  ' });
  assert.equal(r.excerpt, 'short body');
  assert.ok(!r.excerpt.endsWith('…'));
});

test('stripBody preserves every routing field the prompts actually use', async () => {
  const { stripBody } = await import('../release-audit-collect.mjs');
  const r = stripBody({ number: 7, title: 't', url: 'u', labels: ['security'], routedVia: 'path-mention', routedTo: 'pkg:core', body: 'b' });
  assert.deepEqual(r, { number: 7, title: 't', url: 'u', labels: ['security'], routedVia: 'path-mention', routedTo: 'pkg:core', excerpt: 'b' });
});

test('routed issues carry no body into the emitted document', async () => {
  const { routeIssues } = await import('../release-audit-collect.mjs');
  const units = [{ id: 'pkg:core', dir: 'packages/core', slug: 'core', name: '@adlc/core', manifest: null }];
  const { byUnit, unmapped } = routeIssues([
    { number: 1, title: 'a', body: 'packages/core/lib/x.mjs ' + 'y'.repeat(9000), labels: [] },
    { number: 2, title: 'b', body: 'z'.repeat(9000), labels: [] },
  ], units);
  assert.equal(byUnit.get('pkg:core')[0].body, undefined);
  assert.equal(unmapped[0].body, undefined);
});

test('workflowArgs drops the per-unit file inventory the prompts never read', async () => {
  const { workflowArgs } = await import('../release-audit-collect.mjs');
  const doc = { version: '1.11.0', units: [{ id: 'pkg:core', fileCount: 32, bytes: 900, files: ['a', 'b', 'c'] }], issues: {}, probes: {} };
  const [unit] = workflowArgs(doc).units;
  assert.equal(unit.files, undefined);
  assert.equal(unit.fileCount, 32, 'the count survives — an agent is told what it is walking into');
  assert.equal(unit.bytes, 900);
});

test('workflowArgs keeps the fan-out inputs and defaults the absent ones', async () => {
  const { workflowArgs } = await import('../release-audit-collect.mjs');
  const a = workflowArgs({ version: '1.11.0', currentVersion: '1.10.0', since: 'v1.10.0' });
  assert.equal(a.version, '1.11.0');
  assert.equal(a.currentVersion, '1.10.0');
  assert.equal(a.filtered, false);
  assert.deepEqual(a.units, []);
  assert.deepEqual(a.issues.sweepBatches, [[]], 'the sweep still has one shard to expect');
  assert.deepEqual(a.probes.versionDrift, []);
});

test('workflowArgs marks a narrowed run so the synthesizer can cap its verdict', async () => {
  const { workflowArgs } = await import('../release-audit-collect.mjs');
  assert.equal(workflowArgs({ filtered: true }).filtered, true);
});

test('narrowing the run does not change how an ambiguous issue routes', async () => {
  // The filter selects which artifacts are AUDITED. It must not change what the
  // router believes, or a narrowed re-run would hand one artifact an issue that a
  // full run correctly refused to attribute to anybody.
  const { routeIssue } = await import('../release-audit-collect.mjs');
  const all = UNITS;
  const narrowed = UNITS.filter((u) => u.id === 'pkg:hollow-test');
  const issue = { number: 315, title: 'x', body: 'packages/fleet/lib/live-deps.mjs and packages/hollow-test/lib/y.mjs' };

  const fleetUnit = { id: 'pkg:fleet', dir: 'packages/fleet', slug: 'fleet', name: '@adlc/fleet', manifest: null };
  assert.equal(routeIssue(issue, [...all, fleetUnit]).via, 'ambiguous-path');
  // Routed against the narrowed list, the same issue looks unambiguous — which is
  // precisely why collectMain must route against every discovered unit.
  assert.equal(routeIssue(issue, narrowed).via, 'path-mention');
});

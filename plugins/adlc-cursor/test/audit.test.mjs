// audit.test.mjs — T18 AC3: the flail piggyback in the afterFileEdit audit hook
// fires an advisory on a synthetic churn window and stays silent otherwise;
// the rail audit behavior is unchanged and the hook still never blocks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { audit, flailCheck } from '../hooks/adlc-audit.mjs';
import { SESSION_TTL_MS, RECENT_EDITS_FILE } from '../constants.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUDIT_SCRIPT = join(HERE, '..', 'hooks', 'adlc-audit.mjs');

function fixture({ tickets = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-cursor-audit-'));
  if (tickets) {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets }));
  }
  return root;
}
const cleanup = (root) => rmSync(root, { recursive: true, force: true });
const payload = (filePath) => ({ tool_name: 'edit', file_path: filePath });
const windowPath = (root) => join(root, '.adlc', RECENT_EDITS_FILE);
const seedWindow = (root, entries) =>
  writeFileSync(windowPath(root), entries.map((e) => `${JSON.stringify(e)}\n`).join(''));

const RAILED = [{ id: 'T1', title: 'one', rails: ['src/frozen.js'] }];
const env = () => ({ ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' });

// --- flail advisory (AC3) ----------------------------------------------------

test('flail advisory FIRES on a synthetic churn window (>= 3 edits of one path)', async () => {
  const root = fixture({ tickets: RAILED });
  try {
    const now = Date.now();
    seedWindow(root, [
      { ts: now - 1000, path: 'src/churny.js' },
      { ts: now - 500, path: 'src/churny.js' },
    ]);
    const res = await flailCheck(payload('src/churny.js'), { root, now });
    assert.equal(res.flagged, true);
    assert.deepEqual(res.churn, [{ path: 'src/churny.js', count: 3 }]);
  } finally { cleanup(root); }
});

test('flail advisory is SILENT on distinct paths (no churn)', async () => {
  const root = fixture({ tickets: RAILED });
  try {
    for (const p of ['src/a.js', 'src/b.js', 'src/c.js']) {
      const res = await flailCheck(payload(p), { root });
      assert.equal(res.flagged, false);
    }
  } finally { cleanup(root); }
});

test('flail advisory counts a path WITH SPACES whole (not truncated at the first space) — T18 F4', async () => {
  // extractPath's `Editing <path>` pattern captures `[^\s]+`, so a spaced path
  // ("src/my dir/churny.js") would be truncated to "src/my" and mis-attributed.
  // The hook must encode window entries in the `"file_path":"<path>"` shape,
  // whose `[^"]+` capture keeps the whole path. RED under the old `Editing`
  // format: churn would report { path: 'src/my', count: 3 }.
  const root = fixture({ tickets: RAILED });
  try {
    const now = Date.now();
    const spaced = 'src/my dir/churny.js';
    seedWindow(root, [
      { ts: now - 1000, path: spaced },
      { ts: now - 500, path: spaced },
    ]);
    const res = await flailCheck(payload(spaced), { root, now });
    assert.equal(res.flagged, true);
    assert.deepEqual(res.churn, [{ path: spaced, count: 3 }], 'the spaced path must be counted whole, not truncated at the space');
  } finally { cleanup(root); }
});

test('flail window is TTL-scoped: entries older than SESSION_TTL_MS are pruned, not counted', async () => {
  const root = fixture({ tickets: RAILED });
  try {
    const now = Date.now();
    seedWindow(root, [
      { ts: now - SESSION_TTL_MS - 60_000, path: 'src/churny.js' },
      { ts: now - SESSION_TTL_MS - 30_000, path: 'src/churny.js' },
    ]);
    const res = await flailCheck(payload('src/churny.js'), { root, now });
    assert.equal(res.flagged, false, 'stale (previous-session) edits must not count toward churn');
    const kept = readFileSync(windowPath(root), 'utf8').trim().split('\n');
    assert.equal(kept.length, 1, 'stale entries are pruned from the persisted window');
  } finally { cleanup(root); }
});

test('flail check SKIPS (creates nothing) in a repo with no .adlc/', async () => {
  const root = fixture();
  try {
    const res = await flailCheck(payload('src/a.js'), { root });
    assert.deepEqual(res, { flagged: false, skipped: true });
    assert.ok(!existsSync(join(root, '.adlc')), 'must not create .adlc in a non-ADLC repo');
  } finally { cleanup(root); }
});

test('a flail-detector import failure degrades silently and never breaks the audit', async () => {
  const root = fixture({ tickets: RAILED });
  try {
    const res = await flailCheck(payload('src/a.js'), {
      root,
      importModule: async () => { throw new Error('simulated missing @adlc/flail-detector'); },
    });
    assert.equal(res.flagged, false);
  } finally { cleanup(root); }
});

test('the churn heuristic is IMPORTED from @adlc/flail-detector (no local copy)', () => {
  const src = readFileSync(join(HERE, '..', 'hooks', 'adlc-audit.mjs'), 'utf8');
  assert.ok(src.includes('@adlc/flail-detector/lib/signals.mjs'), 'must import the flail-detector lib subpath');
  assert.ok(!/function\s+detectEditChurn\s*\(/.test(src), 'must not hand-copy detectEditChurn');
});

// --- hollow-test survivors (T18 P5 amendment) --------------------------------

test('pathless payload: flailCheck returns EXACTLY { flagged: false } and persists nothing', async () => {
  const root = fixture({ tickets: RAILED });
  try {
    // No path under any known key — the check must bail out silently.
    const res = await flailCheck({ tool_name: 'edit' }, { root });
    assert.deepEqual(res, { flagged: false }, 'a pathless payload must report flagged:false (not true, not skipped)');
    assert.ok(!existsSync(windowPath(root)), 'a pathless payload must not touch the recent-edits window');
  } finally { cleanup(root); }
});

test('wire format: a pathless payload is SILENT (no stderr) and still emits the no-op {}', () => {
  const root = fixture({ tickets: RAILED });
  try {
    const r = spawnSync(process.execPath, [AUDIT_SCRIPT], {
      cwd: root,
      env: { ...process.env },
      input: JSON.stringify({ tool_name: 'edit', workspace_roots: [root] }),
      encoding: 'utf8',
    });
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), {});
    assert.equal(r.stderr, '', 'a pathless payload must produce no advisory noise');
  } finally { cleanup(root); }
});

test('multi-root workspace, no explicit root: flailCheck resolves the OWNING root from paths[0]', async () => {
  // repo-a (first root, NOT an ADLC repo) + repo-b (ADLC-initialized, owns the
  // edited path). The check must attribute the edit to repo-b — picking the
  // first root blindly (or looking past paths[0]) would silently skip.
  const repoA = fixture();
  const repoB = fixture({ tickets: RAILED });
  try {
    const now = Date.now();
    const abs = join(repoB, 'src', 'churny.js');
    seedWindow(repoB, [
      { ts: now - 1000, path: abs },
      { ts: now - 500, path: abs },
    ]);
    const res = await flailCheck({ file_path: abs, workspace_roots: [repoA, repoB] }, { now });
    assert.equal(res.flagged, true, 'the churn window lives in repo-b: the owning root must be resolved from paths[0]');
    assert.deepEqual(res.churn, [{ path: abs, count: 3 }]);
  } finally { cleanup(repoA); cleanup(repoB); }
});

test('afterFileEdit-shaped payload (bare top-level file_path, no tool bag) is still audited', () => {
  // Regression pin for the afterFileEdit wire shape: the path arrives as a bare
  // top-level scalar. NOTE: extractFilePaths() already reads file_path/filePath/
  // path at the top level, so this shape is served by the batch extractor itself;
  // the firstAfterEditPath() fallback behind it is defensive redundancy that only
  // becomes live if the shared extractor is ever narrowed.
  const root = fixture({ tickets: RAILED });
  try {
    assert.equal(audit({ file_path: 'src/frozen.js' }, { root, env: env() }).rail, true);
    assert.equal(audit({ file_path: 'src/free.js' }, { root, env: env() }).rail, false);
  } finally { cleanup(root); }
});

// --- rail audit unchanged ----------------------------------------------------

test('rail audit unchanged: rail touch observed, non-rail silent, never blocks', () => {
  const root = fixture({ tickets: RAILED });
  try {
    const hit = audit({ tool_name: 'edit', file_path: 'src/frozen.js' }, { root, env: env() });
    assert.equal(hit.rail, true);
    const miss = audit({ tool_name: 'edit', file_path: 'src/free.js' }, { root, env: env() });
    assert.equal(miss.rail, false);
  } finally { cleanup(root); }
});

test('wire format: the audit script still emits the no-op {} verdict (cannot block)', () => {
  const root = fixture({ tickets: RAILED });
  try {
    const out = execFileSync(process.execPath, [AUDIT_SCRIPT], {
      cwd: root,
      env: { ...process.env, ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' },
      input: JSON.stringify({ tool_name: 'edit', file_path: 'src/frozen.js', workspace_roots: [root] }),
    }).toString();
    assert.deepEqual(JSON.parse(out), {});
  } finally { cleanup(root); }
});

test('wire format: churn advisory reaches stderr from the real script; verdict stays the no-op {}', () => {
  const root = fixture({ tickets: RAILED });
  try {
    const now = Date.now();
    seedWindow(root, [
      { ts: now - 1000, path: 'src/churny.js' },
      { ts: now - 500, path: 'src/churny.js' },
    ]);
    const r = spawnSync(process.execPath, [AUDIT_SCRIPT], {
      cwd: root,
      env: { ...process.env },
      input: JSON.stringify({ tool_name: 'edit', file_path: 'src/churny.js', workspace_roots: [root] }),
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, 'the audit hook must always exit 0');
    assert.deepEqual(JSON.parse(r.stdout), {}, 'the verdict must remain the no-op object');
    assert.match(r.stderr, /FLAIL signal/, 'the churn advisory must reach stderr');
    assert.match(r.stderr, /src\/churny\.js/);
  } finally { cleanup(root); }
});

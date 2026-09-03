// Concern: loadTicketsForTier (bin/adlc-prosecute.mjs) unions the base-tip and
// worktree/HEAD ticket tables without resolving a shared ticket id, so a branch
// cut BEFORE a ticket completes on main still carries its own stale, not-yet-
// completed copy of that ticket. classifyTrustRootTier's per-object filter
// (#905) only exempts a ticket when the SPECIFIC object it sees says
// completed: true — the stale HEAD copy still says completed: false/undefined,
// so it still contributes its rails deny-path reason even though the ticket is
// authoritatively completed at the base tip.
//
// Fix: merge duplicate ticket ids across sources BEFORE classification, with
// base-tip precedence for `completed` — matching rail-freeze's own trust
// anchor ("completed is read from the BASE TIP, never HEAD"). A base-active
// ticket must still override a HEAD-only completion claim (the existing #905
// security property: a HEAD-only edit cannot self-exempt a ticket that is
// still active at the base). Rails are unioned across duplicate copies so a
// widening edit is not lost.
//
// End-to-end at the process boundary in a real git repo, mirroring
// tier-merge-base.test.mjs's fixture shape.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;

process.env.ADLC_MANIFEST_KEY = 'test-tier-completed-merge-signing-key';

function runBin(args, cwd, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const PINNED_GIT_DATE = '2026-01-01T00:00:00Z';

function scratchRepo({ baseTickets, mutate, advanceBase }) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-tier-completed-merge-'));
  const g = (...a) => execFileSync('git', a, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_AUTHOR_DATE: PINNED_GIT_DATE, GIT_COMMITTER_DATE: PINNED_GIT_DATE },
  });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 'tester');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'baseline\n');
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets: baseTickets }));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.mjs'), 'export const x = 0;\n');
  g('add', '-A'); g('commit', '-qm', 'baseline');
  g('checkout', '-q', '-b', 'feat');
  mutate(dir, g);
  g('add', '-A'); g('commit', '-qm', 'feat change');
  if (advanceBase) {
    g('checkout', '-q', 'main');
    advanceBase(dir, g);
    g('add', '-A'); g('commit', '-qm', 'main advances after the branch point');
    g('checkout', '-q', 'feat');
  }
  return { dir, g };
}

const T = (over = {}) => ({ id: 'T1', title: 'x', scope: ['src/**'], rails: ['src/**'], edges: [], ...over });
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });
const editRail = (d) => writeFileSync(join(d, 'src', 'app.mjs'), 'export const x = 1; // feat edit\n');

describe('loadTicketsForTier merges duplicate ticket ids with base-tip precedence for `completed` (#905 follow-up)', () => {
  it('a stale HEAD copy of a ticket main later completes no longer tiers the change (was: tiered)', () => {
    // feat branches BEFORE T1 completes; T1 is still active on feat's own copy.
    // main later marks T1 completed. feat edits src/app.mjs, a T1 rail.
    const { dir } = scratchRepo({
      baseTickets: [T()], // completed: undefined
      mutate: editRail,
      advanceBase: (d) => writeFileSync(join(d, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [T({ completed: true })] })),
    });
    try {
      const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc'], dir);
      assert.equal(r.status, 0, `base-tip completion must suppress the stale HEAD copy's rails: ${r.stderr}`);
      assert.match(r.stdout, /NOT trust-root tier/);
    } finally { cleanup(dir); }
  });

  it('a base-ACTIVE ticket still overrides a HEAD-only completion claim (existing #905 security property preserved)', () => {
    // feat's own (HEAD) copy claims completed: true, but main's base-tip copy is
    // still active — the merge must not let the HEAD-only claim self-exempt.
    const { dir } = scratchRepo({
      baseTickets: [T()], // completed: undefined, still active at base
      mutate: (d) => {
        writeFileSync(join(d, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [T({ completed: true })] }));
        editRail(d);
      },
    });
    try {
      const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc'], dir);
      assert.equal(r.status, 2, 'a HEAD-only completion claim must not exempt a ticket still active at the base');
      assert.match(r.stderr, /T1/);
    } finally { cleanup(dir); }
  });

  it('a null entry in a --dir ticket table is skipped, not crashed on or misclassified', () => {
    // readTicketArray (the --dir custom source) does no schema validation, so a
    // genuinely non-object entry can reach mergeTicketsById's per-entry guard.
    // A well-formed ticket (T2, rails matching the changed file) sits alongside
    // it in the SAME array, so the guard must skip the garbage without dropping
    // or misclassifying the real ticket.
    const { dir } = scratchRepo({ baseTickets: [T({ rails: [] })], mutate: editRail });
    try {
      mkdirSync(join(dir, 'custom'), { recursive: true });
      writeFileSync(join(dir, 'custom', 'tickets.json'), JSON.stringify({
        tickets: [null, T({ id: 'T2' })],
      }));
      const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', 'custom'], dir);
      assert.equal(r.status, 2, 'the well-formed ticket in the same array must still tier the change');
      assert.match(r.stderr, /T2/);
    } finally { cleanup(dir); }
  });

  it('an entry with no usable string id still contributes its rails — dedup-by-id must not narrow the tier surface', () => {
    // mergeTicketsById cannot DEDUPLICATE an id-less entry, but pre-#905 the
    // unmerged union already tiered on such an entry's rails regardless of
    // `id`'s type (classifyTrustRootTier only ever reads `ticket?.rails`, never
    // `ticket.id`, to decide whether a rail applies). Silently dropping the
    // entry here would be a NEW narrowing this merge step must not introduce.
    const { dir } = scratchRepo({ baseTickets: [T({ rails: [] })], mutate: editRail });
    try {
      mkdirSync(join(dir, 'custom'), { recursive: true });
      writeFileSync(join(dir, 'custom', 'tickets.json'), JSON.stringify({
        tickets: [{ title: 'no id at all', rails: ['src/**'] }, { id: 42, title: 'numeric id', rails: ['docs/**'] }],
      }));
      const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', 'custom'], dir);
      assert.equal(r.status, 2, 'the id-less entry\'s matching rail must still tier the change');
      assert.match(r.stderr, /src\/\*\*/);
    } finally { cleanup(dir); }
  });

  it('a `tickets: null` custom table fails closed (exit 1), never silently treated as absent', () => {
    // `parsed?.tickets ?? []` collapses a PRESENT `tickets: null` and a GENUINELY
    // ABSENT `tickets` key to the same empty array; only the absent-key case may
    // read as "nothing to check".
    const { dir } = scratchRepo({ baseTickets: [T({ rails: [] })], mutate: editRail });
    try {
      mkdirSync(join(dir, 'custom'), { recursive: true });
      writeFileSync(join(dir, 'custom', 'tickets.json'), JSON.stringify({ tickets: null }));
      const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', 'custom'], dir);
      assert.equal(r.status, 1, 'a present but null `tickets` field must be an operational error');
      assert.match(r.stderr, /tickets.*field/i);
    } finally { cleanup(dir); }
  });

  it('a custom ticket table whose top-level JSON is not an object (e.g. bare `null`) fails closed, never crashes uncaught', () => {
    // `'tickets' in parsed` throws a TypeError if `parsed` is null (or any
    // non-object) — the top-level-shape guard must reject it BEFORE that `in`
    // check runs, with the same clean operational-error message every other
    // malformed-table case uses, not an uncaught crash with unrelated text.
    const { dir } = scratchRepo({ baseTickets: [T({ rails: [] })], mutate: editRail });
    try {
      mkdirSync(join(dir, 'custom'), { recursive: true });
      writeFileSync(join(dir, 'custom', 'tickets.json'), 'null');
      const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', 'custom'], dir);
      assert.equal(r.status, 1, 'a bare `null` ticket table must be a clean operational error');
      assert.match(r.stderr, /does not contain a JSON object/);
    } finally { cleanup(dir); }
  });

  it('a genuinely absent `tickets` key still reads as an empty table (no regression)', () => {
    const { dir } = scratchRepo({ baseTickets: [T({ rails: [] })], mutate: editRail });
    try {
      mkdirSync(join(dir, 'custom'), { recursive: true });
      writeFileSync(join(dir, 'custom', 'tickets.json'), JSON.stringify({ other: 'field' }));
      const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', 'custom'], dir);
      assert.equal(r.status, 0, 'an absent `tickets` key contributes nothing, same as an absent file');
    } finally { cleanup(dir); }
  });

  it('a --dir ticket table whose `tickets` field is not an array fails closed (exit 1), never silently treated as empty', () => {
    // readTicketArray parses the file fine (valid JSON) but the `tickets` field
    // itself is an object, not an array — the same "exists and is malformed"
    // case the JSON-parse-failure branch already throws on. Without validating
    // the array shape, mergeTicketsById's defensive Array.isArray fallback
    // silently drops this source's rails entirely (fail open).
    const { dir } = scratchRepo({ baseTickets: [T({ rails: [] })], mutate: editRail });
    try {
      mkdirSync(join(dir, 'custom'), { recursive: true });
      writeFileSync(join(dir, 'custom', 'tickets.json'), JSON.stringify({ tickets: { T1: 'not an array' } }));
      const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', 'custom'], dir);
      assert.equal(r.status, 1, 'a non-array `tickets` field must be an operational error, never a silent empty table');
      assert.match(r.stderr, /tickets.*field/i);
    } finally { cleanup(dir); }
  });

  it('rails are unioned across duplicate copies, not just replaced by the base-tip copy', () => {
    // Base declares T1 with no rails; feat's own HEAD copy of T1 (not yet synced
    // to base) already carries a widened rails set. The widened rail must still
    // apply (union), even though `completed` precedence comes from base.
    const { dir } = scratchRepo({
      baseTickets: [T({ rails: [] })],
      mutate: (d) => {
        writeFileSync(join(d, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [T({ rails: ['src/**'] })] }));
        editRail(d);
      },
    });
    try {
      const r = runBin(['tier-check', '--base', 'main', '--author-provider', 'anthropic', '--dir', '.adlc'], dir);
      assert.equal(r.status, 2, 'the HEAD copy widening the rails set must still be honoured');
      assert.match(r.stderr, /T1/);
    } finally { cleanup(dir); }
  });
});

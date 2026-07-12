// roundtrip.test.mjs — producer→consumer round-trip coverage (T40 / #104).
//
// ticket-sync is the OTHER `.adlc/tickets.json` producer. Its additive writes
// (adopting a new remote issue as a new ticket) must merge through the same
// CONSUMER gate `ticket-prune` has to satisfy: `scripts/rails-guard-ci.mjs`.
//
// This test runs the REAL `pull` (offline, via an injected fake provider — no
// network) with --write against a temp git repo, commits its ACTUAL additive
// tickets.json output, then runs the REAL `scripts/rails-guard-ci.mjs` on the
// committed diff and asserts the gate ACCEPTS it (exit 0). Nothing is mocked but
// the GitHub provider (whose job is only to hand `pull` the issue list offline).
//
// Load-bearing, not trivial: the base ticket is RAILED, so rails are genuinely
// ACTIVE at base — the gate runs its full rail-glob + base-contract-preservation
// check, and exit 0 means "the additive write preserved every base ticket and
// touched no frozen path", exactly what a producer must guarantee.
//
// Offline, leaves no trace (mkdtempSync temp dirs + scratch git repos inside them).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pull } from '../lib/pull.mjs';
import { push } from '../lib/push.mjs';
import { serializeBlock } from '../lib/block.mjs';
import { githubProvider } from '../lib/providers/github.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// The REAL consumer gate, resolved from the repo root (packages/ticket-sync/test → root).
const RAILS_GUARD_CI = join(HERE, '..', '..', '..', 'scripts', 'rails-guard-ci.mjs');

function git(dir, args) {
  execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
}

/** Run the REAL rails-guard-ci gate (subprocess) against base=main in `dir`. */
function runRailsGuardCi(dir) {
  try {
    execFileSync(process.execPath, [RAILS_GUARD_CI, 'main'], { cwd: dir, stdio: 'pipe' });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
}

// Offline fake provider (same shape validity.test.mjs uses).
const fakeProvider = (issues) => ({ listIssues: async () => ({ ok: true, issues }) });
const issue = (number, block, prose = 'desc') => ({
  number, nodeId: `N${number}`, url: `https://github.com/acme/app/issues/${number}`,
  title: `issue ${number}`, body: serializeBlock({ prefix: `${prose}\n`, suffix: '' }, block), labels: [], state: 'open',
});

test('AC2: pull --write adds a new ticket to .adlc/tickets.json, and the REAL committed additive diff is ACCEPTED by the REAL rails-guard-ci → exit 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-sync-rt-'));
  try {
    // ── base commit on main: an existing RAILED, in-flight ticket + its rail file.
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'a@b.c']);
    git(dir, ['config', 'user.name', 'x']);
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    const baseTickets = {
      tickets: [{ id: 'T1', title: 'existing in-flight work', scope: ['src/x/**'], rails: ['src/guarded/**'] }],
    };
    writeFileSync(join(dir, '.adlc', 'tickets.json'), `${JSON.stringify(baseTickets, null, 2)}\n`);
    mkdirSync(join(dir, 'src', 'guarded'), { recursive: true });
    writeFileSync(join(dir, 'src', 'guarded', 'thing.mjs'), 'frozen\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'base']);
    git(dir, ['checkout', '-q', '-b', 'feat']);

    // ── config.json is written to disk for `pull` to read, but is DELIBERATELY
    //    NOT committed: rails-guard-ci reads `baseHasConfig` from the base tree,
    //    and an added-in-PR .adlc/config.json would trip the trust-root guard
    //    (config.json is an immutable trust root once base rails exist). Keeping
    //    it untracked keeps the PR diff to exactly the additive tickets.json write.
    writeFileSync(
      join(dir, '.adlc', 'config.json'),
      JSON.stringify({ ticketSync: { provider: 'github', repo: 'acme/app' } }),
    );

    // ── run the REAL producer: adopt a new remote issue as a new local ticket.
    const r = await pull({
      dir,
      provider: fakeProvider([issue(1, { scope: ['src/newfeature/**'], duration: 1 })]),
      write: true,
      now: 'T',
    });
    assert.equal(r.exitCode, 0, `pull --write must succeed: ${JSON.stringify(r.errors)}`);

    // Prove the ACTUAL additive output: T1 preserved, a NEW gh ticket added.
    const after = JSON.parse(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8'));
    const ids = after.tickets.map((t) => t.id);
    assert.ok(ids.includes('T1'), 'existing base ticket preserved');
    assert.ok(ids.includes('gh:acme/app#1'), 'new ticket added by the real writer');

    // Commit ONLY the tickets.json change (config/sidecar stay untracked).
    git(dir, ['add', '.adlc/tickets.json']);
    git(dir, ['commit', '-qm', 'ticket-sync: adopt gh:acme/app#1']);

    // ── run the REAL consumer gate on the real additive diff.
    assert.equal(runRailsGuardCi(dir), 0, 'the additive tickets.json write must merge through the gate');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── AC2 (push writer): the SECOND tickets.json writer — push.mjs writeTicketsAtomic ──
//
// The pull test above exercises pull.mjs's writeTicketsAtomic; push.mjs has its
// OWN writeTicketsAtomic callsite (push.mjs:292, when a local-only ticket is
// created and its id reassigned to gh:<repo>#<n>). That write must ALSO merge
// through rails-guard-ci. This drives the REAL `push --write` with an OFFLINE
// stateful fake `gh` runner (network boundary only — the real githubProvider and
// the real write path both run), commits its additive tickets.json output, and
// asserts the REAL gate accepts it.

// Stateful offline fake `gh` runner (mirrors packages/ticket-sync/test/github.test.mjs
// — stubs ONLY the network boundary, so push's real create→reassign→write path runs).
function fakeGitHub({ issues = [], login = 'bot' } = {}) {
  const state = { issues: issues.map((i) => ({ labels: [], comments: [], state: 'open', ...i })) };
  let seq = Math.max(0, ...state.issues.map((i) => i.number));
  const mutating = [];
  const find = (n) => state.issues.find((i) => String(i.number) === String(n));
  const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '', error: null });
  const runner = async (args) => {
    const [a0, a1] = args;
    if (a0 === 'issue' && a1 === 'list') {
      const want = [];
      for (let k = 0; k < args.length; k++) if (args[k] === '--label') want.push(args[k + 1]);
      const selected = state.issues.filter((i) => want.every((l) => i.labels.includes(l)));
      return ok(JSON.stringify(selected.map((i) => ({
        id: i.id, number: i.number, title: i.title, body: i.body,
        labels: i.labels.map((name) => ({ name })), state: i.state.toUpperCase(), url: i.url,
      }))));
    }
    if (a0 === 'api' && a1 === 'user') return ok(JSON.stringify({ login }));
    if (a0 === 'issue' && a1 === 'view') {
      const i = find(args[2]);
      const fields = args[args.indexOf('--json') + 1];
      if (!i) return { ok: false, code: 1, stdout: '', stderr: 'not found', error: 'not found' };
      if (fields.includes('comments')) return ok(JSON.stringify({ comments: i.comments }));
      const out = { id: i.id, number: i.number, url: i.url };
      if (fields.includes('labels')) out.labels = i.labels.map((name) => ({ name }));
      if (fields.includes('state')) out.state = i.state.toUpperCase();
      if (fields.includes('body')) out.body = i.body;
      return ok(JSON.stringify(out));
    }
    if (a0 === 'issue' && a1 === 'create') {
      mutating.push(args);
      seq += 1;
      const number = seq;
      const labels = [];
      for (let k = 0; k < args.length; k++) if (args[k] === '--label') labels.push(args[k + 1]);
      state.issues.push({
        number, id: `I_${number}`, url: `https://github.com/acme/app/issues/${number}`,
        title: args[args.indexOf('--title') + 1], body: args[args.indexOf('--body') + 1],
        labels, state: 'open', comments: [],
      });
      return ok(`https://github.com/acme/app/issues/${number}\n`);
    }
    if (a0 === 'label' && a1 === 'create') { mutating.push(args); return ok(); }
    if (a0 === 'issue' && a1 === 'edit') {
      mutating.push(args);
      const i = find(args[2]);
      for (let k = 0; k < args.length; k++) {
        if (args[k] === '--add-label' && !i.labels.includes(args[k + 1])) i.labels.push(args[k + 1]);
        if (args[k] === '--remove-label') i.labels = i.labels.filter((l) => l !== args[k + 1]);
      }
      return ok();
    }
    if (a0 === 'issue' && a1 === 'comment') {
      mutating.push(args);
      const i = find(args[2]);
      const cid = 1000 + i.comments.length + 1;
      i.comments.push({ author: { login }, body: args[args.indexOf('--body') + 1], url: `${i.url}#issuecomment-${cid}` });
      return ok();
    }
    return { ok: false, code: 1, stdout: '', stderr: `unhandled: ${args.join(' ')}`, error: `unhandled: ${args.join(' ')}` };
  };
  return { runner, state, mutating };
}

const PUSH_CONFIG = {
  ticketSync: {
    provider: 'github', repo: 'acme/app',
    select: { state: 'open', labels: ['adlc'] }, createLabel: 'adlc',
    statusLabels: { 'p5-pass': 'adlc:passed', 'p5-fail': 'adlc:failed', wip: 'adlc:in-progress' },
  },
};

test('AC2 (push): ticket-sync push --write creates a local ticket (writeTicketsAtomic reassign path), and the REAL committed additive diff is ACCEPTED by the REAL rails-guard-ci → exit 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-sync-push-rt-'));
  try {
    // ── base on main: an existing SYNCED, RAILED, in-flight ticket + its rail file.
    //    (An already-`gh:` id that is NOT in the push selection is skipped by push's
    //    update pass, so it is preserved byte-for-byte — the base-contract the gate
    //    enforces — while rails stay ACTIVE so the exit 0 is non-trivial.)
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'a@b.c']);
    git(dir, ['config', 'user.name', 'x']);
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    const baseTickets = {
      tickets: [{ id: 'gh:acme/app#5', title: 'existing synced work', scope: ['src/x/**'], rails: ['src/guarded/**'], duration: 1 }],
    };
    writeFileSync(join(dir, '.adlc', 'tickets.json'), `${JSON.stringify(baseTickets, null, 2)}\n`);
    mkdirSync(join(dir, 'src', 'guarded'), { recursive: true });
    writeFileSync(join(dir, 'src', 'guarded', 'thing.mjs'), 'frozen\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'base']);
    git(dir, ['checkout', '-q', '-b', 'feat']);

    // ── config.json written for push to read, DELIBERATELY not committed (same
    //    trust-root reasoning as the pull test).
    writeFileSync(join(dir, '.adlc', 'config.json'), JSON.stringify(PUSH_CONFIG));

    // ── a NEW local-only ticket lands in the working tree (as /adlc-ticket would
    //    add it), alongside the preserved synced ticket. NO manifest → migrate is a
    //    no-op → no untracked manifest.jsonl for the gate to reject.
    const working = {
      tickets: [
        baseTickets.tickets[0],
        { id: 'T7', title: 'new local work', scope: ['src/newfeature/**'], duration: 1 },
      ],
    };
    writeFileSync(join(dir, '.adlc', 'tickets.json'), `${JSON.stringify(working, null, 2)}\n`);

    // ── run the REAL producer: push creates T7 and reassigns it → gh:acme/app#1,
    //    writing tickets.json via writeTicketsAtomic (push.mjs:292).
    const gh = fakeGitHub(); // empty remote → #5 is not in the selection (skipped), T7 creates as #1
    const r = await push({ dir, provider: githubProvider(), runner: gh.runner, write: true, now: 'T', uuid: () => 'K' });
    assert.equal(r.exitCode, 0, `push --write must succeed: ${JSON.stringify(r.errors)}`);

    // Prove the ACTUAL additive output of the push write path.
    const outTickets = JSON.parse(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8')).tickets;
    const ids = outTickets.map((t) => t.id);
    assert.ok(ids.includes('gh:acme/app#5'), 'existing synced base ticket preserved by push');
    assert.ok(ids.includes('gh:acme/app#1'), 'T7 was created and reassigned by the real push writer');
    assert.ok(!ids.includes('T7'), 'the local T7 id was reassigned, not left behind');

    // Guard the manifest assumption: push must not have emitted an untracked
    // manifest.jsonl (which rails-guard-ci would reject) for a ticket with no evidence.
    assert.equal(
      execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).includes('manifest.jsonl'),
      false,
      'no untracked manifest.jsonl should exist',
    );

    // Commit ONLY the tickets.json change (config/sidecar stay untracked).
    git(dir, ['add', '.adlc/tickets.json']);
    git(dir, ['commit', '-qm', 'ticket-sync push: create gh:acme/app#1']);

    // ── run the REAL consumer gate on the real additive diff.
    assert.equal(runRailsGuardCi(dir), 0, 'the push additive tickets.json write must merge through the gate');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

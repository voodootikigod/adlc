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
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pull } from '../lib/pull.mjs';
import { push } from '../lib/push.mjs';
import { serializeBlock } from '../lib/block.mjs';
import { githubProvider } from '../lib/providers/github.mjs';
import { createHmac } from 'node:crypto';
import { recordTicketEvidence, segmentPath, canonicalJson } from '@adlc/tickets';
import { sha256 } from '@adlc/core';

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
      // T1 declares a rail, so the store is a frozen trust root and the sync's
      // write is an audited override that must be signable
      // (packages/tickets/test/bypass-audit.test.mjs). The audit entry lands in
      // the untracked manifest; the committed diff below is still tickets-only,
      // which is exactly what this test puts in front of the real gate.
      key: 'test-manifest-key',
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
    // Frozen trust root, as in the pull case above — the write must be signable.
    const r = await push({ dir, provider: githubProvider(), runner: gh.runner, write: true, now: 'T', uuid: () => 'K', key: 'test-manifest-key' });
    assert.equal(r.exitCode, 0, `push --write must succeed: ${JSON.stringify(r.errors)}`);

    // Prove the ACTUAL additive output of the push write path.
    const outTickets = JSON.parse(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8')).tickets;
    const ids = outTickets.map((t) => t.id);
    assert.ok(ids.includes('gh:acme/app#5'), 'existing synced base ticket preserved by push');
    assert.ok(ids.includes('gh:acme/app#1'), 'T7 was created and reassigned by the real push writer');
    assert.ok(!ids.includes('T7'), 'the local T7 id was reassigned, not left behind');

    // The manifest assumption, restated for a frozen trust root. The base ticket
    // declares a rail, so the store IS one, and the audited-override contract
    // (packages/tickets/test/bypass-audit.test.mjs) means this sync deliberately
    // records one signed entry — the previous expectation of "no manifest at all"
    // held only while such a write went unaudited. What must still hold, and is
    // what the gate below actually reads, is that the entry stays OUT of the
    // committed diff: the PR is tickets-only.
    const manifest = join(dir, '.adlc', 'manifest.jsonl');
    const audit = readFileSync(manifest, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(audit.length, 1, 'one mutation, one audit entry');
    assert.equal(audit[0].data.bypass, true);
    assert.ok(audit[0].sig, 'and it is signed');
    assert.match(
      execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }),
      /\?\? \.adlc\/manifest\.jsonl/,
      'the audit entry is untracked here, so it never enters the reviewed diff',
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

// The other half of the invariant the push test above used to carry alone: the
// audited-override contract is scoped to frozen trust roots, so a sync against a
// store where NO ticket declares a rail must still emit nothing at all. Without
// this, "records an entry" could silently spread to every routine sync — manifest
// noise on repos that never opted into rails, and a keyless refusal where none was
// ever intended.
// The refusal has to come before the REMOTE writes. Reaching it only at
// writeTicketsAtomic means the push has already created issues upstream, and the
// operator is left with remote and local disagreeing over a missing key.
test('a keyless push against a frozen trust root refuses BEFORE it touches the remote', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-sync-push-refuse-'));
  try {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'a@b.c']);
    git(dir, ['config', 'user.name', 'x']);
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'tickets.json'), `${JSON.stringify({ tickets: [
      { id: 'T-RAILED', title: 'railed in-flight', scope: ['src/x/**'], rails: ['src/guarded/**'], duration: 1 },
      { id: 'T7', title: 'new local work', scope: ['src/newfeature/**'], duration: 1 },
    ] }, null, 2)}\n`);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'base']);
    writeFileSync(join(dir, '.adlc', 'config.json'), JSON.stringify(PUSH_CONFIG));
    const before = readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8');

    const gh = fakeGitHub();
    const r = await push({ dir, provider: githubProvider(), runner: gh.runner, write: true, now: 'T', uuid: () => 'K' });

    // 2 = BLOCKED by policy, not 1 = operational failure: automation has to tell a
    // deliberate refusal apart from a transient error it should retry.
    assert.equal(r.exitCode, 2);
    assert.match(r.errors.join('\n'), /ADLC_MANIFEST_KEY/);
    assert.equal(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8'), before, 'local store untouched');
    assert.equal(existsSync(join(dir, '.adlc', 'manifest.jsonl')), false, 'and nothing recorded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The opt-out has to reach the LOCAL write, not just the preflight: accepting it,
// clearing the preflight, creating the remote issue, and then refusing at
// writeTicketsAtomic is the worst of both — the flag was honoured just far enough
// to do the irreversible half.
test('a keyless push with --allow-unsigned completes the local write it was granted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-sync-push-unsigned-'));
  try {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'a@b.c']);
    git(dir, ['config', 'user.name', 'x']);
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'tickets.json'), `${JSON.stringify({ tickets: [
      { id: 'T-RAILED', title: 'railed in-flight', scope: ['src/x/**'], rails: ['src/guarded/**'], duration: 1 },
      { id: 'T7', title: 'new local work', scope: ['src/newfeature/**'], duration: 1 },
    ] }, null, 2)}\n`);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'base']);
    writeFileSync(join(dir, '.adlc', 'config.json'), JSON.stringify(PUSH_CONFIG));

    const gh = fakeGitHub();
    const r = await push({
      dir, provider: githubProvider(), runner: gh.runner, write: true, now: 'T', uuid: () => 'K',
      allowUnsigned: true,
    });

    assert.equal(r.exitCode, 0, `push must complete: ${JSON.stringify(r.errors)}`);
    const ids = JSON.parse(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8')).tickets.map((t) => t.id);
    assert.ok(ids.includes('gh:acme/app#1'), 'the local reassignment landed, not just the remote create');
    assert.ok(!ids.includes('T7'));
    const audit = readFileSync(join(dir, '.adlc', 'manifest.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(audit.length, 1);
    assert.equal(audit[0].data.bypass, true);
    assert.equal(audit[0].sig, undefined, 'recorded unsigned, exactly as asked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// pull's opt-out defaults OFF, same as everything else here. A default of ON would
// mean every routine sync of a frozen trust root quietly wrote unsigned evidence.
test('pull defaults allowUnsigned OFF: a keyless pull into a frozen trust root refuses', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-sync-pull-default-'));
  try {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'a@b.c']);
    git(dir, ['config', 'user.name', 'x']);
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'tickets.json'), `${JSON.stringify({ tickets: [
      { id: 'T1', title: 'railed in-flight', scope: ['src/x/**'], rails: ['src/guarded/**'] },
    ] }, null, 2)}\n`);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'base']);
    writeFileSync(join(dir, '.adlc', 'config.json'), JSON.stringify({ ticketSync: { provider: 'github', repo: 'acme/app' } }));
    const before = readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8');

    const refused = await pull({ // allowUnsigned OMITTED
      dir, provider: fakeProvider([issue(1, { scope: ['src/newfeature/**'], duration: 1 })]), write: true, now: 'T',
    });
    assert.equal(refused.exitCode, 2, 'blocked by policy, not an operational failure');
    assert.match(refused.errors.join('\n'), /ADLC_MANIFEST_KEY/);
    assert.equal(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8'), before, 'and the store is untouched');

    // The opt-out, passed explicitly, is what gets through.
    const allowed = await pull({
      dir, provider: fakeProvider([issue(1, { scope: ['src/newfeature/**'], duration: 1 })]), write: true, now: 'T',
      allowUnsigned: true,
    });
    assert.equal(allowed.exitCode, 0, `pull --allow-unsigned must apply: ${JSON.stringify(allowed.errors)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A push whose tickets are all already remote ids never writes the local store, so
// it owes no audit and must not be refused for a missing key. Over-refusing here
// would block routine label and status-comment updates on any railed repo.
test('a remote-only push against a frozen trust root needs no key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-sync-remote-only-'));
  try {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'a@b.c']);
    git(dir, ['config', 'user.name', 'x']);
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    // Every ticket already carries a remote id — nothing to create or reassign.
    writeFileSync(join(dir, '.adlc', 'tickets.json'), `${JSON.stringify({ tickets: [
      { id: 'gh:acme/app#5', title: 'railed in-flight', scope: ['src/x/**'], rails: ['src/guarded/**'], duration: 1 },
    ] }, null, 2)}\n`);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'base']);
    writeFileSync(join(dir, '.adlc', 'config.json'), JSON.stringify(PUSH_CONFIG));
    const before = readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8');

    const gh = fakeGitHub();
    const r = await push({ dir, provider: githubProvider(), runner: gh.runner, write: true, now: 'T', uuid: () => 'K' });

    assert.notEqual(
      (r.errors ?? []).join('\n').includes('ADLC_MANIFEST_KEY'),
      true,
      'a push that cannot touch the local store must not demand a signing key',
    );
    assert.equal(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8'), before, 'and indeed it did not');
    assert.equal(existsSync(join(dir, '.adlc', 'manifest.jsonl')), false, 'nothing recorded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A repo can be a trust root with NO ticket store present — the marker lives in the
// manifest. Initializing the store before the refusal would leave .adlc/tickets/ and
// .adlc/ticket-archive/ behind for a write that never happened.
test('a keyless pull into a store-less trust root refuses without creating the store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-sync-storeless-'));
  try {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'a@b.c']);
    git(dir, ['config', 'user.name', 'x']);
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    // No ticket store at all, but a recorded override says this repo uses rails.
    writeFileSync(join(dir, '.adlc', 'manifest.jsonl'), `${JSON.stringify({
      seq: 1, gate: 'rails-bypass', ts: 'T', data: { path: 'src/x', reason: 'r' }, files: {}, prev: null,
    })}\n`);
    writeFileSync(join(dir, '.adlc', 'config.json'), JSON.stringify({ ticketSync: { provider: 'github', repo: 'acme/app' } }));

    const refused = await pull({
      dir, provider: fakeProvider([issue(1, { scope: ['src/newfeature/**'], duration: 1 })]), write: true, now: 'T',
    });
    assert.equal(refused.exitCode, 2);
    assert.match(refused.errors.join('\n'), /ADLC_MANIFEST_KEY/);
    assert.equal(existsSync(join(dir, '.adlc', 'tickets')), false, 'no store was created');
    assert.equal(existsSync(join(dir, '.adlc', 'ticket-archive')), false, 'no archive either');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a sync against a store with NO rails emits no manifest entry and needs no key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-sync-unrailed-rt-'));
  try {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'a@b.c']);
    git(dir, ['config', 'user.name', 'x']);
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(
      join(dir, '.adlc', 'tickets.json'),
      `${JSON.stringify({ tickets: [{ id: 'T1', title: 'unrailed work', scope: ['src/x/**'], rails: [] }] }, null, 2)}\n`,
    );
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'base']);
    writeFileSync(join(dir, '.adlc', 'config.json'), JSON.stringify({ ticketSync: { provider: 'github', repo: 'acme/app' } }));

    // No `key` — a store that is not a trust root must not require one.
    const r = await pull({
      dir,
      provider: fakeProvider([issue(1, { scope: ['src/newfeature/**'], duration: 1 })]),
      write: true,
      now: 'T',
    });
    assert.equal(r.exitCode, 0, `pull --write must succeed with no key: ${JSON.stringify(r.errors)}`);
    assert.ok(
      JSON.parse(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8')).tickets.some((t) => t.id === 'gh:acme/app#1'),
      'the sync really did mutate the store',
    );
    assert.equal(existsSync(join(dir, '.adlc', 'manifest.jsonl')), false, 'and recorded nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pull preserves local-only fields — a converged pull must not un-complete a ticket', async () => {
  // The data-loss this closes: buildTicket constructed a ticket from scratch out
  // of id/title/body plus the block keys, and the union step then replaced the
  // local record wholesale. Anything outside that contract was deleted by an
  // ORDINARY converged pull — including `completed`, which every consumer reads
  // as `completed === true` (fleet, model-router, coldstart, ticket-prune). A
  // ticket finished with `adlc ticket complete` came back queued for work again.
  const dir = mkdtempSync(join(tmpdir(), 'ticket-sync-preserve-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    const id = 'gh:acme/app#1';
    writeFileSync(join(dir, '.adlc', 'tickets.json'), `${JSON.stringify({
      tickets: [{
        id,
        title: 'issue 1',
        body: 'desc',
        scope: ['src/x/**'],
        duration: 1,
        completed: true,        // set locally by `adlc ticket complete`
        ownerNote: 'keep me',   // an extension field the remote never carries
      }],
    }, null, 2)}\n`);
    writeFileSync(
      join(dir, '.adlc', 'config.json'),
      JSON.stringify({ ticketSync: { provider: 'github', repo: 'acme/app' } }),
    );

    const r = await pull({
      dir,
      provider: fakeProvider([issue(1, { scope: ['src/x/**'], duration: 1 })]),
      write: true,
      force: true, // no sidecar base here, so take remote deterministically
      now: 'T',
    });
    assert.equal(r.exitCode, 0, `pull must succeed: ${JSON.stringify(r.errors)}`);

    const after = JSON.parse(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8'));
    const ticket = after.tickets.find((t) => t.id === id);
    assert.equal(ticket.completed, true, 'lifecycle state must survive a pull');
    assert.equal(ticket.ownerNote, 'keep me', 'and so must an extension field');
    // The synced contract is still owned by the remote.
    assert.deepEqual(ticket.scope, ['src/x/**']);
    assert.equal(ticket.duration, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pull still deletes a block field the remote dropped', async () => {
  // Preservation must not become "never remove anything": absence from the
  // remote block is how a synced field gets cleared, and that has to keep
  // working or sync stops converging.
  const dir = mkdtempSync(join(tmpdir(), 'ticket-sync-drop-'));
  try {
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    const id = 'gh:acme/app#1';
    writeFileSync(join(dir, '.adlc', 'tickets.json'), `${JSON.stringify({
      tickets: [{ id, title: 'issue 1', body: 'desc', scope: ['src/x/**'], category: 'feature', completed: true }],
    }, null, 2)}\n`);
    writeFileSync(
      join(dir, '.adlc', 'config.json'),
      JSON.stringify({ ticketSync: { provider: 'github', repo: 'acme/app' } }),
    );

    const r = await pull({
      dir,
      provider: fakeProvider([issue(1, { scope: ['src/x/**'] })]), // category dropped remotely
      write: true,
      force: true,
      now: 'T',
    });
    assert.equal(r.exitCode, 0, `pull must succeed: ${JSON.stringify(r.errors)}`);

    const ticket = JSON.parse(readFileSync(join(dir, '.adlc', 'tickets.json'), 'utf8'))
      .tickets.find((t) => t.id === id);
    assert.equal(ticket.category, undefined, 'a block field absent remotely is still cleared');
    assert.equal(ticket.completed, true, 'while local-only state is untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// T-MANIFEST-FOREST, fourth round: push now recovers real evidence across a
// lost `.lineage` token (recoverOpenSegment matches on the EXACT `branch`
// field every segment's first entry carries, not the lossy filename slug —
// see recoverOpenSegment's own doc), so it no longer wrongly refuses (or,
// pre-round-3, wrongly rendered a stale root-only status) when a real,
// committed segment holds real evidence — the exact scenario the original
// ticket named: a fresh CI checkout of a branch with committed segment
// evidence. A real signing key is required throughout: exact identity is not
// authenticity (round-4 adversarial-review finding) — recovery filters to
// only signature-verified entries, so an unsigned segment publishes nothing.
test('push recovers real evidence across a lost .lineage token (fresh-clone/branch-switch case) — publishes the REAL status, not a stale/missing one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-sync-push-recovery-'));
  const KEY = 'push-recovery-key';
  try {
    git(dir, ['init', '-q', '-b', 'feat/push-recovery']);
    git(dir, ['config', 'user.email', 'a@b.c']);
    git(dir, ['config', 'user.name', 'x']);
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(
      join(dir, '.adlc', 'tickets.json'),
      `${JSON.stringify({ tickets: [{ id: 'T1', title: 'Do the thing', scope: ['src/**'], duration: 1 }] }, null, 2)}\n`,
    );
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'base']);
    writeFileSync(join(dir, '.adlc', 'config.json'), JSON.stringify(PUSH_CONFIG));

    // Segment first, THEN cut over — mirrors gitStoreWithSegmentedEvidence's fixture
    // shape elsewhere in this package's tests.
    mkdirSync(join(dir, '.adlc', 'manifest.d'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'manifest.d', '.store.json'), JSON.stringify({ format: 'adlc-manifest-segments', version: 1 }));
    // Mints the segment's first (anchor + branch carrying) entry, v2-signed.
    recordTicketEvidence(dir, {
      transactionId: 'tx-1', operation: 'complete', ticketId: 'T1',
      ticketHash: 'h'.repeat(64), storeHash: 's'.repeat(64), key: KEY,
    });
    // A REAL, v2-signed P5 pass for T1, hand-appended as the segment's second
    // entry — this is the evidence a lost token must not hide from
    // outcomes.mjs's status reduction. Root stays untouched (rootless
    // segmented repo), so a fallback to root-only would find NOTHING for T1,
    // not merely a stale value.
    const segDir = join(dir, '.adlc', 'manifest.d');
    const segName = readdirSync(segDir).find((n) => n.endsWith('.jsonl'));
    const segPath = segmentPath(join(dir, '.adlc'), segName);
    const firstRawLine = readFileSync(segPath, 'utf8').trim().split('\n')[0];
    const p5 = {
      seq: 2, gate: 'prosecution', ts: '2026-06-01T00:00:00Z', ticket: 'T1',
      data: { verdict: 'clear' }, files: {}, prev: sha256(firstRawLine), sigVersion: 2,
    };
    p5.sig = createHmac('sha256', KEY).update(canonicalJson(p5)).digest('hex');
    writeFileSync(segPath, `${firstRawLine}\n${JSON.stringify(p5)}\n`);
    // Discard the token — this checkout can no longer identify its own segment
    // by token, only by the exact `branch` field the segment's first entry
    // carries, even though a real committed segment (with real evidence) exists
    // on disk.
    rmSync(join(dir, '.adlc', 'manifest.d', '.lineage'), { force: true });

    const gh = fakeGitHub();
    const r = await push({ dir, provider: githubProvider(), runner: gh.runner, write: true, now: 'T', uuid: () => 'K', key: KEY });
    assert.equal(r.exitCode, 0, `must recover and succeed, never refuse: ${JSON.stringify(r.errors)}`);
    assert.ok(
      gh.state.issues[0].labels.includes('adlc:passed'),
      `recovered p5-pass evidence must be published — a lost token must never publish a missing/stale status instead: ${JSON.stringify(gh.state.issues[0]?.labels)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The forgery this exists to prevent (round-4/round-5 adversarial-review
// findings): exact branch matching proves identity, not authenticity. An
// ENTIRELY UNSIGNED segment claiming the right branch, with a hand-planted
// "clear" P5 verdict, must never get published — even though push has a
// real key available and the branch field matches perfectly. It refuses
// outright (never silently renders a status computed from root alone,
// which could equally remove a real label) since nothing here proves anyone
// who held the key ever touched this segment.
test('push refuses (never publishes a forged P5 pass) when a recovered segment is entirely unsigned, even with an exact branch match', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-sync-push-forged-'));
  const KEY = 'push-forgery-key';
  try {
    git(dir, ['init', '-q', '-b', 'feat/push-forged']);
    git(dir, ['config', 'user.email', 'a@b.c']);
    git(dir, ['config', 'user.name', 'x']);
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(
      join(dir, '.adlc', 'tickets.json'),
      `${JSON.stringify({ tickets: [{ id: 'T1', title: 'Do the thing', scope: ['src/**'], duration: 1 }] }, null, 2)}\n`,
    );
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'base']);
    writeFileSync(join(dir, '.adlc', 'config.json'), JSON.stringify(PUSH_CONFIG));

    mkdirSync(join(dir, '.adlc', 'manifest.d'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'manifest.d', '.store.json'), JSON.stringify({ format: 'adlc-manifest-segments', version: 1 }));
    // Mints the segment's branch-carrying first entry — UNSIGNED (the attacker
    // does not have KEY, only local/commit write access to the segment file).
    recordTicketEvidence(dir, {
      transactionId: 'tx-1', operation: 'complete', ticketId: 'T1',
      ticketHash: 'h'.repeat(64), storeHash: 's'.repeat(64), key: null,
    });
    // A forged, UNSIGNED "clear" verdict for T1 — the branch field on the
    // FIRST entry matches exactly, but this second entry carries no valid
    // signature at all.
    const segDir = join(dir, '.adlc', 'manifest.d');
    const segName = readdirSync(segDir).find((n) => n.endsWith('.jsonl'));
    const segPath = segmentPath(join(dir, '.adlc'), segName);
    const firstRawLine = readFileSync(segPath, 'utf8').trim().split('\n')[0];
    const forged = {
      seq: 2, gate: 'prosecution', ts: '2026-06-01T00:00:00Z', ticket: 'T1',
      data: { verdict: 'clear' }, files: {}, prev: sha256(firstRawLine),
    };
    writeFileSync(segPath, `${firstRawLine}\n${JSON.stringify(forged)}\n`);
    rmSync(join(dir, '.adlc', 'manifest.d', '.lineage'), { force: true });

    // Push DOES have a real key available (the normal CI configuration).
    const gh = fakeGitHub();
    const r = await push({ dir, provider: githubProvider(), runner: gh.runner, write: true, now: 'T', uuid: () => 'K', key: KEY });
    assert.equal(r.exitCode, 1, `an entirely unsigned recovered segment must refuse, not silently render a status computed from root alone`);
    assert.ok(
      r.errors.some((e) => /failed chain or signature verification/.test(e)),
      `expected a chain/signature verification error, got: ${JSON.stringify(r.errors)}`,
    );
    assert.ok(
      !(gh.state.issues[0]?.labels ?? []).includes('adlc:passed'),
      `an unsigned forged verdict must never be published, even with an exact branch match: ${JSON.stringify(gh.state.issues[0]?.labels)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The refuse guard above must not fire when there is genuinely nothing to
// miss: a repo freshly cut over to segments (`.store.json` written) but with
// no segment ever opened for this branch has no local `.lineage` token either
// — that is the ordinary, expected state, not a lost-token failure, and push
// must proceed normally rather than refuse every first push after cutover.
test('push succeeds normally in a freshly segmented repo with no .lineage token, when no segment has ever been opened for this branch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-sync-push-fresh-segment-'));
  try {
    git(dir, ['init', '-q', '-b', 'feat/push-fresh-segment']);
    git(dir, ['config', 'user.email', 'a@b.c']);
    git(dir, ['config', 'user.name', 'x']);
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'tickets.json'), `${JSON.stringify({ tickets: [] }, null, 2)}\n`);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'base']);
    writeFileSync(join(dir, '.adlc', 'config.json'), JSON.stringify(PUSH_CONFIG));

    // Cut over to segments — no evidence recorded, no segment ever opened, no
    // .lineage token ever written (there's nothing yet for one to name).
    mkdirSync(join(dir, '.adlc', 'manifest.d'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'manifest.d', '.store.json'), JSON.stringify({ format: 'adlc-manifest-segments', version: 1 }));

    const gh = fakeGitHub();
    const r = await push({ dir, provider: githubProvider(), runner: gh.runner, write: false, now: 'T' });
    assert.equal(r.exitCode, 0, `must not wrongly refuse when there is no segment to miss: ${JSON.stringify(r.errors)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The refuse guard must ALSO not fire on the ordinary happy path: a segmented
// repo whose own `.lineage` token resolves cleanly (the normal case for every
// checkout that has recorded its own evidence) must push exactly as it would
// pre-lineage-durability — never refuse just because the repo happens to be
// segmented.
test('push succeeds normally in a segmented repo whose own .lineage token resolves cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-sync-push-healthy-segment-'));
  try {
    git(dir, ['init', '-q', '-b', 'feat/push-healthy-segment']);
    git(dir, ['config', 'user.email', 'a@b.c']);
    git(dir, ['config', 'user.name', 'x']);
    mkdirSync(join(dir, '.adlc'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'tickets.json'), `${JSON.stringify({ tickets: [] }, null, 2)}\n`);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'base']);
    writeFileSync(join(dir, '.adlc', 'config.json'), JSON.stringify(PUSH_CONFIG));

    mkdirSync(join(dir, '.adlc', 'manifest.d'), { recursive: true });
    writeFileSync(join(dir, '.adlc', 'manifest.d', '.store.json'), JSON.stringify({ format: 'adlc-manifest-segments', version: 1 }));
    // Records real evidence AND mints the segment's own valid .lineage token —
    // the ordinary state of any checkout that has done real work.
    recordTicketEvidence(dir, {
      transactionId: 'tx-1', operation: 'complete', ticketId: 'T1',
      ticketHash: 'h'.repeat(64), storeHash: 's'.repeat(64), key: null,
    });

    const gh = fakeGitHub();
    const r = await push({ dir, provider: githubProvider(), runner: gh.runner, write: false, now: 'T' });
    assert.equal(r.exitCode, 0, `must not refuse when this checkout's own segment resolves cleanly: ${JSON.stringify(r.errors)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

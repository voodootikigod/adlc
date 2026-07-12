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
import { serializeBlock } from '../lib/block.mjs';

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

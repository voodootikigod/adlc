#!/usr/bin/env node
// ticket-sync-smoke.mjs — the ONE opt-in, live `gh` smoke for @adlc/ticket-sync.
//
// 100% of the package's logic is covered offline via the injected `gh` runner;
// the single untested edge is the thin REAL runner in lib/gh.mjs (execFile → gh).
// This script exercises exactly that edge against a real repo, READ-ONLY (it only
// ever runs `gh issue list` + an offline dry-run pull — it never creates, edits,
// labels, or comments). It is NOT part of the default offline `npm test` (it lives
// outside scripts/test/ so the suite never imports it) and SKIPS unless opted in.
//
//   ADLC_TICKET_SYNC_LIVE=1 ADLC_TICKET_SYNC_REPO=owner/repo \
//     node scripts/ticket-sync-smoke.mjs
//
// Without ADLC_TICKET_SYNC_LIVE=1 it prints a skip notice and exits 0, so it is
// safe to invoke unconditionally in any environment. Honors GH_HOST (Enterprise).

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeGhRunner } from '../packages/ticket-sync/lib/gh.mjs';
import { githubProvider } from '../packages/ticket-sync/lib/providers/github.mjs';
import { pull } from '../packages/ticket-sync/lib/pull.mjs';

function fail(message) {
  console.error(`ticket-sync-smoke: ${message}`);
  process.exit(2);
}

async function resolveRepo(runner) {
  if (process.env.ADLC_TICKET_SYNC_REPO) return process.env.ADLC_TICKET_SYNC_REPO;
  const r = await runner(['repo', 'view', '--json', 'nameWithOwner']);
  if (!r.ok) fail('no ADLC_TICKET_SYNC_REPO set and `gh repo view` failed — set the env var or run inside a gh-authed repo');
  try {
    return JSON.parse(r.stdout).nameWithOwner;
  } catch (e) {
    fail(`could not parse repo from gh: ${e.message}`);
  }
  return null;
}

async function main() {
  if (process.env.ADLC_TICKET_SYNC_LIVE !== '1') {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'set ADLC_TICKET_SYNC_LIVE=1 to run the live gh smoke' }, null, 2));
    process.exit(0);
  }

  const runner = makeGhRunner();
  const repo = await resolveRepo(runner);
  const provider = githubProvider();

  // (1) The real runner read path: `gh issue list --json …` parses to issues.
  const list = await provider.listIssues({ runner, repo, ticketSync: { select: { state: 'open' } }, limit: 200 });
  if (!list.ok && !list.truncated) fail(`live issue list failed for ${repo}: ${list.error}`);
  if (list.ok && !Array.isArray(list.issues)) fail('issue list did not return an array');

  // (2) End-to-end READ-ONLY: an offline-default `pull` (dry-run) through the real
  // provider+runner — proves map → parse → reconcile → validity over live data with
  // ZERO writes. Exit 2 (a remote block conflict/invalid) is an acceptable live
  // outcome; only an operational failure (exit 1) is a smoke failure.
  const dir = mkdtempSync(join(tmpdir(), 'adlc-ts-smoke-'));
  mkdirSync(join(dir, '.adlc'));
  writeFileSync(join(dir, '.adlc', 'config.json'), JSON.stringify({ ticketSync: { provider: 'github', repo } }));
  let pulled;
  try {
    pulled = await pull({ dir, provider, runner, write: false });
    if (pulled.exitCode === 1) fail(`dry-run pull hit an operational error: ${(pulled.errors ?? []).join('; ')}`);
    if (existsSync(join(dir, '.adlc', 'tickets.json'))) fail('dry-run pull WROTE tickets.json — must be read-only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(JSON.stringify({
    ok: true,
    skipped: false,
    repo,
    ghHost: process.env.GH_HOST ?? 'github.com',
    issuesListed: list.ok ? list.issues.length : `>=200 (truncated — ok, runner works)`,
    dryRunPullExit: pulled.exitCode,
    wrote: false,
  }, null, 2));
  process.exit(0);
}

main().catch((err) => fail(err?.message ?? String(err)));

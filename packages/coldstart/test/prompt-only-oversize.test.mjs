// prompt-only-oversize.test.mjs — the operator path fails closed too.
//
// --prompt-only prints the audit prompt for a human or harness to answer, and
// --record-verdict stores their answer against the FULL ticket's hash. For a
// ticket over TICKET_TEXT_MAX_CHARS that prompt would carry a head-truncated
// ticket, so a clean answer would certify acceptance criteria nobody read.
// The CLI emits no prompt for such a run, records nothing, and exits 2 naming
// the size and the cap. Driven through the real CLI because the claim is about
// what reaches stdout and the ledger.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { TICKET_TEXT_MAX_CHARS } from '../lib/prompt.mjs';

const fixtureDirs = new Set();
after(() => { for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true }); });

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'coldstart.mjs');

function storeWith(tickets) {
  const dir = mkdtempSync(join(tmpdir(), 'coldstart-oversize-'));
  fixtureDirs.add(dir);
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets }, null, 2));
  return dir;
}

const BIG = { id: 'T-BIG', title: 'Too long to audit', body: `OPENING\n${'x'.repeat(TICKET_TEXT_MAX_CHARS)}\nACCEPTANCE_AT_END` };
const SMALL = { id: 'T-SMALL', title: 'Fits', body: 'Do the thing.' };

test('--prompt-only on an over-cap ticket: exit 2, no prompt on stdout, stderr names the size and the cap', () => {
  const dir = storeWith([BIG]);
  const res = spawnSync(process.execPath, [CLI, 'T-BIG', '--prompt-only'], { cwd: dir, encoding: 'utf8' });
  assert.equal(res.status, 2, `stderr: ${res.stderr}`);
  assert.doesNotMatch(res.stdout, /=== user/, 'no audit prompt may be emitted for a ticket the auditor cannot see whole');
  assert.doesNotMatch(res.stdout, /UNTRUSTED:TICKET/);
  assert.match(res.stderr, /T-BIG/);
  assert.match(res.stderr, /exceeds the auditable size/);
  assert.match(res.stderr, new RegExp(String(TICKET_TEXT_MAX_CHARS)));
  assert.match(res.stderr, /split the ticket/);
});

test('--prompt-only --record-verdict on an over-cap ticket records nothing, even when handed a clean verdict', () => {
  const dir = storeWith([BIG]);
  const res = spawnSync(process.execPath, [CLI, 'T-BIG', '--prompt-only', '--record-verdict', '-'], {
    cwd: dir, input: '{"gaps": []}\n', encoding: 'utf8',
  });
  assert.equal(res.status, 2, `stderr: ${res.stderr}`);
  assert.equal(existsSync(join(dir, '.adlc', 'manifest.jsonl')), false, 'a clean verdict on a prefix must never reach the ledger');
  assert.doesNotMatch(res.stdout, /gate-manifest: recorded/);
});

test('--prompt-only --all with one over-cap ticket fails the whole run closed and names only the offender', () => {
  const dir = storeWith([SMALL, BIG]);
  const res = spawnSync(process.execPath, [CLI, '--all', '--prompt-only'], { cwd: dir, encoding: 'utf8' });
  assert.equal(res.status, 2, `stderr: ${res.stderr}`);
  assert.doesNotMatch(res.stdout, /=== user/);
  assert.match(res.stderr, /T-BIG/);
  assert.doesNotMatch(res.stderr, /T-SMALL/);
});

test('--prompt-only on a ticket that fits is unchanged: exit 0 and the prompt is printed', () => {
  const dir = storeWith([SMALL]);
  const res = spawnSync(process.execPath, [CLI, 'T-SMALL', '--prompt-only'], { cwd: dir, encoding: 'utf8' });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /=== user \(T-SMALL\)/);
});

test('--offline on an over-cap ticket: exit 2 with the overflow gap in the report', () => {
  const dir = storeWith([{ ...BIG, scope: ['src/**'] }]);
  const res = spawnSync(process.execPath, [CLI, 'T-BIG', '--offline', '--json'], { cwd: dir, encoding: 'utf8' });
  assert.equal(res.status, 2, `stderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  const gaps = JSON.stringify(out);
  assert.match(gaps, /exceeds the auditable size/);
});

// Without any provider the real path used to exit 1 ("configure an API key")
// before the size decision was reached. Splitting the ticket is the fix, not a
// key, so the overflow verdict must not depend on having one.
test('the real path with NO provider configured still exits 2 with the overflow gap for an over-cap ticket', () => {
  const dir = storeWith([BIG]);
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(ANTHROPIC|OPENAI|GEMINI|ADLC)_/.test(k)) delete env[k];
  }
  env.NODE_ENV = 'production';
  const res = spawnSync(process.execPath, [CLI, 'T-BIG', '--json'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(res.status, 2, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
  assert.doesNotMatch(res.stderr, /no LLM provider configured/);
  assert.match(res.stdout, /exceeds the auditable size/);
  assert.equal(existsSync(join(dir, '.adlc', 'manifest.jsonl')), false, 'a refusal to audit records nothing');
});

test('the real path with NO provider and a ticket that fits still asks for a provider (exit 1), unchanged', () => {
  const dir = storeWith([SMALL]);
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(ANTHROPIC|OPENAI|GEMINI|ADLC)_/.test(k)) delete env[k];
  }
  env.NODE_ENV = 'production';
  const res = spawnSync(process.execPath, [CLI, 'T-SMALL'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(res.status, 1, `stderr: ${res.stderr}`);
  assert.match(res.stderr, /no LLM provider configured/);
});

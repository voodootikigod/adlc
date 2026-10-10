// cli-cache-signature.test.mjs — issue #595, through the real CLI.
//
// The lib tests prove checkAll's rule; these prove bin/coldstart.mjs wires the
// operator's key into it and says on stderr what it did. No network: a cache
// HIT makes no provider call, and a forced re-audit under a fake API key fails
// before any verdict (exit 1), which is exactly what distinguishes the cases.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ticketHash } from '@adlc/tickets';
import { record } from '@adlc/gate-manifest/lib/record.mjs';
import { buildCacheData } from '../lib/cache.mjs';
import { TICKET_TEXT_MAX_CHARS, ticketToText } from '../lib/prompt.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'coldstart.mjs');
const KEY = 'cli-cache-signature-key';
const MODEL = 'test-model-cheap'; // pinned via ADLC_MODEL_CHEAP so the signed entry's model matches the run's
const TICKET = { id: 'T1', title: 'Login form', body: 'Create login.', scope: ['src/**'], rails: [], edges: [], duration: 1, category: 'feature' };

const fixtureDirs = new Set();
after(() => { for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true }); });

function fixture({ recordKey = KEY, corruptLine = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'coldstart-cli-sig-'));
  fixtureDirs.add(dir);
  const adlc = join(dir, '.adlc');
  mkdirSync(adlc, { recursive: true });
  writeFileSync(join(adlc, 'tickets.json'), JSON.stringify({ tickets: [TICKET] }, null, 2));
  record({
    key: recordKey,
    gate: 'coldstart',
    ticket: TICKET.id,
    dir: adlc,
    rawData: JSON.stringify({ tier: 'cheap', cache: buildCacheData({ ticketHash: ticketHash(TICKET), model: MODEL, gaps: [], textChars: ticketToText(TICKET).length, cap: TICKET_TEXT_MAX_CHARS }) }),
  });
  if (corruptLine) appendFileSync(join(adlc, 'manifest.jsonl'), 'not json at all\n');
  return dir;
}

function runCli(dir, { manifestKey, extraArgs = [] } = {}) {
  const { ADLC_MANIFEST_KEY: _k, ADLC_GATE_MOCK_RESPONSE: _m, NODE_ENV: _n, ADLC_PROVIDER: _p, ...base } = process.env;
  const env = {
    ...base,
    // Any non-empty value satisfies provider detection; this one is shaped so no
    // secret scanner mistakes it for a credential, and no real call can succeed.
    ANTHROPIC_API_KEY: 'placeholder-provider-key-no-network',
    ADLC_MODEL_CHEAP: MODEL,
    ...(manifestKey ? { ADLC_MANIFEST_KEY: manifestKey } : {}),
  };
  return spawnSync(process.execPath, [CLI, 'T1', '--tickets', join(dir, '.adlc', 'tickets.json'), ...extraArgs], {
    cwd: dir, env, encoding: 'utf8', timeout: 30_000,
  });
}

const NO_KEY_NOTICE = 'coldstart: ADLC_MANIFEST_KEY is not set — cached verdicts are not trusted; re-auditing';

test('with the key and a signed entry, the CLI serves the cached PASS: exit 0, (cached), no provider call, no notices', () => {
  const r = runCli(fixture(), { manifestKey: KEY });
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /\(cached\)/);
  assert.equal(r.stderr.includes(NO_KEY_NOTICE), false, r.stderr);
  assert.equal(r.stderr.includes('unreadable manifest line'), false, r.stderr);
});

test('without the key, the same signed entry is not trusted: the CLI says so once on stderr and re-audits (which cannot complete here)', () => {
  const r = runCli(fixture(), { manifestKey: null });
  assert.notEqual(r.status, 0, 'a re-audit under a fake API key cannot produce a verdict');
  assert.equal(r.stdout.includes('(cached)'), false, r.stdout);
  assert.equal(r.stderr.split(NO_KEY_NOTICE).length - 1, 1, `notice must appear exactly once:\n${r.stderr}`);
});

test('with the key but an UNSIGNED entry, the CLI does not serve it and prints no key notice (the key is present; the entry is the problem)', () => {
  const r = runCli(fixture({ recordKey: null }), { manifestKey: KEY });
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout.includes('(cached)'), false, r.stdout);
  assert.equal(r.stderr.includes(NO_KEY_NOTICE), false, r.stderr);
});

test('--force with no key prints no key notice: the operator chose to skip the cache', () => {
  const r = runCli(fixture(), { manifestKey: null, extraArgs: ['--force'] });
  assert.equal(r.stderr.includes(NO_KEY_NOTICE), false, r.stderr);
});

test('an unreadable ledger line is reported on stderr with its count while the signed entry is still served', () => {
  const r = runCli(fixture({ corruptLine: true }), { manifestKey: KEY });
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /\(cached\)/);
  assert.match(r.stderr, /^coldstart: 1 unreadable manifest line\(s\) were skipped while reading the verdict cache$/m);
});

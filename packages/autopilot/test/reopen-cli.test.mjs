// AC 46 (CLI half): the REAL `adlc ticket` binary against a temporary sharded
// store — create → complete → reopen (`update --input - --expect <hash>
// --authorize --write`) exits 0 and leaves `completed:false`; the same update
// WITHOUT --authorize exits 2 with AUTHORIZATION_REQUIRED. The reopen is the
// key-bearing call of AC 12, so the child gets the manifest key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { childEnv } from '../lib/keys.mjs';
import { parseLastJson } from '../lib/review.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ADLC = join(REPO, 'packages', 'cli', 'bin', 'adlc.mjs');
const KEY = 'reopen-cli-test-key-0123456789abcdef0123456789abcdef';

function adlc(root, args, { stdin, key = KEY } = {}) {
  const env = childEnv({ PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8' }, { key, keyBearing: true });
  const r = spawnSync(process.execPath, [ADLC, ...args], { cwd: root, env, input: stdin, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function ac46_reopenCli() {
  const root = mkdtempSync(join(tmpdir(), 'ap-reopen-cli-'));
  try {
    mkdirSync(join(root, '.adlc', 'tickets'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'tickets', '.store.json'), JSON.stringify({ format: 'adlc-ticket-directory', version: 1 }));
    const doc = { title: 'Reopen me', category: 'feature', scope: ['packages/x/**'], rails: [], edges: [], duration: 1, body: 'body\n\n=== ACCEPTANCE CRITERIA ===\n- done\n' };
    const created = adlc(root, ['ticket', 'create', '--input', '-', '--write', '--root', root, '--json'], { stdin: JSON.stringify(doc) });
    assert.equal(created.status, 0, `create: ${created.stderr}`);
    const id = parseLastJson(created.stdout)?.ticketId ?? parseLastJson(created.stdout)?.ticket?.id ?? created.stdout.match(/T-[0-9A-HJKMNP-TV-Z]{26}/)?.[0];
    assert.match(String(id), /^T-[0-9A-HJKMNP-TV-Z]{26}$/, `a ULID ticket id (stdout: ${created.stdout.slice(0, 300)})`);
    const done = adlc(root, ['ticket', 'complete', id, '--write', '--root', root, '--json']);
    assert.equal(done.status, 0, `complete: ${done.stderr}`);
    const shown = adlc(root, ['ticket', 'show', id, '--json', '--root', root]);
    assert.equal(shown.status, 0, shown.stderr);
    const env = parseLastJson(shown.stdout);
    assert.equal(env.ticket.completed, true);
    const reopened = { ...env.ticket, completed: false };
    const noAuth = adlc(root, ['ticket', 'update', id, '--input', '-', '--expect', env.ticketHash, '--write', '--root', root, '--json'], { stdin: JSON.stringify(reopened) });
    assert.equal(noAuth.status, 2, `without --authorize: exit 2 (got ${noAuth.status}: ${noAuth.stderr} ${noAuth.stdout.slice(0, 200)})`);
    assert.match(`${noAuth.stderr}${noAuth.stdout}`, /AUTHORIZATION_REQUIRED/);
    const withAuth = adlc(root, ['ticket', 'update', id, '--input', '-', '--expect', env.ticketHash, '--authorize', '--write', '--root', root, '--json'], { stdin: JSON.stringify(reopened) });
    assert.equal(withAuth.status, 0, `with --authorize: ${withAuth.stderr} ${withAuth.stdout.slice(0, 300)}`);
    const after = parseLastJson(adlc(root, ['ticket', 'show', id, '--json', '--root', root]).stdout);
    assert.equal(after.ticket.completed, false, 'the ticket is reopened');
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('AC46: the REAL adlc ticket binary: create → complete → reopen with --authorize exits 0 and completed:false; the same update without --authorize exits 2 AUTHORIZATION_REQUIRED', { timeout: 120_000 }, ac46_reopenCli);

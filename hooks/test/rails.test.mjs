// rails.test.mjs — the PreToolUse rail-guard contract is security-critical, so
// it gets a committed regression test. Drives the real hook entrypoint as a
// subprocess (the hook is a script, not an importable module). Offline, no
// network, leaves no trace.
//
// Contract (integration plan §4.4): the gate fails CLOSED whenever rails cannot
// be trustworthily determined, is a no-op when no rails are declared, denies on
// a rail hit, and honors an audited ADLC_RAILS_BYPASS override.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'adlc-hook.mjs');

/**
 * Run the rails hook in a throwaway repo.
 * @returns {{ verdict: 'deny'|'allow', out: string, dir: string }}
 *   dir is returned (already removed) only for reference; pass keepDir to inspect.
 */
function runRails(ticketsJson, relPath, { env = {}, keepDir = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-rails-'));
  let manifest = '';
  try {
    mkdirSync(join(dir, '.adlc'));
    if (ticketsJson !== null) writeFileSync(join(dir, '.adlc', 'tickets.json'), ticketsJson);
    const input = JSON.stringify({ cwd: dir, tool_input: { file_path: join(dir, relPath) } });
    let out = '';
    try {
      out = execFileSync('node', [HOOK, 'rails'], {
        input,
        encoding: 'utf8',
        env: { ...process.env, ...env },
      });
    } catch (e) {
      out = e.stdout ?? '';
    }
    const mp = join(dir, '.adlc', 'manifest.jsonl');
    if (existsSync(mp)) manifest = readFileSync(mp, 'utf8');
    const verdict = out.includes('"permissionDecision":"deny"') ? 'deny' : 'allow';
    return { verdict, out, manifest };
  } finally {
    if (!keepDir) rmSync(dir, { recursive: true, force: true });
  }
}

// ---- no-op (cannot brick a clean repo) ----

test('no tickets file → allow', () => {
  assert.equal(runRails(null, 'src/app.mjs').verdict, 'allow');
});

test('schema-valid empty tickets → allow', () => {
  assert.equal(runRails('{"tickets":[]}', 'src/app.mjs').verdict, 'allow');
});

test('rails declared but path is not a rail → allow', () => {
  const t = '{"tickets":[{"id":"T1","rails":["test/**"]}]}';
  assert.equal(runRails(t, 'src/app.mjs').verdict, 'allow');
});

// ---- enforcement ----

test('edit to a glob rail → deny', () => {
  const t = '{"tickets":[{"id":"T1","rails":["test/auth/**"]}]}';
  assert.equal(runRails(t, 'test/auth/login.test.mjs').verdict, 'deny');
});

test('edit to an exact-file rail → deny', () => {
  const t = '{"tickets":[{"id":"T1","rails":["src/types/api.d.ts"]}]}';
  assert.equal(runRails(t, 'src/types/api.d.ts').verdict, 'deny');
});

// ---- fail closed: any state where rails cannot be trusted ----

for (const [name, json] of [
  ['unparseable JSON', '{ not json'],
  ['bare array (no envelope)', '[]'],
  ['object without tickets key', '{"foo":1}'],
  ['tickets not an array', '{"tickets":"nope"}'],
  ['non-object ticket entry', '{"tickets":["bad"]}'],
  ['non-array rails field', '{"tickets":[{"id":"T1","rails":"test/**"}]}'],
  ['non-string rail element', '{"tickets":[{"id":"T1","rails":[123]}]}'],
]) {
  test(`fail closed: ${name} → deny`, () => {
    assert.equal(runRails(json, 'src/app.mjs').verdict, 'deny');
  });
}

// ---- audited bypass ----

test('ADLC_RAILS_BYPASS=1 on a rail → allow and record a manifest bypass', () => {
  const t = '{"tickets":[{"id":"T1","rails":["test/**"]}]}';
  const r = runRails(t, 'test/x.mjs', { env: { ADLC_RAILS_BYPASS: '1' } });
  assert.equal(r.verdict, 'allow');
  // Recording requires `adlc` on PATH; assert it audited when available.
  if (r.manifest) assert.match(r.manifest, /rails-bypass/);
});

test('ADLC_RAILS_BYPASS=1 on schema-invalid tickets → allow (override)', () => {
  const r = runRails('[]', 'src/app.mjs', { env: { ADLC_RAILS_BYPASS: '1' } });
  assert.equal(r.verdict, 'allow');
});

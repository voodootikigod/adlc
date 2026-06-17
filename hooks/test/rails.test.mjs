// rails.test.mjs — the PreToolUse rail-guard contract is security-critical, so
// it gets a committed regression test. Drives the real hook entrypoint as a
// subprocess (the hook is a script, not an importable module). Offline, no
// network, leaves no trace.
//
// Contract (integration plan §4.4): the gate fails CLOSED whenever rails cannot
// be trustworthily determined, is a no-op when no rails are declared, denies on
// a rail hit, and honors an audited ADLC_RAILS_BYPASS override.
//
// SCOPE: this guards the STRUCTURED edit tools (Edit/Write/MultiEdit), resolved
// precisely with no shell parsing. Bash is NOT gated in-session — a shell can't
// be reliably parsed; rail mutations via Bash are caught by the rails-guard CI
// diff gate at commit time (see scripts/test/rails-guard-ci.test.mjs).

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
function runRails(ticketsJson, relPath, { env = {}, keepDir = false, rawFilePath = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-rails-'));
  let manifest = '';
  try {
    mkdirSync(join(dir, '.adlc'));
    if (ticketsJson !== null) writeFileSync(join(dir, '.adlc', 'tickets.json'), ticketsJson);
    // rawFilePath lets a test pass a non-canonical path verbatim (the default
    // `join` would otherwise normalize it before the hook sees it). `%DIR%` is
    // substituted with the temp project dir.
    const filePath = rawFilePath ? rawFilePath.replace('%DIR%', dir) : join(dir, relPath);
    const input = JSON.stringify({ cwd: dir, tool_input: { file_path: filePath } });
    let out = '';
    try {
      // Use the absolute node path so the child always launches, even when a
      // test overrides PATH to control whether `adlc` is reachable.
      out = execFileSync(process.execPath, [HOOK, 'rails'], {
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


// ---- trust root: tickets.json is frozen once rails exist (structured edits) ----

const RAIL_T = '{"tickets":[{"id":"T1","rails":["test/auth/**","src/types/api.d.ts"]}]}';

test('editing .adlc/tickets.json while rails exist → deny (trust root)', () => {
  assert.equal(runRails(RAIL_T, '.adlc/tickets.json').verdict, 'deny');
});


test('editing .adlc/tickets.json with NO rails declared → allow (authoring the first ticket)', () => {
  assert.equal(runRails('{"tickets":[]}', '.adlc/tickets.json').verdict, 'allow');
});

// ---- Bash is intentionally NOT gated in-session (Option C) ----

test('a Bash command targeting a rail is a no-op in-session (CI gate is the backstop)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-rails-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(join(dir, '.adlc', 'tickets.json'), RAIL_T);
    // A Bash-shaped payload (command, no file_path) — the rails hook must NOT
    // try to gate it; it returns no output (allow) and leaves it to the CI gate.
    const input = JSON.stringify({ cwd: dir, tool_name: 'Bash', tool_input: { command: 'rm test/auth/login.test.mjs' } });
    let out = '';
    try {
      out = execFileSync(process.execPath, [HOOK, 'rails'], { input, encoding: 'utf8' });
    } catch (e) {
      out = e.stdout ?? '';
    }
    assert.equal(out.includes('"permissionDecision":"deny"'), false); // not gated in-session
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- canonicalization: non-canonical spellings must not dodge a rail ----

for (const [name, raw] of [
  ['./ prefix', '%DIR%/./src/types/api.d.ts'],
  ['.. segment', '%DIR%/src/../src/types/api.d.ts'],
  ['duplicate separator', '%DIR%/src//types/api.d.ts'],
]) {
  test(`canonicalize: ${name} still denies the rail`, () => {
    const t = '{"tickets":[{"id":"T1","rails":["src/types/api.d.ts"]}]}';
    assert.equal(runRails(t, '', { rawFilePath: raw }).verdict, 'deny');
  });
}

test('canonicalize: relative ./ input resolves against the repo and denies', () => {
  const t = '{"tickets":[{"id":"T1","rails":["src/types/api.d.ts"]}]}';
  assert.equal(runRails(t, '', { rawFilePath: './src/types/api.d.ts' }).verdict, 'deny');
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

// ---- audited bypass: allowed ONLY when the override can be durably recorded ----

const NODE_DIR = dirname(process.execPath);
const REPO_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', '.bin');
const WITH_ADLC = `${REPO_BIN}:${NODE_DIR}:${process.env.PATH ?? ''}`; // recorder reachable
const WITHOUT_ADLC = NODE_DIR; // node only — `adlc` not resolvable

test('bypass on a rail WITH a working recorder → allow + audited entry', () => {
  const t = '{"tickets":[{"id":"T1","rails":["test/**"]}]}';
  const r = runRails(t, 'test/x.mjs', { env: { ADLC_RAILS_BYPASS: '1', PATH: WITH_ADLC } });
  assert.equal(r.verdict, 'allow');
  assert.match(r.manifest, /rails-bypass/);
});

test('bypass on schema-invalid tickets WITH recorder → allow (audited)', () => {
  const r = runRails('[]', 'src/app.mjs', { env: { ADLC_RAILS_BYPASS: '1', PATH: WITH_ADLC } });
  assert.equal(r.verdict, 'allow');
});

test('bypass with the recorder UNAVAILABLE → deny (an unaudited override is refused)', () => {
  const t = '{"tickets":[{"id":"T1","rails":["test/**"]}]}';
  const r = runRails(t, 'test/x.mjs', { env: { ADLC_RAILS_BYPASS: '1', PATH: WITHOUT_ADLC } });
  assert.equal(r.verdict, 'deny');
});

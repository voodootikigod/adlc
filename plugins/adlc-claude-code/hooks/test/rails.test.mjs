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
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ticketFilename } from '../generated-ticket-reader.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'adlc-hook.mjs');

// Hermetic harness (#204): a developer with ADLC_RAILS_BYPASS set in their own
// shell would otherwise have it inherited by every hook spawn below, silently
// inverting the deny-tests to allow (a gate whose suite is disarmed by the same
// variable that disarms the gate). Scrub it from the ambient env once, and give
// spawns a builder that scrubs per-call too, so even a value set MID-test does
// not leak. A test that WANTS a bypass passes it explicitly in `env`.
delete process.env.ADLC_RAILS_BYPASS;
function childEnv(env = {}) {
  const e = { ...process.env, ...env };
  if (!('ADLC_RAILS_BYPASS' in env)) delete e.ADLC_RAILS_BYPASS;
  return e;
}

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
    if (ticketsJson !== null) {
      try {
        const fixture = JSON.parse(ticketsJson);
        for (const ticket of fixture.tickets ?? []) if (ticket && typeof ticket === 'object') ticket.title ??= `${ticket.id ?? '?'} fixture`;
        ticketsJson = JSON.stringify(fixture);
      } catch {}
      writeFileSync(join(dir, '.adlc', 'tickets.json'), ticketsJson);
    }
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
        env: childEnv(env),
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

test('sharded ticket store enforces declared rails and freezes every shard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-rails-sharded-'));
  try {
    const store = join(dir, '.adlc/tickets');
    mkdirSync(store, { recursive: true });
    const ticket = { id: 'T1', title: 'Sharded fixture', rails: ['test/**'] };
    writeFileSync(join(store, '.store.json'), JSON.stringify({ format: 'adlc-ticket-directory', version: 1 }));
    writeFileSync(join(store, ticketFilename(ticket.id)), JSON.stringify(ticket));
    const run = (filePath) => {
      try {
        return execFileSync(process.execPath, [HOOK, 'rails'], {
          cwd: dir,
          input: JSON.stringify({ cwd: dir, tool_input: { file_path: join(dir, filePath) } }),
          encoding: 'utf8',
          env: { ...process.env },
        });
      } catch (error) { return error.stdout ?? ''; }
    };
    assert.match(run('test/x.mjs'), /"permissionDecision":"deny"/);
    assert.match(run(`.adlc/tickets/${ticketFilename(ticket.id)}`), /"permissionDecision":"deny"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

// ---- completion expires a ticket's rails (issue #162) ----
//
// A ticket's `rails` are a PER-BUILD freeze: they stop that build from editing
// its own frozen foundation while it runs. Once the ticket is `completed: true`
// there is no in-flight build left to protect, so its rails expire — matching
// scripts/rails-guard-ci.mjs (the commit-time gate, which already does this)
// and the opencode/pi in-session checkers, which narrow to one active ticket.
// The trust-root freeze is a SEPARATE mechanism and must survive expiry.

test("a COMPLETED ticket's rail no longer freezes → allow", () => {
  const t = '{"tickets":[{"id":"T1","completed":true,"rails":["packages/**"]}]}';
  assert.equal(runRails(t, 'packages/fleet/package.json').verdict, 'allow');
});

test("an INCOMPLETE ticket's rail still denies (regression guard)", () => {
  const t = '{"tickets":[{"id":"T1","completed":false,"rails":["packages/**"]}]}';
  assert.equal(runRails(t, 'packages/fleet/package.json').verdict, 'deny');
});

test('the issue #162 repro: completed T37 freezes packages/**, active T42 rails packages/core/** only', () => {
  const t = JSON.stringify({ tickets: [
    { id: 'T37', completed: true, rails: ['packages/**', 'docs/ci/**'] },
    { id: 'T42', rails: ['packages/core/**'] },
  ] });
  // T42's scope authorizes a brand-new sibling package — previously denied by T37.
  assert.equal(runRails(t, 'packages/fleet/package.json').verdict, 'allow');
  // T42's OWN rail is untouched by the fix.
  assert.equal(runRails(t, 'packages/core/lib/x.mjs').verdict, 'deny');
});

test('trust root stays frozen even when EVERY declaring ticket is completed', () => {
  const t = '{"tickets":[{"id":"T1","completed":true,"rails":["packages/**"]}]}';
  assert.equal(runRails(t, '.adlc/tickets.json').verdict, 'deny');
  assert.equal(runRails(t, '.adlc/current-ticket.json').verdict, 'deny');
});

// `completed` is a strict boolean gate: anything that is not exactly `true` is
// NOT a completion, and the rail keeps freezing. Guards against a truthy-ish or
// tampered value silently expiring a live rail.
for (const [name, value] of [
  ['string "true"', '"true"'],
  ['number 1', '1'],
  ['null', 'null'],
  ['object', '{}'],
  ['string "yes"', '"yes"'],
]) {
  test(`completed: ${name} is NOT a completion → rail still denies`, () => {
    const t = `{"tickets":[{"id":"T1","completed":${value},"rails":["packages/**"]}]}`;
    assert.equal(runRails(t, 'packages/fleet/package.json').verdict, 'deny');
  });
}

// Malformed rail data on a COMPLETED ticket must still fail closed — completion
// must never become a way to smuggle an unvalidated store past the gate.
//
// These assert WHY it denied, not just that it denied. A bare `deny` assertion
// is close to hollow here: this hook denies on many unrelated conditions (an
// unreachable project dir, a symlink loop, an unextractable path), so a
// verdict-only test still passes if the rail validation is gone entirely and
// something else happens to deny.
//
// The reason is matched layer-AGNOSTICALLY. Two layers can legitimately reject
// this input: the store reader (loadTicketStoreReadOnly → validate(), which is
// what rejects today, before rails() iterates at all) and the hook's own
// in-loop checks (defense-in-depth, currently unreachable through the reader).
// Either is a correct fail-closed, so pinning one layer's exact wording would
// fail the suite while the gate is working — a brittle change-detector. The
// property under test is "denied BECAUSE the rails data is invalid", which is
// what the alternation encodes.
// NB: `out` is the raw JSON the hook prints, so any quotes inside a message are
// backslash-escaped there. Match on unquoted fragments only.
const RAILS_VALIDATION_DENIAL =
  /rails must be an array of strings|non-string rail entry|has a non-array/;

test('a COMPLETED ticket with a malformed rails field still fails closed', () => {
  const r = runRails('{"tickets":[{"id":"T1","completed":true,"rails":"packages/**"}]}', 'src/app.mjs');
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, RAILS_VALIDATION_DENIAL);
});

test('a COMPLETED ticket with a non-string rail entry still fails closed', () => {
  const r = runRails('{"tickets":[{"id":"T1","completed":true,"rails":["ok/**",42]}]}', 'src/app.mjs');
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, RAILS_VALIDATION_DENIAL);
});

test('a COMPLETED ticket with a non-array rails object still fails closed', () => {
  const r = runRails('{"tickets":[{"id":"T1","completed":true,"rails":{"glob":"packages/**"}}]}', 'packages/x.mjs');
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, RAILS_VALIDATION_DENIAL);
  // Completion must never be reported as "schema-valid, nothing declared".
  assert.doesNotMatch(r.out, /no rails declared/);
});


// ---- #243: the frozen-rail denial states its SCOPE honestly ----
// The hook gates structured edits only; a shell write to a rail (cat >>, perl -i)
// is NOT blocked in-session. If the message only says "blocked during build", an
// agent blocked on an Edit wrongly concludes the rail is fully enforced — then a
// shell dodge silently loses the in-session guard it thinks it has. The message
// must name its scope. It must NOT over-promise the CI backstop: rails-guard-ci
// reads its frozen set from the TRUSTED BASE, so it catches shell writes only to
// rails ALREADY on the base branch — not a rail this same change declares, and
// not the gitignored .adlc/current-ticket.json pointer (both surfaced by the P5
// prosecution of this ticket). A blanket "caught by CI / does not escape" claim
// would hand the agent false assurance for exactly those cases.
// (out is raw JSON with backslash-escaped quotes — match unquoted fragments only.)
test('#243: a frozen-rail denial names its structured-edit scope and honestly scopes the CI backstop', () => {
  const r = runRails('{"tickets":[{"id":"T1","rails":["test/auth/**"]}]}', 'test/auth/login.test.mjs');
  assert.equal(r.verdict, 'deny');
  assert.match(r.out, /structured edits/i);            // scope named
  assert.match(r.out, /rails-guard CI diff gate/i);     // backstop named
  assert.match(r.out, /base branch/i);                  // …but scoped to base-branch rails
  assert.match(r.out, /ADLC_RAILS_BYPASS=1\b/);          // the audited override names the correct value
  // Never revert to the blanket false claim (P5: false for same-change rails and the pointer).
  assert.doesNotMatch(r.out, /does not escape enforcement/i);
});

test('#243: the active-ticket pointer denial does not falsely claim CI catches a shell write to it', () => {
  // .adlc/current-ticket.json is gitignored local state with NO commit-time CI diff,
  // so the message must not promise it is CI-backstopped.
  const r = runRails('{"tickets":[{"id":"T1","rails":["test/auth/**"]}]}', '.adlc/current-ticket.json');
  assert.equal(r.verdict, 'deny');
  assert.doesNotMatch(r.out, /does not escape enforcement/i);
  assert.match(r.out, /active-ticket pointer/i);        // the scoped caveat is present
});


// ---- trust root: tickets.json is frozen once rails exist (structured edits) ----

const RAIL_T = '{"tickets":[{"id":"T1","rails":["test/auth/**","src/types/api.d.ts"]}]}';

test('editing .adlc/tickets.json while rails exist → deny (trust root)', () => {
  assert.equal(runRails(RAIL_T, '.adlc/tickets.json').verdict, 'deny');
});


test('editing .adlc/tickets.json with NO rails declared → allow (authoring the first ticket)', () => {
  assert.equal(runRails('{"tickets":[]}', '.adlc/tickets.json').verdict, 'allow');
});

// ---- trust root: .adlc/current-ticket.json is frozen once rails exist too
// (build-gate's active-ticket pointer — see issue #48 follow-up review) ----

test('editing .adlc/current-ticket.json while rails exist → deny (trust root)', () => {
  assert.equal(runRails(RAIL_T, '.adlc/current-ticket.json').verdict, 'deny');
});

test('editing .adlc/current-ticket.json with NO rails declared → allow (build-gate not opted into rails)', () => {
  assert.equal(runRails('{"tickets":[]}', '.adlc/current-ticket.json').verdict, 'allow');
});

// ---- multi-file / nested-path edit payloads ----

/** Run the hook with an arbitrary tool_input payload; returns 'deny'|'allow'. */
function runPayload(ticketsJson, toolInput, { env = {}, cwdOverride = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-rails-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    try {
      const fixture = JSON.parse(ticketsJson);
      for (const ticket of fixture.tickets ?? []) if (ticket && typeof ticket === 'object') ticket.title ??= `${ticket.id ?? '?'} fixture`;
      ticketsJson = JSON.stringify(fixture);
    } catch {}
    writeFileSync(join(dir, '.adlc', 'tickets.json'), ticketsJson);
    const input = JSON.stringify({ cwd: cwdOverride ?? dir, tool_input: toolInput });
    let out = '';
    try {
      out = execFileSync(process.execPath, [HOOK, 'rails'], {
        input,
        encoding: 'utf8',
        env: childEnv({ CLAUDE_PROJECT_DIR: '', ...env }),
      });
    } catch (e) {
      if (e.status === 2 && !e.stdout) return 'deny'; // fail-closed exit 2 with no payload
      out = e.stdout ?? '';
    }
    return out.includes('"permissionDecision":"deny"') ? 'deny' : 'allow';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const RAIL_MF = '{"tickets":[{"id":"T1","rails":["src/types/api.d.ts","test/auth/**"]}]}';

test('edits[] array carrying a rail file_path → deny (MultiEdit-style)', () => {
  const v = runPayload(RAIL_MF, { edits: [{ file_path: 'src/types/api.d.ts', old_string: 'a', new_string: 'b' }] });
  assert.equal(v, 'deny');
});

test('files[] string array containing a rail → deny', () => {
  const v = runPayload(RAIL_MF, { files: ['src/app.mjs', 'test/auth/x.test.mjs'] });
  assert.equal(v, 'deny');
});

test('multi-file edit with NO rail among the paths → allow', () => {
  const v = runPayload(RAIL_MF, { files: ['src/app.mjs', 'docs/readme.md'] });
  assert.equal(v, 'allow');
});

test('chdir failure (unreachable project dir) in rails mode → fail closed', () => {
  const v = runPayload(RAIL_MF, { file_path: 'src/app.mjs' }, { cwdOverride: '/nonexistent-adlc-xyz-12345' });
  assert.equal(v, 'deny');
});

// ---- robustness: subdir invocation + symlinked rail definitions ----

test('a RELATIVE file_path from a subdir resolves against the invocation dir → deny', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-rails-'));
  try {
    mkdirSync(join(dir, '.git'));
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(join(dir, '.adlc', 'tickets.json'), '{"tickets":[{"id":"T1","rails":["src/**"]}]}');
    mkdirSync(join(dir, 'src'));
    // cwd = src/, file_path is RELATIVE "secret.js" → really src/secret.js, must be denied
    const input = JSON.stringify({ cwd: join(dir, 'src'), tool_name: 'Edit', tool_input: { file_path: 'secret.js' } });
    let out = '';
    try {
      out = execFileSync(process.execPath, [HOOK, 'rails'], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
    } catch (e) {
      out = e.stdout ?? '';
    }
    assert.match(out, /"permissionDecision":"deny"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RELATIVE file_path with CLAUDE_PROJECT_DIR set to the root resolves against input.cwd → deny', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-rails-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(join(dir, '.adlc', 'tickets.json'), '{"tickets":[{"id":"T1","rails":["src/**"]}]}');
    mkdirSync(join(dir, 'src'));
    // CLAUDE_PROJECT_DIR = repo root, but the tool ran in src/ with a relative path
    const input = JSON.stringify({ cwd: join(dir, 'src'), tool_name: 'Edit', tool_input: { file_path: 'secret.js' } });
    let out = '';
    try {
      out = execFileSync(process.execPath, [HOOK, 'rails'], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
    } catch (e) {
      out = e.stdout ?? '';
    }
    assert.match(out, /"permissionDecision":"deny"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a nested subdir .adlc does NOT shadow the git-root rail config → deny', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-rails-'));
  try {
    mkdirSync(join(dir, '.git')); // git root marker
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(join(dir, '.adlc', 'tickets.json'), '{"tickets":[{"id":"T1","rails":["src/**"]}]}');
    mkdirSync(join(dir, 'src', 'sub'), { recursive: true });
    mkdirSync(join(dir, 'src', '.adlc')); // a nested (rail-less) .adlc that must NOT win
    const input = JSON.stringify({ cwd: join(dir, 'src', 'sub'), tool_name: 'Edit', tool_input: { file_path: join(dir, 'src', 'secret.js') } });
    let out = '';
    try {
      out = execFileSync(process.execPath, [HOOK, 'rails'], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
    } catch (e) {
      out = e.stdout ?? '';
    }
    assert.match(out, /"permissionDecision":"deny"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hook invoked from a SUBDIR (no CLAUDE_PROJECT_DIR) still gates a rail → deny', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-rails-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, '.adlc', 'tickets.json'), '{"tickets":[{"id":"T1","rails":["src/**"]}]}');
    // cwd is the SUBDIR src/, CLAUDE_PROJECT_DIR unset → must walk up to find .adlc
    const input = JSON.stringify({ cwd: join(dir, 'src'), tool_name: 'Edit', tool_input: { file_path: join(dir, 'src', 'secret.js') } });
    let out = '';
    try {
      out = execFileSync(process.execPath, [HOOK, 'rails'], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
    } catch (e) {
      out = e.stdout ?? '';
    }
    assert.match(out, /"permissionDecision":"deny"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rail on a symlinked dir, editing the REAL path directly → deny (resolved rail form)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-rails-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    mkdirSync(join(dir, 'real_dir'));
    symlinkSync(join(dir, 'real_dir'), join(dir, 'symdir')); // symdir → real_dir
    writeFileSync(join(dir, '.adlc', 'tickets.json'), '{"tickets":[{"id":"T1","rails":["symdir/**"]}]}');
    // edit the REAL path directly — must still be caught (rail resolved to real_dir/**)
    const input = JSON.stringify({ cwd: dir, tool_name: 'Write', tool_input: { file_path: join(dir, 'real_dir', 'f.js') } });
    let out = '';
    try {
      out = execFileSync(process.execPath, [HOOK, 'rails'], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
    } catch (e) {
      out = e.stdout ?? '';
    }
    assert.match(out, /"permissionDecision":"deny"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a backslash-spelled rail glob is normalized → deny', () => {
  // rail "src\\api.d.ts" (JSON-escaped) → normalized to src/api.d.ts
  const v = runRails('{"tickets":[{"id":"T1","rails":["src\\\\api.d.ts"]}]}', 'src/api.d.ts');
  assert.equal(v.verdict, 'deny');
});

test('a rail defined on a symlinked FILE → editing the symlink path → deny (lexical form)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-rails-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'real_api.d.ts'), 'x\n');
    symlinkSync(join(dir, 'src', 'real_api.d.ts'), join(dir, 'src', 'api.d.ts')); // api.d.ts → real_api.d.ts
    writeFileSync(join(dir, '.adlc', 'tickets.json'), '{"tickets":[{"id":"T1","rails":["src/api.d.ts"]}]}');
    const input = JSON.stringify({ cwd: dir, tool_name: 'Edit', tool_input: { file_path: join(dir, 'src', 'api.d.ts') } });
    let out = '';
    try {
      out = execFileSync(process.execPath, [HOOK, 'rails'], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
    } catch (e) {
      out = e.stdout ?? '';
    }
    assert.match(out, /"permissionDecision":"deny"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a rail defined on a SYMLINKED dir matches the resolved target → deny', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-rails-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    mkdirSync(join(dir, 'real_dir'));
    symlinkSync(join(dir, 'real_dir'), join(dir, 'symdir')); // symdir → real_dir
    writeFileSync(join(dir, '.adlc', 'tickets.json'), '{"tickets":[{"id":"T1","rails":["symdir/**"]}]}');
    // edit the symlink path → resolves to real_dir/f.js; rail symdir/** must still catch it
    const input = JSON.stringify({ cwd: dir, tool_name: 'Write', tool_input: { file_path: join(dir, 'symdir', 'f.js') } });
    let out = '';
    try {
      out = execFileSync(process.execPath, [HOOK, 'rails'], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
    } catch (e) {
      out = e.stdout ?? '';
    }
    assert.match(out, /"permissionDecision":"deny"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- symlink resolution: editing a symlink that points at a rail → deny ----

test('editing a symlink that resolves to a rail file → deny', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-rails-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(join(dir, '.adlc', 'tickets.json'), '{"tickets":[{"id":"T1","rails":["src/api.d.ts"]}]}');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'api.d.ts'), 'rail\n');
    symlinkSync(join(dir, 'src', 'api.d.ts'), join(dir, 'src', 'link.d.ts')); // link → rail
    const input = JSON.stringify({ cwd: dir, tool_input: { file_path: join(dir, 'src', 'link.d.ts') } });
    let out = '';
    try {
      out = execFileSync(process.execPath, [HOOK, 'rails'], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
    } catch (e) {
      out = e.stdout ?? '';
    }
    assert.match(out, /"permissionDecision":"deny"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writing a NEW nested file under a symlinked rail dir → deny', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-rails-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(join(dir, '.adlc', 'tickets.json'), '{"tickets":[{"id":"T1","rails":["secret/**"]}]}');
    mkdirSync(join(dir, 'secret')); // the frozen rail dir
    symlinkSync(join(dir, 'secret'), join(dir, 'link')); // link → secret
    // new file in a NEW subdir under the symlink (subdir does not exist yet)
    const input = JSON.stringify({ cwd: dir, tool_name: 'Write', tool_input: { file_path: join(dir, 'link', 'newsub', 'f.js') } });
    let out = '';
    try {
      out = execFileSync(process.execPath, [HOOK, 'rails'], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
    } catch (e) {
      out = e.stdout ?? '';
    }
    assert.match(out, /"permissionDecision":"deny"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('structured edit (Edit) with no extractable path while rails exist → fail closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-rails-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(join(dir, '.adlc', 'tickets.json'), '{"tickets":[{"id":"T1","rails":["test/**"]}]}');
    // an Edit tool whose payload has no file_path/edits/files at all
    const input = JSON.stringify({ cwd: dir, tool_name: 'Edit', tool_input: { foo: 'bar' } });
    let code = 0;
    try {
      execFileSync(process.execPath, [HOOK, 'rails'], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
    } catch (e) {
      code = e.status;
    }
    assert.equal(code, 2); // fail closed
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writing under a BROKEN symlink that points at a (not-yet-existing) rail dir → deny', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-rails-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(join(dir, '.adlc', 'tickets.json'), '{"tickets":[{"id":"T1","rails":["rail_dir/**"]}]}');
    symlinkSync(join(dir, 'rail_dir'), join(dir, 'link')); // link → rail_dir, which does NOT exist yet
    const input = JSON.stringify({ cwd: dir, tool_name: 'Write', tool_input: { file_path: join(dir, 'link', 'new', 'f.js') } });
    let out = '';
    try {
      out = execFileSync(process.execPath, [HOOK, 'rails'], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
    } catch (e) {
      out = e.stdout ?? '';
    }
    assert.match(out, /"permissionDecision":"deny"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an UNRECOGNIZED matched tool targeting a rail → deny (fail closed by default)', () => {
  // The hook trusts the matcher: any tool routed here is gated by path, with no
  // in-code allowlist that could drift and fail open for a newly-matched tool.
  const dir = mkdtempSync(join(tmpdir(), 'adlc-rails-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(join(dir, '.adlc', 'tickets.json'), '{"tickets":[{"id":"T1","rails":["test/**"]}]}');
    const input = JSON.stringify({ cwd: dir, tool_name: 'SomeFutureEditTool', tool_input: { file_path: join(dir, 'test', 'x.test.mjs') } });
    let out = '';
    try {
      out = execFileSync(process.execPath, [HOOK, 'rails'], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
    } catch (e) {
      out = e.stdout ?? '';
    }
    assert.match(out, /"permissionDecision":"deny"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('editing the real target of a symlinked .adlc/tickets.json → deny (trust root via resolved path)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-rails-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    mkdirSync(join(dir, 'cfg'));
    // the REAL tickets file lives elsewhere; .adlc/tickets.json is a symlink to it
    writeFileSync(join(dir, 'cfg', 'real-tickets.json'), '{"tickets":[{"id":"T1","rails":["src/secret.js"]}]}');
    symlinkSync(join(dir, 'cfg', 'real-tickets.json'), join(dir, '.adlc', 'tickets.json'));
    // editing the real target would clear the rails → must be denied as the trust root
    const input = JSON.stringify({ cwd: dir, tool_name: 'Edit', tool_input: { file_path: join(dir, 'cfg', 'real-tickets.json') } });
    let out = '';
    try {
      out = execFileSync(process.execPath, [HOOK, 'rails'], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
    } catch (e) {
      out = e.stdout ?? '';
    }
    assert.match(out, /"permissionDecision":"deny"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a symlink loop in the target path → fail closed (no infinite resolution)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-rails-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(join(dir, '.adlc', 'tickets.json'), '{"tickets":[{"id":"T1","rails":["test/**"]}]}');
    symlinkSync(join(dir, 'b'), join(dir, 'a')); // a → b
    symlinkSync(join(dir, 'a'), join(dir, 'b')); // b → a  (loop)
    const input = JSON.stringify({ cwd: dir, tool_name: 'Write', tool_input: { file_path: join(dir, 'a', 'x.js') } });
    let code = 0;
    try {
      execFileSync(process.execPath, [HOOK, 'rails'], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
    } catch (e) {
      code = e.status;
    }
    assert.equal(code, 2); // fail closed, not hang/allow
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- fail closed on unreadable/malformed input ----

test('malformed stdin in rails mode → fail closed (deny)', () => {
  let code = 0;
  try {
    execFileSync(process.execPath, [HOOK, 'rails'], { input: 'not json at all', encoding: 'utf8' });
  } catch (e) {
    code = e.status;
  }
  assert.equal(code, 2); // fail-closed exit
});

// ---- Bash is intentionally NOT gated in-session (Option C) ----
// The hook trusts the matcher, so "Bash is not gated" is enforced at the CONFIG
// level: the PreToolUse rails matcher must not include Bash. (If Bash were routed
// here it would fail closed — which is why the guarantee lives in the matcher.)

test('the PreToolUse rails matcher excludes Bash (Bash → CI-gate territory)', () => {
  const hooksJson = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks.json'), 'utf8')
  );
  const railsEntry = hooksJson.hooks.PreToolUse.find((e) =>
    e.hooks.some(
      (h) =>
        (h.command.includes('adlc-hook-run.mjs') || h.command.includes('adlc-hook.mjs')) &&
        h.command.includes('rails')
    )
  );
  assert.ok(railsEntry, 'a PreToolUse rails hook entry exists');
  assert.equal(/\bBash\b/.test(railsEntry.matcher), false); // Bash not gated in-session
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
const REPO_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'node_modules', '.bin');
const WITH_ADLC = `${REPO_BIN}:${NODE_DIR}:${process.env.PATH ?? ''}`; // recorder reachable

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
  // Simulate an unreachable recorder with an EMPTY PATH dir. Pointing PATH at
  // node's own directory is NOT sufficient: a globally-installed `adlc` lands
  // alongside the node binary (npm global bins under fnm/nvm share node's dir),
  // so it would still resolve there and the bypass would be (wrongly) audited.
  // An empty dir guarantees `adlc` is off PATH regardless of where it is
  // installed. The hook is launched via an absolute node path, so it needs
  // nothing on PATH to run — only the recorder lookup is affected.
  const noAdlcDir = mkdtempSync(join(tmpdir(), 'adlc-no-recorder-'));
  try {
    const t = '{"tickets":[{"id":"T1","rails":["test/**"]}]}';
    const r = runRails(t, 'test/x.mjs', { env: { ADLC_RAILS_BYPASS: '1', PATH: noAdlcDir } });
    assert.equal(r.verdict, 'deny');
  } finally {
    rmSync(noAdlcDir, { recursive: true, force: true });
  }
});

test('bypass on a multi-file edit hitting two rails → allow + BOTH audited', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-rails-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(join(dir, '.adlc', 'tickets.json'), '{"tickets":[{"id":"T1","title":"T1 fixture","rails":["a/**"]},{"id":"T2","title":"T2 fixture","rails":["b/**"]}]}');
    const input = JSON.stringify({ cwd: dir, tool_input: { files: ['a/x.mjs', 'b/y.mjs'] } });
    let out = '';
    try {
      out = execFileSync(process.execPath, [HOOK, 'rails'], {
        input, encoding: 'utf8', env: { ...process.env, ADLC_RAILS_BYPASS: '1', PATH: WITH_ADLC, CLAUDE_PROJECT_DIR: '' },
      });
    } catch (e) {
      out = e.stdout ?? '';
    }
    assert.equal(out.includes('"permissionDecision":"deny"'), false); // audited bypass → allow
    const manifest = readFileSync(join(dir, '.adlc', 'manifest.jsonl'), 'utf8');
    const bypassEntries = manifest.split('\n').filter((l) => l.includes('rails-bypass')).length;
    assert.equal(bypassEntries, 2); // BOTH rail hits audited, not just the first
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// ---- #204: hermetic suite, scoped bypass, in-session observability ----
// (out is raw JSON with backslash-escaped quotes — match unquoted fragments only.)

test('#204 (AC1): an ambient ADLC_RAILS_BYPASS in the parent env does not disarm a deny-test', () => {
  // The reported self-blinding: with the var live in the process env, ~43/57
  // deny-tests inverted to passing-as-allow. childEnv scrubs it per-call, so a
  // rail edit still DENIES even when the parent has it set.
  const prev = process.env.ADLC_RAILS_BYPASS;
  process.env.ADLC_RAILS_BYPASS = '1';
  try {
    const r = runRails('{"tickets":[{"id":"T1","rails":["test/auth/**"]}]}', 'test/auth/login.test.mjs');
    assert.equal(r.verdict, 'deny');
  } finally {
    if (prev === undefined) delete process.env.ADLC_RAILS_BYPASS;
    else process.env.ADLC_RAILS_BYPASS = prev;
  }
});

test('#204 (AC2): a scoped ADLC_RAILS_BYPASS=<glob> authorizes only matching rails', () => {
  const t = '{"tickets":[{"id":"T1","rails":["test/auth/**","src/types/api.d.ts"]}]}';
  // In scope → allow (and audited).
  const rIn = runRails(t, 'test/auth/login.test.mjs', { env: { ADLC_RAILS_BYPASS: 'test/auth/**', PATH: WITH_ADLC } });
  assert.equal(rIn.verdict, 'allow');
  assert.match(rIn.manifest, /rails-bypass/);
  // Out of scope → deny, naming the scope (a bypass must not silently authorize
  // outside the scope it was granted for).
  const rOut = runRails(t, 'src/types/api.d.ts', { env: { ADLC_RAILS_BYPASS: 'test/auth/**', PATH: WITH_ADLC } });
  assert.equal(rOut.verdict, 'deny');
  assert.match(rOut.out, /does not authorize/i);
});

test('#204 (AC3): the unscoped =1 bypass emits a visible notice disclosing its session lifetime', () => {
  const t = '{"tickets":[{"id":"T1","rails":["test/auth/**"]}]}';
  const r = runRails(t, 'test/auth/login.test.mjs', { env: { ADLC_RAILS_BYPASS: '1', PATH: WITH_ADLC } });
  assert.equal(r.verdict, 'allow');
  assert.match(r.out, /ADLC_RAILS_BYPASS active/i);
  assert.match(r.out, /UNSCOPED, session-wide/i);
  assert.match(r.out, /deleting a settings file does NOT revoke it/i);
  // …and the concrete revocation guidance (the four AC3 pillars: what/scope,
  // lifetime, not-revoked-by-settings, how-to-revoke).
  assert.match(r.out, /unset ADLC_RAILS_BYPASS and restart the session/i);
  assert.match(r.out, /scope it with ADLC_RAILS_BYPASS=<glob>/i);
});

test('#204 (AC3): a scoped bypass notice names the scope and omits the session-wide disclosure', () => {
  const t = '{"tickets":[{"id":"T1","rails":["test/auth/**"]}]}';
  const r = runRails(t, 'test/auth/login.test.mjs', { env: { ADLC_RAILS_BYPASS: 'test/auth/**', PATH: WITH_ADLC } });
  assert.equal(r.verdict, 'allow');
  assert.match(r.out, /ADLC_RAILS_BYPASS active \(scope/i);
  assert.match(r.out, /test\/auth\/\*\*/);
  assert.doesNotMatch(r.out, /session-wide/i);
});

test('#204: an inert sentinel (=0 / =false / =off) is NOT a bypass — a rail edit still denies', () => {
  const t = '{"tickets":[{"id":"T1","rails":["test/auth/**"]}]}';
  for (const v of ['0', 'false', 'off']) {
    const r = runRails(t, 'test/auth/login.test.mjs', { env: { ADLC_RAILS_BYPASS: v, PATH: WITH_ADLC } });
    assert.equal(r.verdict, 'deny', `=${v} must not authorize a rail edit`);
    assert.doesNotMatch(r.out, /ADLC_RAILS_BYPASS active/i); // no bypass notice
    assert.doesNotMatch(r.manifest, /rails-bypass/);          // no audit entry
    // Crucially, an inert value takes the NORMAL frozen-rail deny path — it is
    // NOT consulted as a bypass at all. If it were mistakenly treated as an
    // active (empty) scope, the deny would instead say "does not authorize".
    assert.match(r.out, /frozen rail declared by ticket/i);
    assert.doesNotMatch(r.out, /does not authorize|wildcard-only/i);
  }
});

test('#204: a wildcard-only scope (=** / =* / =**/*) is refused — session-wide requires =1', () => {
  const t = '{"tickets":[{"id":"T1","rails":["test/auth/**"]}]}';
  for (const v of ['**', '*', '**/*']) {
    const r = runRails(t, 'test/auth/login.test.mjs', { env: { ADLC_RAILS_BYPASS: v, PATH: WITH_ADLC } });
    assert.equal(r.verdict, 'deny', `=${v} must be refused as a scope`);
    assert.match(r.out, /wildcard-only scope|ADLC_RAILS_BYPASS=1 for a deliberate/i);
    assert.doesNotMatch(r.out, /ADLC_RAILS_BYPASS active/i); // refused, not honored
  }
});

// ---- root resolution must stay inside the user's project (~/.adlc collision) ----
//
// The upward walk that finds the ADLC root used to accept a bare `.adlc/`
// directory and to ascend without bound. Both let a directory in `$HOME` become
// the "root": the hook `chdir`'d there, escaping the repo the user was actually
// editing and resolving every rail path against `$HOME`. Two guards, two tests.

/** Run the rails hook against `startDir` with a synthetic `$HOME`. */
function runRailsIn(startDir, filePath, home) {
  const input = JSON.stringify({ cwd: startDir, tool_input: { file_path: filePath } });
  const env = { ...process.env, HOME: home };
  delete env.CLAUDE_PROJECT_DIR; // must not short-circuit the walk
  delete env.ADLC_RAILS_BYPASS;
  delete env.ADLC_TICKET_STORE;
  delete env.ADLC_TICKETS;
  let out = '';
  try {
    out = execFileSync(process.execPath, [HOOK, 'rails'], { input, encoding: 'utf8', env });
  } catch (e) {
    out = e.stdout ?? '';
  }
  return { verdict: out.includes('"permissionDecision":"deny"') ? 'deny' : 'allow', out };
}

// Observed through `manifest` mode: it reports on whichever directory the hook
// adopted as the root, so adopting a stray one is directly visible. `rails` mode
// cannot show this — it allows either way once no ticket store is found.
test('a bare .adlc directory above a repo is not adopted as the ADLC root', () => {
  const home = mkdtempSync(join(tmpdir(), 'adlc-home-bare-'));
  try {
    // Stray plugin state — a `.adlc/` with no ticket store. It carries a corrupt
    // manifest so that adopting it would be loudly visible on stdout.
    const stray = join(home, 'work');
    mkdirSync(join(stray, '.adlc'), { recursive: true });
    writeFileSync(join(stray, '.adlc', 'cursor-buildgate-depth-anonymous.json'), '{"count":6}');
    writeFileSync(
      join(stray, '.adlc', 'manifest.jsonl'),
      '{"seq":1,"phase":"P4","prev":"bogus","sig":"nope"}\n',
    );
    const project = join(stray, 'project');
    mkdirSync(join(project, '.git'), { recursive: true });
    mkdirSync(join(project, 'src'), { recursive: true });

    const env = { ...process.env, HOME: home, PATH: WITH_ADLC, CLAUDE_PROJECT_DIR: '' };
    delete env.ADLC_TICKET_STORE;
    delete env.ADLC_TICKETS;
    let out = '';
    try {
      out = execFileSync(process.execPath, [HOOK, 'manifest'], {
        input: JSON.stringify({ cwd: join(project, 'src') }),
        encoding: 'utf8',
        env,
      });
    } catch (e) {
      out = e.stdout ?? '';
    }
    // Adopting the stray dir would surface ITS manifest as an invalid chain.
    assert.equal(out.trim(), '', `hook reported on a directory it should not have adopted: ${out}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a ticket store that LANDS at ~/.adlc cannot capture a repo below it', () => {
  const home = mkdtempSync(join(tmpdir(), 'adlc-home-store-'));
  try {
    // The real accident: a scaffolder run from $HOME leaves a genuine store here,
    // with rails that would freeze everything underneath.
    mkdirSync(join(home, '.adlc'));
    writeFileSync(
      join(home, '.adlc', 'tickets.json'),
      JSON.stringify({ tickets: [{ id: 'T1', title: 'stray', rails: ['**'] }] }),
    );
    const project = join(home, 'unrelated-project');
    mkdirSync(join(project, '.git'), { recursive: true });
    mkdirSync(join(project, 'src'), { recursive: true });
    const r = runRailsIn(join(project, 'src'), join(project, 'src', 'app.js'), home);
    assert.equal(r.verdict, 'allow', "$HOME's rails must not govern an unrelated repo");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a repo rooted AT $HOME still enforces its own rails', () => {
  const home = mkdtempSync(join(tmpdir(), 'adlc-home-dotfiles-'));
  try {
    mkdirSync(join(home, '.adlc'));
    writeFileSync(
      join(home, '.adlc', 'tickets.json'),
      JSON.stringify({ tickets: [{ id: 'T1', title: 'dotfiles', rails: ['zsh/**'] }] }),
    );
    mkdirSync(join(home, 'zsh'), { recursive: true });
    const r = runRailsIn(home, join(home, 'zsh', '.zshrc'), home);
    assert.equal(r.verdict, 'deny', 'a dotfiles repo rooted at $HOME is still a real ADLC repo');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Bounding the walk at $HOME must not disarm a repo that legitimately IS $HOME.
// A dotfiles repo has to keep enforcing its rails from its own subdirectories
// (adversarial-review finding), while a $HOME that merely CONTAINS a stray
// .adlc still must not capture anything.
test('a dotfiles repo rooted at $HOME enforces rails from a SUBDIRECTORY', () => {
  const home = mkdtempSync(join(tmpdir(), 'adlc-home-dotfiles-sub-'));
  try {
    mkdirSync(join(home, '.git'), { recursive: true }); // a real repo rooted at $HOME
    mkdirSync(join(home, '.adlc'), { recursive: true });
    writeFileSync(
      join(home, '.adlc', 'tickets.json'),
      JSON.stringify({ tickets: [{ id: 'T1', title: 'dotfiles', rails: ['zsh/**'] }] }),
    );
    mkdirSync(join(home, 'zsh'), { recursive: true });
    const r = runRailsIn(join(home, 'zsh'), join(home, 'zsh', '.zshrc'), home);
    assert.equal(r.verdict, 'deny', 'rails of a $HOME-rooted repo must apply in its subdirs');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a stray store at $HOME is still ignored even when $HOME is a git repo below it', () => {
  // $HOME is NOT a git repo here — only the nested project is. The store at
  // $HOME must not reach down into it.
  const home = mkdtempSync(join(tmpdir(), 'adlc-home-stray-sub-'));
  try {
    mkdirSync(join(home, '.adlc'), { recursive: true });
    writeFileSync(
      join(home, '.adlc', 'tickets.json'),
      JSON.stringify({ tickets: [{ id: 'T1', title: 'stray', rails: ['**'] }] }),
    );
    const project = join(home, 'proj');
    mkdirSync(join(project, '.git'), { recursive: true });
    mkdirSync(join(project, 'src'), { recursive: true });
    const r = runRailsIn(join(project, 'src'), join(project, 'src', 'app.js'), home);
    assert.equal(r.verdict, 'allow');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// With no enclosing git repo, the NEAREST ancestor store wins — the fallback the
// walk documents. Pins `adlcRoot === null && …`: relaxing that condition lets a
// HIGHER ancestor's store overwrite the nearer one, so the wrong ticket's rails
// would govern the edit.
test('the nearest-ancestor store wins over a higher one when there is no git root', () => {
  const box = mkdtempSync(join(tmpdir(), 'adlc-nested-store-'));
  try {
    const outer = join(box, 'outer');
    const inner = join(outer, 'inner');
    mkdirSync(join(outer, '.adlc'), { recursive: true });
    mkdirSync(join(inner, '.adlc'), { recursive: true });
    mkdirSync(join(inner, 'secret'), { recursive: true });
    // The far store freezes something the edit does NOT touch...
    writeFileSync(
      join(outer, '.adlc', 'tickets.json'),
      JSON.stringify({ tickets: [{ id: 'OUTER', title: 'outer', rails: ['untouched/**'] }] }),
    );
    // ...while the NEAR one freezes exactly what is being edited.
    writeFileSync(
      join(inner, '.adlc', 'tickets.json'),
      JSON.stringify({ tickets: [{ id: 'INNER', title: 'inner', rails: ['secret/**'] }] }),
    );
    // $HOME is elsewhere, so the home guard plays no part here.
    const r = runRailsIn(inner, join(inner, 'secret', 'x.js'), join(box, 'home'));
    assert.equal(r.verdict, 'deny', "the nearest store's rails must govern the edit");
    assert.match(r.out, /INNER/, 'and it must be the NEAR ticket that denies, not the far one');
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});

// The ancestor fallback must never reach OUTSIDE the enclosing git repo. The
// $HOME guard alone only covered a store sitting exactly at $HOME; a store in
// any intermediate ancestor captured the repo below it just the same
// (adversarial-review finding).
test('a store in an ancestor ABOVE a non-ADLC git repo does not capture it', () => {
  const home = mkdtempSync(join(tmpdir(), 'adlc-ancestor-store-'));
  try {
    const work = join(home, 'work');
    mkdirSync(join(work, '.adlc'), { recursive: true });
    writeFileSync(
      join(work, '.adlc', 'tickets.json'),
      JSON.stringify({ tickets: [{ id: 'ANCESTOR', title: 'stray', rails: ['**'] }] }),
    );
    const repo = join(work, 'my-repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    const r = runRailsIn(join(repo, 'src'), join(repo, 'src', 'app.js'), home);
    assert.equal(r.verdict, 'allow', "an ancestor's rails must not govern an unrelated repo");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ...but a store at or BELOW the git root is still honored, so a package-level
// store in a monorepo keeps enforcing (guards against over-correcting above).
test('a package-level store BELOW the git root still enforces its rails', () => {
  const home = mkdtempSync(join(tmpdir(), 'adlc-monorepo-store-'));
  try {
    const mono = join(home, 'mono');
    mkdirSync(join(mono, '.git'), { recursive: true });
    const pkg = join(mono, 'pkg');
    mkdirSync(join(pkg, '.adlc'), { recursive: true });
    mkdirSync(join(pkg, 'secret'), { recursive: true });
    writeFileSync(
      join(pkg, '.adlc', 'tickets.json'),
      JSON.stringify({ tickets: [{ id: 'PKG', title: 'pkg', rails: ['secret/**'] }] }),
    );
    // Start BELOW the package root. Starting at `pkg` itself would prove nothing:
    // the hook already chdir'd there, so the walk's answer could be discarded
    // entirely and the rail would still be found.
    const r = runRailsIn(join(pkg, 'secret'), join(pkg, 'secret', 'x.js'), home);
    assert.equal(r.verdict, 'deny');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

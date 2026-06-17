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

// ---- multi-file / nested-path edit payloads ----

/** Run the hook with an arbitrary tool_input payload; returns 'deny'|'allow'. */
function runPayload(ticketsJson, toolInput, { env = {}, cwdOverride = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-rails-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(join(dir, '.adlc', 'tickets.json'), ticketsJson);
    const input = JSON.stringify({ cwd: cwdOverride ?? dir, tool_input: toolInput });
    let out = '';
    try {
      out = execFileSync(process.execPath, [HOOK, 'rails'], {
        input,
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: '', ...env },
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
    e.hooks.some((h) => h.command.includes('adlc-hook.mjs') && h.command.includes('rails'))
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

test('bypass on a multi-file edit hitting two rails → allow + BOTH audited', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-rails-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(join(dir, '.adlc', 'tickets.json'), '{"tickets":[{"id":"T1","rails":["a/**"]},{"id":"T2","rails":["b/**"]}]}');
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

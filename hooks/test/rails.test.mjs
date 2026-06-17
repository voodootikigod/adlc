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

// ---- Bash branch: deny shell writes to a rail, allow reads/runs ----

function runBash(ticketsJson, command, { env = {}, shape = 'tool_input' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-rails-'));
  try {
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(join(dir, '.adlc', 'tickets.json'), ticketsJson);
    const cmd = command.replace(/%DIR%/g, dir); // %DIR% → the temp project root
    const payload = { cwd: dir, tool_name: 'Bash', [shape]: { command: cmd } };
    const input = JSON.stringify(payload);
    let out = '';
    try {
      out = execFileSync(process.execPath, [HOOK, 'rails'], { input, encoding: 'utf8', env: { ...process.env, ...env } });
    } catch (e) {
      out = e.stdout ?? '';
    }
    return out.includes('"permissionDecision":"deny"') ? 'deny' : 'allow';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const RAIL_T = '{"tickets":[{"id":"T1","rails":["test/auth/**","src/types/api.d.ts"]}]}';

for (const [name, cmd, exp] of [
  ['redirect > rail', 'echo x > test/auth/login.test.mjs', 'deny'],
  ['append >> rail', 'echo x >> test/auth/login.test.mjs', 'deny'],
  ['sed -i rail', "sed -i 's/a/b/' test/auth/login.test.mjs", 'deny'],
  ['sed -i with pipe delimiter', "sed -i 's|a|b|' test/auth/login.test.mjs", 'deny'],
  ['sed -i with semicolon in script', "sed -i 's/a/b/;s/c/d/' test/auth/login.test.mjs", 'deny'],
  ['write after a pipe', 'cat x | tee test/auth/login.test.mjs', 'deny'],
  ['command chain ; then write', 'echo hi ; echo x > test/auth/login.test.mjs', 'deny'],
  ['tee rail', 'echo x | tee test/auth/login.test.mjs', 'deny'],
  ['dd of= rail', 'dd if=/dev/null of=src/types/api.d.ts', 'deny'],
  ['truncate rail', 'truncate -s 0 test/auth/login.test.mjs', 'deny'],
  ['redirect to ./rail', 'echo x > ./test/auth/login.test.mjs', 'deny'],
  ['redirect to absolute rail', 'echo x > %DIR%/test/auth/login.test.mjs', 'deny'],
  ['redirect to quoted rail', 'echo x > "test/auth/login.test.mjs"', 'deny'],
  ['sed -i ./rail', "sed -i 's/a/b/' ./test/auth/login.test.mjs", 'deny'],
  ['run a rail test (no write)', 'node test/auth/login.test.mjs', 'allow'],
  ['cat a rail (read)', 'cat test/auth/login.test.mjs', 'allow'],
  ['write a non-rail', 'echo x > src/app.mjs', 'allow'],
  ['grep a rail (read, no write)', 'grep foo test/auth/login.test.mjs', 'allow'],
  ['rm a rail (deletion)', 'rm test/auth/login.test.mjs', 'deny'],
  ['rm -f a rail', 'rm -f test/auth/login.test.mjs', 'deny'],
  ['mv a rail away (source)', 'mv test/auth/login.test.mjs /tmp/x', 'deny'],
  ['mv onto a rail (dest)', 'mv /tmp/x test/auth/login.test.mjs', 'deny'],
  ['cp onto a rail (dest written)', 'cp evil.mjs test/auth/login.test.mjs', 'deny'],
  ['cp a rail as source (read)', 'cp test/auth/login.test.mjs backup.mjs', 'allow'],
  ['rm a non-rail', 'rm src/app.mjs', 'allow'],
  ['rm -rf the rail parent dir', 'rm -rf test/auth', 'deny'],
  ['rm -rf a grandparent dir of a rail', 'rm -rf test', 'deny'],
  ['rm -rf a non-rail dir', 'rm -rf build', 'allow'],
  ['sudo rm a rail (wrapper)', 'sudo rm test/auth/login.test.mjs', 'deny'],
  ['env VAR=1 rm a rail (wrapper+assignment)', 'env FOO=1 rm test/auth/login.test.mjs', 'deny'],
  ['xargs rm a rail (wrapper)', 'xargs rm test/auth/login.test.mjs', 'deny'],
  ['subshell $(rm rail)', 'echo $(rm test/auth/login.test.mjs)', 'deny'],
  ['backtick rm rail', 'echo `rm test/auth/login.test.mjs`', 'deny'],
  ['command grouping { rm rail; }', '{ rm test/auth/login.test.mjs; }', 'deny'],
  ['bare subshell ( rm rail )', '( rm test/auth/login.test.mjs )', 'deny'],
  ['glob rm -rf test/*', 'rm -rf test/*', 'deny'],
  ['glob rm -rf build/* (non-rail)', 'rm -rf build/*', 'allow'],
  ['cp --target-directory=rail', 'cp --target-directory=test/auth src.mjs', 'deny'],
  ['mv -t rail dir', 'mv -t test/auth src.mjs', 'deny'],
  ['wrapper with value: sudo -u root rm rail', 'sudo -u root rm test/auth/login.test.mjs', 'deny'],
  ['wrapper with value: nice -n 10 rm rail', 'nice -n 10 rm test/auth/login.test.mjs', 'deny'],
  ['git rm a rail', 'git rm test/auth/login.test.mjs', 'deny'],
  ['no-space subshell (rm exact-file rail)', '(rm src/types/api.d.ts)', 'deny'],
  ['partial-segment glob rm -rf test/aut*', 'rm -rf test/aut*', 'deny'],
  ['partial glob non-rail rm -rf bui*', 'rm -rf bui*', 'allow'],
  ['bare star rm -rf * (covers rail ancestor)', 'rm -rf *', 'deny'],
  ['sed -i -e flag script then rail file', 'sed -i -es/a/b/ test/auth/login.test.mjs', 'deny'],
  ['sed -i --expression then rail file', 'sed -i --expression=s/a/b/ test/auth/login.test.mjs', 'deny'],
  ['touch a rail', 'touch test/auth/login.test.mjs', 'deny'],
  ['ln -sf over a rail', 'ln -sf /tmp/evil test/auth/login.test.mjs', 'deny'],
  ['mkdir over a rail path', 'mkdir test/auth', 'deny'],
  ['touch a non-rail', 'touch src/app.mjs', 'allow'],
]) {
  test(`bash: ${name} → ${exp}`, () => {
    assert.equal(runBash(RAIL_T, cmd), exp);
  });
}

test('bash via parameters.command payload shape → deny (rail write)', () => {
  assert.equal(runBash(RAIL_T, 'echo x > test/auth/login.test.mjs', { shape: 'parameters' }), 'deny');
});

// ---- quoted rail paths containing spaces ----

const SPACE_T = '{"tickets":[{"id":"T1","rails":["docs/frozen file.md"]}]}';
for (const [name, cmd, exp] of [
  ['redirect to quoted spaced rail', 'echo x > "docs/frozen file.md"', 'deny'],
  ['sed -i quoted spaced rail', "sed -i 's/a/b/' 'docs/frozen file.md'", 'deny'],
  ['tee quoted spaced rail', 'echo x | tee "docs/frozen file.md"', 'deny'],
  ['redirect to backslash-escaped spaced rail', 'echo x > docs/frozen\\ file.md', 'deny'],
  ['sed -i backslash-escaped spaced rail', "sed -i 's/a/b/' docs/frozen\\ file.md", 'deny'],
  ['read quoted spaced rail', 'cat "docs/frozen file.md"', 'allow'],
]) {
  test(`bash (spaces): ${name} → ${exp}`, () => {
    assert.equal(runBash(SPACE_T, cmd), exp);
  });
}

test('wildcard target overlaps an early-wildcard rail (test/**/*.test.js) → deny', () => {
  const t = '{"tickets":[{"id":"T1","rails":["test/**/*.test.js"]}]}';
  assert.equal(runBash(t, 'rm -rf test/auth/*'), 'deny');
});

test('non-overlapping deep glob with an early-wildcard rail → allow', () => {
  const t = '{"tickets":[{"id":"T1","rails":["test/**/*.test.js"]}]}';
  assert.equal(runBash(t, 'rm -rf docs/api/*'), 'allow');
});

// ---- trust root: tickets.json is frozen once rails exist ----

test('editing .adlc/tickets.json while rails exist → deny (trust root)', () => {
  assert.equal(runRails(RAIL_T, '.adlc/tickets.json').verdict, 'deny');
});

test('bash redirect into .adlc/tickets.json while rails exist → deny', () => {
  assert.equal(runBash(RAIL_T, 'echo "{}" > .adlc/tickets.json'), 'deny');
});

test('rm .adlc/tickets.json (disabling the trust root) while rails exist → deny', () => {
  assert.equal(runBash(RAIL_T, 'rm .adlc/tickets.json'), 'deny');
});

test('mv .adlc/tickets.json away while rails exist → deny', () => {
  assert.equal(runBash(RAIL_T, 'mv .adlc/tickets.json /tmp/t.json'), 'deny');
});

test('rm -rf .adlc (destroys the trust root) while rails exist → deny', () => {
  assert.equal(runBash(RAIL_T, 'rm -rf .adlc'), 'deny');
});

test('editing .adlc/tickets.json with NO rails declared → allow (authoring the first ticket)', () => {
  assert.equal(runRails('{"tickets":[]}', '.adlc/tickets.json').verdict, 'allow');
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

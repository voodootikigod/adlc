// shell-quoting.test.mjs — issue #216.
//
// shellIsPositivelyReadOnly split the shell payload with a plain regex, ignoring
// quoting. A read-only `rg` whose pattern contained an alternation was shredded
// into fragments that could not match the allowlist, so the hook denied it:
//
//   rg -n '"(prepack|prepare|postpack)"' package.json
//     -> ["rg -n '\"(prepack", "prepare", "postpack)\"' package.json"]
//
// `rg` IS allowlisted; the parse defeated the allowlist before it was consulted.
// The practical cost was a blocked cross-model P5 review, which then looked like
// a bug in the external reviewer rather than in this hook.
//
// The dangerous direction is the opposite one. The allowlist only inspects each
// segment's PREFIX, so a separator the splitter MISSES is fail-open:
// `cat x | rm -rf y` left unsplit still starts with `cat`. Half of these tests
// exist to pin that, because a fix that merely stops over-splitting could easily
// start under-splitting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'adlc-rails-guard.mjs');
const ticket = { id: 'T1', title: 'Active', scope: ['src/**'], rails: ['test/**'], edges: [] };

function withRepo(fn) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-codex-quoting-'));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc/tickets.json'), `${JSON.stringify({ tickets: [ticket] }, null, 2)}\n`);
  writeFileSync(join(root, '.adlc/current-ticket.json'), '{"id":"T1"}\n');
  try { return fn(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

/** Run the hook with a shell payload; returns { status, stderr }. */
function shell(root, command) {
  const { ADLC_P4_ENFORCEMENT: _e, ADLC_TICKET: _t, ADLC_TICKETS: _ts, ADLC_TICKET_STORE: _s, ADLC_RAILS_BYPASS: _b, ...base } = process.env;
  return spawnSync(process.execPath, [HOOK], {
    cwd: root,
    env: base,
    input: JSON.stringify({ tool_name: 'shell', tool_input: { command } }),
    encoding: 'utf8',
  });
}


const DENIED = 2;

// --- the regression: read-only commands carrying quoted separators ----------

test('a read-only rg with a quoted alternation is ALLOWED', () => {
  withRepo((root) => {
    // The exact command that was denied, costing a cross-model review.
    const r = shell(root, `rg -n '"(prepack|prepare|postpack|prepublishOnly|prepublish)"' package.json packages plugins`);
    assert.notEqual(r.status, DENIED,
      `a quoted | inside an rg pattern must not deny:\n${r.stderr}`);
  });
});

test('read-only commands with other quoted separators are ALLOWED', () => {
  withRepo((root) => {
    for (const command of [
      `grep -n "a;b" file.txt`,
      `rg 'x&y' .`,
      `rg "one||two" .`,
      `grep -n 'a && b' file.txt`,
      `rg --json '{"k":"v|w"}' .`,
      `cat 'weird|name.txt'`,
    ]) {
      const r = shell(root, command);
      assert.notEqual(r.status, DENIED, `must not deny: ${command}\n${r.stderr}`);
    }
  });
});

// --- the dangerous direction: real separators must still split --------------

// NOTE ON WHAT THIS HOOK ACTUALLY GUARDS: it is a RAIL guard, not a general
// mutation guard. `shellHasMutation()` runs BEFORE the read-only check, and a
// mutation to a non-rail path is legitimately allowed — so `cat x | rm -rf y`
// is ALLOWED by design when `y` is not a rail. The deny cases below therefore
// target `test/**`, the fixture's declared rail.

test('an UNQUOTED pipeline touching a RAIL is still DENIED', () => {
  withRepo((root) => {
    // If the splitter missed the separator, the payload becomes one segment
    // beginning with an allowlisted command — the fail-open direction.
    for (const command of [
      'cat x | rm -rf test/frozen.test.mjs',
      'ls && rm -rf test/frozen.test.mjs',
      'pwd; rm -rf test/frozen.test.mjs',
      'grep x file & rm test/frozen.test.mjs',
    ]) {
      const r = shell(root, command);
      assert.equal(r.status, DENIED, `must deny: ${command}\n${r.stderr}`);
    }
  });
});

test('a separator immediately after a CLOSING quote still splits', () => {
  withRepo((root) => {
    // The quote closes before the separator, so it is unquoted and must split.
    const r = shell(root, `rg 'a|b' file; rm -rf test/frozen.test.mjs`);
    assert.equal(r.status, DENIED, 'a real separator after a quoted region must still be seen');
  });
});

test('an escaped quote does not swallow the rest of the payload', () => {
  withRepo((root) => {
    // If the backslash-escaped quote were treated as opening a string, the
    // trailing rail mutation would be considered quoted and hidden.
    const r = shell(root, `grep -n "he said \\"hi\\"" f.txt; rm -rf test/frozen.test.mjs`);
    assert.equal(r.status, DENIED, 'an escaped quote must not hide a later rail mutation');
  });
});

test('an UNTERMINATED quote fails closed', () => {
  withRepo((root) => {
    // Unparseable payloads must never be treated as positively read-only.
    const r = shell(root, `rg 'unterminated`);
    assert.equal(r.status, DENIED, 'a payload that cannot be parsed must not be allowed');
  });
});

test('a plain read-only command is still ALLOWED (control)', () => {
  withRepo((root) => {
    // Denominator: proves the deny assertions above are not simply "everything
    // is denied".
    for (const command of ['git status', 'pwd', 'rg foo .', 'ls -la', 'npm test']) {
      const r = shell(root, command);
      assert.notEqual(r.status, DENIED, `must allow: ${command}\n${r.stderr}`);
    }
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  matchRecoveryCommand,
  isBareInspectionPwd,
  formatRecoveryCommand,
  formatNoSessionIdMessage,
} from '../lib/recovery-exception.mjs';

// Fixture interpreter/script: real files on disk so fs.realpathSync resolves
// them exactly like the real adapter's process.execPath / bin/handoff.mjs.
function fixturePaths() {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-exception-'));
  const interpreterPath = join(dir, 'node');
  const scriptPath = join(dir, 'handoff.mjs');
  writeFileSync(interpreterPath, '');
  writeFileSync(scriptPath, '');
  return { dir, interpreterPath, scriptPath };
}

function cmd({ interpreterPath, scriptPath }, rest) {
  return `${interpreterPath} ${scriptPath} ${rest}`;
}

test('isBareInspectionPwd — exact literal pwd only', () => {
  assert.equal(isBareInspectionPwd('pwd'), true);
  assert.equal(isBareInspectionPwd('pwd -L'), false);
  assert.equal(isBareInspectionPwd(' pwd'), false);
  assert.equal(isBareInspectionPwd('pwd '), false);
  assert.equal(isBareInspectionPwd('pwd; rm -rf /'), false);
  assert.equal(isBareInspectionPwd('pwd\n'), false);
  assert.equal(isBareInspectionPwd('pwd\r\n'), false);
  assert.equal(isBareInspectionPwd(''), false);
  assert.equal(isBareInspectionPwd(null), false);
  assert.equal(isBareInspectionPwd(undefined), false);
});

test('matchRecoveryCommand — positive fixture for every subcommand with a session value', () => {
  const fx = fixturePaths();
  const sessionId = 'abc-123';
  for (const sub of ['bypass', 'unlock', 'repair', 'write', 'resume']) {
    const text = cmd(fx, `${sub} --session ${sessionId} --write`);
    const result = matchRecoveryCommand(text, {
      interpreterPath: fx.interpreterPath,
      scriptPath: fx.scriptPath,
      sessionId,
    });
    assert.equal(result.matched, true, `${sub} should match`);
    assert.equal(result.subcommand, sub);
  }
});

test('matchRecoveryCommand — unlock --started-at reproduces an ISO 8601 timestamp exactly', () => {
  const fx = fixturePaths();
  const sessionId = 'sess-1';
  const iso = '2026-08-15T12:34:56.789Z';
  const text = cmd(fx, `unlock --session ${sessionId} --started-at ${iso} --write`);
  const result = matchRecoveryCommand(text, { ...fx, sessionId });
  assert.equal(result.matched, true);
});

test('matchRecoveryCommand — resume --deny-session may name a DIFFERENT session', () => {
  const fx = fixturePaths();
  const sessionId = 'consumer-session';
  const text = cmd(fx, `resume --session ${sessionId} --deny-session other-denier-session --write`);
  const result = matchRecoveryCommand(text, { ...fx, sessionId });
  assert.equal(result.matched, true);
});

test('matchRecoveryCommand — --session naming a DIFFERENT (but valid) session is rejected', () => {
  const fx = fixturePaths();
  const sessionId = 'this-session';
  const text = cmd(fx, `bypass --session some-other-session --write`);
  const result = matchRecoveryCommand(text, { ...fx, sessionId });
  assert.equal(result.matched, false);
});

test('matchRecoveryCommand — no session resolvable means no --session command can match', () => {
  const fx = fixturePaths();
  const text = cmd(fx, `bypass --session anything --write`);
  const result = matchRecoveryCommand(text, { ...fx, sessionId: null });
  assert.equal(result.matched, false);
});

test('matchRecoveryCommand — unbound bypass reason (free text) is not eligible', () => {
  const fx = fixturePaths();
  const sessionId = 'sess-1';
  const text = cmd(fx, `bypass --session ${sessionId} --unbound-reason "free text here" --write`);
  const result = matchRecoveryCommand(text, { ...fx, sessionId });
  assert.equal(result.matched, false);
});

test('matchRecoveryCommand — quoted PATH_GRAMMAR token may contain $, &, (, ; as literal bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-exception-special-'));
  const interpreterPath = join(dir, "node-with-$-&-(-;");
  const scriptPath = join(dir, 'handoff.mjs');
  writeFileSync(interpreterPath, '');
  writeFileSync(scriptPath, '');
  const sessionId = 'sess-1';
  const text = `'${interpreterPath}' '${scriptPath}' bypass --session ${sessionId} --write`;
  const result = matchRecoveryCommand(text, { interpreterPath, scriptPath, sessionId });
  assert.equal(result.matched, true);
});

test('matchRecoveryCommand — a quoted path containing a literal space matches (formatRecoveryCommand round-trips)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-exception-space '));
  const interpreterPath = join(dir, 'node');
  const scriptPath = join(dir, 'handoff.mjs');
  writeFileSync(interpreterPath, '');
  writeFileSync(scriptPath, '');
  const sessionId = 'sess-1';
  const text = `'${interpreterPath}' '${scriptPath}' bypass --session ${sessionId} --write`;
  const result = matchRecoveryCommand(text, { interpreterPath, scriptPath, sessionId });
  assert.equal(result.matched, true);
});

test('matchRecoveryCommand — two adjacent quoted spans glued into one token are rejected, not concatenated', () => {
  // A real POSIX shell concatenates adjacent quoted spans after removing
  // every quote: '/a''b' executes as /ab (no apostrophes survive). A naive
  // parser that strips only the OUTER first/last quote and keeps interior
  // quotes as literal bytes instead computes /a''b (WITH literal
  // apostrophes) — a different filesystem path than what the shell actually
  // executes. That gap would let an attacker-controlled executable at the
  // shell's real (apostrophe-free) path pass identity validation via a decoy
  // path (with literal apostrophes) that happens to realpath to the trusted
  // binary. Prove this concretely: create a symlink whose literal ON-DISK
  // NAME contains two embedded apostrophes, pointing at the trusted
  // interpreter — under the bug, this fixture's glued token would resolve
  // and match; the fix must reject the token SHAPE outright, before
  // `identityMatches` is even consulted.
  const fx = fixturePaths();
  const sessionId = 'sess-1';
  const decoyName = "node''fake"; // literal apostrophes in the ON-DISK filename
  const decoyPath = join(fx.dir, decoyName);
  symlinkSync(fx.interpreterPath, decoyPath);
  assert.equal(realpathSync(decoyPath), realpathSync(fx.interpreterPath), 'decoy symlink must resolve to the trusted interpreter');
  // Token shape: '<dir>/node''fake' — two adjacent quoted spans a real shell
  // concatenates to `<dir>/nodefake`, but whose naive-strip inner content is
  // literally `<dir>/node''fake` (the decoy symlink's actual name).
  const gluedToken = `'${join(fx.dir, 'node')}''fake'`;
  const glued = `${gluedToken} '${fx.scriptPath}' bypass --session ${sessionId} --write`;
  const result = matchRecoveryCommand(glued, { ...fx, sessionId });
  assert.equal(result.matched, false);
});

test('matchRecoveryCommand — decoys are rejected', () => {
  const fx = fixturePaths();
  const sessionId = 'sess-1';
  const decoys = [
    cmd(fx, `bypass --session ${sessionId} --write; rm -rf /`),
    cmd(fx, `bypass --session ${sessionId} --write && rm -rf /`),
    cmd(fx, `bypass --session ${sessionId} --write \`echo hi\``),
    cmd(fx, `frobnicate --session ${sessionId} --write`), // wrong subcommand
    cmd(fx, `bypass --session ${sessionId} --nonexistent-flag`), // unrecognized flag
    `node ${fx.scriptPath} bypass --session ${sessionId} --write`, // bare interpreter, not absolute-resolved
    `${fx.interpreterPath} ./handoff.mjs bypass --session ${sessionId} --write`, // relative script
  ];
  for (const decoy of decoys) {
    const result = matchRecoveryCommand(decoy, { ...fx, sessionId });
    assert.equal(result.matched, false, `decoy should not match: ${decoy}`);
  }
});

test('matchRecoveryCommand — a raw newline at a token boundary is rejected outright', () => {
  const fx = fixturePaths();
  const sessionId = 'sess-1';
  const text = cmd(fx, `bypass --session\n${sessionId} --write`);
  const result = matchRecoveryCommand(text, { ...fx, sessionId });
  assert.equal(result.matched, false);
});

test('matchRecoveryCommand — script identity mismatch (wrong script) is rejected', () => {
  const fx = fixturePaths();
  const sessionId = 'sess-1';
  const otherScript = join(fx.dir, 'not-handoff.mjs');
  writeFileSync(otherScript, '');
  const text = `${fx.interpreterPath} ${otherScript} bypass --session ${sessionId} --write`;
  const result = matchRecoveryCommand(text, { ...fx, sessionId });
  assert.equal(result.matched, false);
});

test('matchRecoveryCommand — symlinked script resolves to the same real identity and still matches', () => {
  const fx = fixturePaths();
  const sessionId = 'sess-1';
  const linkPath = join(fx.dir, 'handoff-link.mjs');
  symlinkSync(fx.scriptPath, linkPath);
  const text = `${fx.interpreterPath} ${linkPath} bypass --session ${sessionId} --write`;
  const result = matchRecoveryCommand(text, { ...fx, sessionId });
  assert.equal(result.matched, true);
  assert.equal(realpathSync(linkPath), realpathSync(fx.scriptPath));
});

test('matchRecoveryCommand — duplicate flag is rejected', () => {
  const fx = fixturePaths();
  const sessionId = 'sess-1';
  const text = cmd(fx, `bypass --session ${sessionId} --session ${sessionId} --write`);
  const result = matchRecoveryCommand(text, { ...fx, sessionId });
  assert.equal(result.matched, false);
});

test('formatRecoveryCommand — quotes paths containing a space', () => {
  const out = formatRecoveryCommand({
    interpreterPath: '/Users/alice/My Project/node',
    scriptPath: '/Users/alice/My Project/adlc/handoff.mjs',
    sessionId: 'sess-1',
  });
  assert.match(out, /^'\/Users\/alice\/My Project\/node' '\/Users\/alice\/My Project\/adlc\/handoff\.mjs' bypass --session sess-1 --write$/);
});

test('formatRecoveryCommand — does not quote a plain path', () => {
  const out = formatRecoveryCommand({
    interpreterPath: '/usr/local/bin/node',
    scriptPath: '/repo/packages/context-handoff/bin/handoff.mjs',
    sessionId: 'sess-1',
  });
  assert.equal(
    out,
    "/usr/local/bin/node /repo/packages/context-handoff/bin/handoff.mjs bypass --session sess-1 --write",
  );
});

test('formatRecoveryCommand — a sessionId outside VALUE_GRAMMAR is never interpolated into the diagnostic', () => {
  // isSafeSessionId (deny-marker.mjs) only guards path-traversal safety for
  // use as a filename component — it accepts spaces, semicolons, and other
  // shell metacharacters that VALUE_GRAMMAR (the grammar matchRecoveryCommand
  // itself requires a --session value to satisfy) rejects. A session id that
  // passes isSafeSessionId but fails VALUE_GRAMMAR must never be interpolated
  // unquoted into a diagnostic an operator is instructed to copy-paste into a
  // real shell — that diagnostic must degrade to the no-safe-session message
  // instead, exactly as if no session id had resolved at all.
  const unsafe = 'x; env #';
  const out = formatRecoveryCommand({
    interpreterPath: '/usr/local/bin/node',
    scriptPath: '/repo/handoff.mjs',
    sessionId: unsafe,
  });
  assert.doesNotMatch(out, /;/);
  assert.doesNotMatch(out, /#/);
  assert.doesNotMatch(out, / env /);
  assert.match(out, /no session id could be resolved/i);
});

test('formatRecoveryCommand — a VALUE_GRAMMAR-safe sessionId still formats normally', () => {
  const out = formatRecoveryCommand({
    interpreterPath: '/usr/local/bin/node',
    scriptPath: '/repo/handoff.mjs',
    sessionId: 'sess-abc.123_ok',
  });
  assert.match(out, /--session sess-abc\.123_ok --write$/);
});

test('formatRecoveryCommand — an interpreterPath containing an apostrophe degrades to the unsafe-path message, never a broken command', () => {
  const out = formatRecoveryCommand({
    interpreterPath: "/repo/it's-mine/node",
    scriptPath: '/repo/handoff.mjs',
    sessionId: 'sess-1',
  });
  // The apostrophe must never appear as an unescaped shell quote terminator:
  // the output must not be a would-be command starting with a quoted path —
  // it must be the plain, non-command diagnostic instead.
  assert.doesNotMatch(out, /^'/);
  assert.match(out, /cannot be printed as a safe, copy-pasteable shell command/);
});

test('formatRecoveryCommand — a scriptPath containing an apostrophe degrades to the unsafe-path message, never a broken command', () => {
  const out = formatRecoveryCommand({
    interpreterPath: '/repo/node',
    scriptPath: "/repo/it's-mine/handoff.mjs",
    sessionId: 'sess-1',
  });
  assert.doesNotMatch(out, /^'/);
  assert.match(out, /cannot be printed as a safe, copy-pasteable shell command/);
});

test('formatRecoveryCommand — a CR/LF in either path degrades to the unsafe-path message, never a broken command', () => {
  const out = formatRecoveryCommand({
    interpreterPath: '/repo/node\ntouch PWNED',
    scriptPath: '/repo/handoff.mjs',
    sessionId: 'sess-1',
  });
  assert.doesNotMatch(out, /^'/);
  assert.match(out, /cannot be printed as a safe, copy-pasteable shell command/);
});

test('formatNoSessionIdMessage — contains all three required elements, no --session', () => {
  const msg = formatNoSessionIdMessage();
  assert.match(msg, /no session id could be resolved/i);
  assert.match(msg, /end.*(this )?session and start a new one/i);
  assert.match(msg, /`pwd`/);
  assert.doesNotMatch(msg, /--session/);
  assert.doesNotMatch(msg, /--deny-session/);
});

test('matchRecoveryCommand — a recovery command with NO --session flag at all is rejected, for every subcommand (Round-5)', () => {
  // The per-flag check only enforced same-session binding WHEN --session
  // was present; a bare `bypass` (no flags) matched unconditionally,
  // regardless of sessionId — including when sessionId is null (no safe
  // session id resolved) or a real, valid session id. --session must be
  // required, not merely validated-if-present.
  const fx = fixturePaths();
  for (const sub of ['bypass', 'unlock', 'repair', 'write', 'resume']) {
    const bare = cmd(fx, sub);
    for (const sessionId of [null, 'consumer-1']) {
      const result = matchRecoveryCommand(bare, {
        interpreterPath: fx.interpreterPath,
        scriptPath: fx.scriptPath,
        sessionId,
      });
      assert.equal(result.matched, false, `${sub} with no --session and sessionId=${sessionId} must not match`);
    }
  }
});

test('matchRecoveryCommand — bypass --write with no --session is rejected even though --write is a valid boolean flag', () => {
  const fx = fixturePaths();
  const text = cmd(fx, 'bypass --write');
  const result = matchRecoveryCommand(text, { interpreterPath: fx.interpreterPath, scriptPath: fx.scriptPath, sessionId: 'consumer-1' });
  assert.equal(result.matched, false);
});

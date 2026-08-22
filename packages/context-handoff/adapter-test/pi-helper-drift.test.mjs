// pi-helper-drift.test.mjs — pin the pi extension's trusted local Recovery
// Exception copy to this package's canonical implementation.
//
// plugins/adlc-pi/lib/handoff-gate.mjs keeps its own path/value grammars and
// recovery formatters rather than importing them, for the reason its own
// comment gives: the deny message is what an operator is left holding, and a
// message assembled out of package exports can fail in exactly the
// broken-install case it exists to report.
//
// The cost of a local twin is drift, and drift here is silent — the pi suite
// tests the twin against itself, so a widened character class or a dropped
// grammar character passes everything. cc-helper-drift.test.mjs's header
// records a real bug this pattern already caught in another adapter. Same
// pattern, same reason.
//
// Deliberate divergences are asserted as divergences below, not glossed over:
// pi's command carries `--dir` and `--unbound-reason`, and pi's
// no-session-id message says something different from the canonical one on
// purpose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  formatRecoveryCommand as canonicalFormatRecoveryCommand,
  formatNoSessionIdMessage as canonicalFormatNoSessionIdMessage,
  formatUnsafeInstallPathMessage as canonicalFormatUnsafeInstallPathMessage,
} from '@adlc/context-handoff';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PI_HANDOFF_GATE = join(REPO_ROOT, 'plugins', 'adlc-pi', 'lib', 'handoff-gate.mjs');
const CANONICAL_SOURCE = join(
  REPO_ROOT,
  'packages',
  'context-handoff',
  'lib',
  'recovery-exception.mjs',
);

const { formatRecoveryCommand: piFormatRecoveryCommand } = await import(PI_HANDOFF_GATE);

/** Read a named regex literal out of a module's source, without importing it. */
async function regexLiteral(file, name) {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(file, 'utf8');
  const match = new RegExp(`const ${name} = (/[^\\n]*/);`).exec(source);
  assert.ok(match, `${name} not found in ${file}`);
  return match[1];
}

test("pi's path grammar is byte-identical to the canonical PATH_UNQUOTED_RE", async () => {
  // Widening this class is the dangerous drift: a path carrying `;` or `$`
  // would then be emitted UNQUOTED into a command an operator pastes.
  assert.equal(
    await regexLiteral(PI_HANDOFF_GATE, 'RECOVERY_PATH_UNQUOTED_RE'),
    await regexLiteral(CANONICAL_SOURCE, 'PATH_UNQUOTED_RE'),
  );
});

test("pi's value grammar is byte-identical to the canonical VALUE_RE", async () => {
  assert.equal(
    await regexLiteral(PI_HANDOFF_GATE, 'RECOVERY_VALUE_RE'),
    await regexLiteral(CANONICAL_SOURCE, 'VALUE_RE'),
  );
});

test("pi's quoting agrees with the canonical formatter on every path shape", () => {
  // Compared through the formatters, since `quotePathForDisplay` is private in
  // both. pi's command carries extra flags, so the comparison is on how each
  // RENDERS the interpreter and script paths, not on the whole string.
  const sessionId = 'sess-a';
  const paths = [
    '/usr/bin/node',
    '/opt/my adlc/bin/handoff.mjs',
    '/srv/a;rm -rf x/handoff.mjs',
    '/srv/$(id)/handoff.mjs',
    '/srv/a&&b/handoff.mjs',
    '/srv/a|b/handoff.mjs',
    '/srv/plain-path_1.2/handoff.mjs',
    '/srv/eq=sign/handoff.mjs',
    "/opt/it's/handoff.mjs",
    '/usr/bin/no\nde',
  ];
  for (const scriptPath of paths) {
    const canonical = canonicalFormatRecoveryCommand({
      interpreterPath: '/usr/bin/node',
      scriptPath,
      sessionId,
    });
    const pi = piFormatRecoveryCommand({
      interpreterPath: '/usr/bin/node',
      scriptPath,
      adlcDir: '/srv/repo/.adlc',
      sessionId,
    });
    // Both degrade, or neither does.
    const canonicalDegraded = !canonical.startsWith('/usr/bin/node ');
    const piDegraded = !pi.startsWith('/usr/bin/node ');
    assert.equal(piDegraded, canonicalDegraded, `degrade drift on ${JSON.stringify(scriptPath)}`);
    if (canonicalDegraded) continue;
    // And they quote the script path the same way.
    const rendered = canonical.slice('/usr/bin/node '.length).split(' bypass ')[0];
    assert.ok(
      pi.includes(`/usr/bin/node ${rendered} bypass `),
      `quoting drift on ${JSON.stringify(scriptPath)}: ${pi}`,
    );
  }
});

test("pi's session-id acceptance agrees with the canonical formatter", () => {
  for (const sessionId of [
    'sess-a',
    'a.b:c=d/e',
    '../escape',
    'has/slash',
    'has space',
    '',
    null,
    undefined,
  ]) {
    const canonical = canonicalFormatRecoveryCommand({
      interpreterPath: '/usr/bin/node',
      scriptPath: '/opt/adlc/bin/handoff.mjs',
      sessionId,
    });
    const pi = piFormatRecoveryCommand({
      interpreterPath: '/usr/bin/node',
      scriptPath: '/opt/adlc/bin/handoff.mjs',
      adlcDir: '/srv/repo/.adlc',
      sessionId,
    });
    const canonicalBuilt = canonical.includes('bypass --session');
    const piBuilt = pi.includes('bypass --session');
    // pi is deliberately STRICTER: it also requires isSafeSessionId, so a
    // traversal id the deny store would refuse gets no command. It must never
    // be LOOSER than canonical.
    if (piBuilt) {
      assert.ok(canonicalBuilt, `pi built a command canonical refused: ${JSON.stringify(sessionId)}`);
    }
  }
  // Pin the intended divergence so it cannot silently disappear.
  const traversal = { interpreterPath: '/usr/bin/node', scriptPath: '/opt/a/handoff.mjs', sessionId: '../escape' };
  assert.ok(canonicalFormatRecoveryCommand(traversal).includes('bypass --session'));
  assert.ok(!piFormatRecoveryCommand({ ...traversal, adlcDir: '/srv/repo/.adlc' }).includes('bypass --session'));
});

test('pi keeps the canonical unsafe-install-path contract, minus the pwd clause', () => {
  // The canonical message ends with a `pwd` remark that belongs to codex's
  // Inspection Exception; pi has no such exception, so it is dropped. Every
  // other element must still be there.
  const opts = {
    interpreterPath: '/usr/bin/node',
    scriptPath: "/opt/it's/handoff.mjs",
    sessionId: 'sess-a',
  };
  const canonical = canonicalFormatUnsafeInstallPathMessage(opts);
  const pi = piFormatRecoveryCommand({ ...opts, adlcDir: '/srv/repo/.adlc' });
  for (const fragment of [
    'cannot be printed as a safe, copy-pasteable shell command',
    'interpreter at /usr/bin/node',
    "script at /opt/it's/handoff.mjs",
    'bypass --session sess-a',
  ]) {
    assert.ok(canonical.includes(fragment), `canonical drifted: ${fragment}`);
    assert.ok(pi.includes(fragment), `pi drifted: ${fragment}`);
  }
});

test("pi's no-session-id message deliberately differs from the canonical one", () => {
  // Canonical tells the operator to start a new session. For an OPEN DENY that
  // is false — the record is in the repo and reaches the next session — which
  // is the whole point of the pi rewrite. If this assertion ever fails because
  // the two now agree, check which one moved before "fixing" it.
  const canonical = canonicalFormatNoSessionIdMessage();
  const pi = piFormatRecoveryCommand({
    interpreterPath: '/usr/bin/node',
    scriptPath: '/opt/adlc/bin/handoff.mjs',
    adlcDir: '/srv/repo/.adlc',
    sessionId: null,
  });
  assert.match(canonical, /start a new one/, 'canonical still gives the fresh-session advice');
  assert.doesNotMatch(pi, /fresh session/i);
  assert.doesNotMatch(pi, /start a new one/);
  assert.match(pi, /reaches a new session as well/);
});

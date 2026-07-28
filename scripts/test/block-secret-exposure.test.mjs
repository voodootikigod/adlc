// The PreToolUse guard that stops a shell command printing a secret.
//
// This exists because ADLC_MANIFEST_KEY — the manifest trust root — was echoed
// into a session transcript by a command that had already redacted the file's
// contents. The redaction and the leak were on different paths. Both paths are
// pinned here, and so is the guard's fail direction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { violations, SAFE_FORM } from '../block-secret-exposure.mjs';

const HOOK = fileURLToPath(new URL('../block-secret-exposure.mjs', import.meta.url));

/** Run the hook exactly as Claude Code does: JSON on stdin, JSON or nothing out. */
function runHook(command) {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
  const out = execFileSync('node', [HOOK], { input, encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : null;
}

const decisionFor = (command) => runHook(command)?.hookSpecificOutput?.permissionDecision ?? 'allow';

test('the command that actually leaked the key is refused', () => {
  // Verbatim shape of the real incident. `set -x` traces the FULLY EXPANDED
  // command, and $(...) expands to a literal ADLC_MANIFEST_KEY=<value> argument
  // before env runs — so the sed redaction on the line above protected nothing.
  const leaked = "set -x; cat .env.local | sed 's/=.*/=<redacted>/'; "
    + "env $(grep -v '^#' .env.local | xargs) node packages/prosecute/bin/adlc-prosecute.mjs tier-check";
  assert.equal(decisionFor(leaked), 'deny');
  // Both independent defects must be named, not just the first one found — the
  // point of the incident is that fixing one would have left the other.
  assert.equal(violations(leaked).length, 3, 'tracing, substitution, and the xargs pipe are each their own finding');
});

test('either defect alone is enough to refuse', () => {
  // Neither is safe on its own, so neither may depend on the other to be caught.
  assert.equal(decisionFor('set -x; cat .env.local'), 'deny', 'tracing beside a secrets file');
  assert.equal(decisionFor('env $(cat .env.local | xargs) node x.mjs'), 'deny', 'substitution into argv, no tracing');
});

test('the guard permits the very form it recommends', () => {
  // Not a wording check — a consistency invariant between the two halves of this
  // module. A guard that refuses its own documented alternative is worse than no
  // guard: the only way to get work done is to disable it. Asserted against the
  // exported constant, so changing the advice without re-checking it fails here.
  assert.equal(decisionFor(SAFE_FORM), 'allow', 'the recommended form must not itself be refused');
  assert.equal(decisionFor('set +x; env $(echo A=1) node x.mjs'), 'allow', '+x DISABLES tracing — it is the fix');
  assert.match(SAFE_FORM, /\.env\.local/, 'and it must actually demonstrate loading the secrets file');
});

test('tracing and secrets files are only a defect together', () => {
  assert.equal(decisionFor('set -x; npm test'), 'allow', 'tracing with no secret in reach');
  assert.equal(decisionFor('cat .env.local'), 'allow', 'reading the file is not printing it into a trace');
  assert.equal(decisionFor('git status --short'), 'allow');
});

test('the guard FAILS OPEN, and that direction is deliberate', () => {
  // Per AGENTS.md: fail-open vs fail-closed is a choice, never an accident, and
  // the choice is asserted so it cannot drift. The threat model here is my own
  // carelessness, not an adversary — anyone able to edit the hook can bypass it,
  // so failing closed buys nothing, while a parse bug that blocked every Bash
  // call would be far worse than the leak it guards against.
  const out = execFileSync('node', [HOOK], { input: 'not json at all', encoding: 'utf8' });
  assert.equal(out.trim(), '', 'unparseable hook input must allow, not block');
  assert.equal(decisionFor(''), 'allow', 'an empty command must allow');
});

test('quoted text is refused too, and that false positive is deliberate', () => {
  // Refusing a command whose heredoc merely DESCRIBES the pattern looks like
  // over-blocking, and it is — this guard blocked its own commit message.
  // Keeping it is the considered choice: separating "operative" from "merely
  // quoted" means re-implementing shell quoting, the exact operative-vs-inert
  // approximation docs/review-lenses/text-scanning-gates.md exists to forbid.
  // The lens says scan and wear the false positive rather than approximate the
  // grammar and risk a bypass. Pinned so nobody "fixes" it into a hole.
  const describingIt = "git commit -m \"$(cat <<'EOF'\nWe ran: set -x; cat .env.local\nEOF\n)\"";
  assert.equal(decisionFor(describingIt), 'deny');
  // And the documented escape hatch keeps the text out of argv entirely.
  assert.equal(decisionFor('git commit -F /tmp/msg.txt'), 'allow');
});

test('secret-file matching is broad on purpose', () => {
  // Breadth costs an occasional needless "drop the -x"; narrowness costs a key.
  // Cheap either way, so err wide — including on .env.example, which is usually
  // a template but is not worth carving a hole for.
  for (const file of ['.env', '.env.local', '.env.production', 'id_rsa', 'server.pem', 'credentials.json']) {
    assert.equal(decisionFor(`set -x; cat ${file}`), 'deny', `${file} must count as a secrets file`);
  }
});

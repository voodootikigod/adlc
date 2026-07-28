#!/usr/bin/env node
/**
 * PreToolUse/Bash guard: refuse shell commands that would print a secret.
 *
 * Written after ADLC_MANIFEST_KEY — the manifest trust root — was echoed into a
 * session transcript. The command had ALREADY redacted the file's contents; the
 * leak came from a second path nobody was thinking about:
 *
 *     set -x
 *     cat .env.local | sed 's/=.*<REDACTED>/'          # display path: redacted
 *     env $(grep -v '^#' .env.local | xargs) node ...  # trace path: NOT redacted
 *
 * `set -x` traces every command in its FULLY EXPANDED form, and `$(...)` expands
 * to a literal `ADLC_MANIFEST_KEY=<value>` argument before `env` runs. Two
 * independent mistakes, either of which alone is enough:
 *
 *   1. tracing enabled while a secrets file is in the command, and
 *   2. a secrets file expanded into an argument list at all — argv is visible to
 *      xtrace, to `ps`, and to any harness that logs commands.
 *
 * This blocks both, and names the safe form. See AGENTS.md, "ADLC_MANIFEST_KEY:
 * never let it become an argument".
 *
 * FAILS OPEN on malformed hook input, deliberately. The threat model is my own
 * carelessness, not an adversary — anyone who can edit this file can bypass it
 * anyway, so fail-closed buys no security while a parse bug that blocked every
 * Bash call would be a far worse outcome than the leak it guards. Asserted in
 * scripts/test/block-secret-exposure.test.mjs so it cannot drift silently.
 *
 * It does NOT fail open on ambiguous command TEXT. Quoting the pattern inside a
 * heredoc — a commit message describing the incident, say — is still refused,
 * and that false positive is deliberate. Telling "operative" from "merely
 * quoted" means re-implementing shell quoting, which is precisely the
 * operative-vs-inert boundary docs/review-lenses/text-scanning-gates.md was
 * distilled from; that lens says to scan and accept the false positive rather
 * than approximate the grammar and risk a bypass. The escape hatch is to move
 * the text out of argv (`git commit -F <file>`), which is also the habit this
 * guard is trying to build.
 *
 * KNOWN LIMIT — it sees only the command STRING. A secret exposed from inside a
 * script the command runs (`bash deploy.sh`, an npm script) is invisible here.
 * This covers the inline-command surface, which is where the incident happened;
 * it is not a containment boundary and is not offered as one.
 */

const SECRET_FILE = /(^|[\s'"`/=(])\.env(\.[\w.-]+)?\b|\bid_[rd]sa\b|\.pem\b|\bcredentials(\.\w+)?\b|\bsecrets?\.(json|ya?ml|txt|env)\b/;

// `set -x`, `set -ex`, `set -o xtrace`, `bash -x`, `sh -exc`. Deliberately NOT
// `set +x` (that DISABLES tracing — it is the fix, not the defect) and not
// `set -a`, which is part of the recommended safe form below.
const TRACING = /\bset\s+-[a-wyz]*x|\bset\s+-o\s+xtrace\b|\b(?:ba|z|k)?sh\s+-[a-wyz]*x/;

// A secrets file consumed by command substitution or piped into xargs — either
// way its contents become argv.
const SUBSTITUTION = /\$\([^)]*\)|`[^`]*`/g;
const XARGS_PIPE = /\|\s*xargs\b/;

/**
 * The form this guard recommends — a REAL command, not a `<placeholder>` sketch.
 *
 * Two reasons it is executable rather than illustrative. It is checked: the test
 * asserts this exact string is ALLOWED, so the guard can never recommend
 * something it would itself refuse — the failure mode that makes people disable
 * a guard rather than obey it. And a prose placeholder put an angle bracket in
 * the message, which the mutation gate's invert-comparison operator read as a
 * comparison and rewrote; a concrete example has no such token to mutate.
 */
export const SAFE_FORM = 'set -a; . ./.env.local; set +a; node tool.mjs';

function violations(command) {
  const found = [];

  if (TRACING.test(command) && SECRET_FILE.test(command)) {
    found.push(
      'shell tracing (set -x / sh -x) is enabled in a command that references a secrets file. '
      + 'xtrace prints every command in its FULLY EXPANDED form, so redacting the file\'s '
      + 'display path does not stop the value being printed somewhere else.',
    );
  }

  const substituted = command.match(SUBSTITUTION) ?? [];
  if (substituted.some((chunk) => SECRET_FILE.test(chunk))) {
    found.push(
      'a secrets file is expanded through $(...) or backticks into an argument list. '
      + 'argv is visible to xtrace, to `ps`, and to any harness that logs commands.',
    );
  }

  if (XARGS_PIPE.test(command) && SECRET_FILE.test(command)) {
    found.push(
      'a secrets file is piped into xargs, which turns its contents into arguments. '
      + 'Same exposure as command substitution.',
    );
  }

  return found;
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    let command = '';
    try {
      command = JSON.parse(raw)?.tool_input?.command ?? '';
    } catch {
      process.exit(0); // unparseable input is not a finding — fail open
    }

    const found = violations(command);
    if (found.length === 0) process.exit(0);

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Blocked — this command would expose a secret:\n`
          + found.map((reason) => `  - ${reason}`).join('\n')
          + `\n\nUse instead:\n  ${SAFE_FORM}\n`
          + `  (the value stays in the environment; it never becomes an argument)\n\n`
          + `Drop the tracing flag; env VAR=value cmd prints nothing on its own. `
          + `See AGENTS.md, "ADLC_MANIFEST_KEY: never let it become an argument".`,
      },
    }));
    process.exit(0);
  });
}

// Importable for the test; only reads stdin when run as the hook.
export { violations };
if (import.meta.url === `file://${process.argv[1]}`) main();

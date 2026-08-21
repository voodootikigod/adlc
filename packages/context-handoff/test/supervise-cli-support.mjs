// Shared fixture for the `handoff supervise` end-to-end tests. Same shape as
// continue-cli-support.mjs: drive the real bin as a subprocess, never a
// stand-in.
//
// The fake `claude` is what makes the loop runnable without an API key. It
// records its argv and environment, writes a minimal transcript JSONL exactly
// where Claude Code writes one, arms a real deny marker through the package's
// own keyless `ensureDenyMarker` (the same call an enforcing hook makes), and
// then idles. Everything else is real — the real supervisor, the real
// `handoff continue`, a real manifest key, real files on disk.
//
// LIVE CHECK (not run in CI). To drive the same loop against the real Claude
// Code binary, in a repo you do not mind mutating:
//
//   ADLC_MANIFEST_KEY=$KEY adlc handoff supervise -- claude
//
// then push the session past the handoff band (spec §Tiers) and watch it
// respawn. That check needs a live model and a paid API call per turn, so it is
// documented here rather than executed: nothing in these tests requires it, and
// none of them reads ADLC_CC_LIVE.

import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BIN = join(HERE, '..', 'bin', 'handoff.mjs');
const DENY_MARKER_LIB = join(HERE, '..', 'lib', 'deny-marker.mjs');
export const TEST_KEY = 'd'.repeat(64);

/** The final assistant message the capture is supposed to carry forward. */
export const SUMMARY = 'Handoff summary: rails are frozen, the rollback path still needs a test.';

/**
 * A stand-in for `claude`.
 *
 * First invocation (no positional prompt): write the transcript, arm a deny for
 * its own `--session-id`, then idle until signalled. Second invocation (the
 * successor, which the supervisor gives a bootstrap prompt): record and exit,
 * which is what ends the loop.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDenyMarker } from ${JSON.stringify(DENY_MARKER_LIB)};

const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv, env: process.env }) + '\\n');

const at = argv.indexOf('--session-id');
const sessionId = at === -1 ? null : argv[at + 1];
const prompt = argv.length > 2 ? argv[argv.length - 1] : null;

// A harness that fails on startup — the case a wrapper must not report as a
// successful supervision.
const failWith = process.env.FAKE_CLAUDE_EXIT_CODE;
if (failWith) process.exit(Number(failWith));

// Claude Code's own transcript location (live probe 2026-08-13). Skipped
// entirely when the fixture is standing in for the item-24 failure, where the
// child runs but its transcript never appears.
if (process.env.FAKE_CLAUDE_NO_TRANSCRIPT !== '1') {
  const dir = join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[/.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, sessionId + '.jsonl'),
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'do the work' } }),
      JSON.stringify({
        type: 'assistant',
        requestId: 'req_1',
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: ${JSON.stringify(SUMMARY)} }] },
      }),
    ].join('\\n') + '\\n',
  );
}

if (prompt !== null) process.exit(0); // the successor: its job here is to be observed

// The deny an enforcing hook would arm — keyless, exactly as the hook does it.
const armed = ensureDenyMarker(process.cwd(), {
  sessionId,
  ticketId: process.env.FAKE_CLAUDE_TICKET || null,
  contentHash: null,
  host: 'fake-claude',
});
if (!armed.ok) {
  process.stderr.write('fake claude could not arm a deny: ' + armed.reason + '\\n');
  process.exit(3);
}

// A session that crashes AFTER writing its handoff deny — it has already
// signalled that it is being replaced, so the supervisor continues to its
// successor, but the operator should still hear about it.
const denyThenExit = process.env.FAKE_CLAUDE_DENY_THEN_EXIT;
if (denyThenExit) process.exit(Number(denyThenExit));

// Idle like a TUI waiting for input. SIGTERM's default action ends us, which is
// what the supervisor is counting on.
const idleMs = Number(process.env.FAKE_CLAUDE_IDLE_MS || 0);
if (idleMs > 0) setTimeout(() => process.exit(0), idleMs);
else setInterval(() => {}, 1000);
`;

export function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'handoff-supervise-')));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const fake = join(root, 'fake-claude.mjs');
  writeFileSync(fake, FAKE_CLAUDE, 'utf8');
  chmodSync(fake, 0o755);
  const log = join(root, 'spawns.jsonl');
  writeFileSync(log, '', 'utf8');
  return { root, home, fake, log };
}

export function readSpawns(log) {
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * The environment a supervised run gets.
 *
 * Exported so a test that drives the CLI directly (rather than through
 * `supervise` below) cannot forget HOME or FAKE_CLAUDE_LOG. Forgetting HOME
 * points the fake harness at the REAL `~/.claude`; forgetting the log makes
 * every `readSpawns` assertion vacuously empty, because the fake cannot record
 * anything and a "nothing ever ran" check then passes whether or not it did.
 */
export function superviseEnv({ home, log }, overrides = {}) {
  return {
    ...process.env,
    HOME: home,
    ADLC_MANIFEST_KEY: TEST_KEY,
    FAKE_CLAUDE_LOG: log,
    FAKE_CLAUDE_TICKET: 'T-SUPERVISE',
    FAKE_CLAUDE_IDLE_MS: '0',
    FAKE_CLAUDE_EXIT_CODE: '',
    FAKE_CLAUDE_DENY_THEN_EXIT: '',
    FAKE_CLAUDE_NO_TRANSCRIPT: '0',
    // The markers contract item 24 says must never reach the child. They are
    // set HERE, on the supervisor, because that is how an operator launching
    // the wrapper from inside a Claude Code session gets them.
    CLAUDECODE: '1',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ID: 'parent-session',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    ...overrides,
  };
}

/** Run the real supervisor to completion. */
export function supervise({
  root,
  home,
  fake,
  log,
  ticket = 'T-SUPERVISE',
  idleMs = 0,
  timeout = 90_000,
  command = fake,
  exitCode = '',
  denyThenExit = '',
  noTranscript = false,
}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, 'supervise', '--dir', '.adlc', '--json', '--', command],
      {
        cwd: root,
        encoding: 'utf8',
        timeout,
        env: superviseEnv(
          { home, log },
          {
            FAKE_CLAUDE_TICKET: ticket,
            FAKE_CLAUDE_IDLE_MS: String(idleMs),
            FAKE_CLAUDE_EXIT_CODE: String(exitCode),
            FAKE_CLAUDE_DENY_THEN_EXIT: String(denyThenExit),
            FAKE_CLAUDE_NO_TRANSCRIPT: noTranscript ? '1' : '0',
          },
        ),
      },
      (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
      },
    );
  });
}

/** `handoff supervise --help`, as an operator sees it. */
export function helpText(cwd) {
  return execFileSync(process.execPath, [BIN, 'supervise', '--help'], {
    cwd,
    encoding: 'utf8',
    env: process.env,
  });
}

/**
 * The `Exit codes:` table the help promises, as [code, description] pairs.
 *
 * Parsed rather than hardcoded so the tests can compare what the command
 * DOCUMENTS against what it actually returns. A help text that quietly stops
 * matching the behaviour is a worse failure than a missing one: an operator
 * scripting around `supervise` reads this table and never re-checks it.
 */
export function documentedExitCodes(help) {
  const block = String(help).split('Exit codes:')[1] ?? '';
  const codes = [];
  for (const line of block.split('\n')) {
    const m = /^ {2}(\d+) {2}(\S.*)$/.exec(line);
    if (m) codes.push([Number(m[1]), m[2].trim()]);
  }
  return codes;
}

/** The code the help documents for the outcome whose description contains `needle`. */
export function documentedCodeFor(help, needle) {
  const found = documentedExitCodes(help).filter(([, text]) => text.includes(needle));
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one documented exit code mentioning ${JSON.stringify(needle)}, found ${found.length}`,
    );
  }
  return found[0][0];
}

export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
export const denyPathFor = (root, session) =>
  join(root, '.adlc', 'handoffs', 'denies', `${session}.json`);
export const contentPathFor = (root, session) =>
  join(root, '.adlc', 'handoffs', 'content', `${session}.md`);

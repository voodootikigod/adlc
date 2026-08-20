// cli-supervise.test.mjs — the whole zero-touch loop, driven by the REAL
// `handoff supervise` subcommand against a fake harness binary.
//
// The fake `claude` is what makes this runnable without an API key: it records
// its argv and environment, writes a minimal transcript JSONL exactly where
// Claude Code writes one, arms a real deny marker through the package's own
// keyless `ensureDenyMarker` (the same call an enforcing hook makes), and then
// idles. Everything else in the loop is real — the real supervisor, the real
// `handoff continue`, a real manifest key, real files on disk.
//
// LIVE CHECK (not run in CI). To drive the same loop against the real Claude
// Code binary, in a repo you do not mind mutating:
//
//   ADLC_CC_LIVE=1 ADLC_MANIFEST_KEY=$KEY adlc handoff supervise -- claude
//
// then push the session past the handoff band (spec §Tiers) and watch it
// respawn. That check needs a live model and a paid API call per turn, so it is
// documented here rather than executed: nothing in this file requires it, and
// no test below reads ADLC_CC_LIVE.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'handoff.mjs');
const DENY_MARKER_LIB = join(HERE, '..', 'lib', 'deny-marker.mjs');
const TEST_KEY = 'd'.repeat(64);

/** The final assistant message the capture is supposed to carry forward. */
const SUMMARY = 'Handoff summary: rails are frozen, the rollback path still needs a test.';

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

// Claude Code's own transcript location (live probe 2026-08-13).
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

// Idle like a TUI waiting for input. SIGTERM's default action ends us, which is
// what the supervisor is counting on.
const idleMs = Number(process.env.FAKE_CLAUDE_IDLE_MS || 0);
if (idleMs > 0) setTimeout(() => process.exit(0), idleMs);
else setInterval(() => {}, 1000);
`;

function fixture() {
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

function readSpawns(log) {
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Run the real supervisor to completion. */
function supervise({ root, home, fake, log, ticket = 'T-SUPERVISE', idleMs = 0, timeout = 90_000 }) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, 'supervise', '--dir', '.adlc', '--json', '--', fake],
      {
        cwd: root,
        encoding: 'utf8',
        timeout,
        env: {
          ...process.env,
          HOME: home,
          ADLC_MANIFEST_KEY: TEST_KEY,
          FAKE_CLAUDE_LOG: log,
          FAKE_CLAUDE_TICKET: ticket,
          FAKE_CLAUDE_IDLE_MS: String(idleMs),
          // The markers contract item 24 says must never reach the child. They
          // are set HERE, on the supervisor, because that is how an operator
          // launching the wrapper from inside a Claude Code session gets them.
          CLAUDECODE: '1',
          CLAUDE_CODE_CHILD_SESSION: '1',
          CLAUDE_CODE_SESSION_ID: 'parent-session',
          CLAUDE_CODE_ENTRYPOINT: 'cli',
        },
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const denyPathFor = (root, session) => join(root, '.adlc', 'handoffs', 'denies', `${session}.json`);
const contentPathFor = (root, session) => join(root, '.adlc', 'handoffs', 'content', `${session}.md`);
const resumeAuthFiles = (root) =>
  readdirSync(join(root, '.adlc', 'handoffs'))
    .filter((n) => n.endsWith('.resume-auth.json'))
    .sort();

test('supervise drives deny → continue → respawn with no operator action', async (t) => {
  t.diagnostic('this test waits on the real quiescence + poll intervals (~15s)');
  const fx = fixture();
  try {
    const run = await supervise(fx);
    assert.equal(run.code, 0, `supervise failed: ${run.stderr}`);

    const spawns = readSpawns(fx.log);
    assert.equal(spawns.length, 2, `expected a denied session and its successor, got ${spawns.length}`);

    const [first, second] = spawns;
    assert.equal(first.argv[0], '--session-id');
    const denier = first.argv[1];
    assert.equal(first.argv.length, 2, 'the first session gets no prompt — it is the operator’s');

    assert.equal(second.argv[0], '--session-id');
    const successor = second.argv[1];
    assert.notEqual(successor, denier, 'the successor must be a different session');
    assert.equal(second.argv.length, 3, 'the successor is spawned with the bootstrap prompt');

    // The prompt is the spec's bootstrap payload: fenced, and carrying the
    // previous session's own final message.
    const prompt = second.argv[2];
    assert.match(prompt, new RegExp(`Continuation of session ${denier}`));
    assert.ok(prompt.includes(SUMMARY), 'the successor must receive the narrative from the transcript');
    assert.ok(prompt.includes('<<<UNTRUSTED-CAPTURE-DATA'), 'the untrusted fence must survive into the prompt');
    assert.ok(prompt.includes('END-UNTRUSTED>>>'));

    // Contract item 24, on every spawn — the fact the whole loop depends on.
    for (const spawn of spawns) {
      for (const marker of [
        'CLAUDECODE',
        'CLAUDE_CODE_CHILD_SESSION',
        'CLAUDE_CODE_SESSION_ID',
        'CLAUDE_CODE_ENTRYPOINT',
      ]) {
        assert.equal(spawn.env[marker], undefined, `${marker} reached the harness child`);
      }
      assert.equal(spawn.env.ADLC_MANIFEST_KEY, undefined, 'the signing key must never reach the child');
      assert.equal(spawn.env.ADLC_HANDOFF_SUPERVISED, '1');
    }

    // The deny was consumed EXACTLY once, for exactly this successor.
    const deny = readJson(denyPathFor(fx.root, denier));
    assert.equal(deny.status, 'consumed');
    assert.equal(deny.consumed_by, successor);
    assert.deepEqual(resumeAuthFiles(fx.root), [`${successor}.resume-auth.json`]);

    const capture = readFileSync(contentPathFor(fx.root, denier), 'utf8');
    assert.ok(capture.includes(SUMMARY));
    assert.ok(capture.includes('## Ticket'));

    const manifest = readFileSync(join(fx.root, '.adlc', 'manifest.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.gate === 'context-handoff-continue');
    assert.equal(manifest.length, 1, 'exactly one continuation was recorded');

    const payload = JSON.parse(run.stdout);
    assert.equal(payload.continuations, 1);
    assert.deepEqual(payload.sessions, [denier, successor]);
    assert.equal(payload.reason, 'child_exited');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('an unbound deny degrades: nothing consumed, child left alone, operator told what to run', async (t) => {
  t.diagnostic('this test waits on the real quiescence + poll intervals (~15s)');
  // No ticket on the marker — `continue` refuses to invent one (spec §Continue),
  // which is the degrade the wrapper must hand back rather than work around.
  const fx = fixture();
  try {
    const run = await supervise({ ...fx, ticket: '', idleMs: 12_000 });
    assert.equal(run.code, 2, `expected the degrade exit code, got ${run.code}: ${run.stderr}`);

    const spawns = readSpawns(fx.log);
    assert.equal(spawns.length, 1, 'a degrade must not respawn anything');
    const denier = spawns[0].argv[1];

    const deny = readJson(denyPathFor(fx.root, denier));
    assert.equal(deny.status, 'open', 'nothing may be consumed on a degrade');
    assert.equal(deny.ticket_id, null);
    assert.deepEqual(resumeAuthFiles(fx.root), [], 'no successor was authorized');

    const warnings = run.stderr
      .split('\n')
      .filter((line) => line.includes('automatic continuation is not possible'));
    assert.equal(warnings.length, 1, `expected exactly one warning, got ${warnings.length}`);
    assert.match(run.stderr, new RegExp(`handoff continue --deny-session ${denier} --write`));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('supervise refuses to start without the separator or the key', async () => {
  const fx = fixture();
  try {
    const noSeparator = await new Promise((resolve) => {
      execFile(
        process.execPath,
        [BIN, 'supervise', 'claude'],
        { cwd: fx.root, encoding: 'utf8', env: { ...process.env, ADLC_MANIFEST_KEY: TEST_KEY } },
        (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
      );
    });
    assert.equal(noSeparator.code, 1);
    assert.match(noSeparator.stderr + noSeparator.stdout, /after `--`/);

    // The key is demanded UP FRONT: discovering it after an hour-long session
    // hit its deny would waste the very session being supervised.
    const noKey = await new Promise((resolve) => {
      const env = { ...process.env };
      delete env.ADLC_MANIFEST_KEY;
      execFile(
        process.execPath,
        [BIN, 'supervise', '--', fx.fake],
        { cwd: fx.root, encoding: 'utf8', env },
        (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
      );
    });
    assert.equal(noKey.code, 1);
    assert.match(noKey.stderr + noKey.stdout, /ADLC_MANIFEST_KEY/);
    assert.deepEqual(readSpawns(fx.log), [], 'no harness process may start without the key');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

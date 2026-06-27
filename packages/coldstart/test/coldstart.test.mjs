// Tests for the coldstart package — all offline, no API keys required.
// Tests: prompt construction, gap-report rendering, --all aggregation, unknown-id error.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildPrompt, ticketToText, SYSTEM_PROMPT } from '../lib/prompt.mjs';
import { renderReport, buildJsonOutput, allPass } from '../lib/report.mjs';
import { buildCheckTicket } from '../lib/gate.mjs';

const CLI = fileURLToPath(new URL('../bin/coldstart.mjs', import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'coldstart-test-'));
}

function writeTickets(dir, tickets) {
  const path = join(dir, 'tickets.json');
  writeFileSync(path, JSON.stringify({ tickets }, null, 2));
  return path;
}

function runCLI(args, { cwd, extraEnv = {} } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: cwd ?? tmpdir(),
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      ...extraEnv,
    },
    encoding: 'utf8',
  });
  return result;
}

/**
 * Run the CLI with a canned LLM response injected via ADLC_GATE_MOCK_RESPONSE.
 * Also injects a dummy ANTHROPIC_API_KEY so the provider-detection check passes.
 */
function runCLIWithMockGate(args, mockGapsJson, { cwd } = {}) {
  return runCLI(args, {
    cwd,
    extraEnv: {
      // NODE_ENV=test is REQUIRED: the mock gate seam is only honored in tests.
      // Without it, ADLC_GATE_MOCK_RESPONSE is ignored (F5 backdoor closed).
      NODE_ENV: 'test',
      ANTHROPIC_API_KEY: 'mock-key-for-testing',
      ADLC_GATE_MOCK_RESPONSE: JSON.stringify(mockGapsJson),
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt construction
// ─────────────────────────────────────────────────────────────────────────────

describe('prompt construction', () => {
  test('buildPrompt embeds ticket id and title', () => {
    const ticket = { id: 'T1', title: 'Add login form', body: 'Create a login form.' };
    const prompt = buildPrompt(ticket);
    assert.ok(prompt.includes('T1'), 'prompt must include ticket id');
    assert.ok(prompt.includes('Add login form'), 'prompt must include ticket title');
  });

  test('buildPrompt embeds ticket body', () => {
    const ticket = { id: 'T2', title: 'Refactor auth', body: 'Move auth to its own module.' };
    const prompt = buildPrompt(ticket);
    assert.ok(prompt.includes('Move auth to its own module.'), 'prompt must include body');
  });

  test('buildPrompt embeds scope array when present', () => {
    const ticket = { id: 'T3', title: 'Update tests', scope: ['src/auth/**', 'test/auth/**'] };
    const prompt = buildPrompt(ticket);
    assert.ok(prompt.includes('src/auth/**'), 'prompt must include scope');
  });

  test('buildPrompt embeds rails when present', () => {
    const ticket = { id: 'T4', title: 'Fix bug', rails: ['test/auth/auth.test.ts'] };
    const prompt = buildPrompt(ticket);
    assert.ok(prompt.includes('test/auth/auth.test.ts'), 'prompt must include rails');
  });

  test('buildPrompt embeds edges when present', () => {
    const ticket = {
      id: 'T5',
      title: 'API endpoint',
      edges: [{ to: 'T6', contract: 'src/types/user.d.ts' }],
    };
    const prompt = buildPrompt(ticket);
    assert.ok(prompt.includes('T6'), 'prompt must include edge target');
    assert.ok(prompt.includes('src/types/user.d.ts'), 'prompt must include edge contract');
  });

  test('buildPrompt instructs model to output gap JSON schema', () => {
    const ticket = { id: 'T7', title: 'Simple task' };
    const prompt = buildPrompt(ticket);
    assert.ok(prompt.includes('gaps'), 'prompt must reference gaps schema');
    assert.ok(prompt.includes('what'), 'prompt must reference "what" field');
    assert.ok(prompt.includes('why_blocking'), 'prompt must reference "why_blocking" field');
  });

  test('SYSTEM_PROMPT mentions repo availability', () => {
    assert.ok(
      SYSTEM_PROMPT.toLowerCase().includes('repo'),
      'system prompt must note repo is available'
    );
  });

  test('ticketToText serializes to valid JSON', () => {
    const ticket = { id: 'T8', title: 'Foo', body: 'bar', scope: ['src/**'], rails: ['test/**'] };
    const text = ticketToText(ticket);
    const parsed = JSON.parse(text); // throws if invalid
    assert.equal(parsed.id, 'T8');
    assert.equal(parsed.title, 'Foo');
    assert.deepEqual(parsed.scope, ['src/**']);
  });

  test('ticketToText omits empty arrays and undefined body', () => {
    const ticket = { id: 'T9', title: 'Minimal' };
    const text = ticketToText(ticket);
    const parsed = JSON.parse(text);
    assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'scope'), false, 'scope absent when empty');
    assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'body'), false, 'body absent when missing');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gap-report rendering from fixture JSON
// ─────────────────────────────────────────────────────────────────────────────

describe('renderReport', () => {
  test('renders PASS for ticket with no gaps', () => {
    const results = [{ id: 'T1', gaps: [] }];
    const report = renderReport(results);
    assert.ok(report.includes('[PASS]'), 'should say PASS');
    assert.ok(report.includes('T1'), 'should include ticket id');
  });

  test('renders FAIL with gap count for ticket with gaps', () => {
    const results = [
      {
        id: 'T2',
        gaps: [
          { what: 'UserSchema', why_blocking: 'Shape not defined anywhere in ticket.' },
          { what: 'Target file', why_blocking: 'No file path specified.' },
        ],
      },
    ];
    const report = renderReport(results);
    assert.ok(report.includes('[FAIL]'), 'should say FAIL');
    assert.ok(report.includes('T2'), 'should include ticket id');
    assert.ok(report.includes('UserSchema'), 'should include gap what');
    assert.ok(report.includes('Shape not defined'), 'should include gap why_blocking');
    assert.ok(report.includes('2 gap'), 'should include gap count');
  });

  test('renders multiple tickets in order', () => {
    const results = [
      { id: 'T1', gaps: [] },
      { id: 'T2', gaps: [{ what: 'Missing', why_blocking: 'No info.' }] },
    ];
    const report = renderReport(results);
    const t1Pos = report.indexOf('T1');
    const t2Pos = report.indexOf('T2');
    assert.ok(t1Pos < t2Pos, 'T1 should appear before T2');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildJsonOutput
// ─────────────────────────────────────────────────────────────────────────────

describe('buildJsonOutput', () => {
  test('ok=true when all tickets pass', () => {
    const results = [{ id: 'T1', gaps: [] }, { id: 'T2', gaps: [] }];
    const out = buildJsonOutput(results);
    assert.equal(out.ok, true);
    assert.equal(out.results[0].pass, true);
    assert.equal(out.results[1].pass, true);
  });

  test('ok=false when any ticket has gaps', () => {
    const results = [
      { id: 'T1', gaps: [] },
      { id: 'T2', gaps: [{ what: 'X', why_blocking: 'Y' }] },
    ];
    const out = buildJsonOutput(results);
    assert.equal(out.ok, false);
    assert.equal(out.results[1].pass, false);
    assert.deepEqual(out.results[1].gaps, [{ what: 'X', why_blocking: 'Y' }]);
  });

  test('results array length matches inputs', () => {
    const results = [
      { id: 'T1', gaps: [] },
      { id: 'T2', gaps: [] },
      { id: 'T3', gaps: [{ what: 'A', why_blocking: 'B' }] },
    ];
    const out = buildJsonOutput(results);
    assert.equal(out.results.length, 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// allPass aggregation
// ─────────────────────────────────────────────────────────────────────────────

describe('allPass', () => {
  test('returns true when all results have empty gaps', () => {
    assert.equal(allPass([{ id: 'T1', gaps: [] }, { id: 'T2', gaps: [] }]), true);
  });

  test('returns false when any result has gaps', () => {
    assert.equal(
      allPass([{ id: 'T1', gaps: [] }, { id: 'T2', gaps: [{ what: 'x', why_blocking: 'y' }] }]),
      false
    );
  });

  test('returns true for empty input array', () => {
    assert.equal(allPass([]), true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLI integration tests (no network — uses --prompt-only + error paths)
// ─────────────────────────────────────────────────────────────────────────────

describe('CLI integration (no network)', () => {
  let tmpDir;

  test.before(() => {
    tmpDir = makeTempDir();
  });

  test.after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('no args → exit 1 with usage message', () => {
    const ticketsPath = writeTickets(tmpDir, [{ id: 'T1', title: 'Foo' }]);
    const result = runCLI(['--tickets', ticketsPath]);
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}\nstderr: ${result.stderr}`);
    assert.ok(result.stderr.includes('usage'), `expected usage message, got: ${result.stderr}`);
  });

  test('unknown ticket id → exit 1', () => {
    const ticketsPath = writeTickets(tmpDir, [{ id: 'T1', title: 'Foo' }]);
    const result = runCLI(['UNKNOWN', '--tickets', ticketsPath]);
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}`);
    assert.ok(
      result.stderr.includes('unknown ticket id'),
      `expected unknown-id error, got: ${result.stderr}`
    );
  });

  test('--prompt-only prints prompts and exits 0', () => {
    const ticketsPath = writeTickets(tmpDir, [{ id: 'T1', title: 'Login form', body: 'Create login.' }]);
    const result = runCLI(['T1', '--tickets', ticketsPath, '--prompt-only']);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('Login form'), 'prompt output should include ticket title');
    assert.ok(result.stdout.includes('T1'), 'prompt output should include ticket id');
  });

  test('--prompt-only --all prints one prompt per ticket', () => {
    const ticketsPath = writeTickets(tmpDir, [
      { id: 'T1', title: 'First ticket' },
      { id: 'T2', title: 'Second ticket' },
    ]);
    const result = runCLI(['--all', '--tickets', ticketsPath, '--prompt-only']);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstdout: ${result.stdout}`);
    assert.ok(result.stdout.includes('T1'), 'should include T1 prompt');
    assert.ok(result.stdout.includes('T2'), 'should include T2 prompt');
  });

  test('missing tickets file → exit 1 with error message', () => {
    const result = runCLI(['T1', '--tickets', join(tmpDir, 'nonexistent.json')]);
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}`);
  });

  test('no provider without --prompt-only → exit 1', () => {
    const ticketsPath = writeTickets(tmpDir, [{ id: 'T1', title: 'Foo' }]);
    // All API keys stripped in runCLI env
    const result = runCLI(['T1', '--tickets', ticketsPath]);
    assert.equal(result.status, 1, `expected exit 1 (no provider), got ${result.status}`);
    assert.ok(
      result.stderr.includes('provider') || result.stderr.includes('API'),
      `expected provider error, got: ${result.stderr}`
    );
  });

  test('--all with no tickets → exit 1', () => {
    const ticketsPath = writeTickets(tmpDir, []);
    const result = runCLI(['--all', '--tickets', ticketsPath]);
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}`);
  });

  test('--prompt-only output contains system and user sections', () => {
    const ticketsPath = writeTickets(tmpDir, [
      { id: 'T1', title: 'Add endpoint', body: 'Add POST /users endpoint' },
    ]);
    const result = runCLI(['T1', '--tickets', ticketsPath, '--prompt-only']);
    assert.equal(result.status, 0);
    // System section should include repo mention
    assert.ok(
      result.stdout.toLowerCase().includes('repo'),
      'output should contain repo mention from system prompt'
    );
    // User section should contain the gap-detection instructions
    assert.ok(
      result.stdout.includes('gaps'),
      'output should contain gaps schema instruction'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// gate.mjs — checkTicket / checkAll logic (no network)
// ─────────────────────────────────────────────────────────────────────────────

describe('gate checkTicket / checkAll (unit, no network)', () => {
  test('checkTicket returns { id, gaps: [] } when LLM says no gaps', async () => {
    const stubComplete = async () => '{"gaps":[]}';
    const stubExtractJson = (text) => JSON.parse(text);
    const checkTicketWith = buildCheckTicket(stubComplete, stubExtractJson);

    const ticket = { id: 'T1', title: 'Login form', body: 'Implement login.' };
    const result = await checkTicketWith(ticket);
    assert.equal(result.id, 'T1');
    assert.deepEqual(result.gaps, []);
  });

  test('checkTicket returns gaps when LLM identifies blockers', async () => {
    const gap = { what: 'UserSchema', why_blocking: 'Shape not defined in ticket.' };
    const stubComplete = async () => JSON.stringify({ gaps: [gap] });
    const stubExtractJson = (text) => JSON.parse(text);
    const checkTicketWith = buildCheckTicket(stubComplete, stubExtractJson);

    const ticket = { id: 'T2', title: 'Update user API' };
    const result = await checkTicketWith(ticket);
    assert.equal(result.id, 'T2');
    assert.equal(result.gaps.length, 1);
    assert.equal(result.gaps[0].what, 'UserSchema');
    assert.equal(result.gaps[0].why_blocking, 'Shape not defined in ticket.');
  });

  test('checkTicket passes prompt including ticket fields to completeFn', async () => {
    let capturedOpts;
    const stubComplete = async (opts) => {
      capturedOpts = opts;
      return '{"gaps":[]}';
    };
    const stubExtractJson = (text) => JSON.parse(text);
    const checkTicketWith = buildCheckTicket(stubComplete, stubExtractJson);

    const ticket = { id: 'T3', title: 'Add endpoint', body: 'POST /users' };
    await checkTicketWith(ticket);

    assert.ok(capturedOpts, 'completeFn must be called');
    assert.equal(capturedOpts.tier, 'cheap');
    assert.ok(capturedOpts.prompt.includes('T3'), 'prompt must contain ticket id');
    assert.ok(capturedOpts.prompt.includes('Add endpoint'), 'prompt must contain ticket title');
    assert.ok(capturedOpts.prompt.includes('POST /users'), 'prompt must contain ticket body');
    assert.equal(capturedOpts.system, SYSTEM_PROMPT);
  });

  test('checkTicket treats missing/invalid gaps field as empty array', async () => {
    const stubComplete = async () => '{"result":"ok"}';
    const stubExtractJson = (text) => JSON.parse(text);
    const checkTicketWith = buildCheckTicket(stubComplete, stubExtractJson);

    const ticket = { id: 'T4', title: 'Refactor' };
    const result = await checkTicketWith(ticket);
    assert.deepEqual(result.gaps, []);
  });

  test('checkTicket propagates errors thrown by completeFn', async () => {
    const stubComplete = async () => { throw new Error('network failure'); };
    const stubExtractJson = (text) => JSON.parse(text);
    const checkTicketWith = buildCheckTicket(stubComplete, stubExtractJson);

    const ticket = { id: 'T5', title: 'Deploy' };
    await assert.rejects(() => checkTicketWith(ticket), /network failure/);
  });

  test('checkTicket handles invalid JSON in ADLC_GATE_MOCK_RESPONSE gracefully', async () => {
    // Save original env
    const origEnv = process.env.ADLC_GATE_MOCK_RESPONSE;
    const origNodeEnv = process.env.NODE_ENV;

    process.env.NODE_ENV = 'test';
    process.env.ADLC_GATE_MOCK_RESPONSE = 'invalid json';

    // Import the real checkTicket function for this test to trigger the mock branch
    const { checkTicket } = await import('../lib/gate.mjs');

    const ticket = { id: 'T_INVALID', title: 'Test invalid JSON' };
    let result;
    try {
      result = await checkTicket(ticket);
    } finally {
      // Restore env
      process.env.ADLC_GATE_MOCK_RESPONSE = origEnv;
      process.env.NODE_ENV = origNodeEnv;
    }

    assert.equal(result.id, 'T_INVALID');
    assert.deepEqual(result.gaps, []);
  });

  test('checkAll runs checkTicket for every ticket in order', async () => {
    const responses = [
      { gaps: [] },
      { gaps: [{ what: 'MissingType', why_blocking: 'No shape.' }] },
    ];
    let callCount = 0;
    const stubComplete = async (_opts) => {
      const resp = responses[callCount++];
      return JSON.stringify(resp);
    };
    const stubExtractJson = (text) => JSON.parse(text);
    const checkTicketWith = buildCheckTicket(stubComplete, stubExtractJson);

    // Build a checkAll equivalent using the injected checkTicketWith
    const tickets = [
      { id: 'T1', title: 'First' },
      { id: 'T2', title: 'Second' },
    ];
    const results = [];
    for (const t of tickets) results.push(await checkTicketWith(t));

    assert.equal(results.length, 2);
    assert.equal(results[0].id, 'T1');
    assert.deepEqual(results[0].gaps, []);
    assert.equal(results[1].id, 'T2');
    assert.equal(results[1].gaps.length, 1);
    assert.equal(results[1].gaps[0].what, 'MissingType');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// --all aggregation logic (unit level)
// ─────────────────────────────────────────────────────────────────────────────

describe('--all aggregation logic (unit)', () => {
  test('allPass correctly detects partial failure', () => {
    const mixed = [
      { id: 'T1', gaps: [] },
      { id: 'T2', gaps: [{ what: 'Missing type', why_blocking: 'No shape defined.' }] },
      { id: 'T3', gaps: [] },
    ];
    assert.equal(allPass(mixed), false);
  });

  test('allPass is true only when zero total gaps across all tickets', () => {
    const passing = [
      { id: 'T1', gaps: [] },
      { id: 'T2', gaps: [] },
      { id: 'T3', gaps: [] },
    ];
    assert.equal(allPass(passing), true);
  });

  test('buildJsonOutput groups gaps per ticket id', () => {
    const results = [
      { id: 'T1', gaps: [{ what: 'ContractA', why_blocking: 'Not in ticket.' }] },
      { id: 'T2', gaps: [] },
    ];
    const out = buildJsonOutput(results);
    const t1 = out.results.find((r) => r.id === 'T1');
    const t2 = out.results.find((r) => r.id === 'T2');
    assert.ok(t1, 'T1 in results');
    assert.ok(t2, 'T2 in results');
    assert.equal(t1.gaps.length, 1);
    assert.equal(t2.gaps.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLI integration tests — exit code 2 and --json flag (via mock gate)
// Uses ADLC_GATE_MOCK_RESPONSE to bypass the real LLM call so tests are
// fully offline while exercising the full bin/coldstart.mjs code path.
// ─────────────────────────────────────────────────────────────────────────────

describe('CLI integration — exit code 2 and --json (mock gate)', () => {
  let tmpDir;

  test.before(() => {
    tmpDir = makeTempDir();
  });

  test.after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('exit 2 when ticket has gaps (spec: EXIT 2 listing gaps)', () => {
    const ticketsPath = writeTickets(tmpDir, [{ id: 'T1', title: 'Vague ticket' }]);
    const gaps = [{ what: 'AcceptanceCriteria', why_blocking: 'No measurable check defined.' }];
    const result = runCLIWithMockGate(['T1', '--tickets', ticketsPath], { gaps }, { cwd: tmpDir });
    assert.equal(
      result.status,
      2,
      `expected exit 2 (gaps present), got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  });

  test('exit 0 when ticket has no gaps (spec: EXIT 0 if gaps empty)', () => {
    const ticketsPath = writeTickets(tmpDir, [{ id: 'T2', title: 'Clear ticket' }]);
    const result = runCLIWithMockGate(['T2', '--tickets', ticketsPath], { gaps: [] }, { cwd: tmpDir });
    assert.equal(
      result.status,
      0,
      `expected exit 0 (no gaps), got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
  });

  test('exit 2 with --all when any ticket has gaps', () => {
    const ticketsPath = writeTickets(tmpDir, [
      { id: 'T1', title: 'Clear ticket' },
      { id: 'T2', title: 'Vague ticket' },
    ]);
    // Mock returns one gap for every ticket; --all processes both
    const gaps = [{ what: 'TargetFile', why_blocking: 'No file path specified.' }];
    const result = runCLIWithMockGate(['--all', '--tickets', ticketsPath], { gaps }, { cwd: tmpDir });
    assert.equal(
      result.status,
      2,
      `expected exit 2 with --all (some gaps), got ${result.status}\nstdout: ${result.stdout}`
    );
  });

  test('--json flag: stdout is valid JSON with correct schema when gaps are empty', () => {
    const ticketsPath = writeTickets(tmpDir, [{ id: 'T1', title: 'Passing ticket' }]);
    const result = runCLIWithMockGate(
      ['T1', '--tickets', ticketsPath, '--json'],
      { gaps: [] },
      { cwd: tmpDir }
    );
    assert.equal(
      result.status,
      0,
      `expected exit 0, got ${result.status}\nstderr: ${result.stderr}`
    );
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout); }, 'stdout must be valid JSON');
    assert.equal(parsed.ok, true, 'ok must be true when no gaps');
    assert.ok(Array.isArray(parsed.results), 'results must be an array');
    assert.equal(parsed.results[0].id, 'T1');
    assert.equal(parsed.results[0].pass, true);
    assert.deepEqual(parsed.results[0].gaps, []);
  });

  test('--json flag: stdout is valid JSON with correct schema when gaps are present', () => {
    const ticketsPath = writeTickets(tmpDir, [{ id: 'T2', title: 'Failing ticket' }]);
    const gap = { what: 'DataShape', why_blocking: 'Referenced but not defined.' };
    const result = runCLIWithMockGate(
      ['T2', '--tickets', ticketsPath, '--json'],
      { gaps: [gap] },
      { cwd: tmpDir }
    );
    assert.equal(
      result.status,
      2,
      `expected exit 2, got ${result.status}\nstderr: ${result.stderr}`
    );
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout); }, 'stdout must be valid JSON');
    assert.equal(parsed.ok, false, 'ok must be false when gaps present');
    assert.equal(parsed.results[0].id, 'T2');
    assert.equal(parsed.results[0].pass, false);
    assert.equal(parsed.results[0].gaps.length, 1);
    assert.equal(parsed.results[0].gaps[0].what, 'DataShape');
  });

  test('--json --all: stdout groups results per ticket id', () => {
    const ticketsPath = writeTickets(tmpDir, [
      { id: 'T1', title: 'Clear ticket' },
      { id: 'T2', title: 'Another ticket' },
    ]);
    // Mock returns no gaps — both pass
    const result = runCLIWithMockGate(
      ['--all', '--tickets', ticketsPath, '--json'],
      { gaps: [] },
      { cwd: tmpDir }
    );
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.results.length, 2);
    const ids = parsed.results.map((r) => r.id);
    assert.ok(ids.includes('T1'), 'T1 in results');
    assert.ok(ids.includes('T2'), 'T2 in results');
  });

  test('human-readable output (no --json) includes gap details on exit 2', () => {
    const ticketsPath = writeTickets(tmpDir, [{ id: 'T1', title: 'Ticket with gap' }]);
    const gap = { what: 'ContractSpec', why_blocking: 'Contract named but not embedded.' };
    const result = runCLIWithMockGate(['T1', '--tickets', ticketsPath], { gaps: [gap] }, { cwd: tmpDir });
    assert.equal(result.status, 2);
    assert.ok(result.stdout.includes('[FAIL]'), 'output should say FAIL');
    assert.ok(result.stdout.includes('ContractSpec'), 'output should include gap what');
    assert.ok(result.stdout.includes('Contract named but not embedded'), 'output should include why_blocking');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F5 regression — the mock gate backdoor must be CLOSED outside NODE_ENV=test
// A vague ticket with a green ADLC_GATE_MOCK_RESPONSE and a dummy API key must
// NOT pass via the mock. The gate must ignore the env var and take the real LLM
// path (which fails closed without a valid key / network).
// ─────────────────────────────────────────────────────────────────────────────

describe('F5 regression — mock gate backdoor closed in production', () => {
  let tmpDir;

  test.before(() => {
    tmpDir = makeTempDir();
  });

  test.after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('vague ticket does NOT get a green mock verdict without NODE_ENV=test', () => {
    const ticketsPath = writeTickets(tmpDir, [{ id: 'T1', title: 'Vague ticket' }]);
    // Ambient, agent-controlled env var attempting to force a clean pass.
    // NODE_ENV is explicitly NOT 'test' here (simulating CI/build env).
    const result = runCLI(['T1', '--tickets', ticketsPath], {
      cwd: tmpDir,
      extraEnv: {
        NODE_ENV: 'production',
        ANTHROPIC_API_KEY: 'dummy-key-not-real',
        ADLC_GATE_MOCK_RESPONSE: JSON.stringify({ gaps: [] }),
      },
    });

    // The mock's green verdict would be exit 0 with no gaps. The backdoor being
    // closed means we must NOT see that mock pass — the real LLM path is taken
    // and fails closed (no valid key / no network), so exit code is non-zero.
    // Robust to network absence: any outcome except the mock's clean exit-0.
    assert.notEqual(
      result.status,
      0,
      `backdoor must be closed: vague ticket must not pass via mock.\n` +
        `status: ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
    );
    // And it must not have produced the mock's clean [PASS] report.
    assert.ok(
      !(result.status === 0 && result.stdout.includes('[PASS]')),
      `mock backdoor produced a green verdict outside test env.\nstdout: ${result.stdout}`
    );
  });
});

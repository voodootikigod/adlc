// coldstart-offline.test.mjs — tests for deterministic offline coldstart gate.
// node:test, offline, no API keys, temp ticket stores in mkdtemp.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { checkTicketOffline, checkAllOffline } from '../lib/gate.mjs';
import { renderReport, buildJsonOutput, allPass } from '../lib/report.mjs';

const CLI_PATH = new URL('../bin/coldstart.mjs', import.meta.url).pathname;

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'coldstart-offline-'));
}

function cleanTmp(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// ── checkTicketOffline (unit) ────────────────────────────────────────────────

describe('checkTicketOffline (unit)', () => {
  const validTicket = {
    id: 'T1',
    title: 'Valid Ticket',
    body: 'Complete description with detailed requirements and verification criteria.',
    scope: ['src/**/*.js', 'test/**/*.js'],
    rails: ['package.json'],
    edges: [{ to: 'T2', contract: 'src/types/index.d.ts' }],
    duration: 2,
  };

  const allTickets = [
    validTicket,
    { id: 'T2', title: 'Target Ticket', body: 'Target body', scope: ['src/types/**'] },
  ];

  it('passes on a fully specified ticket with no gaps', () => {
    const result = checkTicketOffline(validTicket, allTickets);
    assert.equal(result.id, 'T1');
    assert.deepEqual(result.gaps, []);
    assert.equal(result.usage, null);
    assert.equal(result.cached, false);
    assert.equal(result.offline, true);
  });

  it('detects missing or whitespace-only body', () => {
    const noBody = { ...validTicket, body: '' };
    const result = checkTicketOffline(noBody, allTickets);
    assert.equal(result.gaps.length, 1);
    assert.equal(result.gaps[0].what, 'missing body');

    const whitespaceBody = { ...validTicket, body: '   \n  ' };
    const resWhitespace = checkTicketOffline(whitespaceBody, allTickets);
    assert.equal(resWhitespace.gaps.length, 1);
    assert.equal(resWhitespace.gaps[0].what, 'missing body');
  });

  it('detects missing or empty scope', () => {
    const noScope = { ...validTicket, scope: [] };
    const result = checkTicketOffline(noScope, allTickets);
    assert.equal(result.gaps.length, 1);
    assert.equal(result.gaps[0].what, 'missing scope');

    const invalidScope = { ...validTicket, scope: ['valid/**', '  '] };
    const resInvalid = checkTicketOffline(invalidScope, allTickets);
    assert.equal(resInvalid.gaps.length, 1);
    assert.equal(resInvalid.gaps[0].what, 'invalid scope');
  });

  it('detects invalid rails', () => {
    const invalidRails = { ...validTicket, rails: [''] };
    const result = checkTicketOffline(invalidRails, allTickets);
    assert.equal(result.gaps.length, 1);
    assert.equal(result.gaps[0].what, 'invalid rails');
  });

  it('detects invalid edges and unknown edge targets', () => {
    const unknownTarget = {
      ...validTicket,
      edges: [{ to: 'T999', contract: 'src/types/index.d.ts' }],
    };
    const resUnknown = checkTicketOffline(unknownTarget, allTickets);
    assert.equal(resUnknown.gaps.length, 1);
    assert.equal(resUnknown.gaps[0].what, 'unknown edge target');

    const invalidContract = {
      ...validTicket,
      edges: [{ to: 'T2', contract: '   ' }],
    };
    const resContract = checkTicketOffline(invalidContract, allTickets);
    assert.equal(resContract.gaps.length, 1);
    assert.equal(resContract.gaps[0].what, 'invalid edge contract');
  });

  it('detects invalid duration', () => {
    const badDuration = { ...validTicket, duration: -1 };
    const result = checkTicketOffline(badDuration, allTickets);
    assert.equal(result.gaps.length, 1);
    assert.equal(result.gaps[0].what, 'invalid duration');
  });
});

// ── checkAllOffline (unit) ───────────────────────────────────────────────────

describe('checkAllOffline (unit)', () => {
  it('evaluates multiple tickets and maps results', () => {
    const tickets = [
      { id: 'T1', title: 'Ticket 1', body: 'Body 1', scope: ['src/**'] },
      { id: 'T2', title: 'Ticket 2', body: '', scope: ['src/**'] },
    ];
    const results = checkAllOffline(tickets);
    assert.equal(results.length, 2);
    assert.equal(results[0].gaps.length, 0);
    assert.equal(results[0].offline, true);
    assert.equal(results[1].gaps.length, 1);
    assert.equal(results[1].gaps[0].what, 'missing body');
    assert.equal(allPass(results), false);
  });
});

// ── report rendering with offline marker ─────────────────────────────────────

describe('report rendering with offline marker', () => {
  it('marks offline pass with (offline)', () => {
    const report = renderReport([{ id: 'T1', gaps: [], offline: true }]);
    assert.match(report, /\[PASS\] T1: ticket is fully executable \(offline\)/);
  });

  it('marks offline fail with (offline)', () => {
    const report = renderReport([{
      id: 'T1',
      gaps: [{ what: 'missing body', why_blocking: 'no body' }],
      offline: true,
    }]);
    assert.match(report, /\[FAIL\] T1: 1 gap\(s\) \(offline\)/);
    assert.match(report, /- missing body: no body/);
  });

  it('includes offline boolean in buildJsonOutput', () => {
    const json = buildJsonOutput([{ id: 'T1', gaps: [], offline: true }]);
    assert.equal(json.ok, true);
    assert.equal(json.results[0].offline, true);
  });
});

// ── CLI --offline integration ────────────────────────────────────────────────

describe('CLI --offline e2e', () => {
  let tmpDir;
  let ticketsFile;

  before(() => {
    tmpDir = makeTmp();
    ticketsFile = join(tmpDir, 'tickets.json');
    const store = {
      tickets: [
        {
          id: 'T1',
          title: 'Clean Ticket',
          body: 'Detailed self-contained requirements.',
          scope: ['lib/**/*.js'],
          duration: 1,
        },
        {
          id: 'T2',
          title: 'Ticket with missing body',
          body: '   ',
          scope: ['lib/**/*.js'],
          duration: 1,
        },
      ],
    };
    writeFileSync(ticketsFile, JSON.stringify(store, null, 2));
  });

  after(() => cleanTmp(tmpDir));

  it('passes and exits 0 on valid ticket with --offline without any LLM keys', () => {
    const res = spawnSync(
      process.execPath,
      [CLI_PATH, 'T1', '--tickets', ticketsFile, '--offline'],
      {
        cwd: tmpDir,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      }
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}\nstdout: ${res.stdout}`);
    assert.match(res.stdout, /\[PASS\] T1: ticket is fully executable \(offline\)/);
  });

  it('fails and exits 2 on ticket with gaps using --offline', () => {
    const res = spawnSync(
      process.execPath,
      [CLI_PATH, 'T2', '--tickets', ticketsFile, '--offline'],
      {
        cwd: tmpDir,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      }
    );
    assert.equal(res.status, 2, `expected exit 2, got ${res.status}`);
    assert.match(res.stdout, /\[FAIL\] T2: 1 gap\(s\) \(offline\)/);
    assert.match(res.stdout, /missing body/);
  });

  it('outputs valid JSON with --json --offline', () => {
    const res = spawnSync(
      process.execPath,
      [CLI_PATH, 'T1', '--tickets', ticketsFile, '--offline', '--json'],
      {
        cwd: tmpDir,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      }
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.results[0].id, 'T1');
    assert.equal(parsed.results[0].pass, true);
    assert.equal(parsed.results[0].offline, true);
  });

  it('--all --offline exits 2 if any active ticket has gaps', () => {
    const res = spawnSync(
      process.execPath,
      [CLI_PATH, '--all', '--tickets', ticketsFile, '--offline'],
      {
        cwd: tmpDir,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      }
    );
    assert.equal(res.status, 2);
    assert.match(res.stdout, /\[PASS\] T1/);
    assert.match(res.stdout, /\[FAIL\] T2/);
  });
});

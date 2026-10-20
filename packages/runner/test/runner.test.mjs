import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, appendFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  assertPhase,
  CURRENT_COLDSTART_CAP,
  LEGACY_COLDSTART_CAP,
  serializeTicketForColdstart,
} from '../lib/assertions.mjs';
import { TICKET_TEXT_MAX_CHARS, ticketToText } from '../../coldstart/lib/prompt.mjs';
import { LEGACY_TICKET_TEXT_CAP } from '../../coldstart/lib/cache.mjs';
import { canonicalJson, resolveChangeSetRevision, resolveRevision, sha256 } from '@adlc/core';
import { tmp, gitRepo } from '@adlc/core/test-kit';
import { appendManifestEntry as realAppendManifestEntry } from '@adlc/gate-manifest';
import { recordAcceptancePacket as realRecordAcceptancePacket } from '../lib/acceptance.mjs';

// These tests always ran keyless (no env setup anywhere in the file); the libraries now
// take `key` explicitly (spec Layer 2), so say so once here instead of at 40 call sites.
const appendManifestEntry = (entry, dir, opts = {}) => realAppendManifestEntry(entry, dir, { key: null, ...opts });
const recordAcceptancePacket = (opts = {}) => realRecordAcceptancePacket({ key: null, ...opts });
import { ticketHash as domainTicketHash } from '@adlc/tickets';

const repoRoot = resolve(new URL('../../../', import.meta.url).pathname);

function tmpAdlc(t) {
  const dir = tmp(t, 'adlc-runner-');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeManifest(dir, entries) {
  for (const entry of entries) appendManifestEntry(entry, dir);
}

function ticketHash(ticket) {
  return domainTicketHash(ticket);
}

function ticketDefinition(ticket) {
  return { id: ticket, title: `${ticket} fixture`, scope: ['src/**'], rails: ['test/**'], edges: [] };
}

function writeTicketDefinition(dir, ticket = 'T1') {
  writeFileSync(join(dir, 'tickets.json'), JSON.stringify({ tickets: [ticketDefinition(ticket)] }));
}

function writeP5Evidence(dir, {
  ticket = 'T1',
  revision = resolveRevision(),
  hash,
  transcriptPath = join(dir, `${ticket}-p5-review.txt`),
  dryLenses = ['security', 'correctness', 'tests'],
} = {}) {
  if (hash === undefined) writeTicketDefinition(dir, ticket);
  const ticketHashValue = hash === undefined ? ticketHash(ticketDefinition(ticket)) : hash;
  const transcriptText = [
    `ticket: ${ticket}`,
    `reviewed revision: ${revision}`,
    'review transcript fixture with enough detail to be accepted as evidence',
    'review transcript fixture with enough detail to be accepted as evidence',
  ].join('\n');
  writeFileSync(transcriptPath, transcriptText);
  const transcript = { path: transcriptPath, hash: sha256(readFileSync(transcriptPath)) };
  const evidenceDir = dirname(transcriptPath);
  const promptPath = join(evidenceDir, `${ticket}-p5-prompt.txt`);
  const inputsPath = join(evidenceDir, `${ticket}-p5-inputs.txt`);
  writeFileSync(promptPath, `review prompt for ${ticket} at ${revision}\n`);
  writeFileSync(inputsPath, `reviewed inputs for ${ticket} at ${revision}\n`);
  const reviewPacket = {
    prompt: { path: promptPath, hash: sha256(readFileSync(promptPath)) },
    inputs: { path: inputsPath, hash: sha256(readFileSync(inputsPath)) },
    cleanWorktree: revision,
  };
  const entries = [];
  dryLenses.forEach((lens, index) => {
    const pass = index + 1;
    entries.push({
      type: 'p5-dry-pass',
      ticket,
      revision,
      pass,
      lens,
      consecutiveDry: pass,
    });
    entries.push({
      type: 'p5-pass-completed',
      ticket,
      revision,
      pass,
      lens,
      dry: true,
      verified: 0,
      killed: 0,
      needsHuman: 0,
      consecutiveDry: pass,
    });
  });
  entries.push({
    type: 'p5-complete',
    ticket,
    revision,
    pass: dryLenses.length,
    consecutiveDry: dryLenses.length,
    provenance: {
      reviewer: 'fixture-reviewer',
      command: 'fixture review command',
      transcript: transcriptPath,
    },
    transcript,
    reviewPacket,
    dryLenses,
    ticketHash: ticketHashValue,
  });
  writeManifest(dir, entries);
}

function writeP5Finding(dir, {
  type = 'p5-finding-verified',
  ticket = 'T1',
  revision = resolveRevision(),
  id = 'F1',
  pass = 1,
  lens = 'security',
  file = 'src/auth.mjs',
  claim = 'verified claim',
  evidence = 'verified finding evidence',
} = {}) {
  writeManifest(dir, [{
    type,
    ticket,
    revision,
    pass,
    lens,
    finding: {
      id,
      category: lens,
      severity: 'high',
      file,
      line_start: 1,
      line_end: 1,
      evidence,
      claim,
      recommendation: 'fix it',
      confidence: 0.9,
      verified_status: type === 'p5-finding-killed' ? 'killed' : type.replace('p5-finding-', ''),
    },
  }]);
}

function p4Fixture(t) {
  const cwd = tmp(t, 'adlc-runner-p4-');
  const dir = join(cwd, '.adlc');
  mkdirSync(join(cwd, 'test'), { recursive: true });
  mkdirSync(dir, { recursive: true });
  const railPath = join(cwd, 'test/a.test.mjs');
  writeFileSync(railPath, 'test("rail", () => {});\n');
  writeFileSync(join(cwd, P4_SRC), P4_SRC_CONTENT);
  return { cwd, dir, railPath };
}

// p4-build must hash the files it covers (#759); p4Fixture writes this one.
const P4_SRC = 'src.mjs';
const P4_SRC_CONTENT = 'export const x = 1;\n';
function p4Build(ticket) {
  return { gate: 'p4-build', ticket, files: { [P4_SRC]: sha256(P4_SRC_CONTENT) } };
}

// flail-check is tree-bound like p4-build (#759): same files, `type:` because
// flail-detector.mjs sets that field explicitly.
function flailCheck(ticket) {
  return { type: 'flail-check', ticket, files: { [P4_SRC]: sha256(P4_SRC_CONTENT) } };
}

// p4-build fixtures use `gate:`, not `type:` — the real, documented producer
// (`adlc gate-manifest record p4-build`) only ever sets `gate` (see
// packages/gate-manifest/lib/record.mjs's `record()`), so entryType()'s
// `entry.type ?? entry.gate` fallback is what actually resolves it in
// production. rails-check and flail-check keep `type:` because their real
// producers (rails-guard.mjs, flail-detector.mjs) set that field explicitly.
function writeP4Evidence(dir, content) {
  writeManifest(dir, [
    p4Build('T1'),
    {
      type: 'rails-check',
      ticket: 'T1',
      railsDiffEmpty: true,
      suppressionsClean: true,
      railFiles: { 'test/a.test.mjs': sha256(content) },
    },
    flailCheck('T1'),
  ]);
}

function writeP4EvidenceForTicket(dir, ticket, content) {
  writeManifest(dir, [
    p4Build(ticket),
    {
      type: 'rails-check',
      ticket,
      railsDiffEmpty: true,
      suppressionsClean: true,
      railFiles: { 'test/a.test.mjs': sha256(content) },
    },
    flailCheck(ticket),
  ]);
}

describe('assertPhase', () => {
  it('passes p4 when rails-check rail hashes match current rail files', (t) => {
    const { cwd, dir, railPath } = p4Fixture(t);
    writeP4Evidence(dir, readFileSync(railPath));
    const result = assertPhase('p4', { dir, ticket: 'T1', cwd });
    assert.equal(result.ok, true);
  });

  it('reports exactly the missing marker when only one of the three p4 markers is absent', (t) => {
    const { cwd, dir, railPath } = p4Fixture(t);
    writeManifest(dir, [
      p4Build('T1'),
      {
        type: 'rails-check',
        ticket: 'T1',
        railsDiffEmpty: true,
        suppressionsClean: true,
        railFiles: { 'test/a.test.mjs': sha256(readFileSync(railPath)) },
      },
      // flail-check deliberately omitted
    ]);
    const result = assertPhase('p4', { dir, ticket: 'T1', cwd });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['flail-check']);
  });

  it('reports exactly p4-build missing when only it is absent', (t) => {
    const { cwd, dir, railPath } = p4Fixture(t);
    writeManifest(dir, [
      // p4-build deliberately omitted
      {
        type: 'rails-check',
        ticket: 'T1',
        railsDiffEmpty: true,
        suppressionsClean: true,
        railFiles: { 'test/a.test.mjs': sha256(readFileSync(railPath)) },
      },
      flailCheck('T1'),
    ]);
    const result = assertPhase('p4', { dir, ticket: 'T1', cwd });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['p4-build']);
  });

  it('reports exactly rails-check missing when only it is absent', (t) => {
    const { cwd, dir } = p4Fixture(t);
    writeManifest(dir, [
      p4Build('T1'),
      // rails-check deliberately omitted
      flailCheck('T1'),
    ]);
    const result = assertPhase('p4', { dir, ticket: 'T1', cwd });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['rails-check']);
  });

  it('requires ticket-scoped evidence for p3 and p4', (t) => {
    const { cwd, dir, railPath } = p4Fixture(t);
    writeP4EvidenceForTicket(dir, 'T2', readFileSync(railPath));

    const p3 = assertPhase('p3', { dir, cwd });
    assert.equal(p3.ok, false);
    assert.equal(p3.operational, true);
    assert.match(p3.errors[0], /p3 requires --ticket/);

    const p4 = assertPhase('p4', { dir, cwd });
    assert.equal(p4.ok, false);
    assert.equal(p4.operational, true);
    assert.match(p4.errors[0], /p4 requires --ticket/);

    const t1 = assertPhase('p4', { dir, ticket: 'T1', cwd });
    assert.equal(t1.ok, false);
    assert.deepEqual(t1.missing, ['p4-build', 'rails-check', 'flail-check']);
  });

  it('rejects p4 when rails-check lacks rail file hashes', (t) => {
    const { cwd, dir } = p4Fixture(t);
    writeManifest(dir, [
      p4Build('T1'),
      { type: 'rails-check', ticket: 'T1', railsDiffEmpty: true, suppressionsClean: true },
      flailCheck('T1'),
    ]);
    const result = assertPhase('p4', { dir, ticket: 'T1', cwd });
    assert.equal(result.ok, false);
    assert.equal(result.operational, true);
    assert.ok(result.errors.some((error) => error.includes('missing railFiles hash snapshot')));
  });

  it('rejects p4 when rail files change after rails-check evidence is recorded', (t) => {
    const { cwd, dir, railPath } = p4Fixture(t);
    writeP4Evidence(dir, readFileSync(railPath));
    writeFileSync(railPath, 'test("rail", () => { throw new Error("changed"); });\n');
    const result = assertPhase('p4', { dir, ticket: 'T1', cwd });
    assert.equal(result.ok, false);
    assert.equal(result.operational, true);
    assert.ok(result.errors.some((error) => error.includes('rail file hash changed')));
  });

  it('passes p5 only when p5-complete exists', (t) => {
    const dir = tmpAdlc(t);
    const revision = resolveRevision();
    writeP5Evidence(dir, { revision });
    const result = assertPhase('p5', { dir, ticket: 'T1' });
    assert.equal(result.ok, true);
  });

  it('uses explicit p5 revision as an offline manifest and artifact selector', (t) => {
    const cwd = tmp(t, 'adlc-runner-offline-');
    const dir = join(cwd, '.adlc');
    mkdirSync(dir, { recursive: true });
    writeP5Evidence(dir, { revision: 'fixture-revision' });
    const result = assertPhase('p5', {
      dir,
      ticket: 'T1',
      revision: 'fixture-revision',
      cwd,
    });
    assert.equal(result.ok, true);
    assert.equal(result.revision, 'fixture-revision');
    assert.equal(result.currentRevision, undefined);
  });

  it('rejects a forged bare p5-complete manifest entry', (t) => {
    const dir = tmpAdlc(t);
    const revision = resolveRevision();
    writeTicketDefinition(dir);
    writeManifest(dir, [{
      type: 'p5-complete',
      ticket: 'T1',
      revision,
      ticketHash: ticketHash(ticketDefinition('T1')),
    }]);
    const result = assertPhase('p5', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.equal(result.operational, true);
    assert.ok(result.errors.some((error) => error.includes('missing provenance')));
    assert.ok(result.errors.some((error) => error.includes('missing transcript')));
    assert.ok(result.errors.some((error) => error.includes('missing reviewPacket')));
  });

  it('rejects p5-complete when a verified finding remains unresolved at the same revision', (t) => {
    const dir = tmpAdlc(t);
    const revision = resolveRevision();
    writeP5Finding(dir, { revision, id: 'F1' });
    writeP5Evidence(dir, { revision });
    const result = assertPhase('p5', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.equal(result.operational, true);
    assert.ok(result.errors.some((error) => error.includes('unresolved p5-finding-verified F1')));
  });

  it('accepts p5-complete after a later killed disposition resolves a verified finding', (t) => {
    const dir = tmpAdlc(t);
    const revision = resolveRevision();
    writeP5Finding(dir, { revision, id: 'F1' });
    writeP5Finding(dir, { type: 'p5-finding-killed', revision, id: 'F1' });
    writeP5Evidence(dir, { revision });
    const result = assertPhase('p5', { dir, ticket: 'T1' });
    assert.equal(result.ok, true);
  });

  it('accepts p5-complete when a killed disposition resolves a verified finding from an earlier pass', (t) => {
    const dir = tmpAdlc(t);
    const revision = resolveRevision();
    writeP5Finding(dir, { revision, id: 'F1', pass: 1 });
    writeP5Finding(dir, { type: 'p5-finding-killed', revision, id: 'F1', pass: 2 });
    writeP5Evidence(dir, { revision });
    const result = assertPhase('p5', { dir, ticket: 'T1' });
    assert.equal(result.ok, true);
  });

  it('does not resolve a verified finding with a killed finding that only shares the id', (t) => {
    const dir = tmpAdlc(t);
    const revision = resolveRevision();
    writeP5Finding(dir, { revision, id: 'F1', lens: 'security', file: 'src/auth.mjs', claim: 'auth bypass' });
    writeP5Finding(dir, {
      type: 'p5-finding-killed',
      revision,
      id: 'F1',
      lens: 'docs',
      file: 'docs/auth.md',
      claim: 'stale docs wording',
      evidence: 'different finding evidence',
    });
    writeP5Evidence(dir, { revision });
    const result = assertPhase('p5', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.equal(result.operational, true);
    assert.ok(result.errors.some((error) => error.includes('unresolved p5-finding-verified F1')));
  });

  it('rejects p5-complete when a killed disposition is appended after completion', (t) => {
    const dir = tmpAdlc(t);
    const revision = resolveRevision();
    writeP5Finding(dir, { revision, id: 'F1' });
    writeP5Evidence(dir, { revision });
    writeP5Finding(dir, { type: 'p5-finding-killed', revision, id: 'F1' });
    const result = assertPhase('p5', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.equal(result.operational, true);
    assert.ok(result.errors.some((error) => error.includes('unresolved p5-finding-verified F1')));
  });

  it('fails p6 without p5 evidence and acceptance packet', (t) => {
    const dir = tmpAdlc(t);
    const revision = resolveRevision();
    writeManifest(dir, [{ type: 'p6-acceptance-packet', ticket: 'T1', revision }]);
    const result = assertPhase('p6', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['p5-complete']);
  });

  it('rejects p6 acceptance packets before matching p5 evidence exists', (t) => {
    const dir = tmpAdlc(t);
    writeTicketDefinition(dir);
    const packet = join(dir, 'acceptance.json');
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));
    const result = recordAcceptancePacket({ dir, ticket: 'T1', packet });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes('no p5-complete for ticket T1')));
  });

  it('rejects explicit-revision p6 acceptance before matching p5 evidence exists', (t) => {
    const dir = tmpAdlc(t);
    writeTicketDefinition(dir);
    const packet = join(dir, 'acceptance.json');
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));
    const result = recordAcceptancePacket({ dir, ticket: 'T1', packet, revision: 'fixture-revision' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes('no p5-complete for ticket T1 at fixture-revision')));
  });

  it('passes p6 with revision-scoped p5 evidence and acceptance packet', (t) => {
    const dir = tmpAdlc(t);
    const revision = resolveRevision();
    const packet = join(dir, 'acceptance.json');
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));
    writeP5Evidence(dir, { revision });

    const recorded = recordAcceptancePacket({ dir, ticket: 'T1', packet });
    assert.equal(recorded.ok, true);

    const result = assertPhase('p6', { dir, ticket: 'T1' });
    assert.equal(result.ok, true);
    const manifest = readFileSync(join(dir, 'manifest.jsonl'), 'utf8');
    assert.match(manifest, /"type":"p6-acceptance-packet"/);
    assert.match(manifest, /"packetHash":/);
    assert.match(manifest, /"ticketHash":/);
    assert.match(manifest, /"storeHash":/);
    assert.match(manifest, /"bindingScope":"ticket"/);
  });

  it('uses explicit p6 revision as an offline manifest and artifact selector', (t) => {
    const cwd = tmp(t, 'adlc-runner-offline-');
    const dir = join(cwd, '.adlc');
    mkdirSync(dir, { recursive: true });
    writeP5Evidence(dir, { revision: 'fixture-revision' });
    const packet = join(dir, 'acceptance.json');
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));

    const recorded = recordAcceptancePacket({
      dir,
      ticket: 'T1',
      packet,
      revision: 'fixture-revision',
      cwd,
    });
    assert.equal(recorded.ok, true);
    assert.equal(recorded.revision, 'fixture-revision');

    const result = assertPhase('p6', {
      dir,
      ticket: 'T1',
      revision: 'fixture-revision',
      cwd,
    });
    assert.equal(result.ok, true);
    assert.equal(result.revision, 'fixture-revision');
  });

  it('rejects a forged bare p6 acceptance packet manifest entry', (t) => {
    const dir = tmpAdlc(t);
    const revision = resolveRevision();
    writeP5Evidence(dir, { revision });
    writeManifest(dir, [{ type: 'p6-acceptance-packet', ticket: 'T1', revision }]);

    const result = assertPhase('p6', { dir, ticket: 'T1', revision });
    assert.equal(result.ok, false);
    assert.equal(result.operational, true);
    assert.ok(result.errors.some((error) => error.includes('missing packet path')));
    assert.ok(result.errors.some((error) => error.includes('missing packetHash')));
  });

  it('passes p6 when the acceptance packet is created inside an evidence root after p5', (t) => {
    const repo = gitRepo(t);
    const dir = join(repo.dir, '.adlc');
    const packet = join(dir, 'acceptance.json');
    writeFileSync(join(repo.dir, 'src.txt'), 'reviewed\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'base');
    const revision = resolveRevision({ cwd: repo.dir });
    mkdirSync(dir, { recursive: true });
    writeP5Evidence(dir, { revision });
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));

    const recorded = recordAcceptancePacket({ dir, ticket: 'T1', packet, cwd: repo.dir });
    assert.equal(recorded.ok, true);
    assert.equal(recorded.revision, revision);

    const result = assertPhase('p6', { dir, ticket: 'T1', cwd: repo.dir });
    assert.equal(result.ok, true);
    assert.equal(result.revision, revision);
  });

  it('passes p6 when the documented packet and snapshots are created inside an evidence root after p5', (t) => {
    const repo = gitRepo(t);
    const dir = tmpAdlc(t);
    writeFileSync(join(repo.dir, 'src.txt'), 'reviewed\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'base');
    const revision = resolveRevision({ cwd: repo.dir });
    writeP5Evidence(dir, { revision });
    mkdirSync(join(repo.dir, '.adlc'), { recursive: true });
    writeFileSync(join(repo.dir, '.adlc/before.json'), '{"before":true}\n');
    writeFileSync(join(repo.dir, '.adlc/after.json'), '{"after":true}\n');
    const packet = join(repo.dir, '.adlc/packet.json');
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));

    const recorded = recordAcceptancePacket({
      dir,
      ticket: 'T1',
      packet,
      before: '.adlc/before.json',
      after: '.adlc/after.json',
      cwd: repo.dir,
    });
    assert.equal(recorded.ok, true);
    assert.equal(recorded.revision, revision);

    const result = assertPhase('p6', { dir, ticket: 'T1', cwd: repo.dir });
    assert.equal(result.ok, true);
    assert.equal(result.revision, revision);
  });

  it('rejects in-worktree P6 artifacts outside evidence roots', (t) => {
    const repo = gitRepo(t);
    const dir = tmpAdlc(t);
    writeFileSync(join(repo.dir, 'src.txt'), 'reviewed\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'base');
    const revision = resolveRevision({ cwd: repo.dir });
    writeP5Evidence(dir, { revision });
    writeFileSync(join(repo.dir, 'packet.json'), JSON.stringify({ behaviorDiff: 'accepted' }));

    const recorded = recordAcceptancePacket({
      dir,
      ticket: 'T1',
      packet: 'packet.json',
      before: 'src.txt',
      cwd: repo.dir,
    });
    assert.equal(recorded.ok, false);
    assert.ok(recorded.errors.some((error) => error.includes('packet inside the worktree must live')));
    assert.ok(recorded.errors.some((error) => error.includes('artifact inside the worktree must live')));
  });

  it('stales p6 when recorded acceptance packet or snapshot evidence changes', (t) => {
    const repo = gitRepo(t);
    const dir = tmpAdlc(t);
    writeFileSync(join(repo.dir, 'src.txt'), 'reviewed\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'base');
    const revision = resolveRevision({ cwd: repo.dir });
    writeP5Evidence(dir, { revision });
    mkdirSync(join(repo.dir, '.adlc'), { recursive: true });
    writeFileSync(join(repo.dir, '.adlc/before.json'), '{"before":true}\n');
    writeFileSync(join(repo.dir, '.adlc/after.json'), '{"after":true}\n');
    const packet = join(repo.dir, '.adlc/packet.json');
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));
    const recorded = recordAcceptancePacket({
      dir,
      ticket: 'T1',
      packet,
      before: '.adlc/before.json',
      after: '.adlc/after.json',
      cwd: repo.dir,
    });
    assert.equal(recorded.ok, true);
    assert.equal(assertPhase('p6', { dir, ticket: 'T1', cwd: repo.dir }).ok, true);

    writeFileSync(join(repo.dir, '.adlc/after.json'), '{"after":"tampered"}\n');
    const afterTamper = assertPhase('p6', { dir, ticket: 'T1', cwd: repo.dir });
    assert.equal(afterTamper.ok, false);
    assert.ok(afterTamper.errors.some((error) => error.includes('artifact hash changed')));

    writeFileSync(join(repo.dir, '.adlc/after.json'), '{"after":true}\n');
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'tampered' }));
    const packetTamper = assertPhase('p6', { dir, ticket: 'T1', cwd: repo.dir });
    assert.equal(packetTamper.ok, false);
    assert.ok(packetTamper.errors.some((error) => error.includes('packet hash changed')));
  });

  it('passes p6 with a non-default manifest dir inside the worktree', (t) => {
    const repo = gitRepo(t);
    writeFileSync(join(repo.dir, 'src.txt'), 'reviewed\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'base');
    const dir = join(repo.dir, '.review');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(repo.dir, '.adlc'), { recursive: true });
    const revision = resolveRevision({ cwd: repo.dir });
    writeP5Evidence(dir, { revision, transcriptPath: join(repo.dir, '.adlc/p5-review.txt') });
    const packet = join(repo.dir, '.adlc/packet.json');
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));

    const recorded = recordAcceptancePacket({ dir, ticket: 'T1', packet, cwd: repo.dir });
    assert.equal(recorded.ok, true);

    const result = assertPhase('p6', { dir, ticket: 'T1', cwd: repo.dir });
    assert.equal(result.ok, true);
    assert.equal(result.revision, revision);
  });

  it('binds non-default manifest evidence to the manifest-dir ticket file before root .adlc tickets', (t) => {
    const repo = gitRepo(t);
    writeFileSync(join(repo.dir, 'src.txt'), 'reviewed\n');
    mkdirSync(join(repo.dir, '.adlc'), { recursive: true });
    writeFileSync(join(repo.dir, '.adlc/tickets.json'), JSON.stringify({
      tickets: [{ id: 'T1', title: 'root ticket', scope: ['root/**'], rails: ['root-test/**'], edges: [] }],
    }));
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'base');
    const dir = join(repo.dir, '.review');
    mkdirSync(dir, { recursive: true });
    const activeTicket = { id: 'T1', title: 'active ticket', scope: ['src/**'], rails: ['test/**'], edges: [] };
    writeFileSync(join(dir, 'tickets.json'), JSON.stringify({ tickets: [activeTicket] }));
    mkdirSync(join(repo.dir, '.adlc'), { recursive: true });
    const revision = resolveRevision({ cwd: repo.dir, ignorePaths: [join(dir, 'tickets.json')] });
    writeP5Evidence(dir, {
      revision,
      hash: ticketHash(activeTicket),
      transcriptPath: join(repo.dir, '.adlc/p5-review.txt'),
    });
    const packet = join(repo.dir, '.adlc/packet.json');
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));

    const recorded = recordAcceptancePacket({ dir, ticket: 'T1', packet, cwd: repo.dir });
    assert.equal(recorded.ok, true);
    assert.equal(assertPhase('p6', { dir, ticket: 'T1', cwd: repo.dir }).ok, true);

    writeFileSync(join(dir, 'tickets.json'), JSON.stringify({
      tickets: [{ ...activeTicket, scope: ['changed/**'] }],
    }));
    const staleRecorded = recordAcceptancePacket({ dir, ticket: 'T1', packet, cwd: repo.dir });
    assert.equal(staleRecorded.ok, false);
    assert.ok(staleRecorded.errors.some((error) => error.includes('ticket definition changed')));
    const stalePhase = assertPhase('p6', { dir, ticket: 'T1', cwd: repo.dir });
    assert.equal(stalePhase.ok, false);
    assert.ok(stalePhase.errors.some((error) => error.includes('ticket definition changed')));
  });

  it('passes p6 after a reviewed dirty tree is committed without content changes', (t) => {
    const repo = gitRepo(t);
    const dir = tmpAdlc(t);
    writeFileSync(join(repo.dir, 'src.txt'), 'base\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'base');
    writeFileSync(join(repo.dir, 'src.txt'), 'reviewed change\n');
    writeFileSync(join(repo.dir, 'feature.mjs'), 'export const reviewed = true;\n');
    const revision = resolveRevision({ cwd: repo.dir });
    writeP5Evidence(dir, { revision });
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'reviewed change');
    mkdirSync(join(repo.dir, '.adlc'), { recursive: true });
    const packet = join(repo.dir, '.adlc/packet.json');
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));

    const recorded = recordAcceptancePacket({ dir, ticket: 'T1', packet, cwd: repo.dir });
    assert.equal(recorded.ok, true);
    assert.equal(recorded.revision, revision);

    const result = assertPhase('p6', { dir, ticket: 'T1', cwd: repo.dir });
    assert.equal(result.ok, true);
    assert.equal(result.revision, revision);
  });

  it('does not stale one ticket when an unrelated ticket is added', (t) => {
    const repo = gitRepo(t);
    const dir = tmpAdlc(t);
    const ticket = { id: 'T1', title: 'one', scope: ['src/**'], edges: [] };
    mkdirSync(join(repo.dir, '.adlc'), { recursive: true });
    writeFileSync(join(repo.dir, '.adlc/tickets.json'), JSON.stringify({ tickets: [ticket] }));
    writeFileSync(join(repo.dir, 'src.txt'), 'reviewed\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'base');
    const revision = resolveRevision({ cwd: repo.dir });
    writeP5Evidence(dir, { revision, hash: ticketHash(ticket) });
    writeFileSync(join(repo.dir, '.adlc/tickets.json'), JSON.stringify({
      tickets: [ticket, { id: 'T2', title: 'two', scope: ['other/**'], edges: [] }],
    }));
    const packet = join(repo.dir, '.adlc/packet.json');
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));

    const recorded = recordAcceptancePacket({ dir, ticket: 'T1', packet, cwd: repo.dir });
    assert.equal(recorded.ok, true);
    const result = assertPhase('p6', { dir, ticket: 'T1', cwd: repo.dir });
    assert.equal(result.ok, true);
  });

  it('does not stale p6 when the active ticket definition is key-reordered only', (t) => {
    const repo = gitRepo(t);
    const dir = tmpAdlc(t);
    const ticket = {
      id: 'T1',
      title: 'one',
      scope: ['src/**'],
      edges: [],
      metadata: { priority: 'high', owner: 'codex' },
    };
    mkdirSync(join(repo.dir, '.adlc'), { recursive: true });
    writeFileSync(join(repo.dir, '.adlc/tickets.json'), JSON.stringify({ tickets: [ticket] }));
    writeFileSync(join(repo.dir, 'src.txt'), 'reviewed\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'base');
    const revision = resolveRevision({ cwd: repo.dir });
    writeP5Evidence(dir, { revision, hash: ticketHash(ticket) });
    writeFileSync(join(repo.dir, '.adlc/tickets.json'), JSON.stringify({
      tickets: [{
        metadata: { owner: 'codex', priority: 'high' },
        edges: [],
        scope: ['src/**'],
        title: 'one',
        id: 'T1',
      }],
    }));
    const packet = join(repo.dir, '.adlc/packet.json');
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));

    const recorded = recordAcceptancePacket({ dir, ticket: 'T1', packet, cwd: repo.dir });
    assert.equal(recorded.ok, true);
    const result = assertPhase('p6', { dir, ticket: 'T1', cwd: repo.dir });
    assert.equal(result.ok, true);
  });

  it('stales p6 when the active ticket definition changes after p5', (t) => {
    const repo = gitRepo(t);
    const dir = tmpAdlc(t);
    const ticket = { id: 'T1', title: 'one', scope: ['src/**'], edges: [] };
    mkdirSync(join(repo.dir, '.adlc'), { recursive: true });
    writeFileSync(join(repo.dir, '.adlc/tickets.json'), JSON.stringify({ tickets: [ticket] }));
    writeFileSync(join(repo.dir, 'src.txt'), 'reviewed\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'base');
    const revision = resolveRevision({ cwd: repo.dir });
    writeP5Evidence(dir, { revision, hash: ticketHash(ticket) });
    const packet = join(repo.dir, '.adlc/packet.json');
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));
    const recordedBeforeChange = recordAcceptancePacket({ dir, ticket: 'T1', packet, cwd: repo.dir });
    assert.equal(recordedBeforeChange.ok, true);
    writeFileSync(join(repo.dir, '.adlc/tickets.json'), JSON.stringify({
      tickets: [{ ...ticket, scope: ['changed/**'] }],
    }));

    const recorded = recordAcceptancePacket({ dir, ticket: 'T1', packet, cwd: repo.dir });
    assert.equal(recorded.ok, false);
    assert.ok(recorded.errors.some((error) => error.includes('ticket definition changed')));
    const pinnedRecorded = recordAcceptancePacket({ dir, ticket: 'T1', packet, revision, cwd: repo.dir });
    assert.equal(pinnedRecorded.ok, false);
    assert.ok(pinnedRecorded.errors.some((error) => error.includes('ticket definition changed')));
    const result = assertPhase('p6', { dir, ticket: 'T1', cwd: repo.dir });
    assert.equal(result.ok, false);
    assert.equal(result.operational, true);
    assert.ok(result.errors.some((error) => error.includes('ticket definition changed')));
    const pinned = assertPhase('p6', { dir, ticket: 'T1', revision, cwd: repo.dir });
    assert.equal(pinned.ok, false);
    assert.equal(pinned.operational, true);
    assert.ok(pinned.errors.some((error) => error.includes('ticket definition changed')));
  });

  it('stales p5 and p6 when P5 did not bind a ticket definition that now exists', (t) => {
    const repo = gitRepo(t);
    const dir = tmpAdlc(t);
    const ticket = { id: 'T1', title: 'one', scope: ['src/**'], edges: [] };
    writeFileSync(join(repo.dir, 'src.txt'), 'reviewed\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'base');
    const revision = resolveRevision({ cwd: repo.dir });
    writeP5Evidence(dir, { revision, hash: null });
    mkdirSync(join(repo.dir, '.adlc'), { recursive: true });
    writeFileSync(join(repo.dir, '.adlc/tickets.json'), JSON.stringify({ tickets: [ticket] }));
    const packet = join(repo.dir, '.adlc/packet.json');
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));

    const recorded = recordAcceptancePacket({ dir, ticket: 'T1', packet, cwd: repo.dir });
    assert.equal(recorded.ok, false);
    assert.ok(recorded.errors.some((error) => error.includes('ticket definition was not bound')));
    rmSync(packet, { force: true });
    const p5 = assertPhase('p5', { dir, ticket: 'T1', cwd: repo.dir });
    assert.equal(p5.ok, false);
    assert.equal(p5.operational, true);
    assert.ok(p5.errors.some((error) => error.includes('ticket definition was not bound')));
    const p6 = assertPhase('p6', { dir, ticket: 'T1', cwd: repo.dir });
    assert.equal(p6.ok, false);
    assert.equal(p6.operational, true);
    assert.ok(p6.errors.some((error) => error.includes('ticket definition was not bound')));
  });

  it('stales p6 when recorded P5 transcript evidence changes after prosecution', (t) => {
    const repo = gitRepo(t);
    const dir = tmpAdlc(t);
    writeFileSync(join(repo.dir, '.gitignore'), '.adlc/*\n');
    writeFileSync(join(repo.dir, 'src.txt'), 'reviewed\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'base');
    mkdirSync(join(repo.dir, '.adlc'), { recursive: true });
    const transcript = join(repo.dir, '.adlc/p5-review.txt');
    writeFileSync(transcript, [
      'ticket: T1',
      'reviewed revision: pending',
      'review transcript fixture with enough detail to be accepted as evidence',
    ].join('\n'));
    const revision = resolveRevision({ cwd: repo.dir });
    writeP5Evidence(dir, { revision, transcriptPath: transcript });
    writeManifest(dir, [{ type: 'p6-acceptance-packet', ticket: 'T1', revision }]);
    writeFileSync(transcript, [
      'ticket: T1',
      'reviewed revision: pending',
      'mutated review transcript after P5',
      'review transcript fixture with enough detail to be accepted as evidence',
    ].join('\n'));
    const packet = join(repo.dir, '.adlc/packet.json');
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));

    const recorded = recordAcceptancePacket({ dir, ticket: 'T1', packet, cwd: repo.dir });
    assert.equal(recorded.ok, false);
    assert.ok(recorded.errors.some((error) => error.includes('transcript hash changed')));
    const result = assertPhase('p6', { dir, ticket: 'T1', cwd: repo.dir });
    assert.equal(result.ok, false);
    assert.equal(result.operational, true);
    assert.ok(result.errors.some((error) => error.includes('transcript hash changed')));
    const pinned = assertPhase('p6', { dir, ticket: 'T1', revision, cwd: repo.dir });
    assert.equal(pinned.ok, false);
    assert.equal(pinned.operational, true);
    assert.ok(pinned.errors.some((error) => error.includes('transcript hash changed')));
  });

  it('stales p5 and p6 when recorded P5 reviewed input evidence changes after prosecution', (t) => {
    const repo = gitRepo(t);
    const dir = tmpAdlc(t);
    writeFileSync(join(repo.dir, 'src.txt'), 'base\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'base');
    const revision = resolveRevision({ cwd: repo.dir });
    writeP5Evidence(dir, { revision });
    const complete = readFileSync(join(dir, 'manifest.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((entry) => entry.type === 'p5-complete');
    writeFileSync(complete.reviewPacket.inputs.path, 'tampered reviewed input packet\n');
    const p5 = assertPhase('p5', { dir, ticket: 'T1', cwd: repo.dir });
    assert.equal(p5.ok, false);
    assert.ok(p5.errors.some((error) => error.includes('reviewPacket.inputs hash changed')));
    const packet = join(repo.dir, '.adlc/packet.json');
    mkdirSync(join(repo.dir, '.adlc'), { recursive: true });
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));
    const recorded = recordAcceptancePacket({ dir, ticket: 'T1', packet, cwd: repo.dir });
    assert.equal(recorded.ok, false);
    assert.ok(recorded.errors.some((error) => error.includes('reviewPacket.inputs hash changed')));
  });

  it('allows re-prosecution to supersede an older P5 transcript at the same path', (t) => {
    const repo = gitRepo(t);
    const dir = tmpAdlc(t);
    writeFileSync(join(repo.dir, '.gitignore'), '.adlc/*\n');
    writeFileSync(join(repo.dir, 'src.txt'), 'reviewed A\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'base A');
    mkdirSync(join(repo.dir, '.adlc'), { recursive: true });
    const transcript = join(repo.dir, '.adlc/p5-review.txt');
    writeFileSync(transcript, [
      'ticket: T1',
      'reviewed revision: A',
      'review transcript fixture with enough detail to be accepted as evidence',
    ].join('\n'));
    const revisionA = resolveRevision({ cwd: repo.dir });
    writeP5Evidence(dir, { revision: revisionA, transcriptPath: transcript });

    writeFileSync(join(repo.dir, 'src.txt'), 'reviewed B\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'base B');
    writeFileSync(transcript, [
      'ticket: T1',
      'reviewed revision: B',
      'new review transcript fixture with enough detail to be accepted as evidence',
    ].join('\n'));
    const revisionB = resolveRevision({ cwd: repo.dir });
    writeP5Evidence(dir, { revision: revisionB, transcriptPath: transcript });
    const packet = join(repo.dir, '.adlc/packet.json');
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));

    const recorded = recordAcceptancePacket({ dir, ticket: 'T1', packet, cwd: repo.dir });
    assert.equal(recorded.ok, true);
    assert.equal(recorded.revision, revisionB);
    const result = assertPhase('p6', { dir, ticket: 'T1', cwd: repo.dir });
    assert.equal(result.ok, true);
    assert.equal(result.revision, revisionB);
  });

  it('stales p6 when an older distinct P5 transcript evidence file changes after re-prosecution', (t) => {
    const repo = gitRepo(t);
    const dir = tmpAdlc(t);
    writeFileSync(join(repo.dir, '.gitignore'), '.adlc/*\n');
    writeFileSync(join(repo.dir, 'src.txt'), 'reviewed A\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'base A');
    mkdirSync(join(repo.dir, '.adlc'), { recursive: true });
    const transcriptA = join(repo.dir, '.adlc/p5-review-A.txt');
    const revisionA = resolveRevision({ cwd: repo.dir });
    writeP5Evidence(dir, { revision: revisionA, transcriptPath: transcriptA });

    writeFileSync(join(repo.dir, 'src.txt'), 'reviewed B\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'base B');
    const transcriptB = join(repo.dir, '.adlc/p5-review-B.txt');
    const revisionB = resolveRevision({ cwd: repo.dir });
    writeP5Evidence(dir, { revision: revisionB, transcriptPath: transcriptB });
    const packet = join(repo.dir, '.adlc/packet.json');
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));

    const recorded = recordAcceptancePacket({ dir, ticket: 'T1', packet, cwd: repo.dir });
    assert.equal(recorded.ok, true);
    assert.equal(recorded.revision, revisionB);
    assert.equal(assertPhase('p6', { dir, ticket: 'T1', cwd: repo.dir }).ok, true);

    writeFileSync(transcriptA, 'mutated older transcript after P6 acceptance\n');
    const staleRecorded = recordAcceptancePacket({ dir, ticket: 'T1', packet, cwd: repo.dir });
    assert.equal(staleRecorded.ok, false);
    assert.ok(staleRecorded.errors.some((error) => error.includes('transcript hash changed')));
    const stalePhase = assertPhase('p6', { dir, ticket: 'T1', cwd: repo.dir });
    assert.equal(stalePhase.ok, false);
    assert.equal(stalePhase.operational, true);
    assert.ok(stalePhase.errors.some((error) => error.includes('transcript hash changed')));
  });

  it('does not ignore root after.json unless it is recorded as a p6 artifact', (t) => {
    const repo = gitRepo(t);
    const dir = tmpAdlc(t);
    writeFileSync(join(repo.dir, 'after.json'), '{"reviewed":true}\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'base');
    const revision = resolveRevision({ cwd: repo.dir });
    writeP5Evidence(dir, { revision });
    writeFileSync(join(repo.dir, 'after.json'), '{"reviewed":false}\n');
    mkdirSync(join(repo.dir, '.adlc'), { recursive: true });
    const packet = join(repo.dir, '.adlc/packet.json');
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));

    const recorded = recordAcceptancePacket({ dir, ticket: 'T1', packet, cwd: repo.dir });
    assert.equal(recorded.ok, false);
    assert.ok(recorded.errors.some((error) => error.includes('P5 evidence is stale')));
  });

  it('fails implicit p6 acceptance when tracked source changes after p5', (t) => {
    const repo = gitRepo(t);
    const dir = tmpAdlc(t);
    writeFileSync(join(repo.dir, 'src.txt'), 'reviewed\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'base');
    writeFileSync(join(repo.dir, 'src.txt'), 'reviewed change\n');
    const revision = resolveRevision({ cwd: repo.dir });
    writeP5Evidence(dir, { revision });
    writeFileSync(join(repo.dir, 'src.txt'), 'unreviewed change\n');
    mkdirSync(join(repo.dir, '.adlc'), { recursive: true });
    const packet = join(repo.dir, '.adlc/acceptance.json');
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));

    const recorded = recordAcceptancePacket({ dir, ticket: 'T1', packet, cwd: repo.dir });
    assert.equal(recorded.ok, false);
    assert.ok(recorded.errors.some((error) => error.includes('P5 evidence is stale')));
    const pinnedRecorded = recordAcceptancePacket({ dir, ticket: 'T1', packet, revision, cwd: repo.dir });
    assert.equal(pinnedRecorded.ok, true);

    const result = assertPhase('p6', { dir, ticket: 'T1', cwd: repo.dir });
    assert.equal(result.ok, false);
    assert.equal(result.operational, true);
    assert.ok(result.errors.some((error) => error.includes('P5 evidence is stale')));
    const pinned = assertPhase('p6', { dir, ticket: 'T1', revision, cwd: repo.dir });
    assert.equal(pinned.ok, true);
  });

  it('uses explicit p5 revision as a selector when tracked source changes after p5', (t) => {
    const repo = gitRepo(t);
    const dir = tmpAdlc(t);
    writeFileSync(join(repo.dir, 'src.txt'), 'reviewed\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'base');
    const revision = resolveRevision({ cwd: repo.dir });
    writeP5Evidence(dir, { revision });
    writeFileSync(join(repo.dir, 'src.txt'), 'unreviewed change\n');

    const implicit = assertPhase('p5', { dir, ticket: 'T1', cwd: repo.dir });
    assert.equal(implicit.ok, false);
    assert.equal(implicit.operational, true);
    assert.ok(implicit.errors.some((error) => error.includes('P5 evidence is stale')));

    const pinned = assertPhase('p5', { dir, ticket: 'T1', revision, cwd: repo.dir });
    assert.equal(pinned.ok, true);
    assert.equal(pinned.revision, revision);
  });

  it('fails p6 acceptance when untracked source appears after p5', (t) => {
    const repo = gitRepo(t);
    const dir = tmpAdlc(t);
    writeFileSync(join(repo.dir, 'src.txt'), 'reviewed\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'base');
    const revision = resolveRevision({ cwd: repo.dir });
    writeP5Evidence(dir, { revision });
    writeFileSync(join(repo.dir, 'feature.mjs'), 'export const unreviewed = true;\n');
    mkdirSync(join(repo.dir, '.adlc'), { recursive: true });
    const packet = join(repo.dir, '.adlc/acceptance.json');
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));

    const recorded = recordAcceptancePacket({ dir, ticket: 'T1', packet, cwd: repo.dir });
    assert.equal(recorded.ok, false);
    assert.ok(recorded.errors.some((error) => error.includes('P5 evidence is stale')));
  });

  it('fails p6 when current revision cannot be resolved', (t) => {
    const dir = tmpAdlc(t);
    const cwd = tmp(t, 'adlc-not-git-');
    writeP5Evidence(dir, { revision: 'git-worktree:old' });
    writeManifest(dir, [{ type: 'p6-acceptance-packet', ticket: 'T1', revision: 'git-worktree:old' }]);
    const result = assertPhase('p6', { dir, ticket: 'T1', cwd });
    assert.equal(result.ok, false);
    assert.equal(result.operational, true);
    assert.ok(result.errors.some((error) => error.includes('current worktree revision could not be resolved')));
  });

  it('requires a ticket for p5 and p6', (t) => {
    const dir = tmpAdlc(t);
    const result = assertPhase('p5', { dir });
    assert.equal(result.ok, false);
    assert.equal(result.operational, true);
    assert.match(result.errors[0], /requires --ticket/);
  });

  it('does not accept unmatched explicit revision evidence', (t) => {
    const dir = tmpAdlc(t);
    writeManifest(dir, [{ type: 'p5-complete', ticket: 'T1', revision: 'git-worktree:old' }]);
    const result = assertPhase('p5', { dir, ticket: 'T1', revision: 'git-worktree:new' });
    assert.equal(result.ok, false);
    assert.equal(result.operational, false);
    assert.deepEqual(result.missing, ['p5-complete']);
  });

  it('fails when manifest has malformed lines', (t) => {
    const dir = tmpAdlc(t);
    const revision = resolveRevision();
    appendFileSync(join(dir, 'manifest.jsonl'), '{bad\n');
    const result = assertPhase('p5', { dir, ticket: 'T1', revision });
    assert.equal(result.ok, false);
    assert.equal(result.skipped.length, 1);
  });

  it('succeeds p5, recordAcceptancePacket, and p6 when p5-complete uses matching git-change revision without explicit revision', (t) => {
    const repo = gitRepo(t);
    const dir = join(repo.dir, '.adlc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(repo.dir, 'base.txt'), 'base\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'base');
    const baseSha = repo.g('rev-parse', 'HEAD').trim();

    writeFileSync(join(repo.dir, 'feature.txt'), 'feature content\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'feature');

    const revision = resolveChangeSetRevision({ cwd: repo.dir, base: baseSha });
    assert.match(revision, /^git-change:([0-9a-f]{40}):[0-9a-f]{64}$/);

    writeP5Evidence(dir, { revision });

    // assertPhase p5 succeeds without explicit revision
    const p5Result = assertPhase('p5', { dir, ticket: 'T1', cwd: repo.dir });
    assert.equal(p5Result.ok, true);
    assert.equal(p5Result.revision, revision);

    // recordAcceptancePacket succeeds without explicit revision
    const packet = join(repo.dir, '.adlc/packet.json');
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));
    const recorded = recordAcceptancePacket({ dir, ticket: 'T1', packet, cwd: repo.dir });
    assert.equal(recorded.ok, true);
    assert.equal(recorded.revision, revision);

    // assertPhase p6 succeeds without explicit revision
    const p6Result = assertPhase('p6', { dir, ticket: 'T1', cwd: repo.dir });
    assert.equal(p6Result.ok, true);
    assert.equal(p6Result.revision, revision);
  });

  it('succeeds with external manifest dir when p5-complete uses matching git-change revision', (t) => {
    const repo = gitRepo(t);
    const dir = tmpAdlc(t);
    writeFileSync(join(repo.dir, 'base.txt'), 'base\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'base');
    const baseSha = repo.g('rev-parse', 'HEAD').trim();

    writeFileSync(join(repo.dir, 'feature.txt'), 'feature content\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'feature');

    const revision = resolveChangeSetRevision({ cwd: repo.dir, base: baseSha });
    assert.match(revision, /^git-change:([0-9a-f]{40}):[0-9a-f]{64}$/);

    writeP5Evidence(dir, { revision });

    const p5Result = assertPhase('p5', { dir, ticket: 'T1', cwd: repo.dir });
    assert.equal(p5Result.ok, true);
    assert.equal(p5Result.revision, revision);

    mkdirSync(join(repo.dir, '.adlc'), { recursive: true });
    const packet = join(repo.dir, '.adlc/packet.json');
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));
    const recorded = recordAcceptancePacket({ dir, ticket: 'T1', packet, cwd: repo.dir });
    assert.equal(recorded.ok, true);
    assert.equal(recorded.revision, revision);

    const p6Result = assertPhase('p6', { dir, ticket: 'T1', cwd: repo.dir });
    assert.equal(p6Result.ok, true);
    assert.equal(p6Result.revision, revision);
  });

  it('fails p5, recordAcceptancePacket, and p6 when git-change change-set has drifted', (t) => {
    const repo = gitRepo(t);
    const dir = join(repo.dir, '.adlc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(repo.dir, 'base.txt'), 'base\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'base');
    const baseSha = repo.g('rev-parse', 'HEAD').trim();

    writeFileSync(join(repo.dir, 'feature.txt'), 'feature content\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'feature');

    const revision = resolveChangeSetRevision({ cwd: repo.dir, base: baseSha });
    assert.match(revision, /^git-change:([0-9a-f]{40}):[0-9a-f]{64}$/);

    writeP5Evidence(dir, { revision });
    const packet = join(repo.dir, '.adlc/packet.json');
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));

    // Drift the change-set by modifying feature.txt in working tree
    writeFileSync(join(repo.dir, 'feature.txt'), 'drifted content\n');

    // assertPhase p5 should fail without explicit revision
    const p5Result = assertPhase('p5', { dir, ticket: 'T1', cwd: repo.dir });
    assert.equal(p5Result.ok, false);
    assert.equal(p5Result.operational, true);
    assert.ok(p5Result.errors.some((error) => error.includes('P5 evidence is stale')));

    // Explicit revision still acts as an offline selector
    const pinnedP5 = assertPhase('p5', { dir, ticket: 'T1', revision, cwd: repo.dir });
    assert.equal(pinnedP5.ok, true);
    assert.equal(pinnedP5.revision, revision);

    // recordAcceptancePacket should fail without explicit revision
    const recorded = recordAcceptancePacket({ dir, ticket: 'T1', packet, cwd: repo.dir });
    assert.equal(recorded.ok, false);
    assert.ok(recorded.errors.some((error) => error.includes('P5 evidence is stale')));

    // assertPhase p6 should fail without explicit revision
    const p6Result = assertPhase('p6', { dir, ticket: 'T1', cwd: repo.dir });
    assert.equal(p6Result.ok, false);
    assert.equal(p6Result.operational, true);
    assert.ok(p6Result.errors.some((error) => error.includes('P5 evidence is stale')));
  });
});

describe('adlc cli', () => {
  // The counterpart to the own-chain identity refusal (own-chain-chronology
  // test): a line that genuinely will not parse must still be called
  // malformed, and must name itself — a bare count tells the operator a number
  // and leaves them to find the line.
  it('reports a genuinely malformed manifest line as malformed, and names it', (t) => {
    const dir = tmpAdlc(t);
    const bin = new URL('../bin/adlc.mjs', import.meta.url).pathname;
    appendFileSync(join(dir, 'manifest.jsonl'), '{bad\n');
    const result = spawnSync(process.execPath, [
      bin, 'run', 'p5', '--dir', dir, '--ticket', 'T1', '--revision', 'fixture-revision',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 2, `expected exit 2, got ${result.status}\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /malformed manifest lines: 1/);
    assert.match(result.stderr, /root:1:/);
  });

  // The other real skip shape: a segment FILE the store rejects outright
  // (`{segment, line: null}`). It has no position to name, and naming one
  // anyway ("segment.jsonl:: reason") sends the reader looking for a line.
  it('locates a skip that has no line number by segment alone', (t) => {
    const dir = tmpAdlc(t);
    const bin = new URL('../bin/adlc.mjs', import.meta.url).pathname;
    mkdirSync(join(dir, 'manifest.d'), { recursive: true });
    writeFileSync(join(dir, 'manifest.d', 'not-a-segment.jsonl'), '{"seq":1}\n');
    const result = spawnSync(process.execPath, [
      bin, 'run', 'p5', '--dir', dir, '--ticket', 'T1', '--revision', 'fixture-revision',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 2, `expected exit 2, got ${result.status}\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /not-a-segment\.jsonl: bad filename grammar/);
  });

  it('exits 1 when scoped evidence omits ticket', (t) => {
    const dir = tmpAdlc(t);
    const bin = new URL('../bin/adlc.mjs', import.meta.url).pathname;
    let code = 0;
    try {
      execFileSync(process.execPath, [bin, 'run', 'p5', '--dir', dir], { encoding: 'utf8' });
    } catch (err) {
      code = err.status;
    }
    assert.equal(code, 1);
  });

  it('rejects p6 acceptance without prior p5 evidence', (t) => {
    const dir = tmpAdlc(t);
    writeTicketDefinition(dir);
    const packet = join(dir, 'acceptance.json');
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));
    const bin = new URL('../bin/adlc.mjs', import.meta.url).pathname;
    let code = 0;
    try {
      execFileSync(process.execPath, [
        bin,
        'accept',
        '--ticket',
        'T1',
        '--packet',
        packet,
        '--dir',
        dir,
        '--json',
      ], { encoding: 'utf8' });
    } catch (err) {
      code = err.status;
      assert.match(err.stdout, /no p5-complete for ticket T1/);
    }
    assert.equal(code, 1);
  });

  it('adlc run p4 exits 0 once real rails-guard, flail-detector, and gate-manifest recordings all land for a ticket', (t) => {
    const { dir: cwd, g } = gitRepo(t);
    const adlcDir = join(cwd, '.adlc');
    mkdirSync(join(cwd, 'test'), { recursive: true });
    writeFileSync(join(cwd, 'test/a.test.mjs'), 'test("rail", () => {});\n');
    writeFileSync(join(cwd, 'src.mjs'), 'export const x = 1;\n');
    mkdirSync(adlcDir, { recursive: true });
    writeFileSync(join(adlcDir, 'tickets.json'), JSON.stringify({
      tickets: [{ id: 'T1', title: 'T1 fixture', scope: ['src.mjs'], rails: ['test/**'], edges: [] }],
    }));
    g('add', '-A');
    g('commit', '-q', '-m', 'initial');
    const base = g('rev-parse', 'HEAD').trim();
    writeFileSync(join(cwd, 'src.mjs'), 'export const x = 2;\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'non-rail change');

    const railsGuardBin = join(repoRoot, 'packages/rails-guard/bin/rails-guard.mjs');
    const railsResult = spawnSync(process.execPath, [
      railsGuardBin, '--ticket', 'T1', '--tickets', join(adlcDir, 'tickets.json'), '--base', base, '--record',
    ], { cwd, encoding: 'utf8' });
    assert.equal(railsResult.status, 0, `rails-guard --record failed: ${railsResult.stderr}`);

    const logFile = join(cwd, 'session.log');
    writeFileSync(logFile, 'Build started\nDone in 2.3s\nAll tests passed.\n');
    const flailBin = join(repoRoot, 'packages/flail-detector/bin/flail-detector.mjs');
    const flailResult = spawnSync(process.execPath, [
      flailBin, logFile, '--record', '--ticket', 'T1', '--files', 'src.mjs',
    ], { cwd, encoding: 'utf8' });
    assert.equal(flailResult.status, 0, `flail-detector --record failed: ${flailResult.stderr}`);

    const gateManifestBin = join(repoRoot, 'packages/gate-manifest/bin/gate-manifest.mjs');
    const p4BuildResult = spawnSync(process.execPath, [
      gateManifestBin, 'record', 'p4-build', '--ticket', 'T1', '--files', 'src.mjs',
    ], { cwd, encoding: 'utf8' });
    assert.equal(p4BuildResult.status, 0, `gate-manifest record p4-build failed: ${p4BuildResult.stderr}`);

    const adlcBin = new URL('../bin/adlc.mjs', import.meta.url).pathname;
    const runResult = spawnSync(process.execPath, [
      adlcBin, 'run', 'p4', '--ticket', 'T1',
    ], { cwd, encoding: 'utf8' });
    assert.equal(runResult.status, 0, `adlc run p4 failed: ${runResult.stdout}${runResult.stderr}`);
  });
});

describe('coldstart truncation completeness (#1197)', () => {
  it('matches @adlc/coldstart constants and ticketToText serialization across optional fields', () => {
    assert.equal(LEGACY_COLDSTART_CAP, 8000);
    assert.equal(LEGACY_COLDSTART_CAP, LEGACY_TICKET_TEXT_CAP);
    assert.equal(CURRENT_COLDSTART_CAP, 64000);
    assert.equal(CURRENT_COLDSTART_CAP, TICKET_TEXT_MAX_CHARS);

    const samples = [
      { id: 'T1', title: 'minimal' },
      { id: 'T2', title: 'empty arrays', body: '', scope: [], rails: [], edges: [] },
      {
        id: 'T3',
        title: 'populated fields',
        body: 'Detailed specification body',
        scope: ['packages/runner/lib/assertions.mjs'],
        rails: ['packages/runner/test/p0-p1-gates.test.mjs'],
        edges: ['T1'],
      },
    ];
    for (const sample of samples) {
      assert.equal(serializeTicketForColdstart(sample), ticketToText(sample));
    }
  });

  it('rejects live coldstart evidence when recorded textChars exceeds recorded cap', (t) => {
    const dir = tmpAdlc(t);
    const ticket = ticketDefinition('T1');
    writeFileSync(join(dir, 'tickets.json'), JSON.stringify({ tickets: [ticket] }));
    const hash = ticketHash(ticket);
    writeManifest(dir, [{
      gate: 'coldstart',
      ticket: 'T1',
      data: {
        tier: 'cheap',
        cache: { ticketHash: hash, model: 'm', gaps: [], textChars: 14296, cap: 8000 },
      },
    }]);

    const res = assertPhase('p0', { dir, ticket: 'T1' });
    assert.equal(res.ok, false);
    assert.equal(res.operational, false);
    assert.ok(res.errors.includes('P0 evidence is incomplete: coldstart audited the first 8000 of 14296 chars'));
  });

  it('enforces exact positive-cap and non-negative-textChars boundaries on live cache records', (t) => {
    const dir = tmpAdlc(t);
    const ticket = ticketDefinition('T1');
    writeFileSync(join(dir, 'tickets.json'), JSON.stringify({ tickets: [ticket] }));
    const hash = ticketHash(ticket);

    // cap: 1 is a valid positive integer cap, so textChars: 2 fails truncation (not invalid cap).
    writeManifest(dir, [{
      gate: 'coldstart',
      ticket: 'T1',
      data: {
        tier: 'cheap',
        cache: { ticketHash: hash, model: 'm', gaps: [], textChars: 2, cap: 1 },
      },
    }]);
    const capOneRes = assertPhase('p0', { dir, ticket: 'T1' });
    assert.equal(capOneRes.ok, false);
    assert.ok(capOneRes.errors.includes('P0 evidence is incomplete: coldstart audited the first 1 of 2 chars'));

    // textChars: 0 is a valid non-negative integer and passes when actualChars <= cap.
    writeManifest(dir, [{
      gate: 'coldstart',
      ticket: 'T1',
      data: {
        tier: 'cheap',
        cache: { ticketHash: hash, model: 'm', gaps: [], textChars: 0, cap: 8000 },
      },
    }]);
    const zeroTextRes = assertPhase('p0', { dir, ticket: 'T1' });
    assert.equal(zeroTextRes.ok, true, JSON.stringify(zeroTextRes));
  });

  it('rejects legacy live coldstart evidence (no cap/textChars) when serialized ticket exceeds 8000 chars and accepts <= 8000', (t) => {
    const dir = tmpAdlc(t);
    const baseTicket = { id: 'T1', title: 'legacy cap check', body: '' };
    const baseLen = serializeTicketForColdstart({ ...baseTicket, body: 'x' }).length - 1;
    const exactFitTicket = { ...baseTicket, body: 'a'.repeat(8000 - baseLen) };
    assert.equal(serializeTicketForColdstart(exactFitTicket).length, 8000);

    writeFileSync(join(dir, 'tickets.json'), JSON.stringify({ tickets: [exactFitTicket] }));
    const fitHash = ticketHash(exactFitTicket);
    writeManifest(dir, [{
      gate: 'coldstart',
      ticket: 'T1',
      data: { tier: 'cheap', cache: { ticketHash: fitHash, model: 'm', gaps: [] } },
    }]);
    assert.equal(assertPhase('p0', { dir, ticket: 'T1' }).ok, true);

    const overTicket = { ...baseTicket, body: 'a'.repeat(8001 - baseLen) };
    assert.equal(serializeTicketForColdstart(overTicket).length, 8001);
    writeFileSync(join(dir, 'tickets.json'), JSON.stringify({ tickets: [overTicket] }));
    const overHash = ticketHash(overTicket);
    writeManifest(dir, [{
      gate: 'coldstart',
      ticket: 'T1',
      data: { tier: 'cheap', cache: { ticketHash: overHash, model: 'm', gaps: [] } },
    }]);
    const overRes = assertPhase('p0', { dir, ticket: 'T1' });
    assert.equal(overRes.ok, false);
    assert.ok(overRes.errors.includes('P0 evidence is incomplete: coldstart audited the first 8000 of 8001 chars'));
  });

  it('accepts live coldstart evidence with cap 64000 and textChars 20000 when ticket fits under cap', (t) => {
    const dir = tmpAdlc(t);
    const ticket = { ...ticketDefinition('T1'), body: 'b'.repeat(19000) };
    const chars = serializeTicketForColdstart(ticket).length;
    writeFileSync(join(dir, 'tickets.json'), JSON.stringify({ tickets: [ticket] }));
    const hash = ticketHash(ticket);
    writeManifest(dir, [{
      gate: 'coldstart',
      ticket: 'T1',
      data: {
        tier: 'cheap',
        cache: { ticketHash: hash, model: 'm', gaps: [], textChars: chars, cap: 64000 },
      },
    }]);
    const res = assertPhase('p0', { dir, ticket: 'T1' });
    assert.equal(res.ok, true, JSON.stringify(res));
  });

  it('rejects live coldstart evidence when recorded textChars is <= cap but actual ticket length exceeds cap', (t) => {
    const dir = tmpAdlc(t);
    const ticket = { ...ticketDefinition('T1'), body: 'c'.repeat(9000) };
    const actualChars = serializeTicketForColdstart(ticket).length;
    writeFileSync(join(dir, 'tickets.json'), JSON.stringify({ tickets: [ticket] }));
    const hash = ticketHash(ticket);
    writeManifest(dir, [{
      gate: 'coldstart',
      ticket: 'T1',
      data: {
        tier: 'cheap',
        cache: { ticketHash: hash, model: 'm', gaps: [], textChars: 100, cap: 8000 },
      },
    }]);
    const res = assertPhase('p0', { dir, ticket: 'T1' });
    assert.equal(res.ok, false);
    assert.ok(res.errors.includes(`P0 evidence is incomplete: coldstart audited the first 8000 of ${actualChars} chars`));
  });

  it('rejects live coldstart evidence with malformed cap or textChars values', (t) => {
    const dir = tmpAdlc(t);
    const ticket = ticketDefinition('T1');
    writeFileSync(join(dir, 'tickets.json'), JSON.stringify({ tickets: [ticket] }));
    const hash = ticketHash(ticket);

    for (const badCap of [0, -1, '8000', null, 1.5]) {
      writeManifest(dir, [{
        gate: 'coldstart',
        ticket: 'T1',
        data: {
          tier: 'cheap',
          cache: { ticketHash: hash, model: 'm', gaps: [], textChars: 100, cap: badCap },
        },
      }]);
      const res = assertPhase('p0', { dir, ticket: 'T1' });
      assert.equal(res.ok, false, `expected failure for cap=${String(badCap)}`);
      assert.ok(res.errors.includes('P0 evidence is incomplete: coldstart cache record has an invalid cap'));
    }

    for (const badTextChars of [-1, '100', null, 1.5]) {
      writeManifest(dir, [{
        gate: 'coldstart',
        ticket: 'T1',
        data: {
          tier: 'cheap',
          cache: { ticketHash: hash, model: 'm', gaps: [], textChars: badTextChars, cap: 8000 },
        },
      }]);
      const res = assertPhase('p0', { dir, ticket: 'T1' });
      assert.equal(res.ok, false, `expected failure for textChars=${String(badTextChars)}`);
      assert.ok(res.errors.includes('P0 evidence is incomplete: coldstart cache record has an invalid textChars'));
    }
  });

  it('rejects prompt-only coldstart evidence when ticket exceeds 64000 chars and accepts <= 64000 chars', (t) => {
    const dir = tmpAdlc(t);
    const baseTicket = { id: 'T1', title: 'prompt-only cap check', body: '' };
    const baseLen = serializeTicketForColdstart({ ...baseTicket, body: 'x' }).length - 1;
    const exactFitTicket = { ...baseTicket, body: 'p'.repeat(64000 - baseLen) };
    assert.equal(serializeTicketForColdstart(exactFitTicket).length, 64000);

    writeFileSync(join(dir, 'tickets.json'), JSON.stringify({ tickets: [exactFitTicket] }));
    const fitHash = ticketHash(exactFitTicket);
    writeManifest(dir, [{
      gate: 'coldstart',
      ticket: 'T1',
      data: { verdict: JSON.stringify({ gaps: [], ticketHash: fitHash }) },
    }]);
    assert.equal(assertPhase('p0', { dir, ticket: 'T1' }).ok, true);

    const overTicket = { ...baseTicket, body: 'p'.repeat(64001 - baseLen) };
    assert.equal(serializeTicketForColdstart(overTicket).length, 64001);
    writeFileSync(join(dir, 'tickets.json'), JSON.stringify({ tickets: [overTicket] }));
    const overHash = ticketHash(overTicket);
    writeManifest(dir, [{
      gate: 'coldstart',
      ticket: 'T1',
      data: { verdict: JSON.stringify({ gaps: [], ticketHash: overHash }) },
    }]);
    const overRes = assertPhase('p0', { dir, ticket: 'T1' });
    assert.equal(overRes.ok, false);
    assert.ok(overRes.errors.includes('P0 evidence is incomplete: coldstart audited the first 64000 of 64001 chars'));
  });
});

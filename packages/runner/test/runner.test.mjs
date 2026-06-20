import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, appendFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { assertPhase } from '../lib/assertions.mjs';
import { canonicalJson, resolveRevision, sha256 } from '@adlc/core';
import { recordAcceptancePacket } from '../lib/acceptance.mjs';

const repoRoot = resolve(new URL('../../../', import.meta.url).pathname);

function tmpAdlc() {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-runner-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeManifest(dir, entries) {
  for (const entry of entries) appendFileSync(join(dir, 'manifest.jsonl'), JSON.stringify(entry) + '\n');
}

function ticketHash(ticket) {
  return sha256(canonicalJson(ticket));
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

function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-runner-git-'));
  const g = (...args) => execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t.co');
  g('config', 'user.name', 'tester');
  g('config', 'commit.gpgsign', 'false');
  return { dir, g };
}

function p4Fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'adlc-runner-p4-'));
  const dir = join(cwd, '.adlc');
  mkdirSync(join(cwd, 'test'), { recursive: true });
  mkdirSync(dir, { recursive: true });
  const railPath = join(cwd, 'test/a.test.mjs');
  writeFileSync(railPath, 'test("rail", () => {});\n');
  return { cwd, dir, railPath };
}

function writeP4Evidence(dir, content) {
  writeManifest(dir, [
    { type: 'rails-green', ticket: 'T1' },
    {
      type: 'rails-check',
      ticket: 'T1',
      railsDiffEmpty: true,
      suppressionsClean: true,
      railFiles: { 'test/a.test.mjs': sha256(content) },
    },
    { type: 'flail-check', ticket: 'T1' },
  ]);
}

function writeP4EvidenceForTicket(dir, ticket, content) {
  writeManifest(dir, [
    { type: 'rails-green', ticket },
    {
      type: 'rails-check',
      ticket,
      railsDiffEmpty: true,
      suppressionsClean: true,
      railFiles: { 'test/a.test.mjs': sha256(content) },
    },
    { type: 'flail-check', ticket },
  ]);
}

describe('assertPhase', () => {
  it('passes p4 when rails-check rail hashes match current rail files', () => {
    const { cwd, dir, railPath } = p4Fixture();
    try {
      writeP4Evidence(dir, readFileSync(railPath));
      const result = assertPhase('p4', { dir, ticket: 'T1', cwd });
      assert.equal(result.ok, true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('requires ticket-scoped evidence for p3 and p4', () => {
    const { cwd, dir, railPath } = p4Fixture();
    try {
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
      assert.deepEqual(t1.missing, ['rails-green', 'rails-check', 'flail-check']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects p4 when rails-check lacks rail file hashes', () => {
    const { cwd, dir } = p4Fixture();
    try {
      writeManifest(dir, [
        { type: 'rails-green', ticket: 'T1' },
        { type: 'rails-check', ticket: 'T1', railsDiffEmpty: true, suppressionsClean: true },
        { type: 'flail-check', ticket: 'T1' },
      ]);
      const result = assertPhase('p4', { dir, ticket: 'T1', cwd });
      assert.equal(result.ok, false);
      assert.equal(result.operational, true);
      assert.ok(result.errors.some((error) => error.includes('missing railFiles hash snapshot')));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects p4 when rail files change after rails-check evidence is recorded', () => {
    const { cwd, dir, railPath } = p4Fixture();
    try {
      writeP4Evidence(dir, readFileSync(railPath));
      writeFileSync(railPath, 'test("rail", () => { throw new Error("changed"); });\n');
      const result = assertPhase('p4', { dir, ticket: 'T1', cwd });
      assert.equal(result.ok, false);
      assert.equal(result.operational, true);
      assert.ok(result.errors.some((error) => error.includes('rail file hash changed')));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('passes p5 only when p5-complete exists', () => {
    const dir = tmpAdlc();
    const revision = resolveRevision();
    writeP5Evidence(dir, { revision });
    const result = assertPhase('p5', { dir, ticket: 'T1' });
    assert.equal(result.ok, true);
  });

  it('uses explicit p5 revision as an offline manifest and artifact selector', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'adlc-runner-offline-'));
    const dir = join(cwd, '.adlc');
    try {
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
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects a forged bare p5-complete manifest entry', () => {
    const dir = tmpAdlc();
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

  it('rejects p5-complete when a verified finding remains unresolved at the same revision', () => {
    const dir = tmpAdlc();
    const revision = resolveRevision();
    writeP5Finding(dir, { revision, id: 'F1' });
    writeP5Evidence(dir, { revision });
    const result = assertPhase('p5', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.equal(result.operational, true);
    assert.ok(result.errors.some((error) => error.includes('unresolved p5-finding-verified F1')));
  });

  it('accepts p5-complete after a later killed disposition resolves a verified finding', () => {
    const dir = tmpAdlc();
    const revision = resolveRevision();
    writeP5Finding(dir, { revision, id: 'F1' });
    writeP5Finding(dir, { type: 'p5-finding-killed', revision, id: 'F1' });
    writeP5Evidence(dir, { revision });
    const result = assertPhase('p5', { dir, ticket: 'T1' });
    assert.equal(result.ok, true);
  });

  it('accepts p5-complete when a killed disposition resolves a verified finding from an earlier pass', () => {
    const dir = tmpAdlc();
    const revision = resolveRevision();
    writeP5Finding(dir, { revision, id: 'F1', pass: 1 });
    writeP5Finding(dir, { type: 'p5-finding-killed', revision, id: 'F1', pass: 2 });
    writeP5Evidence(dir, { revision });
    const result = assertPhase('p5', { dir, ticket: 'T1' });
    assert.equal(result.ok, true);
  });

  it('does not resolve a verified finding with a killed finding that only shares the id', () => {
    const dir = tmpAdlc();
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

  it('rejects p5-complete when a killed disposition is appended after completion', () => {
    const dir = tmpAdlc();
    const revision = resolveRevision();
    writeP5Finding(dir, { revision, id: 'F1' });
    writeP5Evidence(dir, { revision });
    writeP5Finding(dir, { type: 'p5-finding-killed', revision, id: 'F1' });
    const result = assertPhase('p5', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.equal(result.operational, true);
    assert.ok(result.errors.some((error) => error.includes('unresolved p5-finding-verified F1')));
  });

  it('fails p6 without p5 evidence and acceptance packet', () => {
    const dir = tmpAdlc();
    const revision = resolveRevision();
    writeManifest(dir, [{ type: 'p6-acceptance-packet', ticket: 'T1', revision }]);
    const result = assertPhase('p6', { dir, ticket: 'T1' });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['p5-complete']);
  });

  it('rejects p6 acceptance packets before matching p5 evidence exists', () => {
    const dir = tmpAdlc();
    writeTicketDefinition(dir);
    const packet = join(dir, 'acceptance.json');
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));
    const result = recordAcceptancePacket({ dir, ticket: 'T1', packet });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes('no p5-complete for ticket T1')));
  });

  it('rejects explicit-revision p6 acceptance before matching p5 evidence exists', () => {
    const dir = tmpAdlc();
    writeTicketDefinition(dir);
    const packet = join(dir, 'acceptance.json');
    writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));
    const result = recordAcceptancePacket({ dir, ticket: 'T1', packet, revision: 'fixture-revision' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes('no p5-complete for ticket T1 at fixture-revision')));
  });

  it('passes p6 with revision-scoped p5 evidence and acceptance packet', () => {
    const dir = tmpAdlc();
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
  });

  it('uses explicit p6 revision as an offline manifest and artifact selector', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'adlc-runner-offline-'));
    const dir = join(cwd, '.adlc');
    try {
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
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects a forged bare p6 acceptance packet manifest entry', () => {
    const dir = tmpAdlc();
    const revision = resolveRevision();
    writeP5Evidence(dir, { revision });
    writeManifest(dir, [{ type: 'p6-acceptance-packet', ticket: 'T1', revision }]);

    const result = assertPhase('p6', { dir, ticket: 'T1', revision });
    assert.equal(result.ok, false);
    assert.equal(result.operational, true);
    assert.ok(result.errors.some((error) => error.includes('missing packet path')));
    assert.ok(result.errors.some((error) => error.includes('missing packetHash')));
  });

  it('passes p6 when the acceptance packet is created inside an evidence root after p5', () => {
    const dir = tmpAdlc();
    const revision = resolveRevision();
    const packet = join(repoRoot, '.adlc/acceptance.json');
    try {
      mkdirSync(join(repoRoot, '.adlc'), { recursive: true });
      writeP5Evidence(dir, { revision });
      writeFileSync(packet, JSON.stringify({ behaviorDiff: 'accepted' }));

      const recorded = recordAcceptancePacket({ dir, ticket: 'T1', packet });
      assert.equal(recorded.ok, true);
      assert.equal(recorded.revision, revision);

      const result = assertPhase('p6', { dir, ticket: 'T1' });
      assert.equal(result.ok, true);
      assert.equal(result.revision, revision);
    } finally {
      rmSync(packet, { force: true });
    }
  });

  it('passes p6 when the documented packet and snapshots are created inside an evidence root after p5', () => {
    const repo = gitRepo();
    const dir = tmpAdlc();
    try {
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
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('rejects in-worktree P6 artifacts outside evidence roots', () => {
    const repo = gitRepo();
    const dir = tmpAdlc();
    try {
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
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('stales p6 when recorded acceptance packet or snapshot evidence changes', () => {
    const repo = gitRepo();
    const dir = tmpAdlc();
    try {
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
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('passes p6 with a non-default manifest dir inside the worktree', () => {
    const repo = gitRepo();
    try {
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
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('binds non-default manifest evidence to the manifest-dir ticket file before root .adlc tickets', () => {
    const repo = gitRepo();
    try {
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
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('passes p6 after a reviewed dirty tree is committed without content changes', () => {
    const repo = gitRepo();
    const dir = tmpAdlc();
    try {
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
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('does not stale one ticket when an unrelated ticket is added', () => {
    const repo = gitRepo();
    const dir = tmpAdlc();
    try {
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
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('does not stale p6 when the active ticket definition is key-reordered only', () => {
    const repo = gitRepo();
    const dir = tmpAdlc();
    try {
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
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('stales p6 when the active ticket definition changes after p5', () => {
    const repo = gitRepo();
    const dir = tmpAdlc();
    try {
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
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('stales p5 and p6 when P5 did not bind a ticket definition that now exists', () => {
    const repo = gitRepo();
    const dir = tmpAdlc();
    try {
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
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('stales p6 when recorded P5 transcript evidence changes after prosecution', () => {
    const repo = gitRepo();
    const dir = tmpAdlc();
    try {
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
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('stales p5 and p6 when recorded P5 reviewed input evidence changes after prosecution', () => {
    const repo = gitRepo();
    const dir = tmpAdlc();
    try {
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
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows re-prosecution to supersede an older P5 transcript at the same path', () => {
    const repo = gitRepo();
    const dir = tmpAdlc();
    try {
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
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('stales p6 when an older distinct P5 transcript evidence file changes after re-prosecution', () => {
    const repo = gitRepo();
    const dir = tmpAdlc();
    try {
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
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('does not ignore root after.json unless it is recorded as a p6 artifact', () => {
    const repo = gitRepo();
    const dir = tmpAdlc();
    try {
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
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('fails implicit p6 acceptance when tracked source changes after p5', () => {
    const repo = gitRepo();
    const dir = tmpAdlc();
    try {
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
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('uses explicit p5 revision as a selector when tracked source changes after p5', () => {
    const repo = gitRepo();
    const dir = tmpAdlc();
    try {
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
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('fails p6 acceptance when untracked source appears after p5', () => {
    const repo = gitRepo();
    const dir = tmpAdlc();
    try {
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
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('fails p6 when current revision cannot be resolved', () => {
    const dir = tmpAdlc();
    const cwd = mkdtempSync(join(tmpdir(), 'adlc-not-git-'));
    try {
      writeP5Evidence(dir, { revision: 'git-worktree:old' });
      writeManifest(dir, [{ type: 'p6-acceptance-packet', ticket: 'T1', revision: 'git-worktree:old' }]);
      const result = assertPhase('p6', { dir, ticket: 'T1', cwd });
      assert.equal(result.ok, false);
      assert.equal(result.operational, true);
      assert.ok(result.errors.some((error) => error.includes('current worktree revision could not be resolved')));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('requires a ticket for p5 and p6', () => {
    const dir = tmpAdlc();
    const result = assertPhase('p5', { dir });
    assert.equal(result.ok, false);
    assert.equal(result.operational, true);
    assert.match(result.errors[0], /requires --ticket/);
  });

  it('does not accept unmatched explicit revision evidence', () => {
    const dir = tmpAdlc();
    writeManifest(dir, [{ type: 'p5-complete', ticket: 'T1', revision: 'git-worktree:old' }]);
    const result = assertPhase('p5', { dir, ticket: 'T1', revision: 'git-worktree:new' });
    assert.equal(result.ok, false);
    assert.equal(result.operational, false);
    assert.deepEqual(result.missing, ['p5-complete']);
  });

  it('fails when manifest has malformed lines', () => {
    const dir = tmpAdlc();
    const revision = resolveRevision();
    appendFileSync(join(dir, 'manifest.jsonl'), '{bad\n');
    const result = assertPhase('p5', { dir, ticket: 'T1', revision });
    assert.equal(result.ok, false);
    assert.equal(result.skipped.length, 1);
  });
});

describe('adlc cli', () => {
  it('exits 1 when scoped evidence omits ticket', () => {
    const dir = tmpAdlc();
    const bin = new URL('../bin/adlc.mjs', import.meta.url).pathname;
    let code = 0;
    try {
      execFileSync(process.execPath, [bin, 'run', 'p5', '--dir', dir], { encoding: 'utf8' });
    } catch (err) {
      code = err.status;
    }
    assert.equal(code, 1);
  });

  it('rejects p6 acceptance without prior p5 evidence', () => {
    const dir = tmpAdlc();
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
});

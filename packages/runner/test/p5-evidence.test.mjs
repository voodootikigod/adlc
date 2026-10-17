import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveRevision, sha256 } from '@adlc/core';
import { tmp, gitRepo } from '@adlc/core/test-kit';
import { ticketHash as domainTicketHash } from '@adlc/tickets';
import {
  entryType,
  matchesTicket,
  matchesRevision,
  latestP5Entry,
  latestP5Revision,
  isEvidencePath,
  p5TranscriptPaths,
  p5ReviewPacketPaths,
  transcriptIntegrityErrors,
  p5ArtifactIntegrityError,
  reviewPacketIntegrityErrors,
  historicalTranscriptIntegrityErrors,
  ticketDefinitionBinding,
  staleTicketDefinitionError,
  manifestArtifactPaths,
  resolveLiveP5WorktreeRevision,
} from '../lib/p5-evidence.mjs';

describe('entryType', () => {
  it('returns entry.type if present', () => {
    assert.equal(entryType({ type: 'p5-complete', gate: 'p5' }), 'p5-complete');
  });

  it('falls back to entry.gate if entry.type is undefined or null', () => {
    assert.equal(entryType({ gate: 'p4-build' }), 'p4-build');
    assert.equal(entryType({ type: null, gate: 'p4-build' }), 'p4-build');
  });

  it('returns undefined if entry is null or undefined or lacks both properties', () => {
    assert.equal(entryType(null), undefined);
    assert.equal(entryType(undefined), undefined);
    assert.equal(entryType({}), undefined);
  });
});

describe('matchesTicket', () => {
  it('returns true when ticket is undefined', () => {
    assert.equal(matchesTicket({ ticket: 'T1' }, undefined), true);
    assert.equal(matchesTicket({}, undefined), true);
    assert.equal(matchesTicket(null, undefined), true);
  });

  it('returns true when entry.ticket matches ticket exactly', () => {
    assert.equal(matchesTicket({ ticket: 'T1' }, 'T1'), true);
  });

  it('returns false when entry.ticket differs or entry is null', () => {
    assert.equal(matchesTicket({ ticket: 'T1' }, 'T2'), false);
    assert.equal(matchesTicket({}, 'T1'), false);
    assert.equal(matchesTicket(null, 'T1'), false);
  });
});

describe('matchesRevision', () => {
  it('returns true when revision is undefined', () => {
    assert.equal(matchesRevision({ revision: 'r1' }, undefined), true);
    assert.equal(matchesRevision({}, undefined), true);
    assert.equal(matchesRevision(null, undefined), true);
  });

  it('returns true when entry.revision matches revision exactly', () => {
    assert.equal(matchesRevision({ revision: 'r1' }, 'r1'), true);
  });

  it('returns false when entry.revision differs or entry is null', () => {
    assert.equal(matchesRevision({ revision: 'r1' }, 'r2'), false);
    assert.equal(matchesRevision({}, 'r1'), false);
    assert.equal(matchesRevision(null, 'r1'), false);
  });
});

describe('latestP5Entry and latestP5Revision', () => {
  const entries = [
    { type: 'p5-dry-pass', ticket: 'T1', revision: 'r0' },
    { type: 'p5-complete', ticket: 'T1', revision: 'r1' },
    { gate: 'p5-complete', ticket: 'T2', revision: 'r2' },
    { type: 'p5-complete', ticket: 'T1', revision: 'r3' },
    { type: 'p5-complete', ticket: 'T1' }, // no revision
  ];

  it('returns undefined for empty entries', () => {
    assert.equal(latestP5Entry([], 'T1'), undefined);
    assert.equal(latestP5Revision([], 'T1'), undefined);
  });

  it('returns the latest matching entry with a revision and skips entries without revision', () => {
    const entry = latestP5Entry(entries, 'T1');
    assert.deepEqual(entry, { type: 'p5-complete', ticket: 'T1', revision: 'r3' });
    assert.equal(latestP5Revision(entries, 'T1'), 'r3');
  });

  it('matches entry by explicit revision', () => {
    const entry = latestP5Entry(entries, 'T1', 'r1');
    assert.deepEqual(entry, { type: 'p5-complete', ticket: 'T1', revision: 'r1' });
  });

  it('supports gate fallback for entryType in latestP5Entry', () => {
    const entry = latestP5Entry(entries, 'T2');
    assert.deepEqual(entry, { gate: 'p5-complete', ticket: 'T2', revision: 'r2' });
    assert.equal(latestP5Revision(entries, 'T2'), 'r2');
  });

  it('returns undefined if no entry matches ticket or revision', () => {
    assert.equal(latestP5Entry(entries, 'T3'), undefined);
    assert.equal(latestP5Entry(entries, 'T1', 'nonexistent'), undefined);
    assert.equal(latestP5Revision(entries, 'T3'), undefined);
  });
});

describe('isEvidencePath', () => {
  it('identifies .adlc and .omo/evidence paths correctly', () => {
    const cwd = '/workspace/repo';
    assert.equal(isEvidencePath(cwd, '.adlc/manifest.jsonl'), true);
    assert.equal(isEvidencePath(cwd, '.adlc/packet.json'), true);
    assert.equal(isEvidencePath(cwd, '/workspace/repo/.adlc/packet.json'), true);
    assert.equal(isEvidencePath(cwd, '.omo/evidence/run1/transcript.txt'), true);
    assert.equal(isEvidencePath(cwd, '/workspace/repo/.omo/evidence/run1/transcript.txt'), true);
  });

  it('rejects paths outside .adlc and .omo/evidence', () => {
    const cwd = '/workspace/repo';
    assert.equal(isEvidencePath(cwd, 'src/index.mjs'), false);
    assert.equal(isEvidencePath(cwd, 'package.json'), false);
    assert.equal(isEvidencePath(cwd, '../other/.adlc/packet.json'), false);
    assert.equal(isEvidencePath(cwd, '/other/path/.adlc/packet.json'), false);
  });
});

describe('p5TranscriptPaths', () => {
  it('returns empty array when entry or transcript path is missing', () => {
    const cwd = '/workspace/repo';
    assert.deepEqual(p5TranscriptPaths(null, cwd), []);
    assert.deepEqual(p5TranscriptPaths({}, cwd), []);
    assert.deepEqual(p5TranscriptPaths({ transcript: {} }, cwd), []);
  });

  it('returns empty array when transcript path is outside evidence dir', () => {
    const cwd = '/workspace/repo';
    const entry = { transcript: { path: 'outside/transcript.txt' } };
    assert.deepEqual(p5TranscriptPaths(entry, cwd), []);
  });

  it('returns transcript path when inside evidence dir', () => {
    const cwd = '/workspace/repo';
    const entry = { transcript: { path: '.adlc/transcript.txt' } };
    assert.deepEqual(p5TranscriptPaths(entry, cwd), ['.adlc/transcript.txt']);
  });
});

describe('p5ReviewPacketPaths', () => {
  it('returns empty array when entry has no review packet paths', () => {
    const cwd = '/workspace/repo';
    assert.deepEqual(p5ReviewPacketPaths(null, cwd), []);
    assert.deepEqual(p5ReviewPacketPaths({}, cwd), []);
    assert.deepEqual(p5ReviewPacketPaths({ reviewPacket: {} }, cwd), []);
  });

  it('filters out paths outside evidence dir', () => {
    const cwd = '/workspace/repo';
    const entry = {
      inputPath: 'src/main.mjs',
      reviewPacket: {
        prompt: { path: 'docs/prompt.md' },
        inputs: { path: '.adlc/inputs.json' },
      },
    };
    assert.deepEqual(p5ReviewPacketPaths(entry, cwd), ['.adlc/inputs.json']);
  });

  it('collects all valid evidence paths', () => {
    const cwd = '/workspace/repo';
    const entry = {
      inputPath: '.adlc/input.txt',
      reviewPacket: {
        prompt: { path: '.omo/evidence/prompt.txt' },
        inputs: { path: '.adlc/inputs.json' },
      },
    };
    assert.deepEqual(p5ReviewPacketPaths(entry, cwd), [
      '.adlc/input.txt',
      '.omo/evidence/prompt.txt',
      '.adlc/inputs.json',
    ]);
  });
});

describe('transcriptIntegrityErrors', () => {
  it('returns empty array when entry or transcript path/hash is missing', () => {
    assert.deepEqual(transcriptIntegrityErrors(null), []);
    assert.deepEqual(transcriptIntegrityErrors({}), []);
    assert.deepEqual(transcriptIntegrityErrors({ transcript: {} }), []);
    assert.deepEqual(transcriptIntegrityErrors({ transcript: { path: '/some/path' } }), []);
  });

  it('returns empty array when file content matches hash', (t) => {
    const cwd = tmp(t, 'p5-test-');
    const filePath = join(cwd, 'transcript.txt');
    writeFileSync(filePath, 'hello transcript\n');
    const hash = sha256('hello transcript\n');
    assert.deepEqual(transcriptIntegrityErrors({ transcript: { path: filePath, hash } }), []);
  });

  it('reports stale hash error when file content differs', (t) => {
    const cwd = tmp(t, 'p5-test-');
    const filePath = join(cwd, 'transcript.txt');
    writeFileSync(filePath, 'modified transcript\n');
    const oldHash = sha256('original transcript\n');
    const errors = transcriptIntegrityErrors({ transcript: { path: filePath, hash: oldHash } });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /transcript hash changed after prosecution/);
  });

  it('reports unreadable error when file does not exist', () => {
    const errors = transcriptIntegrityErrors({
      transcript: { path: '/nonexistent/transcript.txt', hash: 'abc' },
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /transcript cannot be read/);
  });
});

describe('p5ArtifactIntegrityError', () => {
  it('returns incomplete error when artifact or path/hash is missing', () => {
    assert.match(p5ArtifactIntegrityError('prompt', null), /missing path\/hash/);
    assert.match(p5ArtifactIntegrityError('prompt', {}), /missing path\/hash/);
    assert.match(p5ArtifactIntegrityError('prompt', { path: 'a.txt' }), /missing path\/hash/);
    assert.match(p5ArtifactIntegrityError('prompt', { hash: '123' }), /missing path\/hash/);
  });

  it('returns null when artifact matches hash', (t) => {
    const cwd = tmp(t, 'p5-artifact-');
    const filePath = join(cwd, 'prompt.txt');
    writeFileSync(filePath, 'clean prompt\n');
    const hash = sha256('clean prompt\n');
    assert.equal(p5ArtifactIntegrityError('prompt', { path: filePath, hash }), null);
  });

  it('returns stale error when artifact content changed', (t) => {
    const cwd = tmp(t, 'p5-artifact-');
    const filePath = join(cwd, 'prompt.txt');
    writeFileSync(filePath, 'changed prompt\n');
    const oldHash = sha256('old prompt\n');
    assert.match(
      p5ArtifactIntegrityError('prompt', { path: filePath, hash: oldHash }),
      /prompt hash changed after prosecution/
    );
  });

  it('returns unreadable error when artifact cannot be read', () => {
    assert.match(
      p5ArtifactIntegrityError('prompt', { path: '/nonexistent/file.txt', hash: 'abc' }),
      /prompt cannot be read/
    );
  });
});

describe('reviewPacketIntegrityErrors', () => {
  it('reports missing reviewPacket when entry or reviewPacket is absent', () => {
    assert.deepEqual(reviewPacketIntegrityErrors(null), [
      'P5 evidence is incomplete: p5-complete missing reviewPacket',
    ]);
    assert.deepEqual(reviewPacketIntegrityErrors({}), [
      'P5 evidence is incomplete: p5-complete missing reviewPacket',
    ]);
    assert.deepEqual(reviewPacketIntegrityErrors({ reviewPacket: 'not-an-object' }), [
      'P5 evidence is incomplete: p5-complete missing reviewPacket',
    ]);
  });

  it('checks cleanWorktree against expectedRevision (defaulting to entry.revision)', () => {
    const entry = {
      revision: 'rev-A',
      reviewPacket: {
        cleanWorktree: 'rev-B',
      },
    };
    const errors = reviewPacketIntegrityErrors(entry);
    assert.ok(errors.some((err) => err.includes('reviewPacket cleanWorktree does not match rev-A')));
  });

  it('accepts matching cleanWorktree with valid prompt and inputs', (t) => {
    const cwd = tmp(t, 'p5-packet-');
    const promptPath = join(cwd, 'prompt.txt');
    const inputsPath = join(cwd, 'inputs.txt');
    writeFileSync(promptPath, 'prompt data\n');
    writeFileSync(inputsPath, 'inputs data\n');
    const entry = {
      revision: 'rev-1',
      reviewPacket: {
        cleanWorktree: 'rev-1',
        prompt: { path: promptPath, hash: sha256('prompt data\n') },
        inputs: { path: inputsPath, hash: sha256('inputs data\n') },
      },
    };
    assert.deepEqual(reviewPacketIntegrityErrors(entry), []);
  });

  it('reports prompt and inputs integrity errors', () => {
    const entry = {
      revision: 'rev-1',
      reviewPacket: {
        cleanWorktree: 'rev-1',
        prompt: { path: '/nonexistent/prompt.txt', hash: '123' },
        inputs: { path: '/nonexistent/inputs.txt', hash: '456' },
      },
    };
    const errors = reviewPacketIntegrityErrors(entry);
    assert.equal(errors.length, 2);
    assert.match(errors[0], /reviewPacket\.prompt cannot be read/);
    assert.match(errors[1], /reviewPacket\.inputs cannot be read/);
  });
});

describe('historicalTranscriptIntegrityErrors', () => {
  it('returns empty array when assertedEntry has no transcript path', () => {
    assert.deepEqual(historicalTranscriptIntegrityErrors([], null, 'T1', '/workspace'), []);
    assert.deepEqual(historicalTranscriptIntegrityErrors([], {}, 'T1', '/workspace'), []);
  });

  it('ignores self and matching paths, but audits distinct historical transcript files', (t) => {
    const cwd = tmp(t, 'p5-hist-');
    const activePath = join(cwd, 'active.txt');
    const oldPath = join(cwd, 'old.txt');
    writeFileSync(activePath, 'active\n');
    writeFileSync(oldPath, 'old modified\n');
    const oldHash = sha256('old original\n');

    const assertedEntry = {
      type: 'p5-complete',
      ticket: 'T1',
      transcript: { path: activePath, hash: sha256('active\n') },
    };
    const samePathEntry = {
      type: 'p5-complete',
      ticket: 'T1',
      transcript: { path: activePath, hash: sha256('active\n') },
    };
    const otherTicketEntry = {
      type: 'p5-complete',
      ticket: 'T2',
      transcript: { path: oldPath, hash: oldHash },
    };
    const historicalStaleEntry = {
      type: 'p5-complete',
      ticket: 'T1',
      transcript: { path: oldPath, hash: oldHash },
    };

    const entries = [assertedEntry, samePathEntry, otherTicketEntry, historicalStaleEntry];
    const errors = historicalTranscriptIntegrityErrors(entries, assertedEntry, 'T1', cwd);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /transcript hash changed after prosecution/);
  });
});

describe('ticketDefinitionBinding and staleTicketDefinitionError', () => {
  it('returns null when directory does not exist or ticket is absent', (t) => {
    const cwd = tmp(t, 'p5-ticket-');
    assert.equal(ticketDefinitionBinding(cwd, 'T1', '.adlc'), null);
  });

  it('binds ticket definition when present in tickets.json', (t) => {
    const cwd = tmp(t, 'p5-ticket-');
    const dir = join(cwd, '.adlc');
    mkdirSync(dir, { recursive: true });
    const def = { id: 'T1', title: 'test', scope: ['src/**'], rails: ['test/**'], edges: [] };
    writeFileSync(join(dir, 'tickets.json'), JSON.stringify({ tickets: [def] }));

    const binding = ticketDefinitionBinding(cwd, 'T1', '.adlc');
    assert.ok(binding);
    assert.equal(binding.ticketHash, domainTicketHash(def));
    assert.ok(typeof binding.storeHash === 'string');
  });

  it('evaluates stale ticket definition error messages', () => {
    assert.equal(
      staleTicketDefinitionError(null, 'hash1'),
      'P5 evidence is stale: ticket definition was not bound during prosecution'
    );
    assert.equal(staleTicketDefinitionError('hash1', 'hash1'), null);
    assert.equal(
      staleTicketDefinitionError('hash1', null),
      'P5 evidence is stale: ticket definition disappeared after prosecution'
    );
    assert.equal(
      staleTicketDefinitionError('hash1', 'hash2'),
      'P5 evidence is stale: ticket definition changed after prosecution'
    );
  });
});

describe('manifestArtifactPaths', () => {
  it('constructs correct manifest artifact paths for dir', () => {
    const cwd = '/workspace/repo';
    const paths = manifestArtifactPaths(cwd, '.adlc');
    assert.deepEqual(paths, [
      resolve(cwd, '.adlc/manifest.jsonl'),
      resolve(cwd, '.adlc/manifest.lock'),
      resolve(cwd, '.adlc/manifest.d'),
      resolve(cwd, '.adlc/tickets.json'),
    ]);
  });
});

describe('resolveLiveP5WorktreeRevision', () => {
  it('returns null if explicitRevision is provided', () => {
    assert.equal(
      resolveLiveP5WorktreeRevision({ explicitRevision: 'explicit-rev' }),
      null
    );
  });

  it('dispatches to git-change changeset resolver when revision matches git-change format', (t) => {
    const repo = gitRepo(t);
    writeFileSync(join(repo.dir, 'file.txt'), 'base\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'base commit');
    const baseCommit = repo.g('rev-parse', 'HEAD').trim();

    const fakeGitChange = `git-change:${baseCommit}:0000000000000000000000000000000000000000000000000000000000000000`;
    const resolved = resolveLiveP5WorktreeRevision({
      cwd: repo.dir,
      recordedP5Revision: fakeGitChange,
    });
    assert.ok(resolved.startsWith(`git-change:${baseCommit}:`));
  });

  it('dispatches to resolveRevision when not git-change format', (t) => {
    const repo = gitRepo(t);
    writeFileSync(join(repo.dir, 'file.txt'), 'hello\n');
    repo.g('add', '-A');
    repo.g('commit', '-qm', 'initial');
    const headCommit = repo.g('rev-parse', 'HEAD').trim();

    const resolved = resolveLiveP5WorktreeRevision({
      cwd: repo.dir,
      recordedP5Revision: 'normal-sha',
    });
    assert.equal(resolved, resolveRevision({ cwd: repo.dir }));
  });
});

import { resolveChangeSetRevision, resolveRevision, sha256 } from '@adlc/core';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { LegacyTicketStore, loadTicketSnapshot } from '@adlc/tickets';

export function entryType(entry) {
  return entry?.type ?? entry?.gate;
}

export function matchesTicket(entry, ticket) {
  return ticket === undefined || entry?.ticket === ticket;
}

export function matchesRevision(entry, revision) {
  return revision === undefined || entry?.revision === revision;
}

export function latestP5Entry(entries, ticket, revision) {
  return entries
    .filter((entry) =>
      entryType(entry) === 'p5-complete' &&
      matchesTicket(entry, ticket) &&
      Boolean(entry?.revision)
    )
    .filter((entry) => matchesRevision(entry, revision))
    .at(-1);
}

export function latestP5Revision(entries, ticket) {
  return latestP5Entry(entries, ticket)?.revision;
}

export function isEvidencePath(cwd, path) {
  const rel = relative(cwd, resolve(cwd, path)).replaceAll('\\', '/');
  return rel.startsWith('.adlc/') || rel.startsWith('.omo/evidence/');
}

export function p5TranscriptPaths(entry, cwd) {
  const path = entry?.transcript?.path;
  if (!path || !isEvidencePath(cwd, path)) return [];
  return [path];
}

export function p5ReviewPacketPaths(entry, cwd) {
  return [
    entry?.inputPath,
    entry?.reviewPacket?.prompt?.path,
    entry?.reviewPacket?.inputs?.path,
  ].filter((path) => path && isEvidencePath(cwd, path));
}

export function transcriptIntegrityErrors(entry) {
  const transcript = entry?.transcript;
  if (!transcript?.path || !transcript?.hash) return [];
  try {
    const content = readFileSync(transcript.path);
    if (sha256(content) === transcript.hash) return [];
    return [`P5 evidence is stale: transcript hash changed after prosecution: ${transcript.path}`];
  } catch (err) {
    return [`P5 evidence is stale: transcript cannot be read: ${transcript.path}: ${err.message}`];
  }
}

export function p5ArtifactIntegrityError(label, artifact) {
  if (!artifact?.path || !artifact?.hash) {
    return `P5 evidence is incomplete: ${label} missing path/hash`;
  }
  try {
    const content = readFileSync(artifact.path);
    if (sha256(content) === artifact.hash) return null;
    return `P5 evidence is stale: ${label} hash changed after prosecution: ${artifact.path}`;
  } catch (err) {
    return `P5 evidence is stale: ${label} cannot be read: ${artifact.path}: ${err.message}`;
  }
}

export function reviewPacketIntegrityErrors(entry, expectedRevision = entry?.revision) {
  if (!entry?.reviewPacket || typeof entry.reviewPacket !== 'object') {
    return ['P5 evidence is incomplete: p5-complete missing reviewPacket'];
  }
  const errors = [];
  if (entry.reviewPacket.cleanWorktree !== expectedRevision) {
    errors.push(`P5 evidence is incomplete: reviewPacket cleanWorktree does not match ${expectedRevision}`);
  }
  const promptError = p5ArtifactIntegrityError('reviewPacket.prompt', entry.reviewPacket.prompt);
  if (promptError) errors.push(promptError);
  const inputsError = p5ArtifactIntegrityError('reviewPacket.inputs', entry.reviewPacket.inputs);
  if (inputsError) errors.push(inputsError);
  return errors;
}

export function historicalTranscriptIntegrityErrors(entries, assertedEntry, ticket, cwd) {
  if (!assertedEntry?.transcript?.path) return [];
  const assertedPath = resolve(cwd, assertedEntry.transcript.path);
  return entries
    .filter((entry) => entry !== assertedEntry)
    .filter((entry) => entryType(entry) === 'p5-complete' && matchesTicket(entry, ticket))
    .filter((entry) => entry.transcript?.path && resolve(cwd, entry.transcript.path) !== assertedPath)
    .flatMap((entry) => transcriptIntegrityErrors(entry));
}

export function ticketDefinitionBinding(cwd, ticket, dir) {
  try {
    const customPath = resolve(cwd, dir, 'tickets.json');
    const snapshot = customPath !== resolve(cwd, '.adlc/tickets.json') && existsSync(customPath)
      ? new LegacyTicketStore(customPath).load()
      : loadTicketSnapshot({ root: cwd });
    return snapshot.get(ticket) ? { ticketHash: snapshot.ticketHashes[ticket], storeHash: snapshot.hash } : null;
  } catch { return null; }
}

export function staleTicketDefinitionError(recordedHash, currentHash) {
  if (recordedHash === null) {
    return 'P5 evidence is stale: ticket definition was not bound during prosecution';
  }
  if (recordedHash === currentHash) return null;
  if (currentHash === null) {
    return 'P5 evidence is stale: ticket definition disappeared after prosecution';
  }
  return 'P5 evidence is stale: ticket definition changed after prosecution';
}

export function manifestArtifactPaths(cwd, dir) {
  const root = resolve(cwd, dir);
  // manifest.d/ (T-MANIFEST-FOREST slice 3) is the segmented equivalent of
  // manifest.jsonl/manifest.lock — see prosecute/lib/run.mjs's identical
  // helper for the full rationale (adversarial-review finding: without this,
  // a segmented repo's evidence appends move the revision they are supposed
  // to attest).
  return [join(root, 'manifest.jsonl'), join(root, 'manifest.lock'), join(root, 'manifest.d'), join(root, 'tickets.json')];
}

export function resolveLiveP5WorktreeRevision({ cwd = process.cwd(), explicitRevision, recordedP5Revision, ignorePaths } = {}) {
  if (explicitRevision) return null;
  const changeSetMatch = typeof recordedP5Revision === 'string'
    ? recordedP5Revision.match(/^git-change:([0-9a-f]{40}):[0-9a-f]{64}$/)
    : null;
  return changeSetMatch
    ? resolveChangeSetRevision({ cwd, base: changeSetMatch[1], ignorePaths })
    : resolveRevision({ cwd, ignorePaths });
}

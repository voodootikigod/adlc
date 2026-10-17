import { sha256 } from '@adlc/core';
import { appendManifestEntry } from '@adlc/gate-manifest';
// Scoped to root + this checkout's own segment: `latestP5Entry`'s `.at(-1)`
// below is a chronology claim, and only this chain can carry one. See
// own-chain.mjs.
import { readOwnManifestChain } from '@adlc/gate-manifest/lib/own-chain.mjs';
import { readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  historicalTranscriptIntegrityErrors,
  isEvidencePath,
  latestP5Entry,
  latestP5Revision,
  manifestArtifactPaths,
  p5ReviewPacketPaths,
  p5TranscriptPaths,
  resolveLiveP5WorktreeRevision,
  reviewPacketIntegrityErrors,
  staleTicketDefinitionError,
  ticketDefinitionBinding,
  transcriptIntegrityErrors,
} from './p5-evidence.mjs';

function now() {
  return new Date().toISOString();
}

function isInsideCwd(cwd, absolute) {
  const rel = relative(cwd, absolute).replaceAll('\\', '/');
  return rel !== '' && !rel.startsWith('../') && rel !== '..';
}

function validateInWorktreeEvidencePath(cwd, label, path) {
  const absolute = resolve(cwd, path);
  if (isInsideCwd(cwd, absolute) && !isEvidencePath(cwd, absolute)) {
    return `${label} inside the worktree must live under .adlc/ or .omo/evidence/: ${path}`;
  }
  return null;
}

export function recordAcceptancePacket({
  key,
  dir = '.adlc',
  ticket,
  packet,
  before,
  after,
  revision,
  cwd = process.cwd(),
} = {}) {
  const errors = [];
  if (!ticket) errors.push('ticket is required for P6 acceptance evidence');
  if (!packet) errors.push('packet is required for P6 acceptance evidence');

  let packetPath;
  let packetHash;
  const artifactPaths = [];
  const artifactHashes = [];
  for (const artifact of [before, after].filter(Boolean)) {
    const error = validateInWorktreeEvidencePath(cwd, 'artifact', artifact);
    if (error) errors.push(error);
    const artifactPath = resolve(cwd, artifact);
    try {
      const stat = statSync(artifactPath);
      if (!stat.isFile()) errors.push(`artifact is not a file: ${artifact}`);
      artifactHashes.push({ path: artifactPath, hash: sha256(readFileSync(artifactPath)) });
    } catch (err) {
      errors.push(`artifact cannot be read: ${artifact}: ${err.message}`);
    }
    artifactPaths.push(artifactPath);
  }
  if (packet) {
    const pathError = validateInWorktreeEvidencePath(cwd, 'packet', packet);
    if (pathError) errors.push(pathError);
    try {
      packetPath = resolve(cwd, packet);
      const stat = statSync(packetPath);
      if (!stat.isFile()) errors.push(`packet is not a file: ${packet}`);
      const content = readFileSync(packetPath);
      if (content.length === 0) errors.push(`packet is empty: ${packet}`);
      packetHash = sha256(content);
    } catch (err) {
      errors.push(`packet cannot be read: ${packet}: ${err.message}`);
    }
  }

  const { entries, identityError } = readOwnManifestChain(dir, { cwd });
  // Refused explicitly, not left to the empty-entries fallback: without this,
  // "we cannot tell which evidence is ours" would surface as the ordinary
  // "P5 evidence is missing", which reads as a fixable gap rather than a
  // checkout that cannot be identified. Unlike assertPhase this function has no
  // `skipped` channel, so `identityError` is the only place it can be said.
  if (identityError) errors.push(identityError);
  const p5Revision = latestP5Revision(entries, ticket);
  const assertedP5Entry = latestP5Entry(entries, ticket, revision ?? p5Revision);
  if (ticket && !assertedP5Entry) {
    errors.push(revision
      ? `P5 evidence is missing: no p5-complete for ticket ${ticket} at ${revision}`
      : `P5 evidence is missing: no p5-complete for ticket ${ticket}`);
  }
  const transcriptPaths = p5TranscriptPaths(assertedP5Entry, cwd);
  const reviewPacketPaths = p5ReviewPacketPaths(assertedP5Entry, cwd);
  const p5TicketHash = assertedP5Entry?.ticketHash ?? null;
  const currentBinding = assertedP5Entry ? ticketDefinitionBinding(cwd, ticket, dir) : null;
  const currentTicketHash = currentBinding?.ticketHash ?? null;
  const ticketStaleError = assertedP5Entry
    ? staleTicketDefinitionError(p5TicketHash, currentTicketHash)
    : null;
  errors.push(...transcriptIntegrityErrors(assertedP5Entry));
  errors.push(...reviewPacketIntegrityErrors(assertedP5Entry));
  errors.push(...historicalTranscriptIntegrityErrors(entries, assertedP5Entry, ticket, cwd));
  const ignorePaths = packetPath
    ? [...manifestArtifactPaths(cwd, dir), ...transcriptPaths, ...reviewPacketPaths, ...artifactPaths, packetPath]
    : [...manifestArtifactPaths(cwd, dir), ...transcriptPaths, ...reviewPacketPaths, ...artifactPaths];
  const recordedP5Revision = assertedP5Entry?.revision ?? p5Revision;
  const liveWorktreeRevision = resolveLiveP5WorktreeRevision({
    cwd,
    explicitRevision: revision,
    recordedP5Revision,
    ignorePaths,
  });
  const assertedRevision = revision ?? p5Revision;
  if (!revision && assertedRevision && !liveWorktreeRevision) {
    errors.push(`current worktree revision could not be resolved while P5 evidence exists at ${assertedRevision}`);
  }
  if (!revision && assertedRevision && liveWorktreeRevision && assertedRevision !== liveWorktreeRevision) {
    errors.push(`P5 evidence is stale: recorded ${assertedRevision}, current worktree is ${liveWorktreeRevision}`);
  }
  if (ticketStaleError) {
    errors.push(ticketStaleError);
  }
  const resolvedRevision = assertedRevision ?? liveWorktreeRevision;
  if (!resolvedRevision) errors.push('revision could not be resolved; pass --revision or run inside a git worktree');
  if (errors.length > 0) return { ok: false, exitCode: 1, errors };

  appendManifestEntry({
    ts: now(),
    type: 'p6-acceptance-packet',
    ticket,
    revision: resolvedRevision,
    packet: packetPath,
    packetHash,
    artifactPaths,
    artifactHashes,
    ticketHash: currentBinding.ticketHash,
    storeHash: currentBinding.storeHash,
    bindingScope: 'ticket',
  }, dir, { cwd, key });

  return {
    ok: true,
    exitCode: 0,
    ticket,
    revision: resolvedRevision,
    packet: packetPath,
    packetHash,
    artifactPaths,
    artifactHashes,
    ticketHash: currentBinding.ticketHash,
    storeHash: currentBinding.storeHash,
    bindingScope: 'ticket',
  };
}

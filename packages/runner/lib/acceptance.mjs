import { appendEntry, canonicalJson, readEntries, resolveRevision, sha256 } from '@adlc/core';
import { readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

function now() {
  return new Date().toISOString();
}

function latestP5Revision(entries, ticket) {
  return latestP5Entry(entries, ticket)?.revision;
}

function latestP5Entry(entries, ticket, revision) {
  return entries
    .filter((entry) => entry.type === 'p5-complete' && entry.ticket === ticket)
    .filter((entry) => revision === undefined || entry.revision === revision)
    .at(-1);
}

function p5TranscriptPaths(entry, cwd) {
  const path = entry?.transcript?.path;
  if (!path || !isEvidencePath(cwd, path)) return [];
  return [path];
}

function p5ReviewPacketPaths(entry, cwd) {
  return [
    entry?.inputPath,
    entry?.reviewPacket?.prompt?.path,
    entry?.reviewPacket?.inputs?.path,
  ].filter((path) => path && isEvidencePath(cwd, path));
}

function isInsideCwd(cwd, absolute) {
  const rel = relative(cwd, absolute).replaceAll('\\', '/');
  return rel !== '' && !rel.startsWith('../') && rel !== '..';
}

function transcriptIntegrityErrors(entry) {
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

function p5ArtifactIntegrityError(label, artifact) {
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

function reviewPacketIntegrityErrors(entry) {
  if (!entry?.reviewPacket || typeof entry.reviewPacket !== 'object') {
    return ['P5 evidence is incomplete: p5-complete missing reviewPacket'];
  }
  const errors = [];
  if (entry.reviewPacket.cleanWorktree !== entry.revision) {
    errors.push(`P5 evidence is incomplete: reviewPacket cleanWorktree does not match ${entry.revision}`);
  }
  const promptError = p5ArtifactIntegrityError('reviewPacket.prompt', entry.reviewPacket.prompt);
  if (promptError) errors.push(promptError);
  const inputsError = p5ArtifactIntegrityError('reviewPacket.inputs', entry.reviewPacket.inputs);
  if (inputsError) errors.push(inputsError);
  return errors;
}

function historicalTranscriptIntegrityErrors(entries, ticket, assertedEntry, cwd) {
  if (!assertedEntry?.transcript?.path) return [];
  const assertedPath = resolve(cwd, assertedEntry.transcript.path);
  return entries
    .filter((entry) => entry !== assertedEntry)
    .filter((entry) => entry.type === 'p5-complete' && entry.ticket === ticket)
    .filter((entry) => entry.transcript?.path && resolve(cwd, entry.transcript.path) !== assertedPath)
    .flatMap((entry) => transcriptIntegrityErrors(entry));
}

function isEvidencePath(cwd, path) {
  const rel = relative(cwd, resolve(cwd, path)).replaceAll('\\', '/');
  return rel.startsWith('.adlc/') || rel.startsWith('.omo/evidence/');
}

function validateInWorktreeEvidencePath(cwd, label, path) {
  const absolute = resolve(cwd, path);
  if (isInsideCwd(cwd, absolute) && !isEvidencePath(cwd, absolute)) {
    return `${label} inside the worktree must live under .adlc/ or .omo/evidence/: ${path}`;
  }
  return null;
}

function ticketDefinitionHash(cwd, ticket, dir) {
  const paths = [resolve(cwd, dir, 'tickets.json'), resolve(cwd, '.adlc/tickets.json')];
  for (const path of paths) {
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw);
      const tickets = Array.isArray(parsed?.tickets) ? parsed.tickets : [];
      const definition = tickets.find((candidate) => candidate?.id === ticket);
      if (definition) return sha256(canonicalJson(definition));
    } catch {
      // Try the next supported ticket location.
    }
  }
  return null;
}

function staleTicketDefinitionError(recordedHash, currentHash) {
  if (recordedHash === null) {
    return 'P5 evidence is stale: ticket definition was not bound during prosecution';
  }
  if (recordedHash === currentHash) return null;
  if (currentHash === null) {
    return 'P5 evidence is stale: ticket definition disappeared after prosecution';
  }
  return 'P5 evidence is stale: ticket definition changed after prosecution';
}

function manifestArtifactPaths(cwd, dir) {
  const root = resolve(cwd, dir);
  return [join(root, 'manifest.jsonl'), join(root, 'manifest.lock'), join(root, 'tickets.json')];
}

export function recordAcceptancePacket({
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

  const { entries } = readEntries('manifest', dir);
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
  const currentTicketHash = assertedP5Entry ? ticketDefinitionHash(cwd, ticket, dir) : null;
  const ticketStaleError = assertedP5Entry
    ? staleTicketDefinitionError(p5TicketHash, currentTicketHash)
    : null;
  errors.push(...transcriptIntegrityErrors(assertedP5Entry));
  errors.push(...reviewPacketIntegrityErrors(assertedP5Entry));
  errors.push(...historicalTranscriptIntegrityErrors(entries, ticket, assertedP5Entry, cwd));
  const ignorePaths = packetPath
    ? [...manifestArtifactPaths(cwd, dir), ...transcriptPaths, ...reviewPacketPaths, ...artifactPaths, packetPath]
    : [...manifestArtifactPaths(cwd, dir), ...transcriptPaths, ...reviewPacketPaths, ...artifactPaths];
  const liveWorktreeRevision = revision ? null : resolveRevision({ cwd, ignorePaths });
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

  appendEntry('manifest', {
    ts: now(),
    type: 'p6-acceptance-packet',
    ticket,
    revision: resolvedRevision,
    packet: packetPath,
    packetHash,
    artifactPaths,
    artifactHashes,
  }, dir);

  return {
    ok: true,
    exitCode: 0,
    ticket,
    revision: resolvedRevision,
    packet: packetPath,
    packetHash,
    artifactPaths,
    artifactHashes,
  };
}

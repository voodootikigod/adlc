import { readEntries, ADLC_DIR, canonicalJson, hashFiles, resolveRevision, sha256 } from '@adlc/core';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const PHASE_REQUIREMENTS = {
  p1: ['spec-lint', 'premortem'],
  p2: ['coldstart', 'merge-forecast'],
  p3: ['rails-red', 'hollow-test', 'rails-frozen'],
  p4: ['rails-green', 'rails-check', 'flail-check'],
  p5: ['p5-complete'],
  p6: ['p5-complete', 'p6-acceptance-packet'],
  p7: ['lesson-foundry', 'rejection-mining', 'skill-rot'],
};

function entryType(entry) {
  return entry.type ?? entry.gate;
}

function matchesTicket(entry, ticket) {
  return ticket === undefined || entry.ticket === ticket;
}

function requiresTicket(phase) {
  return phase === 'p3' || phase === 'p4' || phase === 'p5' || phase === 'p6';
}

function requiresRevision(phase) {
  return phase === 'p5' || phase === 'p6';
}

function matchesRevision(entry, revision) {
  return revision === undefined || entry.revision === revision;
}

function latestP5Revision(entries, ticket) {
  return latestP5Entry(entries, ticket)?.revision;
}

function latestP5Entry(entries, ticket, revision) {
  return entries
    .filter((entry) => entryType(entry) === 'p5-complete' && matchesTicket(entry, ticket) && entry.revision)
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

function historicalTranscriptIntegrityErrors(entries, assertedEntry, ticket, cwd) {
  if (!assertedEntry?.transcript?.path) return [];
  const assertedPath = resolve(cwd, assertedEntry.transcript.path);
  return entries
    .filter((entry) => entry !== assertedEntry)
    .filter((entry) => entryType(entry) === 'p5-complete' && matchesTicket(entry, ticket))
    .filter((entry) => entry.transcript?.path && resolve(cwd, entry.transcript.path) !== assertedPath)
    .flatMap((entry) => transcriptIntegrityErrors(entry));
}

function isEvidencePath(cwd, path) {
  const rel = relative(cwd, resolve(cwd, path)).replaceAll('\\', '/');
  return rel.startsWith('.adlc/') || rel.startsWith('.omo/evidence/');
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

function p5CompletionIntegrityErrors(entries, entry, ticket, revision) {
  if (!entry) return [];
  const errors = [];
  const dryLenses = Array.isArray(entry.dryLenses) ? new Set(entry.dryLenses.filter((lens) => typeof lens === 'string' && lens)) : new Set();
  if (!entry.provenance || typeof entry.provenance !== 'object') {
    errors.push('P5 evidence is incomplete: p5-complete missing provenance');
  } else {
    if (typeof entry.provenance.reviewer !== 'string' || entry.provenance.reviewer.length === 0) {
      errors.push('P5 evidence is incomplete: p5-complete missing provenance.reviewer');
    }
    if (typeof entry.provenance.command !== 'string' || entry.provenance.command.length === 0) {
      errors.push('P5 evidence is incomplete: p5-complete missing provenance.command');
    }
  }
  if (!entry.transcript?.path || !entry.transcript?.hash) {
    errors.push('P5 evidence is incomplete: p5-complete missing transcript path/hash');
  }
  if (!entry.reviewPacket || typeof entry.reviewPacket !== 'object') {
    errors.push('P5 evidence is incomplete: p5-complete missing reviewPacket');
  } else {
    if (entry.reviewPacket.cleanWorktree !== revision) {
      errors.push(`P5 evidence is incomplete: reviewPacket cleanWorktree does not match ${revision}`);
    }
    const promptError = p5ArtifactIntegrityError('reviewPacket.prompt', entry.reviewPacket.prompt);
    if (promptError) errors.push(promptError);
    const inputsError = p5ArtifactIntegrityError('reviewPacket.inputs', entry.reviewPacket.inputs);
    if (inputsError) errors.push(inputsError);
  }
  if (!Number.isInteger(entry.consecutiveDry) || entry.consecutiveDry < 2) {
    errors.push('P5 evidence is incomplete: p5-complete requires consecutiveDry >= 2');
  }
  if (dryLenses.size < 3) {
    errors.push('P5 evidence is incomplete: p5-complete requires at least three distinct dry lenses');
  }

  const dryPasses = entries.filter((candidate) =>
    entryType(candidate) === 'p5-dry-pass' &&
    matchesTicket(candidate, ticket) &&
    matchesRevision(candidate, revision)
  );
  const completedDryPasses = entries.filter((candidate) =>
    entryType(candidate) === 'p5-pass-completed' &&
    matchesTicket(candidate, ticket) &&
    matchesRevision(candidate, revision) &&
    candidate.dry === true
  );
  for (const lens of dryLenses) {
    if (!dryPasses.some((pass) => pass.lens === lens)) {
      errors.push(`P5 evidence is incomplete: missing p5-dry-pass for lens ${lens}`);
    }
    if (!completedDryPasses.some((pass) => pass.lens === lens)) {
      errors.push(`P5 evidence is incomplete: missing dry p5-pass-completed for lens ${lens}`);
    }
  }
  if (!dryPasses.some((pass) => Number.isInteger(pass.consecutiveDry) && pass.consecutiveDry >= 2)) {
    errors.push('P5 evidence is incomplete: no supporting p5-dry-pass has consecutiveDry >= 2');
  }
  const completedBeforeEntry = entries.slice(0, entries.indexOf(entry)).filter((candidate) =>
    entryType(candidate) === 'p5-pass-completed' &&
    matchesTicket(candidate, ticket) &&
    matchesRevision(candidate, revision)
  );
  const finalDryLenses = new Set();
  for (let index = completedBeforeEntry.length - 1; index >= 0; index -= 1) {
    const candidate = completedBeforeEntry[index];
    if (candidate.dry !== true) break;
    if (typeof candidate.lens === 'string' && candidate.lens) finalDryLenses.add(candidate.lens);
  }
  for (const lens of dryLenses) {
    if (!finalDryLenses.has(lens)) {
      errors.push(`P5 evidence is incomplete: dry lens ${lens} is not in the final dry streak`);
    }
  }
  if (finalDryLenses.size < 3) {
    errors.push('P5 evidence is incomplete: final dry streak requires at least three distinct dry lenses');
  }
  errors.push(...openP5FindingErrors(entries, ticket, revision, entries.indexOf(entry)));
  return errors;
}

function findingId(entry) {
  return typeof entry.finding?.id === 'string' && entry.finding.id.length > 0
    ? entry.finding.id
    : null;
}

function findingIdentity(entry) {
  const finding = entry.finding;
  if (!finding || typeof finding !== 'object') return null;
  return sha256(canonicalJson({
    id: finding.id ?? null,
    file: finding.file ?? null,
    line_start: finding.line_start ?? null,
    line_end: finding.line_end ?? null,
    category: finding.category ?? null,
    claim: finding.claim ?? null,
    evidence: finding.evidence ?? null,
  }));
}

function openP5FindingErrors(entries, ticket, revision, completionIndex) {
  const openTypes = new Set(['p5-finding-verified', 'p5-finding-needs-human']);
  const errors = [];
  entries.forEach((entry, index) => {
    const type = entryType(entry);
    if (!openTypes.has(type) || !matchesTicket(entry, ticket) || !matchesRevision(entry, revision)) return;
    const id = findingId(entry);
    if (!id) {
      errors.push(`P5 evidence is contradictory: unresolved ${type} without finding.id`);
      return;
    }
    const identity = findingIdentity(entry);
    const killedBeforeCompletion = entries.slice(index + 1, completionIndex).some((candidate) =>
      entryType(candidate) === 'p5-finding-killed' &&
      matchesTicket(candidate, ticket) &&
      matchesRevision(candidate, revision) &&
      findingIdentity(candidate) === identity
    );
    if (!killedBeforeCompletion) {
      errors.push(`P5 evidence is contradictory: unresolved ${type} ${id}`);
    }
  });
  return errors;
}

function p6ArtifactPaths(entries, ticket, cwd) {
  return [
    ...entries
      .filter((entry) => entryType(entry) === 'p6-acceptance-packet' && matchesTicket(entry, ticket))
      .map((entry) => entry.packet)
      .filter(Boolean)
      .filter((path) => isEvidencePath(cwd, path)),
    ...entries
      .filter((entry) => entryType(entry) === 'p6-acceptance-packet' && matchesTicket(entry, ticket))
      .flatMap((entry) => Array.isArray(entry.artifactPaths) ? entry.artifactPaths : [])
      .filter(Boolean)
      .filter((path) => isEvidencePath(cwd, path)),
  ];
}

function manifestArtifactPaths(cwd, dir) {
  const root = resolve(cwd, dir);
  return [join(root, 'manifest.jsonl'), join(root, 'manifest.lock'), join(root, 'tickets.json')];
}

function latestP6Entry(entries, ticket, revision) {
  return entries
    .filter((entry) => entryType(entry) === 'p6-acceptance-packet' && matchesTicket(entry, ticket))
    .filter((entry) => revision === undefined || entry.revision === revision)
    .at(-1);
}

function hashIntegrityError(label, path, expectedHash) {
  try {
    const content = readFileSync(path);
    if (sha256(content) === expectedHash) return null;
    return `P6 evidence is stale: ${label} hash changed after acceptance: ${path}`;
  } catch (err) {
    return `P6 evidence is stale: ${label} cannot be read: ${path}: ${err.message}`;
  }
}

function p6IntegrityErrors(entry) {
  if (!entry) return [];
  const errors = [];
  if (!entry.packet || typeof entry.packet !== 'string') {
    errors.push('P6 evidence is incomplete: acceptance packet missing packet path');
  }
  if (!entry.packetHash || typeof entry.packetHash !== 'string') {
    errors.push('P6 evidence is incomplete: acceptance packet missing packetHash');
  }
  if (entry.packet && entry.packetHash) {
    const error = hashIntegrityError('packet', entry.packet, entry.packetHash);
    if (error) errors.push(error);
  }
  const artifactPaths = Array.isArray(entry.artifactPaths) ? entry.artifactPaths : [];
  const artifactHashes = Array.isArray(entry.artifactHashes) ? entry.artifactHashes : [];
  if (artifactPaths.length !== artifactHashes.length) {
    errors.push('P6 evidence is incomplete: artifact paths and hashes differ');
  }
  for (const artifact of artifactHashes) {
    if (!artifact?.path || typeof artifact.path !== 'string') {
      errors.push('P6 evidence is incomplete: artifact hash entry missing path');
      continue;
    }
    if (!artifact.hash || typeof artifact.hash !== 'string') {
      errors.push(`P6 evidence is incomplete: artifact hash entry missing hash: ${artifact.path}`);
      continue;
    }
    const error = hashIntegrityError('artifact', artifact.path, artifact.hash);
    if (error) errors.push(error);
  }
  return errors;
}

function latestRailCheckEntry(entries, ticket, revision) {
  return entries
    .filter((entry) => entryType(entry) === 'rails-check' && matchesTicket(entry, ticket))
    .filter((entry) => matchesRevision(entry, revision))
    .at(-1);
}

function p4IntegrityErrors(entries, ticket, revision, cwd) {
  const entry = latestRailCheckEntry(entries, ticket, revision);
  if (!entry) return [];
  const errors = [];
  if (entry.railsDiffEmpty !== true) {
    errors.push('P4 evidence is incomplete: rails-check missing railsDiffEmpty=true');
  }
  if (entry.suppressionsClean !== true) {
    errors.push('P4 evidence is incomplete: rails-check missing suppressionsClean=true');
  }
  if (!entry.railFiles || typeof entry.railFiles !== 'object' || Array.isArray(entry.railFiles)) {
    errors.push('P4 evidence is incomplete: rails-check missing railFiles hash snapshot');
    return errors;
  }
  const railPaths = Object.keys(entry.railFiles);
  if (railPaths.length === 0) {
    errors.push('P4 evidence is incomplete: rails-check railFiles snapshot is empty');
    return errors;
  }
  const currentHashes = hashFiles(railPaths, (path) => readFileSync(resolve(cwd, path)));
  for (const path of railPaths) {
    if (typeof entry.railFiles[path] !== 'string') {
      errors.push(`P4 evidence is incomplete: rails-check missing hash for ${path}`);
      continue;
    }
    if (currentHashes[path] !== entry.railFiles[path]) {
      errors.push(`P4 evidence is stale: rail file hash changed after rails-check: ${path}`);
    }
  }
  return errors;
}

export function requirementsForPhase(phase) {
  return PHASE_REQUIREMENTS[phase] ?? null;
}

export function assertPhase(phase, { dir = ADLC_DIR, ticket, revision, cwd = process.cwd() } = {}) {
  const requirements = requirementsForPhase(phase);
  if (requirements === null) {
    return { ok: false, operational: true, phase, errors: [`unknown phase: ${phase}`] };
  }
  if (requiresTicket(phase) && !ticket) {
    return { ok: false, operational: true, phase, errors: [`${phase} requires --ticket`] };
  }

  const { entries, skipped } = readEntries('manifest', dir);
  const hasExplicitRevision = revision !== undefined && revision !== null && String(revision).trim() !== '';
  const explicitRevision = hasExplicitRevision ? String(revision) : undefined;
  const latestScopedP5Revision = requiresRevision(phase) ? latestP5Revision(entries, ticket) : null;
  const p5Revision = phase === 'p6' && !explicitRevision ? latestScopedP5Revision : null;
  const assertedP5Entry = requiresRevision(phase)
    ? latestP5Entry(entries, ticket, explicitRevision ?? latestScopedP5Revision ?? undefined)
    : null;
  const p5TranscriptEvidencePaths = p5TranscriptPaths(assertedP5Entry, cwd);
  const p5ReviewPacketEvidencePaths = p5ReviewPacketPaths(assertedP5Entry, cwd);
  const ignoredEvidencePaths = phase === 'p6'
    ? [...manifestArtifactPaths(cwd, dir), ...p5TranscriptEvidencePaths, ...p5ReviewPacketEvidencePaths, ...p6ArtifactPaths(entries, ticket, cwd)]
    : [...manifestArtifactPaths(cwd, dir), ...p5TranscriptEvidencePaths, ...p5ReviewPacketEvidencePaths];
  const liveWorktreeRevision = requiresRevision(phase) && !explicitRevision
    ? resolveRevision({ cwd, ignorePaths: ignoredEvidencePaths })
    : null;
  const currentRevision = requiresRevision(phase)
    ? explicitRevision ?? liveWorktreeRevision
    : revision;
  const p5TicketHash = assertedP5Entry?.ticketHash ?? null;
  const currentTicketHash = assertedP5Entry ? ticketDefinitionHash(cwd, ticket, dir) : null;
  const ticketStaleError = assertedP5Entry
    ? staleTicketDefinitionError(p5TicketHash, currentTicketHash)
    : null;
  const transcriptErrors = [
    ...transcriptIntegrityErrors(assertedP5Entry),
    ...historicalTranscriptIntegrityErrors(entries, assertedP5Entry, ticket, cwd),
  ];
  const p5CompletionErrors = p5CompletionIntegrityErrors(entries, assertedP5Entry, ticket, assertedP5Entry?.revision);
  const assertedRevisionForLiveCheck = requiresRevision(phase) && !explicitRevision
    ? latestScopedP5Revision
    : null;
  if (requiresRevision(phase) && assertedRevisionForLiveCheck && !liveWorktreeRevision) {
    return {
      ok: false,
      operational: true,
      phase,
      ticket,
      revision: assertedRevisionForLiveCheck,
      currentRevision: liveWorktreeRevision,
      errors: [`current worktree revision could not be resolved while P5 evidence exists at ${assertedRevisionForLiveCheck}`],
    };
  }
  if (requiresRevision(phase) && assertedRevisionForLiveCheck && liveWorktreeRevision && assertedRevisionForLiveCheck !== liveWorktreeRevision) {
    return {
      ok: false,
      operational: true,
      phase,
      ticket,
      revision: assertedRevisionForLiveCheck,
      currentRevision: liveWorktreeRevision,
      errors: [`P5 evidence is stale: recorded ${assertedRevisionForLiveCheck}, current worktree is ${liveWorktreeRevision}`],
    };
  }
  if (requiresRevision(phase) && ticketStaleError) {
    return {
      ok: false,
      operational: true,
      phase,
      ticket,
      revision: p5Revision ?? currentRevision,
      currentRevision,
      errors: [ticketStaleError],
    };
  }
  if (requiresRevision(phase) && transcriptErrors.length > 0) {
    return {
      ok: false,
      operational: true,
      phase,
      ticket,
      revision: p5Revision ?? currentRevision,
      currentRevision,
      errors: transcriptErrors,
    };
  }
  if (requiresRevision(phase) && p5CompletionErrors.length > 0) {
    return {
      ok: false,
      operational: true,
      phase,
      ticket,
      revision: p5Revision ?? currentRevision,
      currentRevision,
      errors: p5CompletionErrors,
    };
  }
  const resolvedRevision = phase === 'p6' && !revision
    ? p5Revision ?? currentRevision
    : requiresRevision(phase)
      ? currentRevision
      : revision;
  const p6Errors = phase === 'p6' && assertedP5Entry
    ? p6IntegrityErrors(latestP6Entry(entries, ticket, resolvedRevision))
    : [];
  const p4Errors = phase === 'p4'
    ? p4IntegrityErrors(entries, ticket, resolvedRevision, cwd)
    : [];
  if (p6Errors.length > 0) {
    return {
      ok: false,
      operational: true,
      phase,
      ticket,
      revision: resolvedRevision,
      currentRevision,
      errors: p6Errors,
    };
  }
  if (p4Errors.length > 0) {
    return {
      ok: false,
      operational: true,
      phase,
      ticket,
      revision: resolvedRevision,
      errors: p4Errors,
    };
  }
  if (requiresRevision(phase) && !resolvedRevision) {
    return {
      ok: false,
      operational: true,
      phase,
      ticket,
      errors: [`${phase} requires a git worktree revision or --revision`],
    };
  }

  const present = new Set(
    entries
      .filter((entry) => matchesTicket(entry, ticket))
      .filter((entry) => matchesRevision(entry, resolvedRevision))
      .map((entry) => entryType(entry))
      .filter(Boolean)
  );
  const missing = requirements.filter((type) => !present.has(type));

  return {
    ok: missing.length === 0 && skipped.length === 0,
    operational: false,
    phase,
    ticket,
    revision: resolvedRevision,
    required: requirements,
    present: Array.from(present).sort(),
    missing,
    skipped,
  };
}

import { ADLC_DIR, canonicalJson, hashFiles, resolveRevision, sha256 } from '@adlc/core';
// Scoped to root + this checkout's own segment, NOT the whole forest: every
// `.at(-1)`, `indexOf`, and `slice` below reads array position as chronology,
// which is only true of a chain this checkout can place in sequence. See
// own-chain.mjs for why the forest's own order cannot carry that weight.
import { readOwnManifestChain } from '@adlc/gate-manifest/lib/own-chain.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { LegacyTicketStore, loadTicketSnapshot } from '@adlc/tickets';

const PHASE_REQUIREMENTS = {
  p0: ['coldstart'],
  p1: ['spec-lint', 'premortem', 'spec-approval'],
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

export function requiresTicket(phase) {
  return phase === 'p0' || phase === 'p1' || phase === 'p3' || phase === 'p4' || phase === 'p5' || phase === 'p6';
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

function ticketDefinitionBinding(cwd, ticket, dir) {
  try {
    const customPath = resolve(cwd, dir, 'tickets.json');
    const snapshot = customPath !== resolve(cwd, '.adlc/tickets.json') && existsSync(customPath)
      ? new LegacyTicketStore(customPath).load()
      : loadTicketSnapshot({ root: cwd });
    return snapshot.get(ticket) ? { ticketHash: snapshot.ticketHashes[ticket], storeHash: snapshot.hash } : null;
  } catch { return null; }
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
  // manifest.d/ (T-MANIFEST-FOREST slice 3) is the segmented equivalent of
  // manifest.jsonl/manifest.lock — see prosecute/lib/run.mjs's identical
  // helper for the full rationale (adversarial-review finding: without this,
  // a segmented repo's evidence appends move the revision they are supposed
  // to attest).
  return [join(root, 'manifest.jsonl'), join(root, 'manifest.lock'), join(root, 'manifest.d'), join(root, 'tickets.json')];
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

function p6IntegrityErrors(entry, currentBinding) {
  if (!entry) return [];
  const errors = [];
  if (entry.bindingScope !== 'ticket' || typeof entry.ticketHash !== 'string' || typeof entry.storeHash !== 'string') {
    errors.push('P6 evidence is incomplete: acceptance packet requires ticketHash, storeHash, and ticket bindingScope');
  } else if (!currentBinding || entry.ticketHash !== currentBinding.ticketHash) {
    errors.push('P6 evidence is stale: accepted ticket definition changed or is absent');
  }
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

// P0's coldstart requirement is presence-only by default (any coldstart
// record anywhere satisfies it) unless this validator narrows it: bound to
// THIS ticket (not an --all sweep, which records no entry.ticket at all —
// see coldstart's bin/adlc-coldstart.mjs), a zero-gap verdict, and a
// ticketHash matching the CURRENT ticket definition (a ticket edited after
// coldstart ran must re-run it). Validates the LATEST matching coldstart
// entry, so a fixed re-run heals a failing one.
// coldstart records evidence in one of two shapes depending on how it ran:
//   live, provider-backed (packages/coldstart/lib/cache.mjs buildCacheData):
//     entry.data.cache = { ticketHash, model, gaps }
//   --prompt-only, operator-recorded (packages/coldstart/lib/verdict.mjs):
//     entry.data.verdict = '{"gaps":[...],"ticketHash":"…"}' (a JSON STRING,
//     matching the exact text the P0 authoring flow instructs writing before
//     --record-verdict)
// Both must be understood, or a real successful audit reads as a P0 failure.
function coldstartEvidenceShape(data) {
  if (data?.cache && typeof data.cache === 'object' && !Array.isArray(data.cache)) {
    return { gaps: data.cache.gaps, ticketHash: data.cache.ticketHash };
  }
  if (typeof data?.verdict === 'string') {
    let parsed;
    try {
      parsed = JSON.parse(data.verdict);
    } catch {
      return { parseError: true };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { parseError: true };
    return { gaps: parsed.gaps, ticketHash: parsed.ticketHash };
  }
  return null;
}

function coldstartIntegrityErrors(entries, ticket, cwd, dir) {
  const entry = entries
    .filter((candidate) => entryType(candidate) === 'coldstart' && candidate.ticket === ticket)
    .at(-1);
  if (!entry) return [];
  const shape = coldstartEvidenceShape(entry.data);
  if (shape === null) {
    return ['P0 evidence is incomplete: coldstart record has neither a live cache result (data.cache) nor a prompt-only verdict (data.verdict)'];
  }
  if (shape.parseError) {
    return ['P0 evidence is incomplete: coldstart verdict is not valid JSON (expected {"gaps":[...],"ticketHash":"…"})'];
  }
  const errors = [];
  if (!Array.isArray(shape.gaps)) {
    errors.push('P0 evidence is incomplete: coldstart record missing a gaps array');
  } else if (shape.gaps.length > 0) {
    errors.push(`P0 evidence is contradictory: coldstart recorded ${shape.gaps.length} unresolved gap(s)`);
  }
  const binding = ticketDefinitionBinding(cwd, ticket, dir);
  if (!binding) {
    errors.push('P0 evidence is stale: ticket definition is absent');
  } else if (shape.ticketHash !== binding.ticketHash) {
    errors.push('P0 evidence is stale: ticket definition changed after coldstart ran');
  }
  return errors;
}

// Gate 1 is a human decision with machine-checked evidence: the approval must
// carry the interrogation summary the protocol produced, an explicit approved
// verdict (not rejected, not missing), a non-empty human approver, a ticket
// binding, and exactly one bound spec file whose recorded hash matches both
// the payload's claimed spec_hash (the approver's stated hash is genuine, not
// fabricated) and the file's CURRENT content (the spec has not been edited
// since approval) — plus recording after the latest spec-lint/premortem
// evidence, so the approval covers the audited spec, not a pre-audit draft.
// Validates the LATEST spec-approval so a corrected re-approval heals a
// rejected one. Emitters: the adlc-approve-spec command in every harness
// plugin (updated atomically with this validator).
function specApprovalIntegrityErrors(entries, ticket, cwd) {
  const entry = entries
    .filter((candidate) => entryType(candidate) === 'spec-approval' && matchesTicket(candidate, ticket))
    .at(-1);
  if (!entry) return [];
  const errors = [];
  const data = entry.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return ['P1 evidence is incomplete: spec-approval missing interrogation payload (data)'];
  }
  if (data.verdict !== 'approved') {
    errors.push('P1 evidence is contradictory: spec-approval verdict is not "approved" (a rejected, pending, or missing verdict cannot pass Gate 1)');
  }
  if (typeof data.approver !== 'string' || data.approver.trim().length === 0) {
    errors.push('P1 evidence is incomplete: spec-approval missing a non-empty approver');
  }
  // No separate "is entry.ticket bound" check here: p1 now requires --ticket
  // (requiresTicket), and `entry` above was selected via matchesTicket(candidate,
  // ticket) — an entry with no matching ticket binding is never selected at
  // all, so it surfaces as "missing: spec-approval" instead, not a data error.
  if (!Number.isInteger(data.rounds) || data.rounds < 1) {
    errors.push('P1 evidence is incomplete: spec-approval missing a positive integer rounds (zero proves no interrogation activity)');
  }
  if (!Number.isInteger(data.questions) || data.questions < 1) {
    errors.push('P1 evidence is incomplete: spec-approval missing a positive integer questions (zero proves no interrogation activity)');
  }
  if (!Array.isArray(data.sources) || data.sources.length === 0) {
    errors.push('P1 evidence is incomplete: spec-approval sources must name at least one interrogation source actually consulted (an empty list proves nothing was checked)');
  } else if (!data.sources.every((source) => typeof source === 'string' && source.trim().length > 0)) {
    errors.push('P1 evidence is incomplete: spec-approval sources must be non-empty strings naming the interrogation source actually consulted');
  }
  if (data.unresolved !== 0) {
    errors.push('P1 evidence is contradictory: spec-approval requires unresolved === 0 (record unresolved divergences as approved_assumptions instead)');
  }
  if (data.approved_assumptions !== undefined && !Array.isArray(data.approved_assumptions)) {
    errors.push('P1 evidence is incomplete: spec-approval approved_assumptions must be an array');
  }

  const filePaths = Object.keys(entry.files ?? {});
  let path, recordedHash;
  if (filePaths.length !== 1) {
    errors.push('P1 evidence is incomplete: spec-approval must bind exactly one spec file via --files');
  } else {
    [path] = filePaths;
    recordedHash = entry.files[path];
    if (typeof data.spec_hash !== 'string' || data.spec_hash.length === 0) {
      errors.push('P1 evidence is incomplete: spec-approval missing spec_hash');
    } else if (recordedHash !== data.spec_hash) {
      errors.push('P1 evidence is contradictory: spec-approval spec_hash does not match the recorded file hash');
    }
    try {
      const currentHash = sha256(readFileSync(resolve(cwd, path)));
      if (currentHash !== recordedHash) {
        errors.push(`P1 evidence is stale: spec file changed after approval was recorded: ${path}`);
      }
    } catch (err) {
      errors.push(`P1 evidence is stale: spec file cannot be read: ${path}: ${err.message}`);
    }
  }

  // Scoped to THIS ticket, not "latest anywhere in the manifest" — otherwise
  // ticket T2's approval could borrow ticket T1's spec-lint/premortem audits
  // (P1 D4). p1 is ticket-required (see requiresTicket) specifically so this
  // scoping is always meaningful, never a silent no-op over the whole ledger.
  //
  // Ticket-scoping alone still lets the SAME ticket launder a stale or
  // different spec: T1 lints spec-A.md, then approves an edited spec-A.md or
  // an entirely different spec-B.md without re-running spec-lint/premortem
  // (codex cross-model review round 2). So beyond ordering, each audit's OWN
  // --files binding must name the exact same (path, hash) the approval
  // bound — and a hand-crafted `gate-manifest record spec-lint` with no
  // --files at all (or spec-lint's own verified:false) must not count either.
  const entryIndex = entries.indexOf(entry);
  const latestSpecLint = entries.reduce((acc, e, i) => (entryType(e) === 'spec-lint' && matchesTicket(e, ticket) ? { entry: e, index: i } : acc), null);
  const latestPremortem = entries.reduce((acc, e, i) => (entryType(e) === 'premortem' && matchesTicket(e, ticket) ? { entry: e, index: i } : acc), null);

  // Path comparison is by RESOLVED absolute location, not raw string —
  // codex cross-model review, round 4: Pi resolves its approval argument to
  // an absolute path before recording, while the documented spec-lint/
  // premortem commands pass through whatever spelling (often relative) the
  // caller typed. The same file audited via two different, both-legitimate
  // spellings must still match.
  function auditMatchesApprovedSpec(audit) {
    if (!path) return true; // approval's own file binding already flagged above; don't double-report
    const auditPaths = Object.keys(audit.entry.files ?? {});
    if (auditPaths.length !== 1) return false;
    const [auditPath] = auditPaths;
    return resolve(cwd, auditPath) === resolve(cwd, path) && audit.entry.files[auditPath] === recordedHash;
  }

  if (!latestSpecLint || entryIndex < latestSpecLint.index) {
    errors.push('P1 evidence is stale: spec-approval was recorded before the latest spec-lint evidence for this ticket');
  } else {
    if (!auditMatchesApprovedSpec(latestSpecLint)) {
      errors.push('P1 evidence is contradictory: the latest spec-lint evidence for this ticket does not audit the approved spec file');
    }
    if (latestSpecLint.entry.data?.verified !== true) {
      errors.push('P1 evidence is incomplete: the latest spec-lint evidence for this ticket is not a verified (passing) result');
    }
  }
  if (!latestPremortem || entryIndex < latestPremortem.index) {
    errors.push('P1 evidence is stale: spec-approval was recorded before the latest premortem evidence for this ticket');
  } else if (!auditMatchesApprovedSpec(latestPremortem)) {
    errors.push('P1 evidence is contradictory: the latest premortem evidence for this ticket does not analyze the approved spec file');
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

export function allPhases() {
  return Object.keys(PHASE_REQUIREMENTS);
}

export function assertPhase(phase, { dir = ADLC_DIR, ticket, revision, cwd = process.cwd() } = {}) {
  const requirements = requirementsForPhase(phase);
  if (requirements === null) {
    return { ok: false, operational: true, phase, errors: [`unknown phase: ${phase}`] };
  }
  if (requiresTicket(phase) && !ticket) {
    return { ok: false, operational: true, phase, errors: [`${phase} requires --ticket`] };
  }

  const { entries, skipped } = readOwnManifestChain(dir, { cwd });
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
  const currentBinding = assertedP5Entry ? ticketDefinitionBinding(cwd, ticket, dir) : null;
  const currentTicketHash = currentBinding?.ticketHash ?? null;
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
    ? p6IntegrityErrors(latestP6Entry(entries, ticket, resolvedRevision), currentBinding)
    : [];
  const p4Errors = phase === 'p4'
    ? p4IntegrityErrors(entries, ticket, resolvedRevision, cwd)
    : [];
  // operational: false — an unresolved gap, a rejected verdict, or stale
  // evidence is a normal, expected GATE rejection with concrete reasons
  // (exit 2), not an infrastructure failure that couldn't be evaluated at
  // all (exit 1). Codex cross-model review, round 4: the CLI's opError-on-
  // operational path exits 1 for these, which misreports a fixable content
  // problem as an outage to any automation branching on exit code.
  const p1Errors = phase === 'p1'
    ? specApprovalIntegrityErrors(entries, ticket, cwd)
    : [];
  if (p1Errors.length > 0) {
    return {
      ok: false,
      operational: false,
      phase,
      ticket,
      errors: p1Errors,
    };
  }
  const p0Errors = phase === 'p0' && ticket
    ? coldstartIntegrityErrors(entries, ticket, cwd, dir)
    : [];
  if (p0Errors.length > 0) {
    return {
      ok: false,
      operational: false,
      phase,
      ticket,
      errors: p0Errors,
    };
  }
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

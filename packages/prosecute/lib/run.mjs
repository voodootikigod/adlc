import { ADLC_DIR, canonicalJson, resolveChangeSetRevision, untrackedNonIgnoredPaths, sha256 } from '@adlc/core';
import { readManifestForest } from '@adlc/gate-manifest/lib/forest.mjs';
import { appendManifestEntry } from '@adlc/gate-manifest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { validateInput } from './schema.mjs';
import { hasCrossModelApprove } from './cross-model.mjs';
import { LegacyTicketStore, loadTicketSnapshot } from '@adlc/tickets';

function now() {
  return new Date().toISOString();
}

function writeEvidence(type, data, dir) {
  return appendManifestEntry({ ts: now(), type, ...data }, dir);
}

function manifestArtifactPaths(cwd, dir) {
  const root = resolve(cwd, dir);
  return [join(root, 'manifest.jsonl'), join(root, 'manifest.lock'), join(root, 'tickets.json')];
}

function isInsideCwd(cwd, absolute) {
  const rel = relative(cwd, absolute).replaceAll('\\', '/');
  return rel !== '' && !rel.startsWith('../') && rel !== '..';
}

function isEvidencePath(cwd, absolute) {
  const rel = relative(cwd, absolute).replaceAll('\\', '/');
  return rel.startsWith('.adlc/') || rel.startsWith('.omo/evidence/');
}

export function revisionIgnorePaths(cwd, dir, input, inputPath) {
  return [
    ...manifestArtifactPaths(cwd, dir),
    inputPath ? resolve(cwd, inputPath) : null,
    input?.provenance?.transcript ? resolve(cwd, input.provenance.transcript) : null,
    input?.review_packet?.prompt ? resolve(cwd, input.review_packet.prompt) : null,
    input?.review_packet?.inputs ? resolve(cwd, input.review_packet.inputs) : null,
  ].filter(Boolean);
}

/**
 * Resolve the reviewed revision exactly as runProsecution does, so a cross-model
 * attestation recorded via the CLI binds to the SAME revision string the gate
 * later checks. Pass the identical { cwd, dir, base, revision, input, inputPath } to
 * all three paths (see bin/adlc-prosecute.mjs record-cross-model and tier-check) —
 * Base resolution is single-sourced here rather than re-derived per consumer.
 *
 * `base` defaults to 'main', matching the CLI's `--base` default, so a caller that
 * omits it (as most direct runProsecution() callers do) still gets the SAME base a
 * bare `adlc-prosecute` invocation would use.
 */
export function resolveProsecutionRevision({ cwd = process.cwd(), dir = ADLC_DIR, base = 'main', revision, input, inputPath } = {}) {
  const ignorePaths = revisionIgnorePaths(cwd, dir, input, inputPath);
  return resolveChangeSetRevision({ cwd, base, revision, ignorePaths });
}

function ticketDefinitionHash(cwd, ticket, dir) {
  try {
    const customPath = resolve(cwd, dir, 'tickets.json');
    const snapshot = customPath !== resolve(cwd, '.adlc/tickets.json') && existsSync(customPath)
      ? new LegacyTicketStore(customPath).load()
      : loadTicketSnapshot({ root: cwd });
    return snapshot.get(ticket) ? { ticketHash: snapshot.ticketHashes[ticket], storeHash: snapshot.hash } : null;
  } catch { return null; }
}

function transcriptReferencesTicket(text, ticket) {
  return text
    .split(/\r?\n/)
    .some((line) => {
      const match = line.match(/^\s*ticket\s*:\s*(.+?)\s*$/i);
      return match?.[1] === ticket;
    });
}

function transcriptProof(transcript, cwd, { ticket, revision }) {
  try {
    const absolute = resolve(cwd, transcript);
    const stat = statSync(absolute);
    if (!stat.isFile()) return `provenance.transcript is not a file: ${transcript}`;
    if (isInsideCwd(cwd, absolute) && !isEvidencePath(cwd, absolute)) {
      return `provenance.transcript inside the worktree must live under .adlc/ or .omo/evidence/: ${transcript}`;
    }
    if (stat.size < 64) return `provenance.transcript is too small to serve as review evidence: ${transcript}`;
    const content = readFileSync(absolute);
    const text = content.toString('utf8');
    if (!transcriptReferencesTicket(text, ticket)) {
      return `provenance.transcript must reference ticket ${ticket}: ${transcript}`;
    }
    if (!text.includes(revision)) {
      return `provenance.transcript must reference reviewed revision ${revision}: ${transcript}`;
    }
    return { path: absolute, hash: sha256(content) };
  } catch (err) {
    return `provenance.transcript cannot be read: ${transcript}: ${err.message}`;
  }
}

function artifactProof(path, expectedHash, cwd, label) {
  try {
    const absolute = resolve(cwd, path);
    const stat = statSync(absolute);
    if (!stat.isFile()) return `${label} is not a file: ${path}`;
    if (isInsideCwd(cwd, absolute) && !isEvidencePath(cwd, absolute)) {
      return `${label} inside the worktree must live under .adlc/ or .omo/evidence/: ${path}`;
    }
    const content = readFileSync(absolute);
    const actualHash = sha256(content);
    if (actualHash !== expectedHash) {
      return `${label} hash mismatch: ${path}`;
    }
    return { path: absolute, hash: actualHash };
  } catch (err) {
    return `${label} cannot be read: ${path}: ${err.message}`;
  }
}

function reviewPacketProof(packet, cwd, revision) {
  const errors = [];
  const prompt = artifactProof(packet.prompt, packet.prompt_hash, cwd, 'review_packet.prompt');
  const inputs = artifactProof(packet.inputs, packet.inputs_hash, cwd, 'review_packet.inputs');
  if (typeof prompt === 'string') errors.push(prompt);
  if (typeof inputs === 'string') errors.push(inputs);
  if (packet.clean_worktree !== revision) {
    errors.push(`review_packet.clean_worktree must equal reviewed revision ${revision}`);
  }
  if (errors.length > 0) return errors;
  return {
    prompt,
    inputs,
    cleanWorktree: packet.clean_worktree,
  };
}

function finalDryLenses(passResults) {
  const lenses = new Set();
  for (let index = passResults.length - 1; index >= 0; index -= 1) {
    const pass = passResults[index];
    if (!pass.dry) break;
    lenses.add(pass.lens);
  }
  return lenses;
}

function classifyPass(pass) {
  const verified = pass.findings.filter((f) => f.verified_status === 'verified');
  const needsHuman = pass.findings.filter((f) => f.verified_status === 'needs-human');
  const killed = pass.findings.filter((f) => f.verified_status === 'killed');
  const dry = pass.findings.length === 0;
  return { verified, needsHuman, killed, dry };
}

function findingIdentity(finding) {
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

function seedOpenFindingsFromManifest(dir, ticket, revision) {
  const openFindings = new Map();
  const { entries } = readManifestForest(dir);
  for (const entry of entries) {
    if (entry.ticket !== ticket || entry.revision !== revision || !entry.finding) continue;
    const type = entry.type ?? entry.gate;
    const identity = findingIdentity(entry.finding);
    if (type === 'p5-finding-verified' || type === 'p5-finding-needs-human') {
      openFindings.set(identity, entry.finding);
    }
    if (type === 'p5-finding-killed') {
      openFindings.delete(identity);
    }
  }
  return openFindings;
}

export function runProsecution(input, {
  ticket,
  dir = ADLC_DIR,
  target = input?.target ?? 'working tree',
  base = 'main',
  revision,
  inputPath,
  cwd = process.cwd(),
  requireCrossModel = false,
  authorProvider,
} = {}) {
  const errors = validateInput(input);
  if (!ticket) errors.push('ticket is required for P5 evidence');
  // FAIL CLOSED: a trust-root-tier prosecution cannot prove the reviewer was a
  // DISTINCT provider without knowing who the author is. The author identity must
  // come from the prosecution invocation (--author-provider / ADLC_AUTHOR_PROVIDER),
  // never from the attestation (which the author fully controls).
  if (requireCrossModel && (typeof authorProvider !== 'string' || authorProvider.trim() === '')) {
    errors.push('trust-root-tier prosecution requires --author-provider (or ADLC_AUTHOR_PROVIDER) to anchor author identity for the cross-model gate');
  }
  const resolvedRevision = resolveProsecutionRevision({ cwd, dir, base, revision, input, inputPath });
  // #365 Decision 2 / AC15 — refuse to attest while an untracked-and-NOT-ignored file is
  // present. The change-set identity deliberately excludes untracked files, so without this
  // runtime check an untracked scratch file could change what a review actually observed
  // without moving the identity at all. Same ignorePaths as the identity, so the manifest
  // itself, an --input file, and review evidence never trigger it.
  //
  // Skipped when `revision` is EXPLICIT (matching resolveChangeSetRevision's own short-circuit):
  // an explicit revision is not auto-resolved from the working tree at all, so the rationale for
  // this refusal — the identity silently disagreeing with what was executed — does not apply. A
  // caller naming its own revision has already taken responsibility for what it means.
  const revisionIsExplicit = revision !== undefined && revision !== null && String(revision).trim() !== '';
  if (!revisionIsExplicit) {
    try {
      const untrackedPaths = untrackedNonIgnoredPaths({ cwd, ignorePaths: revisionIgnorePaths(cwd, dir, input, inputPath) });
      if (untrackedPaths.length > 0) {
        errors.push(`refusing to attest: untracked, non-ignored file(s) present in the working tree — ${untrackedPaths.join(', ')}`);
      }
    } catch (err) {
      errors.push(`cannot verify the working tree is free of untracked files: ${err.message}`);
    }
  }
  const ticketBinding = ticket ? ticketDefinitionHash(cwd, ticket, dir) : null;
  const ticketHash = ticketBinding?.ticketHash ?? null;
  const storeHash = ticketBinding?.storeHash ?? null;
  const binding = { ticketHash, storeHash, bindingScope: 'ticket' };
  if (ticket && !ticketBinding) errors.push(`ticket definition not found for ${ticket}; define it in the active ADLC ticket store`);
  if (!resolvedRevision) errors.push('revision could not be resolved; pass --revision or run inside a git worktree');
  let transcript;
  let reviewPacket;
  if (input?.provenance?.transcript) {
    transcript = transcriptProof(input.provenance.transcript, cwd, {
      ticket: ticket ?? '',
      revision: resolvedRevision ?? '',
    });
    if (typeof transcript === 'string') errors.push(transcript);
  }
  if (input?.review_packet && resolvedRevision) {
    reviewPacket = reviewPacketProof(input.review_packet, cwd, resolvedRevision);
    if (Array.isArray(reviewPacket)) errors.push(...reviewPacket);
  }
  if (errors.length > 0) {
    return { status: 'op-error', exitCode: 1, errors };
  }
  const inputEvidencePath = inputPath ? resolve(cwd, inputPath) : null;

  let consecutiveDry = 0;
  const passResults = [];
  const openFindings = seedOpenFindingsFromManifest(dir, ticket, resolvedRevision);

  for (const [index, pass] of input.passes.entries()) {
    const passNo = index + 1;
    writeEvidence('p5-pass-started', {
      ticket,
      target,
      revision: resolvedRevision,
      pass: passNo,
      lens: pass.lens,
      provenance: input.provenance,
      transcript,
      reviewPacket,
      inputPath: inputEvidencePath,
      ticketHash,
      storeHash,
      bindingScope: 'ticket',
    }, dir);

    for (const finding of pass.findings) {
      writeEvidence('p5-finding-raw', {
        ticket,
        target,
        revision: resolvedRevision,
        pass: passNo,
        lens: pass.lens,
        finding,
        ...binding,
      }, dir);
      writeEvidence(`p5-finding-${finding.verified_status}`, {
        ticket,
        target,
        revision: resolvedRevision,
        pass: passNo,
        lens: pass.lens,
        finding,
        ...binding,
      }, dir);
    }

    const result = classifyPass(pass);
    if (result.dry) {
      consecutiveDry += 1;
      writeEvidence('p5-dry-pass', {
        ticket,
        target,
        revision: resolvedRevision,
        pass: passNo,
        lens: pass.lens,
        consecutiveDry,
        dryEvidence: pass.dry_evidence ?? null,
        ...binding,
      }, dir);
    } else {
      consecutiveDry = 0;
      for (const finding of pass.findings) {
        const identity = findingIdentity(finding);
        if (finding.verified_status === 'verified' || finding.verified_status === 'needs-human') {
          openFindings.set(identity, finding);
        }
        if (finding.verified_status === 'killed') {
          openFindings.delete(identity);
        }
      }
    }

    writeEvidence('p5-pass-completed', {
      ticket,
      target,
      revision: resolvedRevision,
      pass: passNo,
      lens: pass.lens,
      dry: result.dry,
      verified: result.verified.length,
      killed: result.killed.length,
      needsHuman: result.needsHuman.length,
      consecutiveDry,
      ...binding,
    }, dir);

    passResults.push({
      pass: passNo,
      lens: pass.lens,
      dry: result.dry,
      verified: result.verified.length,
      killed: result.killed.length,
      needsHuman: result.needsHuman.length,
      consecutiveDry,
    });

  }

  const dryLenses = finalDryLenses(passResults);
  if (consecutiveDry >= 2 && openFindings.size === 0 && dryLenses.size >= 3) {
    // Trust-root tier: a clean same-model P5 is not sufficient. Require a
    // cross-model adversarial approve from a DISTINCT provider, bound to this
    // revision. Missing -> gate-fail (exit 2), never a silent pass.
    if (requireCrossModel && !hasCrossModelApprove({ dir, ticket, revision: resolvedRevision, authorProvider })) {
      writeEvidence('p5-cross-model-missing', {
        ticket,
        target,
        revision: resolvedRevision,
        pass: passResults.length,
        consecutiveDry,
        dryLenses: Array.from(dryLenses).sort(),
      }, dir);
      return {
        status: 'gate-fail',
        exitCode: 2,
        target,
        ticket,
        revision: resolvedRevision,
        passes: passResults,
        openFindings: [],
        message: `P5 incomplete: trust-root-tier change requires a cross-model adversarial approve from a distinct provider, recorded at revision ${resolvedRevision}`,
      };
    }
    writeEvidence('p5-complete', {
      ticket,
      target,
      revision: resolvedRevision,
      pass: passResults.length,
      consecutiveDry,
      provenance: input.provenance,
      transcript,
      reviewPacket,
      inputPath: inputEvidencePath,
      dryLenses: Array.from(dryLenses).sort(),
      ticketHash,
      storeHash,
      bindingScope: 'ticket',
    }, dir);
    return {
      status: 'pass',
      exitCode: 0,
      target,
      ticket,
      revision: resolvedRevision,
      passes: passResults,
      openFindings: [],
      message: 'P5 review evidence complete: two consecutive dry passes and three distinct dry lenses recorded',
    };
  }

  return {
    status: 'gate-fail',
    exitCode: 2,
    target,
    ticket,
    revision: resolvedRevision,
    passes: passResults,
    openFindings: Array.from(openFindings.values()),
    message: openFindings.size > 0
      ? 'P5 incomplete: verified or needs-human findings were seen at this revision'
      : consecutiveDry >= 2
        ? 'P5 incomplete: fewer than three distinct dry lenses were recorded'
        : 'P5 incomplete: convergence budget ended before two consecutive dry passes',
  };
}

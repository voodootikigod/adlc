import { appendEntry, ADLC_DIR, canonicalJson, readEntries, resolveRevision, sha256 } from '@adlc/core';
import { readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { validateInput } from './schema.mjs';

function now() {
  return new Date().toISOString();
}

function writeEvidence(type, data, dir) {
  return appendEntry('manifest', { ts: now(), type, ...data }, dir);
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

function revisionIgnorePaths(cwd, dir, input, inputPath) {
  return [
    ...manifestArtifactPaths(cwd, dir),
    inputPath ? resolve(cwd, inputPath) : null,
    input?.provenance?.transcript ? resolve(cwd, input.provenance.transcript) : null,
    input?.review_packet?.prompt ? resolve(cwd, input.review_packet.prompt) : null,
    input?.review_packet?.inputs ? resolve(cwd, input.review_packet.inputs) : null,
  ].filter(Boolean);
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
  const { entries } = readEntries('manifest', dir);
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
  revision,
  inputPath,
  cwd = process.cwd(),
} = {}) {
  const errors = validateInput(input);
  if (!ticket) errors.push('ticket is required for P5 evidence');
  const resolvedRevision = resolveRevision({
    cwd,
    revision,
    ignorePaths: revisionIgnorePaths(cwd, dir, input, inputPath),
  });
  const ticketHash = ticket ? ticketDefinitionHash(cwd, ticket, dir) : null;
  if (ticket && !ticketHash) errors.push(`ticket definition not found for ${ticket}; define it in .adlc/tickets.json`);
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
    }, dir);

    for (const finding of pass.findings) {
      writeEvidence('p5-finding-raw', {
        ticket,
        target,
        revision: resolvedRevision,
        pass: passNo,
        lens: pass.lens,
        finding,
      }, dir);
      writeEvidence(`p5-finding-${finding.verified_status}`, {
        ticket,
        target,
        revision: resolvedRevision,
        pass: passNo,
        lens: pass.lens,
        finding,
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

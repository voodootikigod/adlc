import { ADLC_DIR, canonicalJson, resolveChangeSetRevision, untrackedNonIgnoredPaths, sha256 } from '@adlc/core';
// Two readers, deliberately: the finding-lifecycle replay needs a causal order
// and so reads only this checkout's own chain (own-chain.mjs), while the usage
// ledger asks a position-free question — "has this call already been recorded
// ANYWHERE" — where reading the whole forest is the safe direction, since
// missing a record would double-count real spend.
import { readManifestForest } from '@adlc/gate-manifest/lib/forest.mjs';
import { readOwnManifestChain } from '@adlc/gate-manifest/lib/own-chain.mjs';
import { appendManifestEntry } from '@adlc/gate-manifest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { validateInput } from './schema.mjs';
import { hasCrossModelApprove } from './cross-model.mjs';
import { LegacyTicketStore, loadTicketSnapshot } from '@adlc/tickets';

function now() {
  return new Date().toISOString();
}

function writeEvidence(type, data, dir, cwd, key) {
  return appendManifestEntry({ ts: now(), type, ...data }, dir, { cwd, key });
}

function manifestArtifactPaths(cwd, dir) {
  const root = resolve(cwd, dir);
  // manifest.d/ (T-MANIFEST-FOREST slice 3: the segment writer) is the
  // segmented equivalent of manifest.jsonl/manifest.lock — ledger bookkeeping,
  // not reviewable code. Without this, a segmented repo's P5 evidence append
  // would change the tracked tree (new/modified segment file), moving the
  // very revision the NEXT evidence append (cross-model review, P6) has to
  // bind to — the same "evidence writes must not move the reviewed revision"
  // property manifest.jsonl already has, just unreached until a writer
  // existed to make manifest.d/ files real (adversarial-review finding).
  // Ignoring the whole directory (not just *.jsonl) also covers the
  // activation marker (.store.json) and .lineage/.lock, matching how root's
  // OWN cutover entry is likewise excluded via manifest.jsonl already being
  // ignored in full — the marker gets no separate reviewability manifest.jsonl's
  // entries don't already lack.
  return [join(root, 'manifest.jsonl'), join(root, 'manifest.lock'), join(root, 'manifest.d'), join(root, 'tickets.json')];
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

/**
 * Replay this ticket+revision's finding lifecycle to find what is still open.
 *
 * The replay is sequential — `set` on verified, `delete` on killed — so it is
 * only correct over entries whose ARRAY POSITION is a causal order. That is
 * why it reads `readOwnManifestChain` and not the whole forest: two segments
 * sort by anchor topology, so a kill written after a verification can arrive
 * BEFORE it in the forest array and `delete` an entry that has not been added
 * yet, leaving the finding open forever. See own-chain.mjs.
 *
 * An unrelated segment's findings are not this chain's to resolve — the branch
 * that owns them prosecutes them as ITS own chain.
 *
 * @returns {{openFindings: Map<string, object>, errors: string[]}} `errors` is
 *   non-empty when this checkout's own segment could not be identified. The
 *   caller must refuse rather than proceed on a partial replay: proceeding
 *   would seed FEWER open findings than really exist, which is exactly how a
 *   verified finding gets completed past.
 */
function seedOpenFindingsFromManifest(dir, ticket, revision, cwd) {
  const openFindings = new Map();
  const { entries, identityError } = readOwnManifestChain(dir, { cwd });
  if (identityError) return { openFindings, errors: [`refusing to prosecute: ${identityError}`] };
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
  return { openFindings, errors: [] };
}

/**
 * Identity of one external model call, for the usage carrier's exactly-once
 * guarantee (§8a).
 *
 * `callId` alone is not enough: two different prosecutions could reuse the same
 * caller-supplied id, and the same packet re-run against a different revision is
 * genuinely different spend. Binding the id to the revision and the packet's own
 * content hash means "the same call" is judged by what was actually reviewed.
 */
function usageCallKey(revision, packetHash, callId) {
  return `${revision ?? ''}\u0000${packetHash ?? ''}\u0000${callId}`;
}

/**
 * Usage already recorded on the ledger, keyed by call identity.
 *
 * Read once per run and consulted per pass, so a retry after a crash sees the
 * spend its predecessor recorded. Without this, every rerun of an unchanged
 * packet would append another carrier and inflate the phase total — silently,
 * because each individual entry would look perfectly well-formed.
 */
function recordedUsageByCall(dir) {
  const recorded = new Map();
  const { entries } = readManifestForest(dir);
  for (const entry of entries) {
    const key = entry?.data?.usageCallKey;
    if (typeof key === 'string' && entry?.data?.usage) recorded.set(key, entry.data.usage);
  }
  return recorded;
}

/**
 * Do two usage blocks describe the SAME call — counters AND provenance?
 *
 * Provenance is compared, not just the counters (adversarial-review). `model`
 * is what pricing multiplies the counters by, so "same tokens, different model"
 * is a genuinely different charge, not an idempotent replay. Treating it as a
 * replay silently retained the FIRST label, which both blocks a correction of a
 * mislabeled record and can suppress a real second call made after a model
 * change. Presence is significant too: gaining or losing a label is a change.
 */
function sameUsage(a, b) {
  const counters = ['inputTokens', 'outputTokens', 'cachedTokens'];
  const labels = ['provider', 'model', 'tier'];
  return counters.every((k) => (a?.[k] ?? 0) === (b?.[k] ?? 0))
    && labels.every((k) => (a?.[k] ?? null) === (b?.[k] ?? null));
}

/**
 * Decide what usage fields the pass-completed entry should carry (§8a).
 *
 * Four outcomes:
 *  - no usage reported  → `usageStatus: 'unreported'` and NO `usage` key. Never a
 *    zeroed object: `aggregateSpend` would count that as a measured free call,
 *    collapsing "unknown" into "free".
 *  - fresh usage        → the block plus `usageStatus: 'claimed'`. Never
 *    'reported' — shape validation cannot prove a provider actually emitted
 *    these counters, and 'reported' is reserved for adapter-attested telemetry.
 *  - already recorded, same spend → carry no usage again (the ledger keeps its
 *    original carrier), so a retry aggregates to exactly one call.
 *  - already recorded, different spend → conflict; the caller fails closed.
 */
/**
 * Identity of the reviewed packet, for the usage dedup key.
 *
 * BOTH hashes, not just `inputs_hash`: the review packet validates a
 * `prompt_hash` separately because the prompt is part of what was reviewed. Two
 * genuinely different model calls — same diff, revised security prompt — share
 * a revision and an inputs hash, so keying on inputs alone made them collide
 * whenever a caller reused a locally-scoped call id. The collision is not
 * benign in either direction: equal counters silently SUPPRESS the second real
 * call, and different counters REJECT it as a contradictory replay.
 *
 * `:` is a safe separator because both values are hex digests.
 */
function packetIdentity(reviewPacket) {
  const prompt = typeof reviewPacket?.prompt_hash === 'string' ? reviewPacket.prompt_hash : '';
  const inputs = typeof reviewPacket?.inputs_hash === 'string' ? reviewPacket.inputs_hash : '';
  if (prompt === '' && inputs === '') return null;
  return `${prompt}:${inputs}`;
}

/**
 * Find the first usage conflict across the WHOLE packet, touching nothing.
 *
 * Runs before any manifest append so a rejected packet is side-effect-free.
 * Checks both directions a contradiction can arrive from:
 *   - against the LEDGER, for a replay of a callId already recorded;
 *   - against EARLIER PASSES in this same packet, for two passes that claim
 *     the same callId with different counters — a packet that is internally
 *     inconsistent, which the per-pass check could never see because the first
 *     of the two had not been recorded yet when it ran.
 *
 * Returns the error string, or null when the packet is clean.
 */
function firstUsageConflict(passes, { revision, packetHash, recorded }) {
  const seen = new Map();
  for (const [index, pass] of (Array.isArray(passes) ? passes : []).entries()) {
    if (pass?.usage === undefined) continue;
    const hasCallId = typeof pass.callId === 'string' && pass.callId.trim().length > 0;
    if (!hasCallId) continue;
    const callKey = usageCallKey(revision, packetHash, pass.callId);
    const prior = seen.has(callKey) ? seen.get(callKey) : recorded.get(callKey);
    if (prior !== undefined && !sameUsage(prior, pass.usage)) {
      return `pass ${index + 1}: usage replay conflict for callId ${JSON.stringify(pass.callId)} — the ledger already `
        + `records ${JSON.stringify(prior)} for this call but the packet now reports `
        + `${JSON.stringify(pass.usage)}. Refusing to record contradictory spend for one model call.`;
    }
    if (prior === undefined) seen.set(callKey, pass.usage);
  }
  return null;
}

function usageCarrierFor({ pass, revision, packetHash, recorded }) {
  // Everything goes under `data`, because that is where the reader looks:
  // `aggregateSpend` reads `entry.data.usage`. A flat `usage` field would be
  // recorded faithfully and counted by nothing.
  const carrier = (data) => ({ payload: { gate: 'prosecute', data } });

  // `callKey`, never `key`: since T2 this module also threads `key`, the HMAC
  // key that SIGNS ledger entries. Two different secrets-adjacent meanings for
  // one name in one file is how a signing key ends up somewhere it should not
  // be. The recorded FIELD stays `usageCallKey` — that is on-ledger schema.
  if (pass?.usage === undefined) return { ...carrier({ usageStatus: 'unreported' }), callKey: null };

  const hasCallId = typeof pass.callId === 'string' && pass.callId.trim().length > 0;
  const callKey = hasCallId ? usageCallKey(revision, packetHash, pass.callId) : null;
  if (callKey && recorded.has(callKey)) {
    const recordedUsage = recorded.get(callKey);
    if (!sameUsage(recordedUsage, pass.usage)) return { conflict: true, recordedUsage, callKey };
    // Idempotent replay: the spend is already on the ledger, so this entry
    // records the status and a pointer, but NOT the counters again.
    return { ...carrier({ usageStatus: 'claimed', usageReplayOf: callKey }), callKey: null };
  }

  const data = { usage: pass.usage, usageStatus: 'claimed' };
  if (callKey) data.usageCallKey = callKey;
  return { ...carrier(data), callKey };
}

export function runProsecution(input, {
  ticket,
  key = null,
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
  const seeded = seedOpenFindingsFromManifest(dir, ticket, resolvedRevision, cwd);
  // Before the first append, like every other refusal in this function — see
  // the rollback note below: a rejected run must leave no trace.
  if (seeded.errors.length > 0) return { status: 'op-error', exitCode: 1, errors: seeded.errors };
  const openFindings = seeded.openFindings;
  // Packet identity for the usage carrier: the review packet's own inputs hash
  // when it has one, so "the same call" means the same reviewed content.
  const usagePacketHash = packetIdentity(input?.review_packet);
  const alreadyRecordedUsage = recordedUsageByCall(dir);

  // A REJECTED RUN MUST LEAVE NO TRACE. The manifest is append-only, so an
  // op-error returned from inside the pass loop cannot undo the pass-started,
  // finding, and dry-pass entries already written — and a stray
  // `p5-finding-killed` is not inert: seedOpenFindingsFromManifest consumes it
  // on the NEXT run and drops a previously verified finding, so a rejected
  // replay could retire a real finding and let a later dry pass approve.
  // Every usage conflict is therefore resolved BEFORE the first append
  // (adversarial-review CRITICAL, rollback).
  const usageConflict = firstUsageConflict(input.passes, {
    revision: resolvedRevision,
    packetHash: usagePacketHash,
    recorded: alreadyRecordedUsage,
  });
  if (usageConflict) {
    return { status: 'op-error', exitCode: 1, errors: [usageConflict] };
  }

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
    }, dir, cwd, key);

    for (const finding of pass.findings) {
      writeEvidence('p5-finding-raw', {
        ticket,
        target,
        revision: resolvedRevision,
        pass: passNo,
        lens: pass.lens,
        finding,
        ...binding,
      }, dir, cwd, key);
      writeEvidence(`p5-finding-${finding.verified_status}`, {
        ticket,
        target,
        revision: resolvedRevision,
        pass: passNo,
        lens: pass.lens,
        finding,
        ...binding,
      }, dir, cwd, key);
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
      }, dir, cwd, key);
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

    // §8a usage carrier. The pass-completed entry is the SOLE carrier for this
    // pass: one prosecution pass emits pass-started, a finding entry each, and
    // this one, and `aggregateSpend` counts a call per entry carrying
    // `data.usage` — so attaching it to more than one would multiply the pass's
    // spend by its entry count.
    //
    // `gate: 'prosecute'` is what makes the spend attributable: aggregateSpend
    // derives the phase from `PHASE_BY_GATE[entry.gate]`, and an entry without
    // it lands in `unphased` instead of P5. It is safe alongside `type` because
    // every existing reader resolves `entry.type ?? entry.gate`, so `type` still
    // wins for the P5 evidence assertions.
    const usageCarrier = usageCarrierFor({
      pass,
      revision: resolvedRevision,
      packetHash: usagePacketHash,
      recorded: alreadyRecordedUsage,
    });
    if (usageCarrier.conflict) {
      return {
        status: 'op-error',
        exitCode: 1,
        errors: [
          `pass ${passNo}: usage replay conflict for callId ${JSON.stringify(pass.callId)} — the ledger already ` +
            `records ${JSON.stringify(usageCarrier.recordedUsage)} for this call but the packet now reports ` +
            `${JSON.stringify(pass.usage)}. Refusing to record contradictory spend for one model call.`,
        ],
      };
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
      ...usageCarrier.payload,
    }, dir, cwd, key);
    if (usageCarrier.callKey) alreadyRecordedUsage.set(usageCarrier.callKey, pass.usage);

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
    if (requireCrossModel && !hasCrossModelApprove({ dir, ticket, revision: resolvedRevision, authorProvider, key })) {
      writeEvidence('p5-cross-model-missing', {
        ticket,
        target,
        revision: resolvedRevision,
        pass: passResults.length,
        consecutiveDry,
        dryLenses: Array.from(dryLenses).sort(),
      }, dir, cwd, key);
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
    }, dir, cwd, key);
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

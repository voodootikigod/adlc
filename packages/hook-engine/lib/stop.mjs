// stop.mjs — shared Stop / P5 gate combining @adlc/build-gate risk derivation
// and bounded, whole-forest chain + HMAC signature verification across root
// `.adlc/manifest.jsonl` and segmented `.adlc/manifest.d/*.jsonl` ledgers.

import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { computeRiskTier } from '@adlc/build-gate/lib/risk.mjs';
import { sha256 } from '@adlc/core';
import { record } from '@adlc/gate-manifest/lib/record.mjs';
import { verifyEntrySig } from '@adlc/gate-manifest/lib/sign.mjs';
import { verify as verifyManifest } from '@adlc/gate-manifest/lib/verify.mjs';
import { discoverSegments, segmentPath } from '@adlc/tickets/lib/manifest-primitives.mjs';
import { enclosingAdlcRoot, readActiveTicketRails } from './pretool.mjs';
import { harvestTranscriptUsage } from './spend-harvest.mjs';

export const MAX_MANIFEST_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_MANIFEST_SEGMENTS = 64;
export const MAX_MANIFEST_LINES = 50_000;

function readBoundedRegularFile(filePath, maxBytes = MAX_MANIFEST_FILE_BYTES) {
  const flags =
    fsConstants.O_RDONLY |
    (fsConstants.O_NOFOLLOW ?? 0) |
    (fsConstants.O_NONBLOCK ?? 0);
  let fd;
  try {
    fd = openSync(filePath, flags);
  } catch (err) {
    if (err?.code === 'ENOENT') return { status: 'absent', content: null };
    return { status: 'error', reason: `cannot open ${filePath}: ${err?.message ?? String(err)}` };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      return { status: 'error', reason: `${filePath} is not a regular file` };
    }
    if (st.size > maxBytes) {
      return { status: 'error', reason: `${filePath} exceeds ${maxBytes}-byte manifest scan bound` };
    }
    const buf = Buffer.allocUnsafe(st.size);
    let offset = 0;
    while (offset < st.size) {
      const n = readSync(fd, buf, offset, st.size - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    return { status: 'ok', content: buf.toString('utf8', 0, offset) };
  } finally {
    closeSync(fd);
  }
}

function parseStrictJsonl(filePath, { maxBytes = MAX_MANIFEST_FILE_BYTES, remainingLines }) {
  const read = readBoundedRegularFile(filePath, maxBytes);
  if (read.status === 'absent') return { ok: true, entries: [], linesRead: 0, error: null };
  if (read.status !== 'ok') return { ok: false, entries: [], linesRead: 0, error: read.reason };

  const entries = [];
  let linesRead = 0;
  for (const line of read.content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    linesRead += 1;
    if (linesRead > remainingLines) {
      return { ok: false, entries: [], linesRead, error: `manifest scan exceeded ${MAX_MANIFEST_LINES}-line bound` };
    }
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return { ok: false, entries: [], linesRead, error: `malformed JSONL line in ${filePath}` };
    }
    if (!obj || typeof obj !== 'object') {
      return { ok: false, entries: [], linesRead, error: `non-object JSONL entry in ${filePath}` };
    }
    entries.push(obj);
  }
  return { ok: true, entries, linesRead, error: null };
}

/**
 * Inspect both monolithic `.adlc/manifest.jsonl` and segmented
 * `.adlc/manifest.d/*.jsonl` files under `root` for verified gate evidence.
 * Enforces file-size, segment-count, and line-count bounds, then runs the
 * canonical whole-forest verifier (`seq`, `prev`, anchor lineage, and HMAC
 * signatures) before matching by `gate`, `ticketId`, and optional `revision`
 * / `ticketHash` bindings.
 *
 * @param {string} root
 * @param {{ gate?: string | null, ticketId?: string | null, revision?: string | null, ticketHash?: string | null, key?: string | null, maxBytes?: number, maxSegments?: number }} [opts]
 * @returns {{ found: boolean, matchingEntries: object[], manifestSegments: string[], error: string | null }}
 */
export function hasManifestEvidence(
  root,
  opts = {},
) {
  const {
    gate = null,
    ticketId = null,
    revision = null,
    ticketHash = null,
    env = process.env,
    maxBytes = MAX_MANIFEST_FILE_BYTES,
    maxSegments = MAX_MANIFEST_SEGMENTS,
  } = opts;
  const key = opts.key !== undefined ? opts.key : (env?.ADLC_MANIFEST_KEY ?? null);
  if (!root) return { found: false, matchingEntries: [], manifestSegments: [], error: null };
  if (typeof key !== 'string' || key.length === 0) {
    return {
      found: false,
      matchingEntries: [],
      manifestSegments: [],
      error: 'ADLC_MANIFEST_KEY is required to verify manifest evidence',
    };
  }

  const adlcDir = join(root, '.adlc');
  const rootManifest = join(adlcDir, 'manifest.jsonl');
  const { valid: segments, invalid } = discoverSegments(adlcDir);
  if (invalid.length > 0) {
    return {
      found: false,
      matchingEntries: [],
      manifestSegments: segments,
      error: `invalid manifest.d/ entry: ${invalid[0].name} (${invalid[0].reason})`,
    };
  }
  if (segments.length > maxSegments) {
    return {
      found: false,
      matchingEntries: [],
      manifestSegments: segments,
      error: `manifest.d/ exceeds ${maxSegments}-segment scan bound`,
    };
  }

  let remainingLines = MAX_MANIFEST_LINES;
  const allEntries = [];
  const filesToScan = [rootManifest, ...segments.map((seg) => segmentPath(adlcDir, seg))];

  for (const filePath of filesToScan) {
    const parsed = parseStrictJsonl(filePath, { maxBytes, remainingLines });
    if (!parsed.ok) {
      return { found: false, matchingEntries: [], manifestSegments: segments, error: parsed.error };
    }
    remainingLines -= parsed.linesRead;
    allEntries.push(...parsed.entries);
  }

  if (allEntries.length > 0) {
    const forestCheck = verifyManifest(adlcDir, { requireSignatures: false, requireEntries: false, key });
    if (!forestCheck.valid) {
      const reason = Array.isArray(forestCheck.errors) && forestCheck.errors.length > 0
        ? forestCheck.errors[0]
        : 'manifest forest verification failed';
      return { found: false, matchingEntries: [], manifestSegments: segments, error: reason };
    }
  }

  const matchingEntries = allEntries.filter((entry) => {
    if (!verifyEntrySig(key, entry)) return false;
    if (entry.data?.sessionTelemetry === true || typeof entry.data?.transcriptSha256 === 'string') return false;
    if (gate && entry.gate !== gate) return false;
    if (ticketId && entry.ticket !== ticketId) return false;
    if (revision && entry.data?.revision !== revision) return false;
    if (ticketHash) {
      const entryHash = entry.data?.ticketHash ?? entry.data?.cache?.ticketHash ?? null;
      if (entryHash !== ticketHash) return false;
    }
    return true;
  });

  return {
    found: matchingEntries.length > 0,
    matchingEntries,
    manifestSegments: segments,
    error: null,
  };
}

/**
 * Evaluate a Stop hook event: checks ticket risk tier via @adlc/build-gate and
 * verifies whether required chain- and HMAC-verified manifest evidence exists
 * across root + segmented `.adlc/manifest.d/` ledgers.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {string | null} [opts.outerRoot]
 * @param {object | null} [opts.ticket]
 * @param {string | null} [opts.requiredGate]
 * @param {string | null} [opts.revision]
 * @param {string | null} [opts.ticketHash]
 * @param {boolean} [opts.requireEvidence]
 * @param {string | null} [opts.key]
 * @param {string | null} [opts.transcriptPath]
 * @param {boolean} [opts.recordSessionUsage]
 * @param {string} [opts.phaseGate]
 * @param {string | null} [opts.sessionId]
 * @returns {{ decision: 'allow' | 'block', reason: string | null, risk: { tier: 'high' | 'normal', signals: string[] }, hasEvidence: boolean, manifestSegments: string[], root: string | null, harvestedUsage?: object | null }}
 */
export function evaluateStop(opts = {}) {
  const {
    cwd = process.cwd(),
    outerRoot = null,
    ticket = null,
    requiredGate = null,
    revision = null,
    ticketHash = null,
    requireEvidence = false,
    env = process.env,
    transcriptPath = null,
    recordSessionUsage = false,
    phaseGate = 'p4',
    sessionId = null,
  } = opts;
  const key = opts.key !== undefined ? opts.key : (env?.ADLC_MANIFEST_KEY ?? null);
  const root = enclosingAdlcRoot(cwd, { outerRoot });
  const loaded = !ticket && root ? readActiveTicketRails(root, { env }) : null;
  if (loaded && !loaded.ok && requireEvidence) {
    return {
      decision: 'block',
      reason: `ADLC trust-state error: ${loaded.error}`,
      risk: { tier: 'high', signals: ['trust-state-error'] },
      hasEvidence: false,
      manifestSegments: [],
      root,
    };
  }

  const activeTicket = ticket ?? loaded?.activeTicket ?? null;
  const risk = computeRiskTier(activeTicket ?? {});
  const evidence = root
    ? hasManifestEvidence(root, {
        gate: requiredGate,
        ticketId: activeTicket?.id ?? null,
        revision,
        ticketHash,
        key,
        env,
      })
    : { found: false, matchingEntries: [], manifestSegments: [], error: null };

  const willBlock = Boolean(requireEvidence && (evidence.error || !evidence.found));

  let harvestedUsage = null;
  if (transcriptPath) {
    harvestedUsage = harvestTranscriptUsage(transcriptPath);
    if (!willBlock && recordSessionUsage === true && root && harvestedUsage?.calls > 0) {
      const adlcDir = join(root, '.adlc');
      const rootManifest = join(adlcDir, 'manifest.jsonl');
      const { valid: segments } = discoverSegments(adlcDir);
      const filesToScan = [rootManifest, ...segments.map((seg) => segmentPath(adlcDir, seg))];
      const currentSessionKey = sessionId ? `session:${sessionId}` : `transcript:${sha256(transcriptPath)}`;
      let alreadyRecorded = false;
      let hasSignedEntry = false;
      let scanFailed = false;
      let priorInputTokens = 0;
      let priorOutputTokens = 0;
      let priorCachedTokens = 0;
      for (const filePath of filesToScan) {
        const parsed = parseStrictJsonl(filePath, { maxBytes: MAX_MANIFEST_FILE_BYTES, remainingLines: MAX_MANIFEST_LINES });
        if (!parsed.ok) {
          scanFailed = true;
          break;
        }
        for (const entry of parsed.entries) {
          if (typeof entry.sig === 'string' && entry.sig.length > 0) {
            hasSignedEntry = true;
          }
          if (entry.data?.transcriptSha256 === harvestedUsage.transcriptSha256) {
            alreadyRecorded = true;
          }
          const sameSession =
            entry.data?.sessionKey === currentSessionKey ||
            (sessionId && entry.data?.sessionId === sessionId);
          if (sameSession && entry.data?.usage && typeof entry.data.usage === 'object') {
            priorInputTokens += Number(entry.data.usage.inputTokens ?? 0) || 0;
            priorOutputTokens += Number(entry.data.usage.outputTokens ?? 0) || 0;
            priorCachedTokens += Number(entry.data.usage.cachedTokens ?? 0) || 0;
          }
        }
      }

      const deltaInput = Math.max(0, (harvestedUsage.usage.inputTokens ?? 0) - priorInputTokens);
      const deltaOutput = Math.max(0, (harvestedUsage.usage.outputTokens ?? 0) - priorOutputTokens);
      const deltaCached = Math.max(0, (harvestedUsage.usage.cachedTokens ?? 0) - priorCachedTokens);
      if (deltaInput === 0 && deltaOutput === 0 && deltaCached === 0) {
        alreadyRecorded = true;
      }

      let isKeyedForest = false;
      const storeRead = readBoundedRegularFile(join(adlcDir, 'manifest.d', '.store.json'));
      if (storeRead.status === 'error') {
        scanFailed = true;
      } else if (storeRead.status === 'ok') {
        try {
          const marker = JSON.parse(storeRead.content);
          if (marker?.auth === 'keyed') isKeyedForest = true;
        } catch {
          scanFailed = true;
        }
      }

      const hasSigningKey = typeof key === 'string' && key.length > 0;
      const canAppend = !alreadyRecorded && !scanFailed && (hasSigningKey || (!hasSignedEntry && !isKeyedForest));
      if (canAppend) {
        try {
          record({
            gate: phaseGate ?? 'p4',
            ticket: activeTicket?.id,
            dir: adlcDir,
            key: hasSigningKey ? key : null,
            rawData: JSON.stringify({
              sessionTelemetry: true,
              sessionKey: currentSessionKey,
              sessionId: sessionId ?? null,
              transcriptSha256: harvestedUsage.transcriptSha256,
              usage: {
                ...harvestedUsage.usage,
                inputTokens: deltaInput,
                outputTokens: deltaOutput,
                cachedTokens: deltaCached,
              },
              usageStatus: 'reported',
            }),
          });
        } catch {
          // Never allow usage telemetry persistence errors to abort Stop gate evaluation.
        }
      }
    }
  }

  if (willBlock) {
    const label = requiredGate ? `gate "${requiredGate}"` : 'gate';
    const ticketLabel = activeTicket?.id ? ` for ticket "${activeTicket.id}"` : '';
    const detail = evidence.error
      ? `cannot verify ${label} evidence: ${evidence.error}`
      : `missing signed ${label} evidence in .adlc/manifest.jsonl or .adlc/manifest.d/${ticketLabel}`;
    return {
      decision: 'block',
      reason: detail,
      risk,
      hasEvidence: false,
      manifestSegments: evidence.manifestSegments,
      root,
      ...(transcriptPath ? { harvestedUsage } : {}),
    };
  }

  return {
    decision: 'allow',
    reason: null,
    risk,
    hasEvidence: evidence.found,
    manifestSegments: evidence.manifestSegments,
    root,
    ...(transcriptPath ? { harvestedUsage } : {}),
  };
}

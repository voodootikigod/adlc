// stop.mjs — shared Stop / P5 gate combining @adlc/build-gate risk derivation
// and bounded, whole-forest chain + HMAC signature verification across root
// `.adlc/manifest.jsonl` and segmented `.adlc/manifest.d/*.jsonl` ledgers.

import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { computeRiskTier } from '@adlc/build-gate/lib/risk.mjs';
import { verify as verifyManifest } from '@adlc/gate-manifest/lib/verify.mjs';
import { discoverSegments, segmentPath } from '@adlc/tickets/lib/manifest-primitives.mjs';
import { enclosingAdlcRoot, readActiveTicketRails } from './pretool.mjs';

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
  {
    gate = null,
    ticketId = null,
    revision = null,
    ticketHash = null,
    key = process.env.ADLC_MANIFEST_KEY ?? null,
    maxBytes = MAX_MANIFEST_FILE_BYTES,
    maxSegments = MAX_MANIFEST_SEGMENTS,
  } = {},
) {
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
    const forestCheck = verifyManifest(adlcDir, { requireSignatures: true, requireEntries: false, key });
    if (!forestCheck.valid) {
      const reason = Array.isArray(forestCheck.errors) && forestCheck.errors.length > 0
        ? forestCheck.errors[0]
        : 'manifest forest verification failed';
      return { found: false, matchingEntries: [], manifestSegments: segments, error: reason };
    }
  }

  const matchingEntries = allEntries.filter((entry) => {
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
 * @returns {{ decision: 'allow' | 'block', reason: string | null, risk: { tier: 'high' | 'normal', signals: string[] }, hasEvidence: boolean, manifestSegments: string[], root: string | null }}
 */
export function evaluateStop({
  cwd = process.cwd(),
  outerRoot = null,
  ticket = null,
  requiredGate = null,
  revision = null,
  ticketHash = null,
  requireEvidence = false,
  key = process.env.ADLC_MANIFEST_KEY ?? null,
} = {}) {
  const root = enclosingAdlcRoot(cwd, { outerRoot });
  const loaded = !ticket && root ? readActiveTicketRails(root) : null;
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
      })
    : { found: false, matchingEntries: [], manifestSegments: [], error: null };

  if (requireEvidence && (evidence.error || !evidence.found)) {
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
    };
  }

  return {
    decision: 'allow',
    reason: null,
    risk,
    hasEvidence: evidence.found,
    manifestSegments: evidence.manifestSegments,
    root,
  };
}

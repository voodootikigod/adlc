// artifact-review.mjs — first-class artifact review mode for P1 specs & P3 rail sets (ADR-0008, #1432).
//
// Binds review verdicts to a deterministic content+base revision:
//   artifact:<kind>:<baseSha>:<contentHash>
// Any 1-byte edit to the reviewed artifact invalidates the approval immediately.

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { ADLC_DIR, git, sha256 } from '@adlc/core';
import { record } from '@adlc/gate-manifest/lib/record.mjs';
import { readManifestForest } from '@adlc/gate-manifest/lib/forest.mjs';
import { verify } from '@adlc/gate-manifest/lib/verify.mjs';
import { ADMIN_PUB_FILENAME, readAdminPublicKey, verifyEntrySig } from '@adlc/gate-manifest/lib/sign.mjs';
import { validateKeyParam } from '@adlc/tickets/lib/key-contract.mjs';

export const ARTIFACT_REVIEW_KINDS = Object.freeze(['spec', 'rails']);
export const ARTIFACT_GATE_MAP = Object.freeze({
  spec: 'spec-approval',
  rails: 'rails-adequacy',
});

const VALID_VERDICTS = new Set(['approve', 'needs-attention']);
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024; // 2 MiB

function resolveTrustedPubKey({ publicKey, trustedDir } = {}) {
  if (publicKey !== undefined) {
    return { ok: true, publicKey: typeof publicKey === 'string' && publicKey.length > 0 ? publicKey : null };
  }
  if (!trustedDir) {
    return { ok: true, publicKey: null };
  }
  const res = readAdminPublicKey(trustedDir);
  if (res.status === 'error') {
    return { ok: false, publicKey: null, reason: `${ADMIN_PUB_FILENAME}: ${res.reason}` };
  }
  return { ok: true, publicKey: res.publicKey };
}

/**
 * Compute the canonical revision identity for an artifact file on disk.
 * Fails closed on symlinks, directories, missing files, files > 2 MiB,
 * invalid kind, or unresolvable git base ref.
 */
export function computeArtifactRevision(artifactPath, { cwd = process.cwd(), base = 'HEAD', kind = 'spec' } = {}) {
  if (!ARTIFACT_REVIEW_KINDS.includes(kind)) {
    throw new Error(`artifact review kind must be one of ${ARTIFACT_REVIEW_KINDS.join(', ')}, got "${kind}"`);
  }
  if (typeof artifactPath !== 'string' || artifactPath.trim() === '') {
    throw new Error('artifactPath must be a non-empty string');
  }
  if (typeof base !== 'string' || base.trim() === '' || base.startsWith('-')) {
    throw new Error(`invalid base ref: "${base}"`);
  }

  const rootCwd = resolve(cwd);
  const absPath = resolve(rootCwd, artifactPath);

  let lst;
  try {
    lst = lstatSync(absPath);
  } catch (err) {
    throw new Error(`artifact cannot be read (${artifactPath}): ${err.message}`);
  }
  if (lst.isSymbolicLink()) {
    throw new Error(`artifact must not be a symlink: ${artifactPath}`);
  }
  if (!lst.isFile()) {
    throw new Error(`artifact must be a regular file: ${artifactPath}`);
  }
  if (lst.size > MAX_ARTIFACT_BYTES) {
    throw new Error(`artifact exceeds 2 MiB size limit (${lst.size} bytes): ${artifactPath}`);
  }

  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(absPath, flags);
  let rawBuf;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new Error(`artifact must be a regular file: ${artifactPath}`);
    }
    if (st.size > MAX_ARTIFACT_BYTES) {
      throw new Error(`artifact exceeds 2 MiB size limit (${st.size} bytes): ${artifactPath}`);
    }
    rawBuf = readFileSync(fd);
  } finally {
    closeSync(fd);
  }
  if (rawBuf.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error(`artifact exceeds 2 MiB size limit (${rawBuf.byteLength} bytes): ${artifactPath}`);
  }

  const canonicalBytes = Buffer.from(rawBuf.toString('utf8').replaceAll('\r\n', '\n'), 'utf8');
  const contentHash = sha256(canonicalBytes);

  let baseSha;
  try {
    baseSha = git(['rev-parse', '--verify', `${base}^{commit}`], { cwd: rootCwd }).trim();
  } catch (err) {
    throw new Error(`base ref "${base}" could not be resolved: ${err.message}`);
  }
  if (!/^[0-9a-f]{40,64}$/i.test(baseSha)) {
    throw new Error(`base ref "${base}" did not resolve to a commit SHA: "${baseSha}"`);
  }

  const relPath = relative(rootCwd, absPath).replaceAll('\\', '/');
  const gate = ARTIFACT_GATE_MAP[kind];
  return {
    kind,
    gate,
    path: relPath,
    contentHash,
    baseSha,
    revision: `artifact:${kind}:${baseSha}:${contentHash}`,
  };
}

/**
 * Record a signed, hash-chained artifact review verdict in the manifest.
 */
export function recordArtifactReview({
  artifactPath,
  kind = 'spec',
  ticket,
  verdict = 'approve',
  provider,
  model = null,
  findings = [],
  cwd = process.cwd(),
  base = 'HEAD',
  dir = ADLC_DIR,
  key = null,
} = {}) {
  key = validateKeyParam(key);
  if (!ARTIFACT_REVIEW_KINDS.includes(kind)) {
    throw new Error(`artifact review kind must be one of ${ARTIFACT_REVIEW_KINDS.join(', ')}, got "${kind}"`);
  }
  if (!VALID_VERDICTS.has(verdict)) {
    throw new Error(`artifact review verdict must be one of ${[...VALID_VERDICTS].join(', ')}, got "${verdict}"`);
  }
  if (typeof ticket !== 'string' || ticket.trim() === '') {
    throw new Error('artifact review requires a non-empty ticket');
  }
  if (typeof provider !== 'string' || provider.trim() === '') {
    throw new Error('artifact review requires a non-empty provider');
  }
  if (!Array.isArray(findings)) {
    throw new Error('artifact review findings must be an array');
  }

  const rev = computeArtifactRevision(artifactPath, { cwd, base, kind });
  const ledgerDir = resolve(cwd, dir);

  return record({
    gate: rev.gate,
    ticket,
    rawData: JSON.stringify({
      kind: rev.kind,
      path: rev.path,
      contentHash: rev.contentHash,
      baseSha: rev.baseSha,
      revision: rev.revision,
      verdict,
      provider,
      model: model ?? null,
      findingCount: findings.length,
    }),
    dir: ledgerDir,
    key,
  });
}

/**
 * Recompute the live artifact revision from disk and verify the manifest forest
 * contains a signature-verified `approve` for the exact (gate, ticket, revision)
 * with no `needs-attention` revocation.
 *
 * Public keys are loaded ONLY from explicit `publicKey` or `trustedDir` — never
 * from the untrusted manifest `dir`.
 */
export function hasArtifactApproval({
  artifactPath,
  kind = 'spec',
  ticket,
  cwd = process.cwd(),
  base = 'HEAD',
  dir = ADLC_DIR,
  key = null,
  publicKey = undefined,
  trustedDir = undefined,
} = {}) {
  key = validateKeyParam(key);
  if (!ARTIFACT_REVIEW_KINDS.includes(kind)) return false;
  if (typeof ticket !== 'string' || ticket.trim() === '') return false;

  const pub = resolveTrustedPubKey({ publicKey, trustedDir });
  if (!pub.ok) return false;
  const effectivePub = pub.publicKey;
  if (!key && !effectivePub) return false;

  let rev;
  try {
    rev = computeArtifactRevision(artifactPath, { cwd, base, kind });
  } catch {
    return false;
  }

  const ledgerDir = resolve(cwd, dir);
  if (verify(ledgerDir, { requireSignatures: false, key, publicKey: effectivePub }).valid !== true) {
    return false;
  }

  const { entries } = readManifestForest(ledgerDir);
  let approved = false;
  for (const entry of entries) {
    if ((entry.gate ?? entry.type) !== rev.gate) continue;
    if (entry.ticket !== ticket) continue;
    const data = entry.data;
    if (!data || typeof data !== 'object') continue;
    if (data.revision !== rev.revision) continue;

    if (data.verdict === 'needs-attention') {
      return false;
    }
    if (data.verdict === 'approve' && verifyEntrySig(key, entry, { publicKey: effectivePub })) {
      approved = true;
    }
  }
  return approved;
}

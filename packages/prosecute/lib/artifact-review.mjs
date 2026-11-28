// artifact-review.mjs — first-class artifact review mode for P1 specs & P3 rail sets (ADR-0008, #1432).
//
// Binds review verdicts to a deterministic content+base revision:
//   artifact:<kind>:<baseSha>:<contentHash>
// Any 1-byte edit to the reviewed artifact invalidates the approval immediately.

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ADLC_DIR, git, sha256 } from '@adlc/core';
import { record } from '@adlc/gate-manifest/lib/record.mjs';
import { readManifestForest } from '@adlc/gate-manifest/lib/forest.mjs';
import { verify } from '@adlc/gate-manifest/lib/verify.mjs';
import { ADMIN_PUB_FILENAME, readAdminPublicKey, verifyEntrySig } from '@adlc/gate-manifest/lib/sign.mjs';
import { validateKeyParam } from '@adlc/tickets/lib/key-contract.mjs';

export const ARTIFACT_REVIEW_KINDS = Object.freeze(['spec', 'rails']);
export const ARTIFACT_GATE_MAP = Object.freeze({
  spec: 'artifact-spec-review',
  rails: 'artifact-rails-review',
});

const VALID_VERDICTS = new Set(['approve', 'needs-attention']);
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });

function resolveTrustedPubKey({ publicKey, trustedDir } = {}) {
  if (publicKey !== undefined) {
    if (typeof publicKey !== 'string') return { ok: true, publicKey: null };
    return { ok: true, publicKey: publicKey || null };
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

function assertNoSymlinkSegments(rootCwd, relPath, artifactPath) {
  const parts = relPath.split(sep).filter(Boolean);
  let cur = rootCwd;
  for (const part of parts) {
    cur = join(cur, part);
    let lst;
    try {
      lst = lstatSync(cur);
    } catch (err) {
      throw new Error(`artifact cannot be read (${artifactPath}): ${err.message}`);
    }
    if (lst.isSymbolicLink()) {
      throw new Error(`artifact path must not traverse symlinks: ${artifactPath}`);
    }
  }
}

function readRegularFileBounded(rootCwd, relPath, absPath, artifactPath) {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  let fd;
  try {
    fd = openSync(absPath, flags);
  } catch (err) {
    throw new Error(`artifact cannot be read (${artifactPath}): ${err.message}`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new Error(`artifact must be a regular file: ${artifactPath}`);
    }
    if (st.size > MAX_ARTIFACT_BYTES) {
      throw new Error(`artifact exceeds 2 MiB size limit (${st.size} bytes): ${artifactPath}`);
    }
    const chunks = [];
    let total = 0;
    const scratch = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    for (;;) {
      const n = readSync(fd, scratch, 0, scratch.length, null);
      if (n === 0) break;
      total += n;
      if (total > MAX_ARTIFACT_BYTES) {
        throw new Error(`artifact exceeds 2 MiB size limit (${total} bytes): ${artifactPath}`);
      }
      chunks.push(Buffer.from(scratch.subarray(0, n)));
    }
    const postFd = fstatSync(fd);
    if (
      total !== st.size ||
      postFd.size !== st.size ||
      postFd.mtimeMs !== st.mtimeMs ||
      postFd.ctimeMs !== st.ctimeMs
    ) {
      throw new Error(`artifact changed during read: ${artifactPath}`);
    }
    assertNoSymlinkSegments(rootCwd, relPath, artifactPath);
    const postPath = lstatSync(absPath);
    if (
      postPath.isSymbolicLink() ||
      postPath.dev !== st.dev ||
      postPath.ino !== st.ino ||
      postPath.size !== st.size ||
      postPath.mtimeMs !== st.mtimeMs ||
      postPath.ctimeMs !== st.ctimeMs ||
      realpathSync(absPath) !== absPath
    ) {
      throw new Error(`artifact path changed during read: ${artifactPath}`);
    }
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(fd);
  }
}

function parseJsonlEntriesStrict(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('manifest JSONL line is not an object');
    }
    out.push(parsed);
  }
  return out;
}

function readGitBaseManifestEntries(rootCwd, ledgerDir, baseSha) {
  const relDir = relative(rootCwd, ledgerDir);
  if (!relDir || relDir.startsWith('..') || isAbsolute(relDir)) {
    return { ok: true, entries: [] };
  }
  const posixDir = relDir.replaceAll('\\', '/');
  let listed;
  try {
    listed = git(['ls-tree', '-r', '--name-only', baseSha, '--', posixDir], { cwd: rootCwd }).trim();
  } catch {
    return { ok: false, entries: [] };
  }
  if (!listed) return { ok: true, entries: [] };
  const entries = [];
  for (const file of listed.split('\n')) {
    const trimmed = file.trim();
    if (!trimmed.endsWith('.jsonl')) continue;
    try {
      const blob = git(['show', `${baseSha}:${trimmed}`], { cwd: rootCwd });
      entries.push(...parseJsonlEntriesStrict(blob));
    } catch {
      return { ok: false, entries: [] };
    }
  }
  return { ok: true, entries };
}

function entryFingerprint(entry) {
  return `${entry.gate ?? entry.type ?? ''}|${entry.ticket ?? ''}|${entry.data?.revision ?? ''}|${entry.data?.verdict ?? ''}|${entry.sig ?? ''}`;
}

/**
 * Compute the canonical revision identity for an artifact file on disk.
 * Fails closed on symlinks (including parent directories), path escape outside
 * cwd, directories, missing files, files > 2 MiB, invalid UTF-8, concurrent
 * modification, invalid kind, or unresolvable git base ref.
 */
export function computeArtifactRevision(artifactPath, { cwd = process.cwd(), base = 'main', kind = 'spec' } = {}) {
  if (!ARTIFACT_REVIEW_KINDS.includes(kind)) {
    throw new Error(`artifact review kind must be one of ${ARTIFACT_REVIEW_KINDS.join(', ')}, got "${kind}"`);
  }
  if (typeof artifactPath !== 'string' || artifactPath.trim() === '') {
    throw new Error('artifactPath must be a non-empty string');
  }
  if (typeof base !== 'string' || base.trim() === '' || base.startsWith('-')) {
    throw new Error(`invalid base ref: "${base}"`);
  }

  const rootCwd = realpathSync(resolve(cwd));
  const absPath = resolve(rootCwd, artifactPath);
  const relPath = relative(rootCwd, absPath);
  if (relPath === '' || relPath === '..' || relPath.startsWith(`..${sep}`) || isAbsolute(relPath)) {
    throw new Error(`artifact path escapes repository root: ${artifactPath}`);
  }

  assertNoSymlinkSegments(rootCwd, relPath, artifactPath);
  const rawBuf = readRegularFileBounded(rootCwd, relPath, absPath, artifactPath);

  let decoded;
  try {
    decoded = UTF8_STRICT.decode(rawBuf);
  } catch {
    throw new Error(`artifact is not valid UTF-8: ${artifactPath}`);
  }
  const canonicalBytes = Buffer.from(decoded.replaceAll('\r\n', '\n'), 'utf8');
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

  const gate = ARTIFACT_GATE_MAP[kind];
  return {
    kind,
    gate,
    path: relPath.replaceAll('\\', '/'),
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
  base = 'main',
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
 * Recompute the live artifact revision from disk (or use a caller-supplied
 * `resolvedRevision` from `computeArtifactRevision` to avoid double-reads) and
 * verify the manifest forest contains a signature-verified `approve` for the
 * exact (gate, ticket, revision) with no `needs-attention` revocation and no
 * truncation against trusted anchors (git base commit, `trustedDir` manifest if
 * present, and `observedEntries` / `--attestation-store`).
 *
 * Public keys are loaded ONLY from explicit `publicKey` or `trustedDir` — never
 * from the untrusted manifest `dir`.
 */
export function hasArtifactApproval({
  artifactPath,
  kind = 'spec',
  ticket,
  cwd = process.cwd(),
  base = 'main',
  dir = ADLC_DIR,
  key = null,
  publicKey = undefined,
  trustedDir = undefined,
  observedEntries = undefined,
  resolvedRevision = undefined,
} = {}) {
  key = validateKeyParam(key);
  if (!ARTIFACT_REVIEW_KINDS.includes(kind)) return false;
  if (typeof ticket !== 'string' || ticket.trim() === '') return false;

  const pub = resolveTrustedPubKey({ publicKey, trustedDir });
  if (!pub.ok) return false;
  const effectivePub = pub.publicKey;
  if (!key && !effectivePub) return false;

  let rev = resolvedRevision;
  if (!rev) {
    try {
      rev = computeArtifactRevision(artifactPath, { cwd, base, kind });
    } catch {
      return false;
    }
  } else if (rev.kind !== kind || rev.gate !== ARTIFACT_GATE_MAP[kind]) {
    return false;
  }

  const rootCwd = realpathSync(resolve(cwd));
  const ledgerDir = resolve(rootCwd, dir);
  if (verify(ledgerDir, { requireSignatures: false, key, publicKey: effectivePub }).valid !== true) {
    return false;
  }

  const { entries } = readManifestForest(ledgerDir);
  const presentSet = new Set(entries.map(entryFingerprint));

  // Anti-rollback / truncation anchor: fail closed if base git tree cannot be read.
  const baseAnchor = readGitBaseManifestEntries(rootCwd, ledgerDir, rev.baseSha);
  if (!baseAnchor.ok) return false;
  const anchorEntries = [...baseAnchor.entries];
  if (trustedDir) {
    const resolvedTrusted = resolve(rootCwd, trustedDir);
    if (resolvedTrusted !== ledgerDir && existsSync(resolvedTrusted)) {
      anchorEntries.push(...readManifestForest(resolvedTrusted).entries);
    }
  }
  if (Array.isArray(observedEntries)) {
    anchorEntries.push(...observedEntries);
  }

  for (const anchor of anchorEntries) {
    if ((anchor?.gate ?? anchor?.type) !== rev.gate) continue;
    if (anchor?.ticket !== ticket) continue;
    if (anchor?.data?.revision !== rev.revision) continue;
    if (!verifyEntrySig(key, anchor, { publicKey: effectivePub })) continue;
    if (anchor.data.verdict === 'needs-attention') return false;
    if (!presentSet.has(entryFingerprint(anchor))) return false;
  }

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

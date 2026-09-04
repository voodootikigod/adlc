// The actual-diff check (spec §6.5a; AC 34, 55, 76, 98, 100, 140).
//
// Deterministic and orchestrator-side: independent of fleet's rails gate and
// of anything the worker declared. `git diff --name-only <BASE_OID>...<head>`
// in ISSUE_WT must satisfy, in this order:
//   (iv) secret scan FIRST — a hit blocks the run outright (no retry round, the
//        same content must never be re-reviewed or re-dispatched), so it takes
//        precedence over every round-failure class below;
//   (i)  every path matches the ticket scope OR is one of the three
//        pipeline-produced paths, each bound to the run record:
//          .adlc/specs/<ticketId>-ac.md          sha256 == record.criteriaDocSha256
//          .adlc/tickets/<slug>--*.json          canonicalTicketSha256 == record.ticketSnapshotSha256
//          .adlc/manifest.d/*.jsonl              append-only, every added line ∈ record.manifestLinesWritten,
//                                                signed, and `adlc gate-manifest verify` (key-bearing) exits 0
//        a diff to .adlc/findings.jsonl is always a violation;
//   (ii) no path matches the protected-path denylist;
//   (iii) no changed path is a symlink at HEAD whose target escapes the scope.
// Every reported string names a path, a pattern NAME and a line — never the
// matched text.

import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { globMatch } from '@adlc/core';
import { canonicalJson, ticketSlug } from '@adlc/tickets';
import { validateIssueNumber, validateOid, validateTicketId } from './input.mjs';
import { childEnv } from './keys.mjs';
import { DEADLINES } from './spawn.mjs';
import { SECRET_PATTERNS } from './redact.mjs';
import { registerSeams, active } from './mutations.mjs';

registerSeams([
  'diffcheck.skipManifestAppendOnly', // removed manifest lines are not a violation
  'diffcheck.skipForeignLineCheck',   // an added manifest line outside the run's set passes
  'diffcheck.skipManifestVerify',     // `gate-manifest verify` is not spawned / its exit ignored
  'diffcheck.skipSecretScan',         // (iv) is not run
  'diffcheck.ignoreSymlinks',         // (iii) is not run
  'diffcheck.skipTicketSnapshot',     // the shard is accepted without the snapshot hash check
  'diffcheck.skipCriteriaHash',       // the criteria document is accepted without its hash check
  'diffcheck.skipDenylist',           // (ii) is not run
  'diffcheck.allowBinary',
  'diffcheck.scanKeyOnly',
  'diffcheck.allowUnloadedDenylist',
]);

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** The canonical shard hash of §6.5a: `completed` removed, keys sorted (deep), sha256. */
export function canonicalTicketSha256(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new TypeError('ticket shard must be an object');
  const { completed: _c, ...rest } = doc;
  return sha256(canonicalJson(rest));
}

/** The identity of one manifest line as the run record keeps it: sha256 of the exact line, trailing newline stripped. */
export function manifestLineSha256(line) { return sha256(String(line).replace(/\r?\n$/, '')); }

export const MANIFEST_DIR = '.adlc/manifest.d/';
const MANIFEST_RE = /^\.adlc\/manifest\.d\/[^/]+\.jsonl$/;
export const criteriaDocPath = (ticketId) => `.adlc/specs/${validateTicketId(ticketId)}-ac.md`;
export const ticketShardPrefix = (ticketId) => `.adlc/tickets/${ticketSlug(validateTicketId(ticketId))}--`;
const SHARD_RE = /^\.adlc\/tickets\/[^/]+--[0-9a-f]{64}\.json$/;

/**
 * Walk a unified diff and yield every ADDED line with its file and new-file
 * line number. Only `+` content lines count (`+++` headers never do).
 */
export function parseAddedLines(diffText) {
  const out = [];
  let file = null; let lineNo = 0;
  for (const raw of String(diffText).split('\n')) {
    if (raw.startsWith('+++ ')) { const m = /^\+\+\+ (?:b\/)?(.*)$/.exec(raw); file = m && m[1] !== '/dev/null' ? m[1] : null; continue; }
    if (raw.startsWith('--- ') || raw.startsWith('diff --git ')) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { lineNo = Number(hunk[1]); continue; }
    if (raw.startsWith('+')) { out.push({ file, line: lineNo, text: raw.slice(1) }); lineNo++; continue; }
    if (raw.startsWith('-') || raw.startsWith('\\')) continue;
    lineNo++;
  }
  return out;
}

/**
 * (iv) — scan added lines against SECRET_PATTERNS plus every literal
 * orchestrator secret value. Returns hits that name the pattern, file and line ONLY.
 */
export function scanAddedLinesForSecrets(diffText, { secretValues = [] } = {}) {
  const hits = [];
  const literals = secretValues.filter((v) => typeof v === 'string' && v.length >= 8);
  for (const { file, line, text } of parseAddedLines(diffText)) {
    for (const { name, regex } of SECRET_PATTERNS) {
      regex.lastIndex = 0;
      if (regex.test(text)) hits.push({ pattern: name, file, line });
    }
    if (literals.some((v) => text.includes(v))) hits.push({ pattern: 'orchestrator secret value', file, line });
  }
  return hits;
}

/** The comment-safe rendering of secret hits: pattern NAME and file:line, nothing else. */
export function describeSecretHits(hits) {
  return hits.map((h) => `${h.pattern} at ${h.file ?? '?'}:${h.line}`).join('\n');
}

function scopeMatches(scope, path) { return (scope ?? []).some((g) => globMatch(g, path)); }

/** Symlink target resolution relative to the link's directory; null when it escapes the repository. */
export function resolveSymlinkTarget(linkPath, target) {
  if (posix.isAbsolute(target)) return null;
  const resolved = posix.normalize(posix.join(posix.dirname(linkPath), target));
  if (resolved === '..' || resolved.startsWith('../')) return null;
  return resolved;
}

async function gitOut(ctx, cwd, args) { return ctx.git.localOut(cwd, args); }

async function showAtHead(ctx, cwd, head, path) {
  const r = await ctx.git.local(cwd, ['show', `${head}:${path}`]);
  return r.status === 0 ? r.stdout : null;
}

async function checkCriteria({ ctx, cwd, head, record, path, violations }) {
  const content = await showAtHead(ctx, cwd, head, path);
  if (!active('diffcheck.skipCriteriaHash') && (content === null || sha256(content) !== record?.criteriaDocSha256)) {
    violations.push({ path, code: 'criteria-doc-mismatch' });
  }
}

async function checkTicketShards({ ctx, cwd, head, record, prefix, violations }) {
  const listed = (await gitOut(ctx, cwd, ['ls-tree', '-r', '--name-only', head, '--', '.adlc/tickets/'])).split('\n').filter((p) => p.startsWith(prefix));
  if (listed.length !== 1) { violations.push({ path: prefix + '*', code: 'ticket-shard-count', detail: `${listed.length} shards at HEAD` }); return; }
  if (active('diffcheck.skipTicketSnapshot')) return;
  let doc;
  try { doc = JSON.parse(await showAtHead(ctx, cwd, head, listed[0])); } catch { violations.push({ path: listed[0], code: 'ticket-shard-unparseable' }); return; }
  if (doc?.completed !== undefined && typeof doc.completed !== 'boolean') { violations.push({ path: listed[0], code: 'ticket-shard-mismatch' }); return; }
  if (canonicalTicketSha256(doc) !== record?.ticketSnapshotSha256) violations.push({ path: listed[0], code: 'ticket-shard-mismatch' });
}

async function checkManifestSegment({ ctx, cwd, baseOid, head, record, path, status, violations }) {
  if (status !== 'A' && status !== 'M') { violations.push({ path, code: 'manifest-segment-removed' }); return; }
  const diff = await gitOut(ctx, cwd, ['diff', baseOid, head, '--', path]);
  const written = new Set(record?.manifestLinesWritten ?? []);
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('-') && !raw.startsWith('---')) {
      if (!active('diffcheck.skipManifestAppendOnly')) violations.push({ path, code: 'manifest-line-removed' });
      continue;
    }
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
    const line = raw.slice(1);
    if (!active('diffcheck.skipForeignLineCheck') && !written.has(manifestLineSha256(line))) { violations.push({ path, code: 'foreign-manifest-line' }); continue; }
    let entry = null;
    try { entry = JSON.parse(line); } catch { /* unparseable → unsigned */ }
    if (typeof entry?.sig !== 'string' || entry.sig.length === 0) violations.push({ path, code: 'run-entry-unsigned' });
  }
}

async function verifyManifest({ ctx, cwd, violations }) {
  if (active('diffcheck.skipManifestVerify')) return;
  const r = await ctx.spawn({
    argv: [ctx.pinned.adlc, 'gate-manifest', 'verify', '--dir', posix.join(cwd, '.adlc'), '--allow-legacy-unsigned'],
    cwd, env: childEnv(ctx.env.base, { key: ctx.key, keyBearing: true }), deadlineMs: DEADLINES.adlcRecorder, label: 'gate-manifest-verify',
  });
  if (r.status !== 0) violations.push({ path: MANIFEST_DIR, code: 'manifest-verify-failed' });
}

async function checkSymlinks({ ctx, cwd, head, scope, changed, violations }) {
  if (active('diffcheck.ignoreSymlinks')) return;
  const tree = await gitOut(ctx, cwd, ['ls-tree', '-r', '-z', head]);
  const links = new Map();
  for (const rec of tree.split('\0')) {
    const m = /^(\d{6}) blob ([0-9a-f]{40,64})\t(.*)$/.exec(rec);
    if (m && m[1] === '120000') links.set(m[3], m[2]);
  }
  for (const path of changed) {
    if (!links.has(path)) continue;
    const target = (await gitOut(ctx, cwd, ['cat-file', '-p', links.get(path)])).trim();
    const resolved = resolveSymlinkTarget(path, target);
    if (resolved === null || !scopeMatches(scope, resolved)) violations.push({ path, code: 'symlink-escape' });
  }
}

/**
 * @returns {{ ok, code, paths, violations, secretHits }}
 *   code: 'secret-in-diff' | the first violation's code | null
 */
export async function actualDiffCheck({ ctx, issue, record, baseOid, head, scope, ticketId }) {
  const cwd = ctx.paths.issueWorktree(validateIssueNumber(issue));
  validateOid(baseOid); validateOid(head); validateTicketId(ticketId);
  const range = `${baseOid}...${head}`;

  if (!active('diffcheck.skipSecretScan')) {
    const secretHits = scanAddedLinesForSecrets(await gitOut(ctx, cwd, ['diff', range]), { secretValues: active('diffcheck.scanKeyOnly') ? [ctx.key] : (ctx.secretValues ?? [ctx.key]) });   // seam `diffcheck.scanKeyOnly`: only the manifest key is scanned for
    if (secretHits.length) return { ok: false, code: 'secret-in-diff', paths: [...new Set(secretHits.map((h) => h.file))], violations: [], secretHits };
  }

  // A binary blob carries no `+` lines for the secret scan to read: it is refused outright
  // (`binary-file`) unless the mutation seam allows it.
  const numstat = await gitOut(ctx, cwd, ['diff', '--numstat', '--no-renames', range]);
  const binaries = numstat.split('\n').filter((l) => /^-\t-\t/.test(l)).map((l) => l.split('\t')[2]);
  const nameStatus = await gitOut(ctx, cwd, ['diff', '--name-status', '--no-renames', range]);
  const entries = nameStatus.split('\n').filter(Boolean).map((l) => { const [status, path] = l.split('\t'); return { status: status[0], path }; });
  const changed = entries.map((e) => e.path);
  const violations = [];
  const criteriaPath = criteriaDocPath(ticketId);
  const shardPrefix = ticketShardPrefix(ticketId);
  let sawShard = false; let sawManifest = false;

  for (const { status, path } of entries) {
    if (!active('diffcheck.allowBinary') && binaries.includes(path)) { violations.push({ path, code: 'binary-file' }); continue; }
    if (path === '.adlc/findings.jsonl') { violations.push({ path, code: 'findings-ledger-written' }); continue; }
    if (path === criteriaPath) { await checkCriteria({ ctx, cwd, head, record, path, violations }); continue; }
    if (path.startsWith(shardPrefix) && SHARD_RE.test(path)) { sawShard = true; continue; }
    if (MANIFEST_RE.test(path)) { sawManifest = true; await checkManifestSegment({ ctx, cwd, baseOid, head, record, path, status, violations }); continue; }
    // No loaded denylist is a violation in itself (codex r4 B1): the protected-path rule can never be
    // silently skipped because a caller (maintenance) ran before selection loaded the list.
    // Mutation seam `diffcheck.allowUnloadedDenylist`: an absent denylist skips the rule.
    if (!active('diffcheck.skipDenylist') && !active('diffcheck.allowUnloadedDenylist') && typeof ctx.denylist?.matches !== 'function') { violations.push({ path, code: 'denylist-unloaded' }); continue; }
    if (!active('diffcheck.skipDenylist') && ctx.denylist?.matches(path)) { violations.push({ path, code: 'protected-path' }); continue; }
    if (!scopeMatches(scope, path)) violations.push({ path, code: 'out-of-scope' });
  }
  if (sawShard) await checkTicketShards({ ctx, cwd, head, record, prefix: shardPrefix, violations });
  if (sawManifest) await verifyManifest({ ctx, cwd, violations });
  await checkSymlinks({ ctx, cwd, head, scope, changed, violations });

  return { ok: violations.length === 0, code: violations[0]?.code ?? null, paths: [...new Set(violations.map((v) => v.path))], violations, secretHits: [] };
}

// generation-descriptor.mjs — the adoption record schema and generation-path resolver
// (spec: .adlc/specs/manifest-key-hermeticity.md, Layer 3, items 1 and 9).
//
// WHY THIS LIVES IN @adlc/tickets: same reasoning as key-contract.mjs — every consumer
// that reads or writes the manifest forest (gate-manifest, prosecute, model-router,
// ticket-sync, runner, fleet, build-gate) must resolve the SAME active generation
// through ONE shared primitive, and tickets is the acyclic leaf every one of those can
// already reach (gate-manifest -> core -> tickets; a tickets -> gate-manifest import
// would close that loop).
//
// THE ADOPTION RECORD (.adlc/config.json's "signing" key):
//   { schemaVersion: 1, keyFingerprint: <sha256 hex>, generation: <id>|0, priorFingerprints: [...] }
// PRESENCE of this record IS required-mode — there is no separate boolean. Suspending
// signing is REMOVAL of the record, not a flag flip (spec round-5 finding 4).
//
// GENERATION LAYOUT: generation 0 (or the field absent — legacy) means the historical
// in-place files: <dir>/manifest.jsonl + <dir>/manifest.d/. Any other id resolves to
// <dir>/manifest-generations/<id>/, carrying the SAME root+segment layout one level
// down. An id is validated as a bare path COMPONENT — no separators, no traversal — since
// it is joined directly into a filesystem path.

import { lstatSync, openSync, readSync, closeSync, constants as fsConstants } from 'node:fs';
import { join, relative, sep, isAbsolute } from 'node:path';
import { invalid } from './errors.mjs';

export const ADOPTION_RECORD_KEY = 'signing';
export const CONFIG_FILENAME = 'config.json';
export const GENERATIONS_DIRNAME = 'manifest-generations';
export const SCHEMA_VERSION = 1;

const GENERATION_ID_RE = /^[a-z0-9]{1,64}$/;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

// A trust-root config file can carry many other project settings besides `signing` —
// generous headroom over a bare marker file (@adlc/tickets/lib/manifest-segments.mjs's
// readBoundedJsonNoFollow caps at 4096 bytes for a small lineage token; config.json is a
// general project file with unrelated keys plus a growing, append-only priorFingerprints
// list — 64KB gives room for hundreds of rotations before this cap is even a concern).
export const MAX_CONFIG_JSON_BYTES = 65536;

/**
 * True iff `generation` is a legacy (pre-adoption / generation-0) marker: absent, the
 * number 0, or the string '0'. `null` is DELIBERATELY EXCLUDED — an absent `generation`
 * field means "never rotated, still legacy" (a legitimate, common state), but an
 * EXPLICIT `null` in a record that otherwise validates is not a documented value at
 * all; treating it as legacy-equivalent would let a corrupted or tampered record
 * (`signing.generation: null`, e.g. from a serialization bug that dropped a real id)
 * silently downgrade to the historical forest instead of failing validation.
 * @param {unknown} generation
 * @returns {boolean}
 */
export function isLegacyGeneration(generation) {
  return generation === undefined || generation === 0 || generation === '0';
}

/**
 * Validate a generation id is safe to join into a filesystem path: a bare path
 * COMPONENT, never a path — lowercase alphanumeric only, 1-64 characters, no
 * separators, no traversal, no leading dot. Legacy ids (see isLegacyGeneration) are
 * never passed here — callers branch on that first.
 * @param {unknown} id
 * @returns {string}
 */
export function validateGenerationId(id) {
  if (typeof id !== 'string' || !GENERATION_ID_RE.test(id)) {
    throw invalid('INVALID_GENERATION_ID',
      `generation id must be a lowercase alphanumeric path component matching ${GENERATION_ID_RE}; got ${JSON.stringify(id)}`);
  }
  return id;
}

/**
 * Resolve the directory carrying the active generation's root manifest + segments.
 * Legacy (generation 0/absent) resolves to `dir` itself, unchanged — the historical
 * in-place layout. Any other id resolves to `dir/manifest-generations/<id>/`, which
 * carries the identical root+segment layout one level down.
 * @param {string} dir  the .adlc directory
 * @param {unknown} generation
 * @returns {string}
 */
export function resolveGenerationDir(dir, generation) {
  if (isLegacyGeneration(generation)) return dir;
  return join(dir, GENERATIONS_DIRNAME, validateGenerationId(generation));
}

/**
 * Verify `dir` ITSELF plus no path component between `dir` (exclusive) and
 * `targetPath` (inclusive) is a symlink — i.e. that `targetPath` is genuinely reached
 * by descending real directories from a genuinely real `dir`, not redirected through
 * `.adlc` itself being a symlink (which would silently relocate the adoption record,
 * every generation, and everything else this module resolves), nor through a
 * component a branch committed as a symlink (e.g. `.adlc/manifest-generations/g1`
 * pointing at an attacker-controlled directory elsewhere in the checkout), nor through
 * `manifest-generations/g1/manifest.jsonl` itself being a symlink to a decoy file or an
 * unbounded device while every directory ABOVE it is genuinely real). `targetPath` may
 * be a directory (e.g. `generationDir` or `segmentDirPath`) or a file (e.g.
 * `manifestPath`) — every INTERMEDIATE component (including `dir` itself) must be a
 * real directory, but the FINAL component is only required not to be a symlink.
 *
 * resolveGenerationDir/resolveActiveGenerationPaths return PATH STRINGS ONLY and never
 * touch the filesystem — this is deliberate (this module has no consumers yet, and a
 * confinement check performed once at resolution time, then trusted later, is a TOCTOU
 * race: the check and the actual file access are two different moments). Every future
 * writer or verifier that performs REAL file I/O against a resolved generation path
 * MUST call this on the EXACT path it is about to read or write — generationDir AND
 * manifestPath AND segmentDirPath separately, each immediately before its own I/O, not
 * once, cached, at an earlier point, and not only on the directory while trusting the
 * leaf file beneath it — exactly as this module's own readAdoptionRecord,
 * @adlc/gate-manifest's forest.mjs, and @adlc/tickets's own manifest-segments.mjs
 * already do lstatSync-immediately-before-open at their own point of access.
 *
 * RESIDUAL LIMITATION: this is a check, not an open — it inspects pathnames via
 * lstatSync and returns, without retaining any file descriptor for what it verified.
 * "Immediately before I/O" narrows the window between this check and the caller's
 * subsequent open/read/write but cannot close it: a concurrent process could still
 * replace a checked component (the leaf, or an intermediate directory) between this
 * function returning and the caller's own I/O call. Fully closing that gap would mean
 * every consumer opening files through retained, fd-relative (openat-style) directory
 * handles rather than by pathname — Node's `fs` module has no such primitive without a
 * native addon, and every other check in this codebase (readAdoptionRecord above,
 * @adlc/gate-manifest's forest.mjs, @adlc/tickets's own manifest-segments.mjs) has the
 * identical pathname-check-then-open shape and the identical gap.
 * @param {string} dir  the .adlc directory (now itself verified, not assumed trusted)
 * @param {string} targetPath  a path returned by resolveActiveGenerationPaths
 *   (generationDir, manifestPath, or segmentDirPath) — the EXACT path about to be used
 * @param {{mustExist?: boolean}} [options]  mustExist: whether a not-yet-created
 *   component fails closed (true) or is tolerated as "nothing to redirect through yet"
 *   (false). DEFAULTS TO TRUE. This is a per-CALL decision, not one true answer for the
 *   whole module — the three paths resolveActiveGenerationPaths returns have DIFFERENT
 *   existence expectations even in a fully-adopted, active generation:
 *     - generationDir: should exist once adopted/rotated — call with the default
 *       (true) when verifying the ALREADY-ACTIVE generation an adoption record names; a
 *       missing one means a partial checkout, failed recovery, or tampering, and
 *       silently passing would let that look like a valid empty forest.
 *     - manifestPath / segmentDirPath: MAY legitimately not exist yet even in an
 *       adopted generation — a ledger file is typically created lazily on its first
 *       append, so a brand-new or genuinely-empty generation has no manifest.jsonl on
 *       disk at all. Callers reading/verifying these two should pass
 *       `mustExist: false` explicitly (an absent leaf means "nothing written yet", not
 *       "unsafe") — as should an off-path TRANSITION BUILDER constructing any
 *       not-yet-published path.
 */
export function assertGenerationDirNotSymlinked(dir, targetPath, { mustExist = true } = {}) {
  // LEXICAL containment check FIRST, unconditionally — before any filesystem access or
  // ENOENT-tolerant early return. `relative()` alone does not prove `targetPath` is
  // actually a descendant of `dir`: for a sibling or ancestor path it returns a string
  // starting with `..` (or, on Windows, an absolute path when the two are on different
  // drives). Checking this only AFTER `dir` itself is confirmed to exist would let a
  // not-yet-created `dir` (the normal `mustExist:false` case, e.g. before initial
  // adoption) short-circuit past containment entirely: `checkComponent(dir, ...)`
  // returning false on ENOENT would return from the whole function before the
  // out-of-tree target was ever inspected, certifying it safe by omission.
  const rel = targetPath === dir ? '' : relative(dir, targetPath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw invalid('GENERATION_DIR_UNSAFE', `${targetPath} is not inside ${dir}`);
  }

  const checkComponent = (current, isLast) => {
    let st;
    try {
      st = lstatSync(current);
    } catch (err) {
      if (err.code === 'ENOENT' && !mustExist) return false;
      throw invalid('GENERATION_DIR_UNSAFE', `cannot verify ${current} is safe: ${err.code ?? err.message}`);
    }
    if (st.isSymbolicLink()) {
      throw invalid('GENERATION_DIR_UNSAFE', `${current} is a symlink; the generation tree must never be reached through one`);
    }
    if (!isLast && !st.isDirectory()) {
      throw invalid('GENERATION_DIR_UNSAFE', `${current} is not a directory`);
    }
    return true;
  };

  if (!checkComponent(dir, targetPath === dir)) return;
  if (targetPath === dir) return;

  const parts = rel.split(sep);
  let current = dir;
  for (let i = 0; i < parts.length; i += 1) {
    current = join(current, parts[i]);
    if (!checkComponent(current, i === parts.length - 1)) return;
  }
}

/**
 * Validate a parsed `signing` block against the adoption-record schema. Returns the
 * validated record, or throws describing exactly which field is malformed — callers
 * (verifiers) distinguish "malformed" from "absent" per the spec's verifier contract:
 * an adoption record present but its fingerprint malformed/absent FAILS, it is never
 * silently treated the same as "no record at all".
 * @param {unknown} raw
 * @returns {{schemaVersion: number, keyFingerprint: string, generation: unknown, priorFingerprints: string[]}}
 */
export function validateAdoptionRecord(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid('MALFORMED_ADOPTION_RECORD', 'the "signing" record must be an object');
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw invalid('MALFORMED_ADOPTION_RECORD',
      `unsupported signing.schemaVersion: ${JSON.stringify(raw.schemaVersion)} (expected ${SCHEMA_VERSION})`);
  }
  if (typeof raw.keyFingerprint !== 'string' || !FINGERPRINT_RE.test(raw.keyFingerprint)) {
    throw invalid('MALFORMED_ADOPTION_RECORD', 'signing.keyFingerprint must be a 64-character lowercase hex sha256 digest');
  }
  if (!isLegacyGeneration(raw.generation)) validateGenerationId(raw.generation);
  // Default ONLY when the field is absent — an explicit `null` (or any other non-array
  // value) must fail validation, not be silently normalized to []. priorFingerprints is
  // the append-only tree-side commitment to every retired key; converting a corrupted
  // or tampered `null` into an empty array would erase that commitment instead of
  // refusing the record.
  const priorFingerprints = raw.priorFingerprints === undefined ? [] : raw.priorFingerprints;
  if (!Array.isArray(priorFingerprints) || priorFingerprints.some((f) => typeof f !== 'string' || !FINGERPRINT_RE.test(f))) {
    throw invalid('MALFORMED_ADOPTION_RECORD', 'signing.priorFingerprints must be an array of 64-character lowercase hex sha256 digests');
  }
  return {
    schemaVersion: raw.schemaVersion,
    keyFingerprint: raw.keyFingerprint,
    generation: raw.generation ?? 0,
    priorFingerprints,
  };
}

// SECURITY: config.json is repository-TRACKED (a rails-guard trust root), so a
// malicious branch can commit it as a symlink to an unbounded source (e.g. a character
// device). lstatSync FIRST, not just O_NOFOLLOW on the open — O_NOFOLLOW's enforcement
// is not portable (Windows symlinks are reparse points handled differently by Node's fs
// layer; @adlc/tickets/lib/manifest-segments.mjs hit this exact gap on Windows CI).
// lstatSync + isFile() is a portable, OS-independent check; O_NOFOLLOW stays for its
// atomicity where it IS honored. The byte cap closes the unbounded-read path.
//
// FAIL-CLOSED ON AMBIGUITY: record presence IS the required-signing bit (no separate
// boolean), so "genuinely absent" and "exists but I couldn't safely read it" must never
// collapse into the same `present: false` — that would let an EACCES, a symlink, or any
// other read failure on an ADOPTED repo's config.json silently look identical to "never
// adopted" to a future writer, which would then take the keyless legacy path exactly
// the way a downgrade attack wants it to. Only a confirmed ENOENT means absent; every
// other failure (non-regular object, open failure, read failure) is `present: true,
// valid: false` — ambiguous-and-must-fail-closed, never silently clean.
function readBoundedJsonNoFollow(path, maxBytes) {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if (err.code === 'ENOENT') return { present: false };
    return { present: true, valid: false, reason: `config.json could not be stat'd: ${err.code ?? err.message}` };
  }
  if (!st.isFile()) {
    return { present: true, valid: false, reason: 'config.json is not a regular file (symlink, directory, or other object)' };
  }
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    return { present: true, valid: false, reason: `config.json could not be opened: ${err.code ?? err.message}` };
  }
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
    if (bytesRead >= maxBytes) {
      return { present: true, valid: false, reason: `config.json exceeds the ${maxBytes}-byte read cap` };
    }
    let parsed;
    try {
      parsed = JSON.parse(buf.subarray(0, bytesRead).toString('utf8'));
    } catch {
      return { present: true, valid: false, reason: 'config.json is not valid JSON' };
    }
    return { present: true, valid: true, config: parsed };
  } catch (err) {
    return { present: true, valid: false, reason: `config.json could not be read: ${err.code ?? err.message}` };
  } finally {
    closeSync(fd);
  }
}

/**
 * Read and validate the adoption record from `<dir>/config.json`'s "signing" key.
 * Returns a discriminated result — callers (verifiers) must fail closed on
 * `valid: false`, never silently treat a malformed record the same as `present: false`
 * (spec verifier contract: "adoption record present but fingerprint malformed/absent ->
 * FAIL").
 * @param {string} dir  the .adlc directory
 * @returns {{present: false} | {present: true, valid: true, record: object} | {present: true, valid: false, reason: string}}
 */
export function readAdoptionRecord(dir) {
  // `dir` (.adlc) ITSELF is now confirmed safe before the config.json read, not just
  // config.json's own lstat: readBoundedJsonNoFollow only ever inspects the leaf, so a
  // symlinked .adlc ancestor would resolve through it to whatever config.json (present
  // or absent) sits at the redirected target — a genuinely absent target even reads as
  // "unadopted" rather than "unsafe". A confirmed ENOENT on dir itself IS genuine
  // absence (no .adlc at all means no adoption record at all); anything else unsafe
  // about dir is present-but-invalid, never silently treated as absent.
  let dirStat;
  try {
    dirStat = lstatSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return { present: false };
    return { present: true, valid: false, reason: `.adlc could not be stat'd: ${err.code ?? err.message}` };
  }
  if (dirStat.isSymbolicLink()) {
    return { present: true, valid: false, reason: '.adlc is a symlink; it must never be reached through one' };
  }
  if (!dirStat.isDirectory()) {
    return { present: true, valid: false, reason: '.adlc is not a directory' };
  }

  const configPath = join(dir, CONFIG_FILENAME);
  const result = readBoundedJsonNoFollow(configPath, MAX_CONFIG_JSON_BYTES);
  if (!result.present) return { present: false };
  if (!result.valid) return result;
  const { config } = result;
  // A structurally MALFORMED top-level value (null, an array, a primitive) is NOT the
  // same as a valid object that merely lacks a "signing" key — the former is corruption
  // and must fail closed (present:true, valid:false), the latter is legitimately
  // "not yet adopted" (present:false).
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return { present: true, valid: false, reason: 'config.json must contain a JSON object at the top level' };
  }
  if (!(ADOPTION_RECORD_KEY in config)) {
    return { present: false };
  }
  try {
    return { present: true, valid: true, record: validateAdoptionRecord(config[ADOPTION_RECORD_KEY]) };
  } catch (err) {
    return { present: true, valid: false, reason: err.message };
  }
}

/**
 * Resolve the manifest root path and segment directory for the file layout `dir` (a
 * .adlc directory) is currently authoritative for, given its adoption-record read. A
 * `present:true, valid:false` record is a caller error to pass here — resolve only after
 * handling that case (verifiers fail closed; a resolver has no generation to fall back
 * to for a malformed record).
 * @param {string} dir
 * @param {{present: boolean, valid?: boolean, record?: object}} adoption  readAdoptionRecord(dir)'s result
 * @returns {{manifestPath: string, segmentDirPath: string, generationDir: string}}
 */
export function resolveActiveGenerationPaths(dir, adoption) {
  if (adoption.present && !adoption.valid) {
    throw invalid('MALFORMED_ADOPTION_RECORD', `cannot resolve generation paths: ${adoption.reason}`);
  }
  const generation = adoption.present ? adoption.record.generation : 0;
  const generationDir = resolveGenerationDir(dir, generation);
  return {
    generationDir,
    manifestPath: join(generationDir, 'manifest.jsonl'),
    segmentDirPath: join(generationDir, 'manifest.d'),
  };
}

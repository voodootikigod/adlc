// GENERATED FILE — DO NOT EDIT DIRECTLY.
// Canonical trusted-binary PATH resolution and ownership verification.
// Copied by scripts/ticket-readers/generate.mjs into plugin hooks that cannot
// resolve @adlc/core at runtime.

import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

/**
 * Resolve the absolute path of `name` on PATH, skipping relative PATH entries
 * and `node_modules` directories, and requiring each candidate to pass
 * `ownershipRejection`. Never throws; returns null when no trusted binary resolves.
 */
export function resolveTrustedBinary(name, pathEnv) {
  for (const { candidate, rejection } of binaryCandidates(name, pathEnv)) {
    if (rejection === null) return candidate;
  }
  return null;
}

/**
 * Why a stat'ed candidate may not run, or null when it may. Accepted: a file this
 * user owns, or a `sudo npm i -g` install, where the file, the PATH entry naming
 * it (`link`, from lstat) and the directory holding that entry are all owned by
 * root, and neither the file nor the directory is writable by group or others.
 * Only root can create root-owned entries, so a symlink someone else planted,
 * pointing at a root-owned program such as /bin/sh, is still refused: the link
 * itself is not root's. A symlink's own mode bits are always 0777 and never
 * consulted; the directory decides who can replace it. `ancestors` are the
 * directories above the real file and above the PATH directory, up to `/`:
 * another account able to write any of them could swap what runs.
 */
export function ownershipRejection({ file, link, dir, ancestors = [] }, selfUid) {
  if (file.uid === selfUid) return null;
  if (file.uid !== 0) return `it is owned by uid ${file.uid}, not by you or by root`;
  const locked = (st) => st.uid === 0 && (st.mode & 0o022) === 0;
  if (!locked(file)) return 'it is root-owned but writable by group or others';
  const isSymlink = (link.mode & 0o170000) === 0o120000;
  if (link.uid !== 0 || (!isSymlink && !locked(link))) return 'it is reached through a link that root does not own';
  if (!locked(dir)) return 'its directory is not root-owned or is writable by group or others';
  if (!ancestors.every(locked)) return 'a directory above it is not root-owned or is writable by group or others';
  return null;
}

/** The directories above `file`, nearest first, up to and including the filesystem root. */
export function ancestorDirs(file) {
  const out = [];
  for (let d = dirname(file); ; d = dirname(d)) {
    out.push(d);
    if (dirname(d) === d) return out;
  }
}

/** The directories whose writers could swap what `candidate` runs: those above its real file and above the real PATH entry. */
export function candidateAncestors(candidate, dir, name) {
  return [...ancestorDirs(realpathSync(candidate)), ...ancestorDirs(join(realpathSync(dir), name))];
}

/** Every `name` file on PATH in order, each with its rejection reason (null when trusted). Never runs one. */
export function binaryCandidates(name, pathEnv) {
  if (typeof pathEnv !== 'string' || pathEnv.length === 0) return [];
  const sep = process.platform === 'win32' ? ';' : ':';
  const selfUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const out = [];
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    let file;
    try {
      file = statSync(candidate);
    } catch {
      continue; // no file here: try next PATH entry
    }
    if (!file.isFile()) continue;
    let stats = null;
    try {
      stats = candidateStats(candidate, dir, name, file, selfUid);
    } catch {
      /* refused below as uninspectable */
    }
    out.push({ candidate, rejection: candidateRejection(dir, stats, selfUid) });
  }
  return out;
}

/**
 * What ownershipRejection judges for an existing `candidate`: the followed file,
 * the PATH entry itself (lstat), its directory, and, for a root-owned file this
 * user does not own, every directory above the real file and the real PATH entry.
 * Throws when any of them cannot be stat'ed.
 */
export function candidateStats(candidate, dir, name, file, selfUid) {
  const stats = { file, link: lstatSync(candidate), dir: statSync(dir) };
  if (file.uid === 0 && file.uid !== selfUid) {
    stats.ancestors = candidateAncestors(candidate, dir, name).map((d) => statSync(d));
  }
  return stats;
}

/**
 * Why the candidate found in PATH entry `dir` may not run (null when it may).
 * Where it was found is judged first, so a repository-controlled location is
 * named even when its stats are missing; `stats` is null when they could not
 * be gathered.
 */
export function candidateRejection(dir, stats, selfUid) {
  if (!isAbsolute(dir)) return 'it is reached through a relative PATH entry, which resolves inside the repository';
  if (dir.includes('node_modules')) return 'it is inside node_modules, where a repository could have placed it';
  if (stats === null) return 'its link or a directory above it could not be inspected';
  return selfUid === null ? null : ownershipRejection(stats, selfUid);
}

/**
 * Why no trusted `name` resolved although PATH holds one, as a sentence naming the
 * first refused candidate. Null when a trusted one resolves (its failure is not a
 * refusal) and when PATH holds none (an absent toolkit stays silent).
 */
export function untrustedBinaryReason(name, pathEnv) {
  const all = binaryCandidates(name, pathEnv);
  if (all.length === 0 || all.some((c) => c.rejection === null)) return null;
  const { candidate, rejection } = all[0];
  return `${JSON.stringify(candidate)} was not run because ${rejection}. Install @adlc/cli globally (npm i -g @adlc/cli) as yourself or as root.`;
}

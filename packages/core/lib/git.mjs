// Git helpers. All functions shell out via execFileSync (no shell injection
// surface — args are passed as an array, never interpolated).

import { execFileSync } from 'node:child_process';

// Exported (rather than inlined) so a test can pin the exact value directly —
// generating 64 MiB of real git output per mutation trial to observe this
// behaviorally would make every CI run pay that cost.
export const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export function git(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    ...opts,
  });
}

/**
 * Split raw NUL-delimited `git ... -z` OUTPUT (a Buffer) into path strings, and
 * PROVE each decode is lossless.
 *
 * UTF-8 decoding is not injective: every byte git cannot decode becomes U+FFFD.
 * So two files whose names differ only in invalid bytes — `bad-\x80/p.json` and
 * `bad-\xEF\xBF\xBD/p.json` — both decode to `bad-�/p.json` and collapse to
 * ONE entry. A downstream gate keyed on that string then answers for the wrong
 * file: a version bump on one path and a behaviour edit on the other resolve to a
 * single cache entry, and the behaviour edit is exempted. This is the filename
 * analogue of the content-level aliasing fixed in #228; see #249.
 *
 * Splitting the BUFFER on the NUL byte (not the decoded string) keeps the split
 * itself immune to decoding, then each field is decoded and required to
 * re-encode to its exact bytes. A field that does not is a path git is telling us
 * about but that we cannot represent faithfully, so we FAIL CLOSED — a caller of
 * this in a freeze gate must never receive a path that silently aliases another.
 * A non-round-trip filename is already pathological in this repo; the trade is a
 * hard error over a silent wrong answer.
 *
 * @param {Buffer|string} raw  git -z output. A string is accepted for callers
 *        that already decoded, but note it cannot detect aliasing that the
 *        decode already erased — prefer passing the Buffer.
 * @returns {string[]}
 */
export function splitNulPaths(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
  const out = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0) {
      if (i > start) {
        const field = buf.subarray(start, i);
        const text = field.toString('utf8');
        if (!Buffer.from(text, 'utf8').equals(field)) {
          throw new Error(
            `git returned a path that is not valid UTF-8 and cannot be handled ` +
            `safely: ${JSON.stringify(text)}. Refusing to proceed — see #249.`
          );
        }
        out.push(text);
      }
      start = i + 1;
    }
  }
  return out;
}

export function isGitRepo(cwd = process.cwd()) {
  try {
    git(['rev-parse', '--is-inside-work-tree'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

export function gitDiff(base = 'HEAD', cwd = process.cwd()) {
  // -c core.quotepath=false stops git octal-escaping non-ASCII BYTES in the patch
  // headers (+++/---), so a non-ASCII filename no longer desyncs a header parser
  // (rails-guard's parseAddedLines, mutate's changedLinesFromDiff). NOTE: unlike a
  // name list, patch text has no -z form, so this does NOT neutralize every special
  // character — a path with a space still gets a trailing TAB, and tab/quote/newline
  // names are still double-quoted. Those desync per-file HEADER attribution only;
  // the security-critical changed-file SET goes through changedFiles(), which
  // splits raw -z bytes and FAILS CLOSED on any path it cannot decode faithfully
  // (#249) — so that set is trustworthy where these header paths are not. Marker
  // and content detection match on line bodies, not header paths.
  return git(['-c', 'core.quotepath=false', 'diff', base, '--'], { cwd });
}

/** True if `ref` resolves to a commit in this repo. */
export function refExists(ref, cwd = process.cwd()) {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the baseline a freeze/diff gate must compare against: the point where
 * the current work diverged from the trunk. Returns the merge-base of HEAD and
 * the first trunk candidate that exists, or null if none can be found.
 *
 * Gates MUST fail closed when this returns null rather than fall back to HEAD —
 * `git diff HEAD` hides changes that were already committed, so a builder that
 * commits a rail edit would otherwise pass a freeze check against an empty diff.
 */
export function resolveBase(
  cwd = process.cwd(),
  candidates = ['main', 'master', 'origin/main', 'origin/master']
) {
  for (const c of candidates) {
    if (!refExists(c, cwd)) continue;
    try {
      const mb = git(['merge-base', c, 'HEAD'], { cwd }).trim();
      if (mb) return mb;
    } catch {
      // candidate exists but shares no history with HEAD — try the next one
    }
  }
  return null;
}

export function changedFiles(base = 'HEAD', cwd = process.cwd()) {
  // -z emits NUL-delimited raw paths, immune to git's C-quoting of non-ASCII/
  // special characters. Splitting on '\n' the quoted form would hand a downstream
  // matcher (e.g. rails-guard's checkRailEdits) a display string that never matches
  // the real rail path — a silent freeze-gate bypass.
  //
  // Read as a BUFFER and split via splitNulPaths, not `.split('\0')` on a decoded
  // string: decoding first collapses distinct invalid-byte paths to one U+FFFD
  // string BEFORE the split can tell them apart (#249). splitNulPaths fails closed
  // on any path that does not round-trip UTF-8.
  //
  // Union the base-vs-working-tree diff with the base-vs-index (`--cached`) diff. A
  // two-dot `git diff <base>` alone never consults the index, so a rail edit STAGED
  // and then reverted in the working tree diffs empty — yet `git commit` records the
  // staged blob. A gate reading a working-tree-only set would then pass a tree that
  // is not the one being committed (#244). A path differing from base in EITHER place
  // is changed. `--cached` catches a purely-staged edit; the plain diff catches an
  // unstaged one; a Set de-duplicates the overlap. Both invocations go through the
  // same buffer-safe split, so the #249 fidelity guarantee applies to each half.
  const raw = (args) => git(args, { cwd, encoding: 'buffer' });
  const worktree = splitNulPaths(raw(['diff', '--name-only', '-z', base, '--']));
  const staged = splitNulPaths(raw(['diff', '--cached', '--name-only', '-z', base, '--']));
  return [...new Set([...worktree, ...staged])];
}
export function isDirty(cwd = process.cwd()) {
  return git(['status', '--porcelain'], { cwd }).trim().length > 0;
}

/**
 * Absolute path to the repository's top-level working directory, regardless
 * of which subdirectory `cwd` is. Callers that need to reason about
 * repo-root-relative paths (or verify a path stays inside the repo) should
 * use this rather than assuming `cwd` itself is the root.
 */
export function repoRoot(cwd = process.cwd()) {
  return git(['rev-parse', '--show-toplevel'], { cwd }).trim();
}

/**
 * Logical-coupling mining: how often do file pairs change in the same commit?
 * Returns { pairCounts, fileCounts } where pairCounts keys are 'a\u0000b'
 * (sorted), values are co-commit counts. Use pairKey() to build lookups.
 */
export function coChange(limit = 500, cwd = process.cwd()) {
  const out = git(
    ['log', `-n`, String(limit), '--name-only', '--pretty=format:--COMMIT--'],
    { cwd }
  );
  const pairCounts = {};
  const fileCounts = {};
  for (const block of out.split('--COMMIT--')) {
    const files = [...new Set(block.split('\n').map((l) => l.trim()).filter(Boolean))];
    // Skip mega-commits (renames, vendoring) — they assert coupling between everything.
    if (files.length === 0 || files.length > 50) continue;
    for (const f of files) fileCounts[f] = (fileCounts[f] ?? 0) + 1;
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = pairKey(files[i], files[j]);
        pairCounts[key] = (pairCounts[key] ?? 0) + 1;
      }
    }
  }
  return { pairCounts, fileCounts };
}

export function pairKey(a, b) {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/** Commit-count churn per file over the last `limit` commits. */
export function churn(limit = 1000, cwd = process.cwd()) {
  const out = git(
    ['log', '-n', String(limit), '--name-only', '--pretty=format:'],
    { cwd }
  );
  const counts = {};
  for (const line of out.split('\n')) {
    const f = line.trim();
    if (f) counts[f] = (counts[f] ?? 0) + 1;
  }
  return counts;
}

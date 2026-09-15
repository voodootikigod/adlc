/**
 * `contentHash` — the cache key (§4) and the gate's replay key (§3.6), defined
 * once so the two cannot drift apart.
 *
 * SHA-256 over each referenced path's bytes at HEAD, in LEXICOGRAPHIC path
 * order, with the path NAME included in the digest input:
 *  - lexicographic order makes the hash a property of the referenced SET, not of
 *    whatever order the parser happened to emit;
 *  - including the name means adding or removing a path changes the hash even
 *    when the surviving files are untouched, and a rename is not invisible.
 *
 * Every component is LENGTH-DELIMITED. A plain `path + content` concatenation
 * lets `"ab" + "c"` collide with `"a" + "bc"`, which would let one file's bytes
 * migrate into another's name without changing the key.
 *
 * An issue with NO referenced paths has no contentHash — `null`, not the hash of
 * the empty string. That distinction is load-bearing: §4 forbids caching such an
 * issue as `valid`, because a key with no code component can never be
 * invalidated by a code change.
 *
 * Bytes are read AT HEAD, matching verification. Hashing the working tree would
 * key the cache on uncommitted edits, so a verdict computed from HEAD would be
 * stored under a key describing someone's half-finished change.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

/**
 * @param {string[]} paths - referenced repo-relative paths
 * @param {{readFile?: Function}} [io]
 * @returns {string|null} hex digest, or null when there is nothing to hash
 */
export function contentHash(paths, { revision = 'HEAD', readFile = (p) => readFileAtHead(p, revision) } = {}) {
  const unique = [...new Set(paths ?? [])].sort();
  if (unique.length === 0) return null;

  const h = createHash('sha256');
  for (const p of unique) {
    let content;
    try {
      content = readFile(p);
    } catch {
      // An unreadable path yields NO hash rather than a hash of "": hashing the
      // empty string would make two different broken states look identical and
      // would let a cache entry survive the file coming back.
      return null;
    }
    const bytes = Buffer.from(String(content), 'utf8');
    h.update(`${Buffer.byteLength(p, 'utf8')}:${p}`);
    h.update(`${bytes.length}:`);
    h.update(bytes);
  }
  return h.digest('hex');
}

/** Read `path` as of HEAD; throws when it is absent there. */
function readFileAtHead(path, rev = 'HEAD', run = execFileSync) {
  return String(run('git', ['show', `${rev}:${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }));
}

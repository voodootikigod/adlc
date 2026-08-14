// GENERATED-GLOB SOURCE. Run `node scripts/ticket-readers/generate.mjs` after edits.
//
// The rail/scope glob matcher. Copied verbatim into every harness that cannot
// resolve @adlc/core at runtime, so imports here are limited to nothing at all.

const SLASH = '/'.charCodeAt(0);

/**
 * Minimal glob match supporting '*' (within a segment) and '**' (across
 * segments). Enough for declared-scope checks; not a full glob engine.
 *
 * The token vocabulary is exactly what the split below produces:
 *   `**\/` an optional run ending in a slash   (was `(?:.*\/)?`)
 *   `**`   any run, slashes included           (was `.*`)
 *   `*`    any run inside one segment          (was `[^/]*`)
 *   else   a literal, `?` and `[` included — they are not glob syntax here
 *
 * Matched by simulating the automaton rather than by compiling a regex. The
 * regex form was correct and backtracked catastrophically: adjacent `**\/`
 * tokens overlap, so a pattern with a dozen of them took SECONDS on a path that
 * nearly matched, and 200 of them did not finish in ten minutes. Rails are
 * patterns from the ticket store and every rail check calls this first, so that
 * was one unusual rail away from wedging a synchronous pre-execution hook.
 *
 * Here each token advances a set of reachable offsets in ONE left-to-right pass,
 * so the work is bounded by tokens × path length with nothing to backtrack.
 *
 * ONE deliberate change of answer comes with that, and only one: `**` now
 * crosses a LINE TERMINATOR (LF, CR, U+2028, U+2029). The regex expanded it to
 * `.*`, and JavaScript's `.` excludes those characters unless the `s` flag is
 * set — which it never was. Git allows a newline in a path, so a rail
 * `src/**\/frozen.mjs` simply stopped freezing `src/a<LF>b/frozen.mjs`: a
 * matcher artefact, never a decision, and a hole in exactly the direction a
 * freeze must not have one. `*` is unaffected — it expanded to `[^/]*`, whose
 * negated class always admitted them.
 */
export function globMatch(pattern, path) {
  const tokens = pattern.split(/(\*\*\/|\*\*|\*)/).filter((part) => part !== '');
  // reach[i] = the pattern consumed so far can end at offset i. One slot per
  // offset INTO the path, plus the offset just past its last character, which
  // is the accepting one — `end` is read back off the buffer rather than
  // recomputed, so the two can never drift apart.
  let reach = new Uint8Array(path.length + 1);
  const end = reach.length - 1;
  reach[0] = 1;
  for (const token of tokens) {
    const next = new Uint8Array(reach.length);
    if (token === '**') {
      // Any run: once an offset is reachable, so is every later one.
      let open = false;
      for (let i = 0; i <= end; i++) {
        if (reach[i]) open = true;
        if (open) next[i] = 1;
      }
    } else if (token === '**/') {
      // Either nothing, or a run ending at a slash.
      let open = false;
      for (let i = 0; i <= end; i++) {
        if (reach[i]) { next[i] = 1; open = true; }
        if (open && i < end && path.charCodeAt(i) === SLASH) next[i + 1] = 1;
      }
    } else if (token === '*') {
      // A run that stops at the segment boundary rather than crossing it.
      let open = false;
      for (let i = 0; i <= end; i++) {
        if (reach[i]) open = true;
        if (open) next[i] = 1;
        if (i < end && path.charCodeAt(i) === SLASH) open = false;
      }
    } else {
      for (let i = 0; i + token.length <= end; i++) {
        if (reach[i] && path.startsWith(token, i)) next[i + token.length] = 1;
      }
    }
    // No early exit on an all-zero pass: an empty reach set propagates zeros
    // through the remaining tokens and reaches the same answer, so bailing out
    // would be an optimization no result can distinguish.
    reach = next;
  }
  return reach[end] === 1;
}

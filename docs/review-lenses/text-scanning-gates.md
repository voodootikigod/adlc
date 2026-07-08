# Review lens — text-scanning gates (operative vs inert boundary)

A **review lens** is a set of questions a reviewer (or a P5 prosecutor) asks of a
change. This one is distilled by [`lesson-foundry`](../tools/lesson-foundry.md)
(P7) from three same-class defects, and graduated out of the local
`.adlc/lessons/` staging area to here so it is versioned and shared.

Apply it in **P1** (spec) and **P5** (prosecution) to **any gate that scans
source text for "operative" markers** and exempts inert prose/display context —
e.g. `rails-guard`'s suppression scan, secret scanners, banned-API / bare-command
guards, TODO/FIXME gates, or license-header checks.

## Where it came from

The `rails-guard` `.mdx` suppression scan (PR #103) exempts markers that appear in
Markdown *code contexts* (inline spans, fenced blocks) because they render as
inert text. A three-round adversarial prosecution found **three different bypasses
of one root failure** — the detector *approximated* the operative-vs-inert
boundary instead of deriving it authoritatively:

1. **Naive delimiter toggle desynced from the real grammar.** A `` ``` `` line
   inside a ```` ```` ```` block flipped the fence state, so operative code after
   the *real* closer was judged inert. Fix: implement the actual CommonMark rule —
   a closer must match the opener's fence character **and be at least as long**.
2. **Blanket-stripping a delimiter pair ate operative code.** `stripInlineCode`
   removed everything between back-ticks, including an operative `${…}` template
   interpolation. Fix: preserve regions that are operative in the target language
   (interpolations, JSX expressions).
3. **A regex anchor ran before line endings were normalized.** A CRLF closer
   (`` ```\r ``) left a `\r` that defeated `$`, so the fence never "closed" and
   operative lines were judged inert. Fix: normalize `\r\n` / lone `\r` / BOM
   *before* anchoring.

Each of these shipped past initial unit tests and was only caught by adversarial
prosecution — which is why they belong in a lens, not just a changelog.

## The lens

- [ ] **Authoritative source, not an approximation.** Does the detector judge
      operative-vs-inert from the *same artifact the compiler/runtime consumes*
      (the full file), rather than a diff window, a single line, or a summary? A
      per-line or per-hunk view cannot see enclosing context and *will* desync.
- [ ] **Real grammar, not a lookalike toggle.** If it parses a structured format
      (Markdown fences, quotes, comments, heredocs, brackets), does it implement
      the actual closing/escaping rules, rather than flip state on any delimiter
      that *looks* like a boundary?
- [ ] **Normalize before anchoring.** Are line endings (`\r\n`, lone `\r`), BOM,
      and surrounding whitespace normalized *before* regex anchors (`^`/`$`) run?
- [ ] **Strip only provably-inert regions.** When exempting "prose" (inline code,
      fenced blocks, comments), does the exemption exclude constructs that are
      *operative* in the target language (template interpolations, JSX
      expressions, here-doc substitutions)? Never blanket-strip a delimiter pair.
- [ ] **Fail closed on every ambiguity.** When context cannot be resolved
      (unreadable file, pathological input, an unparseable region), does the gate
      *scan* the line — risking a false positive — rather than *skip* it, which
      risks a silent bypass?
- [ ] **Adversarially prosecuted, with evasions as regression tests.** Was the
      exemption logic attacked by a skeptic trying to smuggle an operative marker
      through each inert channel, and was every demonstrated evasion turned into a
      permanent regression test?

## Related

- [`lesson-foundry`](../tools/lesson-foundry.md) — mines repeated findings into
  defenses like this lens (P7).
- [`rejection-mining`](../tools/rejection-mining.md) — mines human PR objections
  into review lenses (P7).
- [`prosecute`](../tools/prosecute.md) — the P5 gate this lens feeds.

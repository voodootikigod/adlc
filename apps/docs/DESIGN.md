---
name: ADLC Marketing — The Change Record
description: A controlled-change record on cool paper, whose evidence stays on the terminal ground that produced it.
colors:
  ground: "#1c1d21"
  foreground: "#cbcdd2"
  comment: "#686b78"
  green: "#78bd65"
  yellow: "#e5cd52"
  blue: "#4fb4d8"
  orange: "#ef7c2a"
  red: "#eb3d54"
  rec-paper: "#e7eaef"
  rec-paper-raised: "#f2f4f7"
  rec-paper-sunk: "#dde1e8"
  rec-ink: "#171920"
  rec-ink-2: "#464c5c"
  rec-ink-3: "#5a616f"
  rec-rule: "#c6cbd6"
  rec-rule-strong: "#a7aebd"
  rec-pass-ink: "#2f6a22"
  rec-pass-edge: "#9dc492"
  rec-pass-field: "#e2efdd"
  rec-fail-ink: "#a81d31"
  rec-fail-edge: "#dda3ad"
  rec-fail-field: "#f7e2e5"
  rec-gate-ink: "#6f5a0d"
  rec-gate-edge: "#cbb44a"
  rec-gate-field: "#faf3d8"
  rec-link: "#17627f"
  rec-link-edge: "#a9cede"
  rec-failure-id: "#a24e15"
  exhibit-border: "#34363d"
  exhibit-rule: "#2c2e34"
  terminal-nav: "#9599a6"
  terminal-muted: "#9093a0"
  terminal-link-edge: "#2b5f74"
  terminal-edge: "#000000"
  print-paper: "#ffffff"
  print-paper-sunk: "#f4f4f4"
  print-ink: "#000000"
  print-ink-2: "#333333"
  print-ink-3: "#555555"
  print-rule: "#999999"
  print-rule-strong: "#444444"
typography:
  statement:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "clamp(30px, 4.3vw, 54px)"
    fontWeight: 700
    lineHeight: 1.02
    letterSpacing: "-0.022em"
  clause-title:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "clamp(19px, 2.1vw, 26px)"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.018em"
  lede:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "16.5px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  row-title:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.012em"
  metric:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  caption:
    fontFamily: "Azeret Mono, ui-monospace, monospace"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.1em"
  chip:
    fontFamily: "Azeret Mono, ui-monospace, monospace"
    fontSize: "10.5px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.03em"
  legend:
    fontFamily: "Azeret Mono, ui-monospace, monospace"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0.13em"
  identifier:
    fontFamily: "Azeret Mono, ui-monospace, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  evidence:
    fontFamily: "Azeret Mono, ui-monospace, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.75
    letterSpacing: "normal"
rounded:
  none: "0px"
spacing:
  hairline: "1px"
  cell-x: "12px"
  cell-y: "14px"
  field: "18px 24px"
  clause-y: "48px"
  gutter: "104px"
components:
  install-field:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.foreground}"
    typography: "{typography.identifier}"
    rounded: "{rounded.none}"
    padding: "12px 16px"
  install-field-copy:
    backgroundColor: "#26272c"
    textColor: "{colors.foreground}"
    typography: "{typography.legend}"
    rounded: "{rounded.none}"
    padding: "0 16px"
  exit-code-pass:
    backgroundColor: "{colors.rec-pass-field}"
    textColor: "{colors.rec-pass-ink}"
    typography: "{typography.chip}"
    rounded: "{rounded.none}"
    padding: "2px 6px"
  exit-code-fail:
    backgroundColor: "{colors.rec-fail-field}"
    textColor: "{colors.rec-fail-ink}"
    typography: "{typography.chip}"
    rounded: "{rounded.none}"
    padding: "2px 6px"
  exit-code-attest:
    backgroundColor: "{colors.rec-gate-field}"
    textColor: "{colors.rec-gate-ink}"
    typography: "{typography.chip}"
    rounded: "{rounded.none}"
    padding: "2px 6px"
  chain-row:
    backgroundColor: "{colors.rec-paper-raised}"
    textColor: "{colors.rec-ink}"
    rounded: "{rounded.none}"
    padding: "14px 12px"
  chain-row-human:
    backgroundColor: "{colors.rec-gate-field}"
    textColor: "{colors.rec-gate-ink}"
    rounded: "{rounded.none}"
    padding: "14px 12px"
  exhibit:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.foreground}"
    typography: "{typography.evidence}"
    rounded: "{rounded.none}"
    padding: "14px 16px"
---

# Design System: ADLC Marketing

## Overview

**North star: The Change Record.**

The marketing surfaces are one controlled-change record. In an enterprise nothing
reaches production without a record of what changed, why, who assessed the impact,
what the back-out is, who approved it, and what evidence was attached — and that
record is what makes a change *defensible* rather than merely done. That is the
question ADLC's buyer has about agents, so the site is not a page describing the
product; it is the record for adopting it.

The system has two surfaces and the split between them carries the argument:

- **The record is paper.** Cool, desaturated, ruled, squared, fixed fields and
  numbered clauses. This is what a person reads and what a non-engineer could
  audit.
- **The evidence is terminal.** Real gate output on `#1c1d21` in the unmodified
  An Old Hope palette. This is what a machine produced.

Evidence is never restyled to match the page around it. The contrast is the point.

Voice is evidence-first and never promotional; over-claiming is treated as a
defect here, not a stylistic preference. The register is deliberately corporate
and unwhimsical: the audience is engineers and the leadership accountable for what
agents merge, and charm reads as the opposite of defensible.

**Confirmed anti-references.** Rejected during direction selection and not to be
revisited: instrument panels and oscilloscopes, split-flap departure boards, and
anything else whose primary register is charm. Also refused: near-black with one
neon accent and glow (the incumbent world this replaced), and the clean
enterprise-SaaS default of white/slate with a blue accent over a card grid.

## Colors

**Strategy: two committed fields, not accents on neutral.** Paper owns the record;
the terminal ground owns evidence, the masthead, and the primary control. Colour
is never sprinkled — a hue appears because it is a verdict, a link, or the brand
mark.

`An Old Hope` is a pinned brand commitment (PRODUCT.md) and is the authority for
the terminal side. The paper is derived *from* it: `#e7eaef` is the palette's own
foreground desaturated up, never a borrowed warm cream, because An Old Hope is a
cool scheme and the record must belong to it.

**Verdict colour is doubled, never sole.** Every verdict pairs a glyph with a word
(`✓ PASS`, `✗ FAIL`, `◆ ATTEST`), and machine verdicts carry the exit code, because
the exit code is the actual contract. This is a binding accessibility commitment,
not a preference.

**The terminal side has its own neutrals.** Paper inks are unreadable on
`#1c1d21`, so anything rendered on the terminal ground draws from
`foreground` (#cbcdd2), `terminal-nav` (#9599a6, masthead links),
`terminal-muted` (#9093a0, body copy on the evidence band), `comment` (#686b78,
prompts and dimmed notes), and `terminal-link-edge` (#2b5f74, the underline on a
link over dark). `terminal-edge` (#000) is the single hard rule where the record
meets the evidence band. Never reach for a `rec-*` ink on the terminal.

Verdict hues exist twice: the An Old Hope originals on the terminal, and darkened
inks (`rec-pass-ink`, `rec-fail-ink`, `rec-gate-ink`) that clear 4.5:1 on paper.
Never put the terminal-bright green, red, or yellow on paper as text.

**Semantics are fixed:** green passes, red refuses, amber is the human gate.
Orange is reserved for the failure register's F-identifiers (`#a24e15` on paper — the palette orange darkened to clear 4.5:1 on the raised paper tone).
Blue is links only.

## Typography

**Archivo** sets the record, **Azeret Mono** sets the machine.

Archivo is a grotesque out of documentary and industrial printing and carries a
width axis, which is what lets the statement run at panel scale without importing
a second display face. `wdth: 92` is used only on the statement and interior page
leads.

Azeret Mono is not a costume for "technical." It appears where the content is an
identifier, an exit code, a filename, a command, a field legend, or captured
output — measurement and code, never prose.

The ramp is a real hierarchy: statement (30–54px), clause title (19–26px), lede
(16.5px), row title (15px), body (13.5px). Legends sit at 11px with `0.13em`
tracking; caption (11px) numbers exhibits and labels controls, and chip (10.5px)
sets the verdict chips. **Row title is the workhorse** — it names the subject of a row in every
register (approval chain, failure map, rollout schedule, harness list, dial
settings), and it is the one step that carries semibold weight at small size.
Metric (22px) is reserved for a bare count standing alone in a cell. Tracking never passes −0.04em; the statement sits at −0.022em.

Prose measure stays at 72–74ch. Display type is NOT held to a prose measure: a heading only needs to avoid one absurdly long line, so statements cap at 26ch and clause titles at 34ch. Capping a heading at prose width forces a short sentence into four ragged lines and strands the right half of the column. Numerals in prose are spelled out; numerals in
cells are tabular (`font-feature-settings: 'tnum'`).

## Layout

One ruled column, `max-width: 1180px`, with visible left and right rules that run
continuously down the page — the record is a bounded document, not a series of
floating sections.

**The clause is the unit.** Every section is a clause: a numbered label in a
104px left gutter, content in the measure beside it, an optional 260px aside
divided by a rule. Clause numbering is the form's own grammar, not decoration —
exhibits reference the clause they attach to.

**Tables have fixed columns that never move.** Below `md` they collapse to a
two-column stack, with the identifier and name on the first line and the
remaining fields below, rather than scrolling sideways.

Density is paced deliberately: airy statement → medium control → dense chain →
dense register → the full-bleed evidence band → compact list → quiet economics
passage. A dense passage earns a quiet one. More space sits above a heading than
below it.

The evidence band is the page's one full-bleed moment and its only tonal break.

## Elevation & Depth

**Flat by law.** Elevation is declared once, as a 1px rule, and never as a shadow.
There are no shadows, no glass, no blur, and no glow anywhere in the system. A
ruled document gets its authority from precision and alignment, and a soft shadow
under a hairline would be the ghost card.

Grouping is expressed three ways only: a hairline rule, a `gap-px` lattice over a
rule-coloured container, or a shift between the three paper tones (`rec-paper`,
`rec-paper-raised`, `rec-paper-sunk`).

## Shapes

**Radius is zero, everywhere.** No pills, no rounded cards, no rounded buttons.
Package names are squared cells in a lattice because a pill is a control and those
are line items.

Two marks carry shape meaning and must stay distinguishable without colour: the
**human gate** is a rotated square (a diamond), the **machine gate** is an open
ring. The masthead brand mark is a 9px green square — the one place pass-green is
identity rather than verdict. The only circle in the system is the 6px status lamp
in the record rail.

## Components

**Install command — the record's primary control.** Not a call-to-action button
beside the copy: it is the value of the IMPLEMENTATION field, so it renders as the
form's executable field — squared, 1px ink border, on the terminal ground, with a
`$` in pass-green and a COPY control divided by a rule. It wraps on narrow screens
rather than scrolling, because a visitor who cannot see the whole command cannot
verify what they are about to pipe to `sh`. The command is always rendered
server-side and always imported from `lib/install-commands.mjs`.

**Exhibit.** A verbatim capture with a number and the clause it attaches to.
Header strip carries the command and the exit status; the body is real output.
Prompts dim to `comment`; verdict lines keep glyph, word, and hue.

**Approval chain.** One row per control point: identifier, name, exit gate, what
acts at that phase, verdict. Human gates are the rows where that is a person —
marked by the amber field, the diamond, and the word, so the exception is
structural rather than chromatic.

The column is headed "At this phase", never "Approver". Naming a tool that runs
at a phase is true; naming it as the thing that closes the gate is a claim the
toolkit does not back for every phase — `rails-guard` enforces frozen rails
rather than proving a suite is RED, and `build-gate` guards entry to a build
rather than validating one. Every name shown must still dispatch through `adlc`,
which `marketing-approvers.test.mjs` enforces.

**Attestation block.** The record ends in signatures. The two human gates render as
signature panels with a ruled signature line and `SIGNED BY A PERSON`. This is the
system's most load-bearing device for the leadership reader and must not be
demoted back into a table cell.

**Masthead.** Stays on the terminal ground on every route — the hard top edge that
keeps the record attached to the world that produced it.

**Motion — one authored moment.** The record resolves: chain rows settle in
sequence at 32ms intervals and each verdict stamps in just after its row. It plays
once on load and holds. There is no second animation anywhere in the system;
scattered hover effects and per-section entrances are not part of it. Everything
honours `prefers-reduced-motion`, which is a binding commitment.

**Print.** The record prints as a document: ink on white, rules preserved, nav
dropped, animation disabled.

## Do's and Don'ts

**Do**

- Attach an exhibit to every claim about what the toolkit does. Argument may be
  argument; capability may not.
- Keep evidence on the terminal ground wherever it appears, including on paper.
- Pair every verdict with a glyph and a word, and carry the exit code for machine
  verdicts.
- Derive counts from the data modules (`phase-graph.mjs`, `toolkit-packages.mjs`)
  rather than typing them.
- Label authored framing. `ADLC-CR-0001` and its status are illustrative and say so
  on the page.
- Name limits plainly: Windows is unsupported, in-session hooks are best-effort,
  the CI gate is the unbypassable control.

**Don't**

- Don't round a corner, add a shadow, or reach for glass, glow, or gradient text.
- Don't put terminal-bright green, red, or yellow on paper as text.
- Don't use monospace for prose, or a tracked uppercase eyebrow over every
  section — the clause label is the form's grammar and an eyebrow is not.
- Don't restyle an exhibit to match the paper around it.
- Don't add a second entrance animation; the record resolves once.
- Don't claim a per-phase evidence artifact the repository cannot back. The chain
  deliberately has no evidence column for exactly this reason; the manifest is
  named once instead.
- Don't invent customers, benchmarks, logos, or time-saved figures, and don't
  pluralize the single public testimonial.

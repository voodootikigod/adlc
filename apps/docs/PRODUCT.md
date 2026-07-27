# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two primary audiences, served deliberately rather than as an unresolved split.

**The hands-on engineer.** Already working inside an agent harness — Claude Code,
Codex, Cursor, OpenCode, pi, Antigravity, or Copilot — and losing time to agent
failure modes: confident hallucination, premature satisfaction, context rot,
tests that pass without testing. Evaluates by installing and getting a gate to
run against their own repository. Adopts bottom-up.

**The engineering leader.** Lead, staff engineer, or director accountable for
what agents merge. Evaluates whether the process is defensible — whether there
is an audit trail a non-engineer could read. Buys top-down.

Both paths are real and neither is a funnel stage for the other. The site must
serve both without diluting either.

## Product Purpose

ADLC is a software lifecycle rebuilt around the ways AI models fail, plus the
toolkit that enforces it. Eight phases, P0–P7, each ending in an explicit exit
contract: deterministic gates leave machine-checkable evidence, and two human
gates record attestation.

**Success is an install** — someone runs the one-line installer and gets a gate
passing in their own repository. The enterprise contact path exists and is
wired to a real pipeline, but adoption is the metric, not lead volume.

## Positioning

The SDLC defends against *human* failure modes: forgetting, fatigue, ambiguity,
turnover. Agents fail differently — they fail confidently, quickly, and at
scale. ADLC's claim is that a process built for one is not adequate for the
other.

The mechanism a neighbouring product could not truthfully copy: every gate is a
**zero-dependency CLI whose exit code is the contract** — `0` passes, `1` is an
operational error, `2` means the gate refused. That makes the lifecycle
executable in CI rather than aspirational in a wiki. Every LLM-backed gate also
supports `--prompt-only`, so the whole thing runs with no API keys: the agent
already in the room is the model.

## Operating Context

Adopters work in a terminal, inside an agent harness, on a git repository with
CI. The lifecycle attaches to artifacts they already have: tickets, specs,
branches, pull requests, workflow files, and review.

Two enforcement layers, and the distinction is load-bearing in every
explanation: in-session hooks are best-effort and harness-dependent, while the
commit-time CI gate is the unbypassable control. Marketing must never present
the in-session layer as the guarantee.

## Capabilities and Constraints

- 26 gate CLIs behind one dispatcher (`adlc <tool>`), zero runtime dependencies,
  Node 18+.
- Seven native harness integrations, plus a harness-neutral skills.sh catalog
  that installs **skills only** — no hooks, MCP, agents, or rail enforcement.
- One-line installer at `agenticlifecycle.ai/install.sh` (macOS and Linux).
- **Windows is not supported.** A `windows-latest` CI run passed 6 of 28 core
  suites. Tracked in issue #352. Do not soften this to "beta" or "experimental".
- `adlc fleet` is POSIX-only by design.
- Published under the `@adlc` npm scope, MIT, via OIDC trusted publishing with a
  human approval gate.
- **Open:** substantial merged work is unreleased — as of 2026-07-27 the npm
  packages sit at 1.6.0 while main carries 47 commits beyond that tag, including
  the entire Copilot harness. Any claim about a shipped capability must be
  checked against the *published* version, not the repository.

## Brand Commitments

- Name: ADLC / the Agentic Development Lifecycle. Site: www.agenticlifecycle.ai.
- Author: Chris Williams (@voodootikigod).
- Origin: the essay series at voodootikigod.com/series/adlc. The site is the
  argument's storefront; the essays are its source.
- **Voice: evidence-first and specific, never promotional.** The repository
  encodes this as a documented obligation (ADR-0009 Decision 4): document only
  the coverage a channel actually has. Over-claiming is treated as a defect,
  not a stylistic preference.
- Terminology is fixed and meaningful: *gate*, *rail*, *prosecute*, *evidence*,
  *attestation*, *phase*. Do not swap these for softer synonyms.
- **Palette: "An Old Hope", binding.** A terminal colour scheme and a deliberate
  Star Wars nod, chosen by the author and already implemented in
  `lib/an-old-hope-shiki.ts` and the CSS tokens. Canonical values in use:
  ground `#1c1d21`, foreground `#cbcdd2`, comment `#686b78`, green `#78bd65`,
  yellow `#e5cd52`, blue `#4fb4d8`, orange `#ef7c2a`, red `#eb3d54`. Future
  visual work keeps this palette; the linked public gist is an iTerm variant
  whose background differs, so the repository implementation is the authority.
  Recorded as a constraint only — it pins the palette, not how boldly it is used.

## Evidence on Hand

**Usable, real, and citable:**

- **The toolkit itself.** 26 published packages, seven harness integrations,
  genuine CLI output and exit codes. The homepage terminal cards already
  demonstrate rather than assert.
- **Dogfooding.** ADLC gates its own repository: rails-guard on frozen paths,
  cross-model attestation on trust-root changes, a mutation gate that refuses to
  report a kill rate when the baseline is red. This is verifiable in CI logs.
- **Two public testimonials**, both from Mykola (@mykola, "Myk is Walking
  Backwards"), unsolicited on X:
  - 14 Jul 2026 — "I was rolling so much of this by hand per project, this gives
    me such a clean reliable workflow and seems to keep claude well-focused!
    Thanks for this work, first time I read it I thought 'finally! someone
    shipped the missing piece!'" (637 views)
  - 21 Jul 2026 — "I've been enjoying this as a workflow… it works as it goes to
    identify dependencies and puts in guardrails to prevent conflicts and bad
    merges." (18 views)

    **Carries a caveat that must not be clipped away:** the same post says "I'm
    not sure how it would do introduced into a legacy project." Greenfield
    adoption is the evidenced case; legacy-repo adoption is not.

**Absences future work must not fill with invention:**

- No case studies, named customer companies, or logos.
- No benchmarks, performance numbers, or time-saved figures.
- No adoption scale. Public GitHub metrics as of 21 Jul 2026 were 9 stars, 3
  contributors, 2 forks. Do not cite, round, or imply scale beyond this, and do
  not describe the project as widely adopted.
- One person has given testimony. Do not pluralize it into "teams" or "users".

## Product Principles

1. **A claim ships only with something that backs it.** If the code cannot do
   it, the page does not say it — including in the interim while a release is
   pending.
2. **Demonstrate rather than assert.** Real commands, real exit codes, real
   evidence trails beat adjectives.
3. **Adoption is a passing gate, not a signup.** Every surface should shorten
   the path to a gate running in the visitor's own repository.
4. **Two audiences, one truth.** The engineer and the leader need different
   entry points to the same honest account, not two different stories.
5. **Name the limits.** Unsupported platforms, best-effort layers, and missing
   proof are stated plainly. Credibility is the product's main asset.

## Accessibility & Inclusion

No externally mandated standard was established. Two existing commitments in the
implementation are binding going forward: motion respects
`prefers-reduced-motion` (the `mk-gate-line` guard in global.css), and gate
verdicts are never carried by colour alone — they pair a glyph with a word
(`✓ PASS` / `✗ FAIL`), which future gate and status treatments must preserve.

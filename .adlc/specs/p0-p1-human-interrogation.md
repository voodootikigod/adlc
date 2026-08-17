# Spec — Human interrogation loop for P0/P1 (grill-style)

**Phase:** P1 contract for closing the gap between the ADLC doctrine's
"grillme-style interrogation" and the shipped P0/P1 tooling, which generates
interrogation questions in three places and asks a human none of them.

## Problem

The doctrine is explicit. `ADLC.md:207-210` prescribes: *"Grillme-style
interrogation: ask me questions until you have none left, but check the
codebase before asking each one."* The series calls P1 the single
highest-leverage phase and Gate 1 (human approves the spec) "the human's
highest-value moment in the entire lifecycle."

The implementation has no human interrogation anywhere:

- `AskUserQuestion` appears zero times in the repo.
- **P0** (`plugins/adlc-claude-code/commands/adlc-ticket.md`) is a template
  fill plus lint. Its entire questioning content is one conditional sentence
  ("If anything … is ambiguous, ask the user rather than guessing"). The §4
  executability check runs `adlc coldstart <id> --prompt-only`, which emits a
  structured `{gaps:[{what, why_blocking}]}` list of exactly the questions a
  fresh agent would have to ask a human — and then §4 says only "summarize
  them and offer to revise." Nobody asks the human the questions.
- **P1 has no Claude Code command at all.** `/adlc-spec` and
  `/adlc-approve-spec` exist for cursor and opencode; `plugins/adlc-claude-code/commands/`
  has neither. The router skill's P1 section routes to bare CLI names.
- `premortem` renders a section literally titled "Questions to fold into
  interrogation" (`packages/premortem/lib/render.mjs:33-38`); nothing folds
  them anywhere.
- `parallax` self-describes as "measured-ambiguity interrogation," renders
  "## Divergences — answer these" with lettered options
  (`packages/parallax/lib/scoring.mjs:40-52`), and fails the gate above
  threshold — then stops. Its fan prompts forbid the *models* from asking
  questions, which is correct, but no surrounding flow puts the rendered
  questions to the *human*.
- `lesson-foundry` (P7) emits `.adlc/lessons/interrogation-template.md` for
  SPEC-GAP clusters, headed "Answer these questions in your spec (P1)". No
  P1 flow reads it, so the decay loop's spec-gap output dead-ends too.
- The P1 gate assertion (`packages/runner/lib/assertions.mjs:12`) requires
  only `spec-lint` and `premortem` manifest records. No human spec-approval
  record is required, despite `ADLC.md:224` ("Gate: human approves the
  spec") and the cursor/opencode `adlc-approve-spec` commands recording one.
  `PHASE_REQUIREMENTS` has no `p0` key at all.

Root cause, for the record: `packages/parallax/README.md:149` names
`grill-me` as the "predecessor; interrogation by introspection" that
parallax "replaces with measurement." The pivot kept the measurement half
(divergence scoring) and dropped the dialogue half (a human answering the
questions). The question *generators* all survived; the question *asking*
was never rebuilt.

## Design

One shared protocol, three consumers, one gate change. The interrogation
loop is prose-driven (harness command/skill text), because only the harness
can talk to a human; the *evidence* that it happened is machine-checked via
the manifest, because prose instructions alone are exactly what decayed into
today's dead ends.

### D1 — Interrogation protocol (shared reference)

A single reference document, `docs/interrogation-protocol.md`, defining the
grill loop once so the six harness plugins don't drift:

- **Design-tree frontier model** (borrowed from the grilling skill): track
  open decisions as a tree; each round asks every question whose
  prerequisites are settled ("the frontier"), numbered, each with a
  recommended answer. Never one-question-at-a-time drip, never questions
  whose premise depends on an unanswered earlier question.
- **Codebase-check clause**: before asking any question, attempt to answer
  it from the repository; only questions the repo cannot answer reach the
  human. This is the half of `ADLC.md:207` that distinguishes interrogation
  from a questionnaire.
- **Question sources**, in priority order: (1) coldstart gaps, (2) parallax
  divergences (already lettered multiple-choice), (3) premortem
  interrogation questions, (4) `.adlc/lessons/interrogation-template.md`
  checkboxes when present, (5) the interrogator's own frontier.
- **Stopping condition**: frontier empty — every branch visited, nothing
  silently assumed — then a one-screen readback of the resolved decisions
  for confirmation.
- **Transcript**: resolved Q→A pairs are folded into the ticket body / spec
  text itself (not a sidecar), so coldstart and spec-lint re-runs see them
  and downstream agents inherit the answers as spec, not as chat history.

In Claude Code the asking mechanism is `AskUserQuestion` (options +
recommended-first, "Other" is free); other harnesses use their native
prompt affordance; headless/CI contexts skip interrogation and must instead
find the answers already folded into the artifact (which is what the gate
checks).

### D2 — P0 consumer: interrogate before the store write

`plugins/adlc-claude-code/commands/adlc-ticket.md` gains a "§1b Interrogate"
between shaping and the dry-run: run the protocol seeded from the §1 field
checklist. §4 changes from "summarize gaps and offer to revise" to: convert
each coldstart gap into a frontier question, put it to the human, fold
answers into the body, re-run `adlc coldstart <id> --prompt-only` until the
gap list is empty. Once it is, record the passing verdict with
`adlc coldstart <id> --prompt-only --record-verdict -` — `--prompt-only`
alone writes no manifest record, and the D4 p0 assertion requires one; a
flow that stops at the prompt-only loop would author tickets that can never
pass p0. Peer
edits: copilot / cursor / opencode / codex / pi ticket flows reference the
same protocol doc.

### D3 — P1 consumer: `/adlc-spec` for Claude Code

Port `plugins/adlc-cursor/command/adlc-spec.md` to
`plugins/adlc-claude-code/commands/adlc-spec.md`, inserting the
interrogation round between parallax and spec-lint: parallax divergences and
premortem interrogation questions become the frontier; answers are folded
into the spec; parallax re-runs, **capped at 3 rounds**. If divergence is
still above threshold after the cap, the loop does not spin: the surviving
divergences are put to the human one final time as explicit decisions,
recorded in the spec as approved assumptions, and the flow proceeds to Gate
1 with the residual divergence score carried in the `spec-approval` payload.
The cap and escape hatch live in the protocol doc (D1), not just here, so
every harness inherits them. This also fixes the router's dangling reference
(the P0 command's §5 already points users at a `/adlc-spec` that does not
exist in this plugin).

### D4 — Gate 1 becomes machine-checked

- Port `adlc-approve-spec` to `plugins/adlc-claude-code/commands/`.
- The approval command records a `spec-approval` manifest record whose
  payload includes an interrogation summary: rounds run, questions asked,
  question sources consumed, unresolved count (must be 0; residual parallax
  divergences approved under the D3 round cap are listed as
  `approved_assumptions`, not counted as unresolved).
- `packages/runner/lib/assertions.mjs` P1 requirement becomes
  `['spec-lint', 'premortem', 'spec-approval']`, and a `p0` key is added
  requiring `coldstart`. This is the one behavior change in package code and
  carries tests; everything else is harness prose plus doc.
- **Atomicity requirement:** T-D updates the existing cursor and opencode
  `adlc-approve-spec` commands to emit the new payload *in the same change*
  that adds the runner validation. Those commands ship today and record
  legacy `spec-approval` payloads without interrogation fields; landing the
  strict assertion without updating them would break P1 for every
  non-Claude-Code harness. The payload validation applies uniformly — no
  legacy-format carve-out — which is only safe because the emitters and the
  validator land in one commit.
- Migration note: existing in-flight P1 work that has run spec-lint +
  premortem but recorded no approval (or a legacy-payload approval) will
  fail `adlc-runner run p1` after this lands. That is the point — the
  current green is hollow — but the change must land with the approve-spec
  command available and payload-current in every harness that asserts p1,
  and the release notes must say so.

### D5 — Router and decay-loop closure

Update the `adlc` router skill's P0/P1 sections (all four copies) to name
interrogation as the phase's mechanism, route P1 to `/adlc-spec`, and list
`.adlc/lessons/interrogation-template.md` as a question source so the
P7→P1 loop closes.

## Ticket breakdown (proposed)

1. **T-A `docs(interrogation)`: protocol reference** — D1. No package code.
2. **T-B `feat(p0)`: interrogation in ticket authoring** — D2, depends on T-A.
3. **T-C `feat(p1)`: /adlc-spec for Claude Code with interrogation** — D3,
   depends on T-A.
4. **T-D `feat(gate)`: spec-approval asserted in p1, coldstart in p0** — D4,
   depends on T-B and T-C (commands must exist before the gate demands
   their records).
5. **T-E `chore(router)`: router + lesson-template closure** — D5, depends
   on T-B/T-C.

## Acceptance criteria

- Protocol doc exists and is referenced: `test -f docs/interrogation-protocol.md`
  exits 0, and `grep -l interrogation-protocol plugins/*/commands/adlc-ticket.md plugins/*/command/adlc-ticket.md plugins/*/skills/adlc-ticket/SKILL.md` matches every harness ticket flow.
- P0 command runs the loop: `grep -c 'AskUserQuestion' plugins/adlc-claude-code/commands/adlc-ticket.md`
  is ≥ 1, and the §4 text instructs re-running `adlc coldstart <id> --prompt-only` until zero gaps (verified by reading the section in review; behavior is prose-driven).
- P0 flow records the gate evidence: `grep -q 'record-verdict' plugins/adlc-claude-code/commands/adlc-ticket.md`
  succeeds, so the prompt-only loop ends in a manifest record the p0 assertion can see.
- P1 command exists: `test -f plugins/adlc-claude-code/commands/adlc-spec.md`
  exits 0 and `grep -q parallax` on that file succeeds.
- Gate change is load-bearing: new test in `packages/runner/test/` asserts
  `p1` fails without a `spec-approval` record and passes with one, and that
  `p0` requires `coldstart`; verified by `node --test packages/runner/test/`.
- Approval payload is validated: new test asserts a `spec-approval` record
  with `unresolved > 0` is rejected; verified by `node --test packages/runner/test/`.
- Emitters and validator land together: in the T-D change,
  `grep -rl 'unresolved' plugins/adlc-cursor plugins/adlc-opencode --include='adlc-approve-spec.md'`
  matches both harnesses' approve-spec commands, confirming they emit the
  new payload in the same commit that enforces it.
- This spec passes its own bar: `adlc spec-lint .adlc/specs/p0-p1-human-interrogation.md`
  exits 0.
- Full suite green before push: `npm test` (all ~35 segments) exits 0.

## Resolved decisions (approved by maintainer, 2026-08-16)

1. **Gate hardness: hard.** `spec-approval` is a required p1 assertion,
   landed atomically with the approve-spec commands (D4), because the
   advisory version of this idea is precisely what already decayed.
2. **Rollout: Claude Code first, peers in the same tickets.** Protocol doc
   plus Claude Code changes are the substance of T-B/T-C; peer harnesses
   get thin edits inside those same tickets (they share the reference doc,
   so the per-harness diff is small). T-D's emitter updates are atomic per
   its atomicity requirement.
3. **parallax gains `--questions-json`.** Consumers get structured
   divergences instead of scraping rendered markdown; small addition
   scoped inside T-C.

## Open question: `approver` identity is not cryptographically verified

`specApprovalIntegrityErrors` (`packages/runner/lib/assertions.mjs`) checks
that `data.approver` is a non-empty string. It does not verify `entry.sig`
against `ADLC_MANIFEST_KEY`, and `assertPhase` does not call
`gate-manifest verify`/`verifyEntrySig` for any phase's evidence today —
this is checkable directly: `grep -n "verify\|sig\\b"
packages/runner/lib/assertions.mjs packages/runner/bin/adlc.mjs` returns no
matches as of this commit. A process with manifest write access (a holder
of `ADLC_MANIFEST_KEY`, which is not distinct from the working agent's own
access in this repository's current key model) can write a `spec-approval`
entry with an arbitrary `approver` string and no human interaction.

Adding `verifyEntrySig` to `specApprovalIntegrityErrors` would require the
entry to be *signed*, but would not by itself distinguish a human from an
agent holding the same key — the signing key is not currently scoped to
authenticated human sessions anywhere in this repository. Whether to (a)
add signature verification as a partial mitigation, (b) build a
human-scoped signing capability, (c) accept the current harness-UI-pause
convention (`AskUserQuestion`/confirm dialog before the CLI runs) as the
system's existing human-gate model — which `p6-acceptance-packet` also
relies on with the same property — or (d) block this change until resolved,
is a decision this spec does not make. Tracked as T-01M07VMFBMC28FNKZAMN32Q13Q.

## Open question: `rounds`/`questions` are self-reported counts, not verified content

`specApprovalIntegrityErrors` requires `data.rounds`/`data.questions` to be
positive integers and `data.sources` to be an array of non-empty strings, but
it does not verify those numbers against any recorded transcript of the
actual interrogation exchange — this is checkable directly:
`grep -n "rounds\|questions" packages/runner/lib/assertions.mjs` shows only
type/positivity checks, no cross-reference to interrogation content. Claude
Code's `/adlc-approve-spec` (`plugins/adlc-claude-code/commands/adlc-approve-spec.md`)
is answered by the same session that ran the interactive
`AskUserQuestion`-driven `/adlc-spec` loop, so its counts reflect that
session's actual activity. Pi's `/adlc-approve-spec`
(`plugins/adlc-pi/lib/commands.mjs`) has no such loop wired to it; it derives
`rounds`/`questions` from the number of ticket-scoped parallax/premortem
manifest entries recorded by the separate `/adlc-spec` prompt-template flow —
a real, non-empty, floor on recorded interrogation artifacts, but not a
count of individual questions asked or answered within them (one premortem
record could contain one proposed question or ten).

Building a structured interrogation transcript — persisted by the component
that actually conducts the dialog, containing the real per-round question
list and answers, and consumed (rather than approximated) by `/adlc-approve-spec` —
would close this gap, but is a larger, cross-package change (parallax,
premortem, and every harness's `/adlc-spec` flow would need to emit and
propagate that structure) than this spec's scope. Whether to (a) build that
structured-transcript mechanism, (b) restrict Pi's `/adlc-approve-spec` to
only the harnesses/flows that do conduct a real, instrumented dialog, or (c)
accept the current artifact-count floor as sufficient given `unresolved: 0`
and the file-hash/ticket binding already prevent the more severe failure
(spec approved before ANY interrogation artifact exists), is a decision this
spec does not make. Tracked as T-01M07VMV85W3SX2ZZHTR23DD0A.

# Lifecycle prompt-injection threat model

`docs/ticket-store-threat-model.md` covers the ticket store's *mechanical*
integrity — locking, hashing, split-brain, recoverability. This is a different
threat class: whether **natural-language content that flows into a lifecycle
prompt can steer the agent reading it**, as opposed to steering the product
those agents are building. ADLC's security posture for the product under
review is well covered (SECURITY.md, the prosecutor-security lens, the
trust-root cross-model gate); injection *of the process itself* is the gap
this doc names (issue #281).

## Actors

- **Ticket author.** Anyone who can file or edit a ticket — the body is free
  text, reviewed by coldstart's executability audit and executed as the
  build agent's specification.
- **PR / diff author.** Anyone who can open a PR or push a branch under
  review — the diff is embedded verbatim into every P5 prosecution lens
  prompt.
- **PR commenter / rejection-doc author.** Anyone whose review comments or
  rejection text `rejection-mining` later ingests as raw prose.
- **Dependency / transitive content author.** Content that reaches a prompt
  indirectly — e.g. a file a diff touches that itself contains planted text,
  read by a verifier re-checking evidence.

None of these actors need write access to the repo's protected paths; a
ticket or a PR is enough.

## Targets

- **Gate verdicts.** A prosecution lens's ship/no-ship judgment, or the
  coldstart auditor's executability verdict.
- **Rails / scope exemptions.** An instruction embedded in a ticket body
  attempting to get a build agent to touch a rail path or expand its declared
  scope — mechanically blocked by rails-guard/the rail hook regardless of
  prompt content, but worth naming as a target class.
- **Suppressed findings.** A verifier refuting a real finding because the
  reviewed content told it to — the harder case, since the verifier's whole
  job is to weigh evidence and a plausible-sounding refutation is not
  inherently suspicious.
- **Budget / retry escalation.** Text in a dead-end log or fix charter
  steering a build agent into unnecessary retries or scope expansion.

## Defenses

- **Fencing.** Ticket/spec/diff/log content that enters a prompt is wrapped
  via `@adlc/core`'s `fence(label, content, maxChars)` (delimiters + a
  declared provenance) rather than spliced directly into a template string.
  `packages/coldstart/lib/prompt.mjs` (ticket JSON, reviewed as data) and
  `packages/fleet/lib/charters.mjs` (dead-end logs as data; the ticket
  specification is fenced too, but framed as the builder's task — see below)
  are the JS-level call sites; `scripts/test/prompt-fencing.test.mjs` greps
  for regressions.
- **Role-appropriate framing, not blanket "never obey."** A ticket body sent
  to a *builder* is legitimately instructional — executing it is the
  builder's job. Fencing it there is for provenance and length, not to
  disable it as instructions; the actual defense against a hostile
  specification (e.g. "also edit the rails-guard config") is that
  scope/rails constraints are declared authoritative over anything the
  fenced specification says, and are enforced mechanically by rails-guard
  and the in-session rail hook regardless of prompt content. A ticket or diff
  sent to a *reviewer* (coldstart's auditor, a prosecution lens, the
  verifier) is data under judgment — there the framing is unconditional:
  treat embedded instructions as findings, never directives.
- **Charter hardening.** The P5 lens fan-out charter
  (`plugins/adlc-claude-code/commands/adlc-prosecute.md`,
  `plugins/adlc-opencode/command/adlc-prosecute.md`) and the verifier charter
  (`prosecutor-verifier.md` in both harnesses) each state explicitly: diff/
  ticket content is data, an embedded directive aimed at the reviewer is
  itself a security-severity finding, and — for the verifier specifically —
  planted instruction-like text next to a flagged line is evidence the
  finding is real, not grounds to refute it.
- **Calibration, not assumption.** `packages/review-calibration`'s planted-bug
  corpus includes prompt-injection fixtures
  (`packages/review-calibration/test/injection-corpus.test.mjs`) alongside
  the mechanical-mutation corpus: a real, locatable defect paired with an
  adjacent instruction-like comment. The harness scores whether a reviewer's
  findings still catch the defect, so resistance is measured per run, not
  assumed once and forgotten (E5 — measurement replaces metacognition).
- **Mechanical enforcement wins over prompt content everywhere it can.**
  Rails, scope, and the trust-root cross-model gate are diff-based/hash-based
  checks a prompt cannot talk its way around — the same "enforce
  mechanically, not by instruction" response F5 already uses for gate-gaming.

## Residual risk

- **Suppressed findings from a single-lens same-context prosecutor** (the
  `prosecutor` subagent's own sequential three-gate pass, as opposed to the
  independent five-lens fan-out) have weaker independence — a steer that
  works on one context persists across that subagent's own gates. The
  fan-out path (`/adlc:adlc-prosecute`) with independent fresh-context
  verification is the stronger defense; prefer it for anything
  security-sensitive.
- **Charter hardening covers the two harnesses with explicit lens fan-out and
  diff embedding today (claude-code, opencode).** The codex/pi/antigravity
  ports carry single-agent prosecutor charters without the same shared
  fan-out block; they are not yet hardened with the equivalent framing.
- **The calibration corpus measures whether a *specific* reviewer run
  resists a *specific* class of planted instruction.** It is a sampling
  measurement, not a proof — a sufficiently novel injection phrasing is not
  guaranteed to be caught by the fixtures shipped today, the same limitation
  the mechanical mutation corpus has against a sufficiently subtle logic bug.
- **A reviewer with a genuinely compromised judgment (not injected, just
  wrong) is out of scope** — this doc is about content-borne steering, not
  general reviewer accuracy.

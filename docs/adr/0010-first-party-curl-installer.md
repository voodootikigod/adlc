# ADR 0010: A first-party `curl | sh` installer — accepted trust-root, with controls

**Status:** **Accepted.** `curl -fsSL https://www.agenticlifecycle.ai/install.sh | sh`
is the documented, preferred one-command install for the ADLC toolkit and every
harness integration present on a machine. Piping a remote script to a shell is a
**consciously accepted residual risk**, mitigated by the controls in Decision 4
below.

> **This document does not tell reviewers what to flag.** An earlier draft
> instructed human and model reviewers to treat the `curl | sh` instruction as
> settled rather than re-litigate it. A cross-model review of PR #351 flagged
> that as prompt injection against model-driven review gates — repository text
> constraining what a reviewer may report — and it was right: the highest
> blast-radius path in this repo is the last place to suppress scrutiny. The
> reasoning below is offered as *input* to a review, not as a boundary on one.
> Re-raise anything here at any time.

**Date:** 2026-07-25
**Deciders:** Chris Williams

> Related: [ADR-0009](./0009-universal-install-via-plugins.md) accepted the
> supply-chain exposure of `npx plugins add voodootikigod/adlc`. This ADR does
> not overturn it — the installer *calls* `npx plugins add` for Claude Code, and
> the native paths remain documented per ADR-0009 Decision 5. This ADR governs
> the **first-party script we serve**, which ADR-0009 does not cover.

---

## Context

Adoption required at minimum three steps (`npx plugins add`, `npm i -g @adlc/cli`,
a per-repo init), and the `plugins` installer only reliably covers Claude Code.
The remaining six harnesses each had a divergent native path documented across
six pages, and there was no Windows story at all. Time-to-first-gate was the
adoption bottleneck, not comprehension.

The obvious fix is the pattern the category already uses — a one-line
`curl | sh`. It is also the pattern with the worst security reputation, for good
reason: the user grants full privileges to a script they have not read, fetched
over a channel they do not control, before they have any basis for trusting us.

Two facts make our position different from the generic case, and one makes it
worse:

- **Better:** the script is *ours*, served from our own domain and versioned in
  our own repo. `npx plugins add` (already accepted in ADR-0009) executes a
  **third-party** package. On the trust axis, the first-party script is the
  narrower exposure, not the wider one.
- **Better:** ADLC is Node, not a compiled binary. The script installs published
  npm packages; it does not fetch and execute an opaque artifact.
- **Worse:** a served installer is a *standing* trust root. Unlike a package
  version, it has no immutable identity — whatever is at that URL today is what
  runs. A change to it reaches every new adopter immediately, with no version
  bump, no changelog, and no lockfile to pin against.

## Decision

1. **Serve `install.sh` and `install.ps1` from `apps/docs/public/`** and document
   `curl -fsSL https://www.agenticlifecycle.ai/install.sh | sh` as the preferred
   install on the README, the marketing site, and the docs.
2. **Accept the pipe-to-shell risk explicitly.** We treat it with the user's
   normal trust posture toward this project, the same way ADR-0009 treats `npx`.
   We do not build bespoke mitigations for the general class.
3. **Never install a language runtime.** Node ≥ 18 is a hard prerequisite. When
   it is missing the installer explains and exits non-zero, installing nothing.
   Silently installing a runtime is not a decision an install script may make on
   a user's behalf.
4. **Treat the served scripts as trust roots, with three controls:**
   - **Content pinning.** `scripts/test/install-digests.json` holds a SHA-256 of
     each served script; `scripts/test/install-sh.test.mjs` fails the suite when
     a script changes and its digest does not. This is *not* a defense against a
     malicious committer — they can update the digest. It is a defense against an
     **unnoticed** edit: a change to a file that lands on thousands of machines
     cannot ride along inside an unrelated diff.
   - **Behavioral tests against the real script.** The installer is executed in a
     sealed sandbox (stub `PATH`, throwaway `HOME`, every binary a logging shim)
     so its actual behavior is asserted, not described.
   - **No speculative installs.** The installer touches only harnesses it detects
     and never modifies user-global configuration for absent software. This is
     asserted on the installer's own detection output, because an absent
     harness's failed invocation logs nothing and would make a
     "no command was run" assertion hollow.
5. **Be honest about coverage.** Two harnesses genuinely cannot be automated
   from a machine-level installer: Cursor's plugin install has no supported
   shell command, and OpenCode's initializer scaffolds the *current directory*,
   so running it from where `curl | sh` was invoked would configure `$HOME`
   instead of the user's repo. Both are detected and reported as a manual step
   rather than fabricated. ADR-0009 Decision 4 (claim accuracy) applies here
   unchanged.

   Copilot was briefly listed here on the grounds that `@adlc/copilot` is
   unpublished. That was wrong — its plugin installs through a **Git
   marketplace** that does not use npm, so the installer automates it. The
   lesson is the one Decision 4 is about in the first place: an unexamined
   assumption about a channel produced an inaccurate coverage claim, in the
   document that exists to prevent inaccurate coverage claims.
6. **No Windows installer ships until Windows works.** This was originally
   written as "Windows ships as beta, backed by CI", and the CI is what
   overturned it: a `windows-latest` run of the core gate suites passed **6 of
   28**. The shared bin-resolution path builds `D:\D:\…` from an already-absolute
   Windows path, and most gates die on it. `install.ps1` was therefore removed
   before merge rather than shipped behind a "beta" label — a beta label
   describes rough edges, not a platform where four fifths of the gates fail.
   Windows adopters are pointed at WSL. `scripts/test/install-sh.test.mjs`
   carries a tripwire asserting no `.ps1` is served, so restoring one requires
   restoring a green `windows-latest` gate in the same change.
   (`packages/fleet` is separately POSIX-only by design.)
7. **Do not remove the native paths.** Every integration page keeps its native
   install instructions, so no adopter is forced through the one-liner and anyone
   who wants to read before running can.
8. **The Claude Code branch AUTOMATES a third-party package, and that is a step
   beyond what ADR-0009 accepted.** ADR-0009 accepted `npx plugins add
   voodootikigod/adlc` as an instruction a user *chooses to type*. Here the
   installer runs it unattended, at the mutable `latest` tag, as part of a
   `curl | sh`. A cross-model review of PR #351 flagged the difference and is
   right that it is a distinct exposure: the user is no longer making the call.

   Accepted anyway, for a specific reason — Claude Code's own plugin install is
   a **slash command inside the app**, so no first-party shell path exists. The
   alternatives were to drop Claude Code from the installer (gutting the
   one-command promise for the flagship harness) or to invent an install path we
   do not control. Neither is better.

   **The automated call is version-pinned; documented ones are not.** This is a
   deliberate narrowing of ADR-0009 Decision 3, not a reversal of it. That
   decision refuses to pin `npx plugins add` *in docs*, and it is still right
   there: a stale pinned version in a README is worse than an unpinned one,
   because nobody notices it rotting. But this call runs **unattended** inside a
   `curl | sh` — the user never sees it, never types it, and never chooses which
   version executes. Automation is what changes the calculus, and automation is
   exactly what ADR-0009 did not contemplate.

   Two independent cross-model reviews reached this conclusion separately —
   codex across four rounds, gemini as its top finding on a fresh read. That
   corroboration is what reopened the decision: a single reviewer repeating
   itself is not new information, but two providers converging independently is.

   `install.sh` therefore pins `PLUGINS_VERSION` to an exact version, bumped
   deliberately with a review. The pin also subsumes the earlier `@latest`
   trick, which existed only because `npx` resolves a bare package name against
   the current project first — a repository shipping a workspace named `plugins`
   could hijack the install, and the agent-led flow runs from inside exactly such
   a repository. Any version spec forces registry resolution; the installer also
   runs it from a scratch directory so there is no local project to resolve
   against.

   Residual risk, reduced but not eliminated: a compromised release of the
   pinned version would still reach users, and our checksum covers `install.sh`
   only, not its dependency. Revisit if Claude Code ever exposes a shell install.

   **Maintenance obligation:** `PLUGINS_VERSION` now needs bumping when
   `plugins` releases. That upkeep is the cost ADR-0009 Decision 3 was written to
   avoid — accepted here because it is paid on exactly one line, in the one place
   where the user has no say.

## Consequences

- Adversarial reviews of the docs will keep surfacing the `curl | sh`
  instruction. That is fine and expected: this ADR is the *reasoning* to weigh
  the finding against, not a reason to dismiss it. If a review makes a case this
  document does not already answer, the decision should be reopened.
- ADR-0009 carried the same reviewer-directing construct. It was initially left
  alone as out of scope — wrongly. A later review round pointed out that this
  ADR both *automates* that dependency and *cites* ADR-0009, so the citation
  would have suppressed review of a risk this change had just increased. It is
  amended in the same PR. Scope is not a defence for leaving a review-suppressing
  instruction on the path you are actively making riskier.
- The served scripts are now the highest-blast-radius files in the repo. They
  are listed as rails on ticket I2 so a change to them is a deliberate act.
- **The install is not a coherent release, and that is a known limitation.** The
  toolkit comes from npm `latest` while the Codex marketplace is fetched from
  mutable `main` and other harness paths follow their own repository state, so a
  user can end up with a CLI and a plugin from different commits. This follows
  directly from ADR-0009 Decision 3's refusal to pin, and the honest fix is a
  release channel the installer can request as one unit rather than pinning each
  path independently. Not solved here; recorded so it is not mistaken for
  something already handled.
- If the digest test starts failing routinely as noise, that is a signal the
  installer is churning too fast — not a reason to delete the control.
- Writing the Windows CI job was worth it even though its result killed the
  feature it was meant to support. The alternative was shipping `install.ps1` on
  the strength of "it's all Node, it should work" — which is exactly what the
  first draft of this ADR said. Any future Windows claim needs the job back,
  green, and required, in the same change that makes the claim.

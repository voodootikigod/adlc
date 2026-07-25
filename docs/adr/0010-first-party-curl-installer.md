# ADR 0010: A first-party `curl | sh` installer — accepted trust-root, with controls

**Status:** **Accepted.** `curl -fsSL https://www.agenticlifecycle.ai/install.sh | sh`
is the documented, preferred one-command install for the ADLC toolkit and every
harness integration present on a machine. Piping a remote script to a shell is a
**consciously accepted residual risk**, mitigated by the controls in Decision 4
below. Reviewers (human or model) flagging the instruction itself should be
pointed at this ADR rather than re-litigating it; a finding against one of the
**controls** is in scope and should be triaged normally.

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
5. **Be honest about coverage.** Cursor's plugin install has no supported shell
   command and `@adlc/copilot` is unpublished; the installer detects both and
   prints the manual step rather than fabricating an automated one. ADR-0009
   Decision 4 (claim accuracy) applies here unchanged.
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

## Consequences

- Adversarial reviews of the docs will keep surfacing the `curl | sh`
  instruction; the response is a citation of this ADR. A finding against a
  *control* in Decision 4 is a real finding and should be fixed.
- The served scripts are now the highest-blast-radius files in the repo. They
  are listed as rails on ticket I2 so a change to them is a deliberate act.
- If the digest test starts failing routinely as noise, that is a signal the
  installer is churning too fast — not a reason to delete the control.
- Writing the Windows CI job was worth it even though its result killed the
  feature it was meant to support. The alternative was shipping `install.ps1` on
  the strength of "it's all Node, it should work" — which is exactly what the
  first draft of this ADR said. Any future Windows claim needs the job back,
  green, and required, in the same change that makes the claim.

# ADR 0009: Universal install via the `plugins` installer — accepted supply-chain tradeoff

**Status:** **Accepted.** `npx plugins add voodootikigod/adlc` is the documented,
preferred install path for ADLC's harness integrations wherever the [`plugins`
package](https://www.npmjs.com/package/plugins) supports the target harness. The
supply-chain exposure inherent in `npx`-executing a third-party installer is a
**consciously accepted residual risk**, not an oversight. Reviewers (human or model)
flagging this instruction should be pointed at this ADR rather than re-litigating it.

**Date:** 2026-07-05
**Deciders:** Chris Williams (prompted by an adversarial-review CRITICAL finding against
the docs-site getting-started page; the finding was triaged as accepted-risk, not a defect).

> Related: [ADR-0003](./0003-adlc-claude-code-plugin.md) ships the Claude Code plugin the
> installer targets; [ADR-0006](./0006-adlc-cursor-integration.md) covers the Cursor
> integration (not yet published, see Scope). This ADR governs only the **install
> instruction** the project recommends, not what any plugin does once installed.

---

## Context

ADLC integrates with six agent harnesses, each with its own native install mechanism
(Claude Code marketplace, Cursor scaffolder, opencode plugin registration, `pi
--extension`, `agy plugin install`). Documenting six divergent flows as the *first* step
of adoption is a real onboarding cost. The `plugins` npm package is a vendor-neutral
installer that detects the agent tools present on a machine and installs a repo's plugin
into each, collapsing the first step to one line:

```sh
npx plugins add voodootikigod/adlc
```

An adversarial review of the documentation site flagged this instruction as a CRITICAL
supply-chain finding: `npx` downloads and executes the `plugins` package, which is
third-party code outside this project's control. The finding is technically accurate —
that is what `npx` does — and applies equally to every `npx <tool>` instruction in any
README anywhere.

## Decision

1. **Keep `npx plugins add voodootikigod/adlc` as the recommended install path** in the
   README, the docs site, and the marketing site, for harnesses the installer actually
   supports.
2. **Accept the supply-chain risk explicitly.** The `plugins` package is executed with
   the user's normal npm trust posture; we treat it the same way we treat `npx
   adversarial-review` or any other CLI this project recommends. Compromise of the npm
   package would be a supply-chain incident upstream of this project; we do not build
   bespoke mitigations for it.
3. **Do not version-pin the installer in docs** (`plugins@x.y.z`). Pinning trades a
   narrow integrity window for permanent maintenance drag and stale-installer bugs; the
   unpinned form is the deliberate choice.
4. **Docs must only claim harness coverage the installer actually has.** Where a
   harness's plugin is not yet published/wired for the installer, the docs say so and
   give the native path instead (see each integration page's Install section).
5. **Native install paths remain documented** on every integration page as the
   fallback, so no adopter is forced through the universal installer.

## Consequences

- Adversarial reviews of docs changes will keep surfacing this instruction; the response
  is a citation of this ADR, not a doc change. (If the reviewer supports focus text,
  include: "`npx plugins add` is accepted per ADR-0009".)
- If the `plugins` package is ever compromised, renamed, or abandoned, this ADR is the
  single place recording why we depend on it — revisit the decision there, then update
  README + getting-started + integration pages together.
- Claim accuracy is now a documented obligation (Decision 4): expanding the "auto-detects
  X" claim requires the X plugin to actually be installable by the installer first.

// @ts-check
// The agent-led onboarding guide, served at /agent-guide.md.
//
// Audience: a coding agent that a human has just pasted AGENT_PROMPT into. It is
// written TO the agent, not to the human — imperative, ordered, and explicit
// about what the agent may not do without asking.
//
// GENERATED, not hand-written. The per-harness install commands already exist in
// integration-facts.mjs and are rendered on six integration pages; a seventh
// hand-maintained copy would rot against those six the first time a harness
// changes its install. ADR-0009 Decision 4 (claim accuracy) is the standing
// obligation here: we describe only the coverage a channel actually has.

import { INTEGRATIONS } from './integration-facts.mjs';
import { UNIVERSAL_INSTALL, SKILLS_INSTALL } from './install-commands.mjs';
import { SITE_URL } from './routes.mjs';

/** @typedef {(typeof INTEGRATIONS)[number]} Integration */

/**
 * Fenced block; install lines are emitted verbatim, never reflowed.
 * @param {readonly string[]} lines
 * @returns {string}
 */
const fence = (lines) => ['```sh', ...lines, '```'].join('\n');

/**
 * @param {Integration} integration
 * @returns {string}
 */
function harnessSection(integration) {
  return [
    `### ${integration.name} (\`${integration.slug}\`)`,
    '',
    integration.tagline,
    '',
    fence(integration.install),
    ...(integration.note ? ['', `**Note:** ${integration.note}`] : []),
    '',
    `Full guide: ${SITE_URL}/integrations/${integration.slug}`,
  ].join('\n');
}

/**
 * The served response. Lives here rather than in the route because the route is
 * `.ts` behind Next's `@/` alias and cannot be imported by the test runner — so
 * anything expressed there is untestable. hollow-test proved that concretely:
 * with the body in the route, replacing it with `return null` survived every
 * test. Keeping it in `.mjs` means the response is actually exercised.
 * @returns {Response}
 */
export function agentGuideResponse() {
  return new Response(buildAgentGuide(), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
}

/** @returns {string} */
export function buildAgentGuide() {
  const slugs = INTEGRATIONS.map((i) => i.slug);

  return `# ADLC — a guide for agents

You are reading this because a human asked you to help them set up the **ADLC**
(Agentic Development Lifecycle) in their project. This document is written for
you, not for them. Work through it in order and check in where it tells you to.

Canonical documentation lives at ${SITE_URL}. Verify any command you are unsure
about against those pages rather than guessing.

## What ADLC is

A software lifecycle rebuilt around the ways models actually fail, rather than
the ways humans do. It splits development into eight phases, P0 through P7, and
puts an explicit **gate** between each one. A gate is a CLI that exits \`0\` when
it passes, \`1\` on an operational error, and \`2\` when the gate **fails**. Gates
produce machine-checkable evidence; the two human phases record attestation.

The practical consequence for you: "I think this is correct" is not an output
the lifecycle accepts. Every claim gets checked by a machine, and the exit code
is the answer.

Every LLM-backed gate supports \`--prompt-only\`, which prints its exact prompt
and exits without calling any provider. **You are the model.** Answer the printed
prompt yourself. Do not ask the human for API keys — they are not needed.

## Before you touch anything

1. Confirm you are in the repository the human means. Run \`git rev-parse --show-toplevel\`.
2. Check whether ADLC is already installed: \`adlc --version\` and \`ls .adlc\`.
   If both succeed, this repo is already set up. Say so and stop — do not re-run
   the installer.
3. Check the Node version: \`node -v\`. **Node 18+ is required.** If it is older
   or missing, tell the human and stop. Do not install or upgrade Node yourself.

## Detect which harness you are running in

Your install path depends on which agent harness you are. Determine this before
choosing a command — do not guess, and do not install for a harness you are not.

The harnesses with a native ADLC plugin are: ${slugs.join(', ')}.

If you are one of those, use its native install below. If you are not — or you
cannot tell — use the universal installer, which detects what is actually on the
machine, or the skills catalog.

## Install: the one command

This installs the gate toolkit and the native integration for **every** harness
present on the machine. Harnesses that are absent are left alone.

${fence([UNIVERSAL_INSTALL])}

**macOS and Linux only.** The toolkit does not currently run on Windows — a
\`windows-latest\` CI run of the core gate suites passed 6 of 28, because the
shared bin-resolution path builds \`D:\\D:\\...\` from an already-absolute
Windows path. If the human is on Windows, tell them plainly and point them at
WSL. Do not install into a native Windows shell and hope.

**Ask before running this.** It pipes a remote script into a shell. If the human
would rather read it first, fetch it and show it to them:
\`curl -fsSL ${SITE_URL}/install.sh -o install.sh\`.

## Install: native, per harness

Use these when the human wants only their own harness wired up, or when the
universal installer reported a harness as needing a manual step.

${INTEGRATIONS.map(harnessSection).join('\n\n')}

## Install: any other agent

For harnesses with no native plugin, the harness-neutral skill catalog reaches
roughly seventy agents through skills.sh:

${fence([SKILLS_INSTALL, 'npm install -g @adlc/cli', 'adlc init'])}

That channel installs **skills only** — a phase router, a bootstrap guide, and
the P5 prosecution workflow, each driven through the \`adlc\` CLI. It installs no
hooks, no MCP tools, no agents, and no in-session rail enforcement. It is
strictly weaker than any native plugin. Where a native plugin exists, prefer it,
and say so rather than quietly installing the weaker option.

## First run: bootstrap the repository

Walk the human through this sequence.

1. **Create the runtime.** \`adlc init\` (add \`--harness cursor\` or
   \`--harness copilot\` where relevant). It is idempotent and confines all
   writes to the repo root. If \`.adlc/config.json\` is already a frozen rail, do
   not overwrite it.
2. **Wire the CI control.** Copy \`docs/ci/rails-guard.yml\` into
   \`.github/workflows/\` and tell the human to make it a **required check**.
   This matters more than it looks: in-session rail enforcement is best-effort
   and harness-dependent, so the commit-time diff gate is the only unbypassable
   control. Without it, frozen rails are advisory.
3. **Verify.** Run \`adlc preflight\`, \`adlc ticket list\`, and
   \`adlc gate-manifest show\`. Report all three results, including failures.
4. **Author the first ticket (P0).** \`adlc ticket create --input <path|-> --write\`.
   Mutations are dry-run without \`--write\`.
5. **Hand off to the lifecycle.** The \`adlc\` phase-routing skill takes it from
   here: P1 \`spec-lint\`, P2 \`coldstart\`, P3 \`rails-guard\`, P5 \`hollow-test\`
   and \`prosecute\`, P7 \`lesson-foundry\`.

## Known limits — state these, do not discover them

- **Node 18+ is required.** The toolkit is Node and zero-dependency. The
  installer will not install a runtime for you.
- **Windows is not supported.** Not "beta" — measured: a \`windows-latest\` run
  of the core gate suites passed 6 of 28. Point Windows users at WSL. Separately,
  \`adlc fleet\` is POSIX-only by design (it shells out through \`/bin/sh\` and
  uses POSIX sandbox backends), so it is unavailable under WSL-less setups
  regardless.
- **Cursor** installs plugins through its in-app marketplace UI. There is no
  supported shell command, so the installer reports it as a manual step.
- **GitHub Copilot's** plugin package is not published to npm yet; use
  \`adlc init --harness copilot\`.
- **skills.sh installs skills only** — no hooks, MCP, agents, or rails.

## Diagnosis

- \`adlc: command not found\` — the global npm bin is not on PATH. Have the
  human run \`npm prefix -g\` and add its \`bin\` to PATH.
- \`npm install -g\` fails with EACCES — do not reach for \`sudo\` on their
  behalf. Suggest \`npm config set prefix ~/.local\` and adding
  \`~/.local/bin\` to PATH, and let them choose.
- A gate exits \`2\` — that is the gate **failing**, not an error. Report what it
  found. Do not retry it, raise a threshold, or route around it.
- A gate exits \`1\` — an operational error. Read the message; it usually means a
  missing file or an unreadable ticket store.
- Slash commands do not appear after install — the harness needs a restart or a
  new session. Say so rather than reinstalling.

## Rules for you

1. **Do not run any install command until the human confirms.** Show them what
   you intend to run and why, then wait. This applies with force to the
   \`curl | sh\` one-liner.
2. **Never use \`sudo\` on your own initiative.**
3. **Do not install for harnesses that are not present.** Detect, then act.
4. **Do not modify the human's global agent configuration** beyond what the
   documented install command for their harness does.
5. **Report failures as failures.** If a gate fails or an install errors, say so
   plainly and show the output. A summary that reads cleaner than the terminal
   is a bug in your report.
6. **Do not weaken a gate to make it pass.** Raising a threshold, adding a skip,
   or deleting a failing check defeats the entire point of the lifecycle. If a
   gate blocks you, that is the gate working.
7. **Prefer the native plugin over the skills catalog** where one exists, and
   tell the human when you are installing the weaker option and why.
`;
}

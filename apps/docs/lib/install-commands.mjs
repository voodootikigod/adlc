// @ts-check
// Single source of truth for the UNIVERSAL install command and the agent-led
// onboarding prompt.
//
// Per-harness install lines live in integration-facts.mjs and stay there. This
// module owns only the commands that are the same everywhere, because those are
// the ones that would otherwise get hand-typed onto the homepage, the
// integrations index, the docs, and the agent guide — four copies that drift
// independently and are wrong in four different ways.
//
// scripts/test/install-cta.test.mjs asserts that these literals appear nowhere
// under apps/docs/app/ or apps/docs/components/ except as an import from here.

/** The one-line install served at /install.sh. Rendered verbatim; never reworded. */
export const UNIVERSAL_INSTALL = 'curl -fsSL https://www.agenticlifecycle.ai/install.sh | sh';

/** The Windows equivalent. Beta — every surface offering it must say so. */
export const UNIVERSAL_INSTALL_WINDOWS = 'irm https://www.agenticlifecycle.ai/install.ps1 | iex';

/** The harness-neutral skill catalog, for the ~70 agents with no native plugin. */
export const SKILLS_INSTALL = 'npx skills add voodootikigod/adlc';

/** Where the agent-led onboarding guide is served. */
export const AGENT_GUIDE_URL = 'https://www.agenticlifecycle.ai/agent-guide.md';

/**
 * The prompt a visitor pastes into whatever agent they already run, so it does
 * the install itself. Deliberately short: it points at the guide rather than
 * embedding instructions, so the guide can change without every paste going
 * stale.
 */
export const AGENT_PROMPT = `Help me set up the ADLC (Agentic Development Lifecycle) in this repo. Read ${AGENT_GUIDE_URL} first, then walk me through it step by step.`;

/** What the installer actually does, for surfaces that need to set expectations. */
export const INSTALL_SUMMARY =
  'Installs the gate toolkit and the native integration for every agent harness on your machine. Requires Node 19+.';

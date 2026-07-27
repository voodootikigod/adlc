// @ts-check
// Single source of truth for the native-integration marketing pages.
// Grounded in docs/integrations/<slug>.md. The test cross-checks existence.
//
// The universal install command is imported rather than repeated: install-commands.mjs
// owns it, and hand-typing it here would be a second copy that drifts when the served
// script moves. (install-commands.mjs imports nothing, so there is no cycle.)

import { UNIVERSAL_INSTALL } from './install-commands.mjs';

/** @typedef {{ key: string, count: number, label: string, title: string, detail: string, items: string[] }} IntegrationSurface */
/** @typedef {{ phase: string, entry: string, evidence: string }} PhaseRoute */
/** @typedef {{ path: string, note: string, surfaceKey?: string }} BundleEntry */
/** @typedef {{ kicker: string, title: string, body: string }} EnforcementSide */
/** @typedef {{ href: string, label: string, external?: boolean }} IntegrationResource */

/**
 * @typedef {object} IntegrationFact
 * @property {string} slug
 * @property {string} name
 * @property {'installer'|'source'|'local'|'marketplace'} status
 * @property {string} tagline
 * @property {string[]} install
 * @property {string} [note]
 * @property {{ kicker: string, title: string, identity: string, badges: { label: string, accent?: boolean }[] }} hero
 * @property {{ title: string, ariaLabel: string, root: string, entries: BundleEntry[] }} bundle
 * @property {IntegrationSurface[]} surfaces
 * @property {{ kicker: string, title: string }} surfacesSection
 * @property {PhaseRoute[]} phaseRoutes
 * @property {{ kicker: string, title: string, intro: string, entryHeader: string }} phaseSection
 * @property {{ session: EnforcementSide, ci: EnforcementSide }} enforcement
 * @property {{ kicker: string, title: string }} railsSection
 * @property {{ kicker: string, title: string }} installSection
 * @property {{ title: string, lines: string[] }} [operate]
 * @property {IntegrationResource[]} resources
 * @property {string} pluginDir
 */

/** @type {IntegrationFact} */
export const CODEX_INTEGRATION = {
  slug: 'codex',
  name: 'Codex',
  status: 'marketplace',
  tagline: 'A native Codex plugin with phase routing, frozen-rail feedback, gate tools, and project review agents.',
  install: [
    'npm install -g @adlc/cli@latest',
    'codex plugin marketplace add voodootikigod/adlc --ref main',
    'codex plugin add adlc-codex@adlc',
    'adlc init --root /absolute/path/to/project',
  ],
  note: 'Install @adlc/cli 1.4.2 or newer from npm, then install the native plugin from the Codex Git marketplace. Keep the CLI and plugin updated together, and start a new Codex thread after installation or upgrade.',
  pluginDir: 'plugins/adlc-codex',
  hero: {
    kicker: 'Codex integration',
    title: 'ADLC as a Codex plugin',
    identity: 'Built for Codex directly. It is not a Claude compatibility shim.',
    badges: [
      { label: 'Native plugin', accent: true },
      { label: 'Git marketplace' },
    ],
  },
  bundle: {
    title: 'adlc-codex / native bundle',
    ariaLabel: 'Native Codex plugin payload',
    root: 'adlc-codex/',
    entries: [
      { path: '├─ .codex-plugin/plugin.json', note: 'manifest' },
      { path: '├─ skills/', surfaceKey: 'skills', note: 'phase-aware workflows' },
      { path: '├─ hooks/hooks.json', surfaceKey: 'hooks', note: 'lifecycle events' },
      { path: '├─ .mcp.json', surfaceKey: 'mcp', note: 'allowlisted tools' },
      { path: '└─ agents/', surfaceKey: 'agents', note: 'project role templates' },
    ],
  },
  surfaces: [
    {
      key: 'skills',
      count: 6,
      label: 'skills',
      title: 'Skills load only the phase you need',
      detail: '$adlc picks the phase, then a focused skill loads just that P0-P7 workflow.',
      items: ['$adlc', '$adlc-init', '$adlc-spec', '$adlc-rail-build', '$adlc-prosecute', '$adlc-distill'],
    },
    {
      key: 'hooks',
      count: 8,
      label: 'hook events',
      title: 'Hooks for context and rail feedback',
      detail: 'Hooks restore context, block frozen-rail writes, watch for repeated failures, and check evidence at stop.',
      items: [
        'SessionStart',
        'PreToolUse',
        'PostToolUse',
        'PreCompact',
        'PostCompact',
        'SubagentStart',
        'SubagentStop',
        'Stop',
      ],
    },
    {
      key: 'mcp',
      count: 2,
      label: 'MCP tools',
      title: 'Two MCP tools, tightly scoped',
      detail: 'A local MCP server exposes allowlisted adlc_gate (no shell) and adlc_prosecute for evidence-producing review.',
      items: ['adlc_gate', 'adlc_prosecute'],
    },
    {
      key: 'agents',
      count: 9,
      label: 'project agents',
      title: 'Project roles for explore, review, verify, and the P5 fan-out',
      detail: 'The initializer writes project-scoped Codex roles — explore/review/verify plus the five-lens P5 prosecution fan-out and its independent verifier — and leaves ~/.codex alone.',
      items: ['explorer', 'reviewer', 'verifier', 'prosecutor-correctness', 'prosecutor-security', 'prosecutor-contract', 'prosecutor-diff', 'prosecutor-tests', 'prosecutor-verifier'],
    },
  ],
  surfacesSection: {
    kicker: 'Native surfaces',
    title: 'What the Codex plugin installs',
  },
  phaseRoutes: [
    { phase: 'P0', entry: '$adlc', evidence: 'preflight' },
    { phase: 'P1-P2', entry: '$adlc-spec', evidence: 'spec-lint · premortem · coldstart' },
    { phase: 'P3-P4', entry: '$adlc-rail-build', evidence: 'hollow-test · rails-guard · phase manifest' },
    { phase: 'P5-P6', entry: '$adlc-prosecute', evidence: 'prosecution · behavior diff · acceptance' },
    { phase: 'P7', entry: '$adlc-distill', evidence: 'foundry · rejection mining · rot · ratchet' },
  ],
  phaseSection: {
    kicker: 'Phase routing',
    title: 'Which skill to start with',
    intro: 'Start with `$adlc`. It routes to a focused skill. Evidence lands under `.adlc/` either way.',
    entryHeader: 'Codex entry',
  },
  enforcement: {
    session: {
      kicker: 'In the session',
      title: 'Session hook blocks frozen-rail edits',
      body: 'PreToolUse arms for the selected incomplete ticket. Conflicting or stale ticket state fails closed once enforcement is on.',
    },
    ci: {
      kicker: 'In CI',
      title: 'CI decides what may merge',
      body: 'Hooks give fast feedback. They are not a full security boundary. Keep the rails-guard job required so the trusted base ref decides what merges.',
    },
  },
  railsSection: {
    kicker: 'Frozen rails',
    title: 'Hooks in session, rails-guard in CI',
  },
  installSection: {
    kicker: 'Install',
    title: 'Install from npm and the Codex Git marketplace',
  },
  operate: {
    title: 'operate: Codex plugin',
    lines: [
      '# Update the CLI and plugin together',
      'npm install -g @adlc/cli@latest',
      'codex plugin marketplace upgrade adlc',
      'codex plugin add adlc-codex@adlc',
      'codex plugin list --json --available',
      '',
      '# Replace the older compatibility install',
      'codex plugin remove adlc@plugins-cli',
      'codex plugin add adlc-codex@adlc',
      '',
      '# Start a new Codex thread to load the refreshed MCP transport',
    ],
  },
  resources: [
    { href: '/docs/integrations/codex', label: 'Read the complete integration guide →' },
    { href: 'https://github.com/voodootikigod/adlc/tree/main/plugins/adlc-codex', label: 'Inspect the plugin source →', external: true },
    { href: 'https://developers.openai.com/codex/build-plugins', label: 'Codex plugin documentation →', external: true },
  ],
};

/** @type {IntegrationFact} */
export const CLAUDE_CODE_INTEGRATION = {
  slug: 'claude-code',
  name: 'Claude Code',
  status: 'installer',
  tagline: 'Phase-routing skill, slash-command gates, rails-guard and build-gate hooks, and a multi-lens prosecutor panel. Claude is the model via --prompt-only.',
  install: [
    'npx plugins add voodootikigod/adlc',
    'npm install -g @adlc/cli',
    '/adlc:adlc-init',
  ],
  note: 'The plugins installer auto-detects Claude Code and installs the native plugin. Prefer /adlc:adlc-init after the toolkit is on PATH. Native marketplace alternative: /plugin marketplace add voodootikigod/adlc then /plugin install adlc@adlc.',
  pluginDir: 'plugins/adlc-claude-code',
  hero: {
    kicker: 'Claude Code integration',
    title: 'ADLC inside Claude Code',
    identity: 'No API keys for ADLC gates. Claude answers --prompt-only prompts in-session. Evidence stays under .adlc/.',
    badges: [
      { label: 'Native plugin', accent: true },
      { label: 'One-line install' },
    ],
  },
  bundle: {
    title: 'adlc-claude-code / native bundle',
    ariaLabel: 'Native Claude Code plugin payload',
    root: 'adlc-claude-code/',
    entries: [
      { path: '├─ .claude-plugin/', note: 'marketplace manifest' },
      { path: '├─ skills/adlc/', note: 'phase-routing skill' },
      { path: '├─ commands/', surfaceKey: 'commands', note: 'slash commands' },
      { path: '├─ hooks/', surfaceKey: 'hooks', note: 'lifecycle events' },
      { path: '├─ .mcp.json', surfaceKey: 'mcp', note: 'bundled MCP server' },
      { path: '└─ agents/', surfaceKey: 'agents', note: 'prosecutor roles' },
    ],
  },
  surfaces: [
    {
      key: 'commands',
      count: 5,
      label: 'commands',
      title: 'Slash commands for each gate',
      detail: 'Each of init, ticket, prosecute, distill, and maintain has its own /adlc:* command.',
      items: ['/adlc:adlc-init', '/adlc:adlc-ticket', '/adlc:adlc-prosecute', '/adlc:adlc-distill', '/adlc:adlc-maintain'],
    },
    {
      key: 'hooks',
      count: 8,
      label: 'hook events',
      title: 'Hooks on session, edit, stop, and compaction',
      detail: 'SessionStart warns if you are not ready and re-injects the active ticket. PreToolUse enforces rails and the build-gate. PostToolUse watches churn. Stop audits evidence and risk-gated review. PreCompact/PostCompact/SubagentStart/SubagentStop re-inject ticket context so a compaction or subagent boundary never drops rail-protection awareness.',
      items: ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop'],
    },
    {
      key: 'mcp',
      count: 1,
      label: 'MCP server',
      title: 'The same gate tools, over MCP',
      detail: 'A bundled MCP server, auto-discovered at the plugin root, shells to the globally-installed adlc binary and exposes the same allowlisted gate tools the Codex integration ships.',
      items: ['adlc'],
    },
    {
      key: 'agents',
      count: 7,
      label: 'prosecutor agents',
      title: 'Five lenses, then a verifier',
      detail: '/adlc:adlc-prosecute fans out five specialist lenses, dedupes findings, and keeps only what a sixth verifier confirms. It loops until two dry rounds.',
      items: ['prosecutor', 'correctness', 'security', 'contract', 'diff', 'tests', 'verifier'],
    },
    {
      key: 'skill',
      count: 1,
      label: 'routing skill',
      title: 'A skill that routes by phase',
      detail: 'The adlc skill is a phase flowchart. Describe the work and it picks a gate so you do not have to memorize twenty tools.',
      items: ['adlc'],
    },
  ],
  surfacesSection: {
    kicker: 'Native surfaces',
    title: 'What the Claude Code plugin installs',
  },
  phaseRoutes: [
    { phase: 'P0', entry: '/adlc:adlc-ticket', evidence: 'schema-valid ticket · coldstart' },
    { phase: 'P1-P2', entry: 'adlc skill', evidence: 'spec-lint · premortem · parallax · router' },
    { phase: 'P3-P4', entry: 'PreToolUse hooks', evidence: 'rails-guard · build-gate · flail' },
    { phase: 'P5-P6', entry: '/adlc:adlc-prosecute', evidence: 'multi-lens loop · hollow-test · behavior-diff' },
    { phase: 'P7', entry: '/adlc:adlc-distill', evidence: 'foundry · rejection mining · maintain' },
  ],
  phaseSection: {
    kicker: 'Phase routing',
    title: 'Route by skill or slash command',
    intro: 'Ask the `adlc` skill what you are doing, or call a slash command directly. Evidence stays under `.adlc/`.',
    entryHeader: 'Claude Code entry',
  },
  enforcement: {
    session: {
      kicker: 'In the session',
      title: 'Frozen-rail edits are denied',
      body: 'PreToolUse rails-guard blocks Edit/Write/MultiEdit on frozen paths. Bash is not gated in-session (a shell cannot be reliably parsed), so pair the hook with CI.',
    },
    ci: {
      kicker: 'In CI',
      title: 'Required check on the PR',
      body: 'docs/ci/rails-guard.yml reads rails from the trusted base ref and rejects any PR that touches them, including shell writes the hook never saw.',
    },
  },
  railsSection: {
    kicker: 'Frozen rails',
    title: 'Session deny plus CI backstop',
  },
  installSection: {
    kicker: 'Install',
    title: 'Install with the plugins CLI',
  },
  operate: {
    title: 'operate: Claude Code plugin',
    lines: [
      '# Offline manifest / hook / command contract',
      'node scripts/claude-code-plugin-smoke.mjs .',
      '',
      '# Native marketplace (same marketplace.json)',
      '/plugin marketplace add voodootikigod/adlc',
      '/plugin install adlc@adlc',
    ],
  },
  resources: [
    { href: '/docs/integrations/claude-code', label: 'Read the complete integration guide →' },
    { href: 'https://github.com/voodootikigod/adlc/tree/main/plugins/adlc-claude-code', label: 'Inspect the plugin source →', external: true },
    { href: 'https://github.com/voodootikigod/adlc/blob/main/docs/adr/0003-adlc-claude-code-plugin.md', label: 'Design rationale (ADR 0003) →', external: true },
  ],
};

/** @type {IntegrationFact} */
export const CURSOR_INTEGRATION = {
  slug: 'cursor',
  name: 'Cursor',
  status: 'marketplace',
  tagline: 'Marketplace plugin with sessionStart context, preToolUse rails, packaged prosecutor agents + MCP wrapper (channel unverified), /adlc-* commands, and CI as the backstop.',
  install: [
    '# Cursor → Settings → Plugins → Add marketplace:',
    '#   https://github.com/voodootikigod/adlc',
    '# Install plugin: adlc-cursor',
    'npm install -g @adlc/cli',
    'adlc init --harness cursor',
  ],
  note: 'Prefer the marketplace install: it brings hooks, skills, and /adlc-* commands. adlc init only bootstraps the .adlc/ runtime (do not commit a generated .adlc/config.json into a repo that already freezes that path). Legacy fallback: npx @adlc/cursor . Wire docs/ci/rails-guard.yml as the unbypassable control.',
  pluginDir: 'plugins/adlc-cursor',
  hero: {
    kicker: 'Cursor integration',
    title: 'ADLC as a Cursor marketplace plugin',
    identity: 'A Cursor marketplace plugin with hooks, skills, rules, and commands. It is not a Claude shim.',
    badges: [
      { label: 'Marketplace plugin', accent: true },
      { label: 'CI rail backstop' },
    ],
  },
  bundle: {
    title: 'adlc-cursor / native bundle',
    ariaLabel: 'Native Cursor plugin payload',
    root: 'adlc-cursor/',
    entries: [
      { path: '├─ .cursor-plugin/', note: 'marketplace manifest' },
      { path: '├─ hooks/', surfaceKey: 'hooks', note: 'Cursor hook events' },
      { path: '├─ agents/', surfaceKey: 'agents', note: 'prosecutor agents' },
      { path: '├─ mcp.json', surfaceKey: 'mcp', note: 'Roots proxy MCP' },
      { path: '├─ command/', surfaceKey: 'commands', note: '/adlc-* commands' },
      { path: '├─ skills/', surfaceKey: 'skills', note: 'skills' },
      { path: '└─ rules/', surfaceKey: 'rules', note: 'phase-router rule' },
    ],
  },
  surfaces: [
    {
      key: 'hooks',
      count: 9,
      label: 'hook events',
      title: 'Rails first, then audit hooks',
      detail: 'sessionStart injects ticket context (best-effort). preToolUse runs rails first; Task spawn allowlist during P5. preCompact re-injects ticket context. subagentStart/Stop coordinate P5. stop/beforeSubmitPrompt surface evidence.',
      items: ['sessionStart', 'preToolUse', 'afterFileEdit', 'beforeShellExecution', 'stop', 'beforeSubmitPrompt', 'preCompact', 'subagentStart', 'subagentStop'],
    },
    {
      key: 'commands',
      count: 9,
      label: 'commands',
      title: '/adlc-* commands in the palette',
      detail: 'Covers init through maintain, including approve-spec, verify-build, and the sequential five-lens prosecute loop.',
      items: [
        '/adlc-init',
        '/adlc-ticket',
        '/adlc-spec',
        '/adlc-approve-spec',
        '/adlc-decompose',
        '/adlc-verify-build',
        '/adlc-prosecute',
        '/adlc-distill',
        '/adlc-maintain',
      ],
    },
    {
      key: 'agents',
      count: 7,
      label: 'prosecutor agents',
      title: 'Packaged prosecutor agents (fan-out unverified)',
      detail: 'Five readonly lenses plus verifier (+ optional orchestrator). Task fan-out is preferred; agents-backed claim waits on installed-Cursor proof.',
      items: ['prosecutor-correctness', 'prosecutor-security', 'prosecutor-contract', 'prosecutor-diff', 'prosecutor-tests', 'prosecutor-verifier', 'prosecutor'],
    },
    {
      key: 'mcp',
      count: 2,
      label: 'MCP tools',
      title: 'Wrapper landed / channel unverified',
      detail: 'mcp.json runs a Roots proxy to adlc mcp-server. Do not claim MCP shipped until installed-Cursor Roots proof.',
      items: ['adlc_gate', 'adlc_prosecute'],
    },
    {
      key: 'skills',
      count: 2,
      label: 'skills',
      title: 'Two skills: router and init',
      detail: 'The marketplace install includes the skills, so you do not copy them into the project by hand.',
      items: ['adlc', 'adlc-init'],
    },
    {
      key: 'rules',
      count: 2,
      label: 'rules',
      title: 'Phase routing + always-apply ticket context',
      detail: 'adlc.mdc keeps phase routing in context; adlc-ticket-context.mdc alwaysApply fallback when sessionStart context is dropped.',
      items: ['adlc.mdc', 'adlc-ticket-context.mdc'],
    },
  ],
  surfacesSection: {
    kicker: 'Native surfaces',
    title: 'What the Cursor plugin installs',
  },
  phaseRoutes: [
    { phase: 'P0', entry: '/adlc-ticket', evidence: 'ticket in .adlc/tickets.json' },
    { phase: 'P1-P2', entry: '/adlc-spec · /adlc-decompose', evidence: 'spec-lint · premortem · coldstart' },
    { phase: 'P3-P4', entry: 'preToolUse dispatcher', evidence: 'rails deny · advisory buildgate · flail' },
    { phase: 'P5-P6', entry: '/adlc-prosecute', evidence: 'five-lens loop · hollow-test · behavior-diff' },
    { phase: 'P7', entry: '/adlc-distill', evidence: 'foundry · rejection mining · maintain' },
  ],
  phaseSection: {
    kicker: 'Phase routing',
    title: 'Pick a phase command',
    intro: 'Use the `/adlc-*` palette for each phase. Prefer Task fan-out for P5; sequential same-context is a degraded fallback. Pair with cross-model `adversarial-review` for the risk gate.',
    entryHeader: 'Cursor entry',
  },
  enforcement: {
    session: {
      kicker: 'In the session',
      title: 'Session deny is best-effort',
      body: 'preToolUse returns permission: deny on a frozen-rail edit, but Cursor deny reliability has open reports and failClosed is false so a hook bug cannot brick the editor. Shell writes are advisory-only.',
    },
    ci: {
      kicker: 'In CI',
      title: 'Base-ref rails-guard is the control',
      body: 'docs/ci/rails-guard.yml is the unbypassable control. It reads rails from the trusted base ref. Freeze new rails in a separate merged commit before the build PR.',
    },
  },
  railsSection: {
    kicker: 'Frozen rails',
    title: 'Best-effort deny, required CI',
  },
  installSection: {
    kicker: 'Install',
    title: 'Install from the Cursor marketplace',
  },
  operate: {
    title: 'operate: Cursor plugin',
    lines: [
      '# Legacy / local-dev scaffolder fallback',
      'npx @adlc/cursor .',
      '',
      '# Offline contract smoke',
      'node scripts/cursor-install-smoke.mjs .',
    ],
  },
  resources: [
    { href: '/docs/integrations/cursor', label: 'Read the complete integration guide →' },
    { href: 'https://github.com/voodootikigod/adlc/tree/main/plugins/adlc-cursor', label: 'Inspect the plugin source →', external: true },
    { href: 'https://github.com/voodootikigod/adlc/blob/main/docs/adr/0006-adlc-cursor-integration.md', label: 'Design rationale (ADR 0006) →', external: true },
  ],
};

/** @type {IntegrationFact} */
export const OPENCODE_INTEGRATION = {
  slug: 'opencode',
  name: 'OpenCode',
  status: 'installer',
  tagline: 'Enforce-by-default rails-guard, full /adlc-* lifecycle commands, native adlc_gate/adlc_prosecute tools, and a multi-lens prosecution loop with a verifier.',
  install: [
    'npm install -g @adlc/cli',
    'npx @adlc/opencode init',
  ],
  note: 'Restart OpenCode after bootstrap so hooks load. /adlc-init inside the TUI re-runs the same idempotent scaffold. Peer dependency: @opencode-ai/plugin >= 1.17.13.',
  pluginDir: 'plugins/adlc-opencode',
  hero: {
    kicker: 'OpenCode integration',
    title: 'ADLC in the OpenCode TUI',
    identity: 'Enforcing by default: a thrown denial in tool.execute.before aborts the tool call. That is documented host behavior, and we regression-test it against a real binary.',
    badges: [
      { label: 'Enforcing by default', accent: true },
      { label: 'One-line install' },
    ],
  },
  bundle: {
    title: 'adlc-opencode / native bundle',
    ariaLabel: 'Native OpenCode plugin payload',
    root: 'adlc-opencode/',
    entries: [
      { path: '├─ index.mjs', note: 'plugin + rails hook' },
      { path: '├─ command/', surfaceKey: 'commands', note: 'lifecycle commands' },
      { path: '├─ agent/', surfaceKey: 'agents', note: 'prosecutor roles' },
      { path: '├─ skill/', note: 'phase-routing skill' },
      { path: '└─ lib/', note: 'keyless bridge · prosecute' },
    ],
  },
  surfaces: [
    {
      key: 'commands',
      count: 9,
      label: 'commands',
      title: '/adlc-* commands in the TUI',
      detail: 'Init, ticket, verify-build, prosecute, distill, and maintain are scaffolded into .opencode/ idempotently.',
      items: [
        '/adlc-init',
        '/adlc-ticket',
        '/adlc-spec',
        '/adlc-approve-spec',
        '/adlc-decompose',
        '/adlc-verify-build',
        '/adlc-prosecute',
        '/adlc-distill',
        '/adlc-maintain',
      ],
    },
    {
      key: 'agents',
      count: 7,
      label: 'prosecutor agents',
      title: 'Prosecutor lenses and a verifier',
      detail: 'Deterministic adlc_prosecute fans out write-disabled child sessions; @prosecutor runs hollow-test / behavior-diff / review-calibration.',
      items: ['correctness', 'security', 'contract', 'diff', 'tests', 'verifier', 'prosecutor'],
    },
    {
      key: 'tools',
      count: 2,
      label: 'native tools',
      title: 'Native tools instead of shelling out',
      detail: 'adlc_gate runs lifecycle gates (LLM-backed ones keyless through the host model); adlc_prosecute is the first-party P5 loop.',
      items: ['adlc_gate', 'adlc_prosecute'],
    },
    {
      key: 'hooks',
      count: 1,
      label: 'enforcing hook',
      title: 'tool.execute.before aborts on rail writes',
      detail: 'Structured edit/write/apply_patch and bash (via the shared shell classifier) deny frozen-rail mutations. Advisory session hooks warn only.',
      items: ['tool.execute.before'],
    },
  ],
  surfacesSection: {
    kicker: 'Native surfaces',
    title: 'What the OpenCode plugin installs',
  },
  phaseRoutes: [
    { phase: 'P0', entry: '/adlc-ticket', evidence: 'ticket · coldstart' },
    { phase: 'P1-P2', entry: '/adlc-spec · /adlc-decompose', evidence: 'parallax · spec-lint · premortem · forecast' },
    { phase: 'P3-P4', entry: 'rails-guard hook', evidence: 'enforcing deny · shell classifier · flail' },
    { phase: 'P5-P6', entry: 'adlc_prosecute', evidence: '5 lenses · verifier · behavior-diff' },
    { phase: 'P7', entry: '/adlc-distill', evidence: 'foundry · rejection mining · maintain' },
  ],
  phaseSection: {
    kicker: 'Phase routing',
    title: 'Commands and tools by phase',
    intro: 'Slash commands and native tools write the same `.adlc/` evidence as the other harnesses. P6 acceptance is still a human decision.',
    entryHeader: 'OpenCode entry',
  },
  enforcement: {
    session: {
      kicker: 'In the session',
      title: 'Thrown denial aborts the tool call',
      body: 'Enforcing by default on @opencode-ai/plugin >= 1.17.13. Unrecognized structured tools with a path fail closed. Downgrade only with the loud ADLC_ALLOW_ADVISORY_HOOKS=1 escape hatch.',
    },
    ci: {
      kicker: 'In CI',
      title: 'Merge still goes through rails-guard',
      body: 'scripts/rails-guard-ci.mjs via docs/ci/rails-guard.yml still decides what may merge, including anything the in-session classifier cannot see.',
    },
  },
  railsSection: {
    kicker: 'Frozen rails',
    title: 'Deny in session, prove in CI',
  },
  installSection: {
    kicker: 'Install',
    title: 'Scaffold the plugin into your project',
  },
  operate: {
    title: 'operate: OpenCode plugin',
    lines: [
      '# Offline scaffold / hook contract (no opencode binary)',
      'node scripts/opencode-install-smoke.mjs .',
      '',
      '# Re-run scaffold from inside the TUI',
      '/adlc-init',
    ],
  },
  resources: [
    { href: '/docs/integrations/opencode', label: 'Read the complete integration guide →' },
    { href: 'https://github.com/voodootikigod/adlc/tree/main/plugins/adlc-opencode', label: 'Inspect the plugin source →', external: true },
    { href: 'https://github.com/voodootikigod/adlc/blob/main/docs/adr/0004-adlc-opencode-integration.md', label: 'Design rationale (ADR 0004) →', external: true },
  ],
};

/** @type {IntegrationFact} */
export const PI_INTEGRATION = {
  slug: 'pi',
  name: 'Pi',
  status: 'installer',
  tagline: 'Proactive tool_call blocking and reactive snapshot revert, five phase skills, native adlc_gate/adlc_prosecute tools, and the strongest team-install story among the harnesses.',
  install: [
    'npm install -g @adlc/cli',
    'pi install -l npm:@adlc/pi',
  ],
  note: 'The -l project install auto-installs for teammates on trusted startup. pi install npm:@adlc/pi (no -l) is user-global instead. Then /adlc-init inside pi finishes the repo scaffold. Requires Node >= 22.19.',
  pluginDir: 'plugins/adlc-pi',
  hero: {
    kicker: 'Pi integration',
    title: 'ADLC as a Pi extension',
    identity: 'Pi skips built-in orchestrators on purpose. ADLC uses the Extension API for proactive and reactive gates instead of a wrapper script.',
    badges: [
      { label: 'Native extension', accent: true },
      { label: 'Team install (-l)' },
    ],
  },
  bundle: {
    title: 'adlc-pi / native bundle',
    ariaLabel: 'Native Pi extension payload',
    root: 'adlc-pi/',
    entries: [
      { path: '├─ index.ts', note: 'Extension API entry' },
      { path: '├─ skills/', surfaceKey: 'skills', note: 'phase skills' },
      { path: '├─ prompts/', note: 'phase templates' },
      { path: '└─ lib/', note: 'rail · prosecute · gate' },
    ],
  },
  surfaces: [
    {
      key: 'skills',
      count: 5,
      label: 'skills',
      title: 'Skills that wrap the adlc CLIs',
      detail: 'adlc routes. Focused skills cover spec, rail-build, prosecute, and distill. Hooks help; rails-guard remains the proof.',
      items: ['adlc', 'adlc-spec', 'adlc-rail-build', 'adlc-prosecute', 'adlc-distill'],
    },
    {
      key: 'gates',
      count: 2,
      label: 'gate layers',
      title: 'Block first, then revert if needed',
      detail: 'tool_call blocks rail/scope/trust-root writes (including bash mutations). tool_result restores a pre-tool snapshot and scans for undeclared suppressions.',
      items: ['tool_call', 'tool_result'],
    },
    {
      key: 'tools',
      count: 2,
      label: 'native tools',
      title: 'Native prosecute and gate tools',
      detail: 'adlc_prosecute fans out write-disabled child sessions; adlc_gate runs LLM-backed gates through the session model.',
      items: ['adlc_prosecute', 'adlc_gate'],
    },
    {
      key: 'commands',
      count: 6,
      label: 'commands',
      title: 'Ticket commands in the TUI',
      detail: '/ticket shows the active ticket. /adlc-ticket activates one. Init, approve-spec, accept, and rollback cover the rest, with a live footer pill.',
      items: ['/ticket', '/adlc-ticket', '/adlc-init', '/adlc-approve-spec', '/adlc-accept', '/adlc-rollback'],
    },
  ],
  surfacesSection: {
    kicker: 'Native surfaces',
    title: 'What the Pi extension installs',
  },
  phaseRoutes: [
    { phase: 'P0-P2', entry: 'adlc-spec skill', evidence: 'parallax · spec-lint · coldstart · forecast' },
    { phase: 'P3-P4', entry: 'extension gates', evidence: 'tool_call block · snapshot revert · flail' },
    { phase: 'P5', entry: 'adlc_prosecute', evidence: 'fan-out · verify · loop-until-dry' },
    { phase: 'P6', entry: '/adlc-accept', evidence: 'behavior-diff · gate-manifest' },
    { phase: 'P7', entry: 'adlc-distill skill', evidence: 'foundry · rejection mining · rot' },
  ],
  phaseSection: {
    kicker: 'Phase routing',
    title: 'Ticket on means gates on',
    intro: 'Activating a ticket is the switch. There is no `ADLC_P4_ENFORCEMENT` flag. Evidence stays under `.adlc/`. Hooks assist; CI proves.',
    entryHeader: 'Pi entry',
  },
  enforcement: {
    session: {
      kicker: 'In the session',
      title: 'Fail closed with an active ticket',
      body: 'Unresolved or unreadable ticket state blocks all tool calls. Bash writes are gated. Trust roots .adlc/tickets.json and .adlc/current-ticket.json are unconditionally blocked.',
    },
    ci: {
      kicker: 'In CI',
      title: 'Same rails-guard job as every harness',
      body: 'The same harness-agnostic rails-guard CI job rejects PRs that edit rails frozen on the trusted base ref. Make it a required check.',
    },
  },
  railsSection: {
    kicker: 'Frozen rails',
    title: 'Block on the way in, revert on the way out',
  },
  installSection: {
    kicker: 'Install',
    title: 'Install the published @adlc/pi extension',
  },
  operate: {
    title: 'operate: Pi extension',
    lines: [
      '# User-global instead of project-local',
      'pi install npm:@adlc/pi',
      '',
      '# Load from a source checkout',
      'pi --extension /path/to/adlc/plugins/adlc-pi/index.ts',
    ],
  },
  resources: [
    { href: '/docs/integrations/pi', label: 'Read the complete integration guide →' },
    { href: 'https://github.com/voodootikigod/adlc/tree/main/plugins/adlc-pi', label: 'Inspect the extension source →', external: true },
    { href: 'https://github.com/voodootikigod/adlc/blob/main/docs/integrations/pi.md', label: 'Design plan →', external: true },
  ],
};

/** @type {IntegrationFact} */
export const ANTIGRAVITY_INTEGRATION = {
  slug: 'antigravity',
  name: 'Google Antigravity',
  status: 'local',
  tagline: 'Advisory PreToolUse rails-guard for agy, plus skills and a prosecutor agent. The unbypassable CI rail-freeze gate is the real control.',
  install: [
    'agy plugin install /abs/path/to/adlc/plugins/adlc-antigravity',
  ],
  note: 'agy plugin install only takes a filesystem path. npm-assisted path: npm install @adlc/antigravity then agy plugin install ./node_modules/@adlc/antigravity. Marketplace and universal-installer support are still planned. Export ADLC_P4_ENFORCEMENT=1 with an active ticket.',
  pluginDir: 'plugins/adlc-antigravity',
  hero: {
    kicker: 'Antigravity integration',
    title: 'ADLC for Google Antigravity',
    identity: 'In-session rails are advisory. agy fails open on hook failure, so CI is the guarantee, not an optional extra.',
    badges: [
      { label: 'Local plugin install', accent: true },
      { label: 'CI is the backstop' },
    ],
  },
  bundle: {
    title: 'adlc-antigravity / native bundle',
    ariaLabel: 'Native Antigravity plugin payload',
    root: 'adlc-antigravity/',
    entries: [
      { path: '├─ plugin.json', note: 'agy manifest' },
      { path: '├─ hooks/', surfaceKey: 'hooks', note: 'PreToolUse event' },
      { path: '├─ skills/', surfaceKey: 'skills', note: 'phase skills' },
      { path: '├─ commands/', surfaceKey: 'commands', note: 'bootstrap command' },
      { path: '└─ agents/', surfaceKey: 'agents', note: 'prosecutor agent' },
    ],
  },
  surfaces: [
    {
      key: 'hooks',
      count: 1,
      label: 'hook event',
      title: 'PreToolUse rails-guard (advisory)',
      detail: 'Denies with allow_tool: false on exit 0. Non-zero exit is fail-open: a crash or timeout can let a rail write through.',
      items: ['PreToolUse'],
    },
    {
      key: 'skills',
      count: 4,
      label: 'skills',
      title: 'Four skills around the adlc CLIs',
      detail: 'Skills wrap the adlc CLIs from triage through distill. The hook only covers the rail moment.',
      items: ['adlc', 'adlc-doctrine', 'adlc-prosecutor', 'adlc-self-orchestrate'],
    },
    {
      key: 'commands',
      count: 3,
      label: 'commands',
      title: 'Commands for bootstrap and diagnostics',
      detail: '/adlc-init finishes the repo scaffold, /adlc-status inspects session context depth, and /adlc-doctor verifies integration health.',
      items: ['/adlc-init', '/adlc-status', '/adlc-doctor'],
    },
    {
      key: 'agents',
      count: 7,
      label: 'prosecutor agents',
      title: 'Five lenses, main prosecutor, and verifier',
      detail: 'P5 prosecution fans out five specialist lenses, dedupes findings via main prosecutor, and verifies with an independent verifier.',
      items: ['prosecutor', 'prosecutor-contract', 'prosecutor-correctness', 'prosecutor-diff', 'prosecutor-security', 'prosecutor-tests', 'prosecutor-verifier'],
    },
  ],
  surfacesSection: {
    kicker: 'Native surfaces',
    title: 'What the Antigravity plugin installs',
  },
  phaseRoutes: [
    { phase: 'P0', entry: '/adlc-init · adlc-ticket', evidence: 'ticket in .adlc/tickets.json' },
    { phase: 'P1-P2', entry: 'adlc CLI via skills', evidence: 'spec-lint · premortem · coldstart' },
    { phase: 'P3-P4', entry: 'PreToolUse + CI', evidence: 'advisory deny · rails-guard-ci' },
    { phase: 'P5-P6', entry: 'prosecutor agent', evidence: 'hollow-test · behavior-diff · manifest' },
    { phase: 'P7', entry: 'adlc skills', evidence: 'foundry · rejection mining' },
  ],
  phaseSection: {
    kicker: 'Phase routing',
    title: 'Skills route, CI enforces',
    intro: 'Skills and commands route work. The hook is only an in-session nudge. Treat CI as required before you rely on this integration for enforcement.',
    entryHeader: 'Antigravity entry',
  },
  enforcement: {
    session: {
      kicker: 'In the session',
      title: 'Advisory deny, fail-open on hook failure',
      body: 'Advisory deny with fail-open on hook failure. POSIX-oriented command paths; Windows in-session is unsupported. Shell writes are not gated. Do not treat the hook as a hard block.',
    },
    ci: {
      kicker: 'In CI',
      title: 'Unbypassable control across platforms',
      body: 'scripts/rails-guard-ci.mjs is the guarantee for every platform, including Windows. Make docs/ci/rails-guard.yml a required check (or fold it into an existing required job on free private repos).',
    },
  },
  railsSection: {
    kicker: 'Frozen rails',
    title: 'Advisory in session, required in CI',
  },
  installSection: {
    kicker: 'Install',
    title: 'Install from a local checkout path',
  },
  operate: {
    title: 'operate: Antigravity plugin',
    lines: [
      '# npm-assisted path (still a filesystem install)',
      'npm install @adlc/antigravity',
      'agy plugin install ./node_modules/@adlc/antigravity',
      '',
      '# Arm enforcement for an active ticket',
      'export ADLC_P4_ENFORCEMENT=1',
    ],
  },
  resources: [
    { href: '/docs/integrations/antigravity', label: 'Read the complete integration guide →' },
    { href: 'https://github.com/voodootikigod/adlc/tree/main/plugins/adlc-antigravity', label: 'Inspect the plugin source →', external: true },
  ],
};

/** @type {IntegrationFact} */
export const COPILOT_INTEGRATION = {
  slug: 'copilot',
  name: 'GitHub Copilot',
  status: 'marketplace',
  tagline: 'A native Copilot CLI plugin: seven lifecycle hooks, six phase skills, allowlisted MCP gate tools, and six read-only prosecution agents.',
  install: [
    'npm install -g @adlc/cli',
    'copilot plugin marketplace add voodootikigod/adlc',
    'copilot plugin install adlc-copilot@adlc',
    'adlc init --no-codex-agents',
  ],
  note: 'Installs from this repo\'s Git plugin marketplace, not npm — the @adlc/copilot npm package is not the install path. The universal installer performs these steps automatically when it detects the copilot CLI. adlc init --harness copilot is NOT available in the published @adlc/cli 1.6.0 (it exits: --harness must be codex or cursor); use --no-codex-agents until the next release. Either way it only scaffolds repository state and is not a substitute for installing the plugin.',
  pluginDir: 'plugins/adlc-copilot',
  hero: {
    kicker: 'Copilot integration',
    title: 'ADLC as a GitHub Copilot plugin',
    identity: 'Built against Copilot\'s own plugin surfaces. The in-session rail hook is best-effort; CI is the guarantee.',
    badges: [
      { label: 'Native plugin', accent: true },
      { label: 'Git marketplace' },
    ],
  },
  bundle: {
    title: 'adlc-copilot / native bundle',
    ariaLabel: 'Native Copilot plugin payload',
    root: 'adlc-copilot/',
    entries: [
      { path: '├─ plugin.json', note: 'manifest' },
      { path: '├─ skills/', surfaceKey: 'skills', note: 'phase-aware workflows' },
      { path: '├─ hooks/hooks.json', surfaceKey: 'hooks', note: 'lifecycle events' },
      { path: '├─ .mcp.json', surfaceKey: 'mcp', note: 'allowlisted tools' },
      { path: '└─ agents/', surfaceKey: 'agents', note: 'prosecution lenses' },
    ],
  },
  surfaces: [
    {
      key: 'skills',
      count: 6,
      label: 'skills',
      title: 'Skills load only the phase you need',
      detail: 'The adlc skill routes to a phase, then a focused skill loads just that P0-P7 workflow instead of the whole lifecycle.',
      items: ['adlc', 'adlc-init', 'adlc-ticket', 'adlc-prosecute', 'adlc-distill', 'adlc-maintain'],
    },
    {
      key: 'hooks',
      count: 7,
      label: 'hook events',
      title: 'Hooks for context, rails, and compaction',
      detail: 'Hooks restore ticket context at session start, check frozen-rail writes before a tool runs, survive compaction, and coordinate subagents.',
      items: [
        'sessionStart',
        'preToolUse',
        'postToolUse',
        'preCompact',
        'subagentStart',
        'subagentStop',
        'agentStop',
      ],
    },
    {
      key: 'mcp',
      count: 2,
      label: 'MCP tools',
      title: 'Two MCP tools, tightly scoped',
      detail: 'A local MCP server exposes allowlisted adlc_gate (no shell) and adlc_prosecute for evidence-producing review.',
      items: ['adlc_gate', 'adlc_prosecute'],
    },
    {
      key: 'agents',
      count: 6,
      label: 'prosecution agents',
      title: 'Five lenses plus an independent verifier',
      detail: 'P5 fans out five read-only specialist lenses, then an independent verifier refutes findings before they gate the merge.',
      items: [
        'prosecutor-correctness',
        'prosecutor-security',
        'prosecutor-contract',
        'prosecutor-diff',
        'prosecutor-tests',
        'prosecutor-verifier',
      ],
    },
  ],
  surfacesSection: {
    kicker: 'Native surfaces',
    title: 'What the Copilot plugin installs',
  },
  phaseRoutes: [
    { phase: 'P0', entry: 'adlc-ticket', evidence: 'ticket in the canonical store' },
    { phase: 'P1-P2', entry: 'adlc skill', evidence: 'spec-lint · premortem · coldstart' },
    { phase: 'P3-P4', entry: 'preToolUse + CI', evidence: 'rail deny · rails-guard-ci' },
    { phase: 'P5-P6', entry: 'adlc-prosecute', evidence: 'hollow-test · behavior diff · manifest' },
    { phase: 'P7', entry: 'adlc-distill', evidence: 'foundry · rejection mining' },
  ],
  phaseSection: {
    kicker: 'Phase routing',
    title: 'Skills route, CI enforces',
    intro: 'The `adlc` skill picks the phase and a focused skill loads that workflow. The preToolUse hook is an in-session nudge; treat CI as the control you rely on.',
    entryHeader: 'Copilot entry',
  },
  enforcement: {
    session: {
      kicker: 'In the session',
      title: 'Best-effort rail deny',
      body: 'The preToolUse hook denies edits to a frozen ticket\'s rails, then build-gate checks context fitness. Bash is not reliably parseable, so a shell write can still reach the diff — that is what the CI gate exists for.',
    },
    ci: {
      kicker: 'In CI',
      title: 'The unbypassable control',
      body: 'scripts/rails-guard-ci.mjs rejects any PR whose diff touches a rail frozen on the base branch, in any spelling. Install docs/ci/rails-guard.yml as .github/workflows/adlc-rails-guard.yml and follow its bootstrap ceremony before making it required.',
    },
  },
  railsSection: {
    kicker: 'Frozen rails',
    title: 'Best-effort in session, required in CI',
  },
  installSection: {
    kicker: 'Install',
    title: 'Install from the Git plugin marketplace',
  },
  operate: {
    title: 'operate: Copilot plugin',
    lines: [
      '# Or let the universal installer detect Copilot and do it for you',
      UNIVERSAL_INSTALL,
      '',
      '# Scaffold repository state (NOT a plugin install)',
      'adlc init --no-codex-agents',
    ],
  },
  resources: [
    { href: '/docs/integrations/copilot', label: 'Read the complete integration guide →' },
    { href: 'https://github.com/voodootikigod/adlc/tree/main/plugins/adlc-copilot', label: 'Inspect the plugin source →', external: true },
  ],
};

/** @type {IntegrationFact[]} */
export const INTEGRATIONS = [
  CLAUDE_CODE_INTEGRATION,
  CODEX_INTEGRATION,
  CURSOR_INTEGRATION,
  OPENCODE_INTEGRATION,
  PI_INTEGRATION,
  ANTIGRAVITY_INTEGRATION,
  COPILOT_INTEGRATION,
];

/**
 * @param {string} slug
 * @returns {IntegrationFact|undefined}
 */
export function integrationFor(slug) {
  return INTEGRATIONS.find((i) => i.slug === slug);
}

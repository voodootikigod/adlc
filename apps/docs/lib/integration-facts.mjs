// @ts-check
// Single source of truth for the native-integration marketing pages.
// Grounded in docs/integrations/<slug>.md — the test cross-checks existence.

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
  status: 'source',
  tagline: 'Phase routing, frozen-rail feedback, deterministic gate tools, and project review agents in one native Codex plugin.',
  install: [
    'git clone https://github.com/voodootikigod/adlc.git && cd adlc',
    'npm install --ignore-scripts',
    'npm install -g @adlc/cli',
    'node packages/init/bin/adlc-init.mjs --root /absolute/path/to/project',
    'codex plugin marketplace add "$PWD"',
    'codex plugin add adlc-codex@adlc',
  ],
  note: 'The native plugin works from source today. The initializer is newer than the current tagged suite release, so use the checkout command above until the matching release is published. Then start a new Codex session in the target project and review the bundled hooks.',
  pluginDir: 'plugins/adlc-codex',
  hero: {
    kicker: 'Codex integration',
    title: 'The lifecycle, packaged for Codex',
    identity: 'This is a Codex plugin, not a translated Claude compatibility layer.',
    badges: [
      { label: 'Native plugin', accent: true },
      { label: 'Available from source' },
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
      title: 'Progressive disclosure across the lifecycle',
      detail: '$adlc routes the task, then focused skills load only the P0–P7 workflow the current phase needs.',
      items: ['$adlc', '$adlc-init', '$adlc-spec', '$adlc-rail-build', '$adlc-prosecute', '$adlc-distill'],
    },
    {
      key: 'hooks',
      count: 8,
      label: 'hook events',
      title: 'Lifecycle context and fast rail feedback',
      detail: 'Native hooks restore context, guard frozen rails, detect repeated failures, and verify evidence before the session stops.',
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
      title: 'Narrow tools for gates and prosecution',
      detail: 'The local MCP server exposes an allowlisted, non-shell gate runner plus an explicit evidence-producing prosecution tool.',
      items: ['adlc_gate', 'adlc_prosecute'],
    },
    {
      key: 'agents',
      count: 3,
      label: 'project agents',
      title: 'Independent exploration, review, and verification',
      detail: 'The initializer writes project-scoped Codex roles without modifying the user’s global ~/.codex configuration.',
      items: ['explorer', 'reviewer', 'verifier'],
    },
  ],
  surfacesSection: {
    kicker: 'Native surfaces',
    title: 'Codex sees the lifecycle where work happens',
  },
  phaseRoutes: [
    { phase: 'P0', entry: '$adlc', evidence: 'preflight' },
    { phase: 'P1–P2', entry: '$adlc-spec', evidence: 'spec-lint · premortem · coldstart' },
    { phase: 'P3–P4', entry: '$adlc-rail-build', evidence: 'hollow-test · rails-guard · phase manifest' },
    { phase: 'P5–P6', entry: '$adlc-prosecute', evidence: 'prosecution · behavior diff · acceptance' },
    { phase: 'P7', entry: '$adlc-distill', evidence: 'foundry · rejection mining · rot · ratchet' },
  ],
  phaseSection: {
    kicker: 'Phase routing',
    title: 'One entry point for each kind of evidence',
    intro: 'Start with `$adlc`. The router hands the task to a focused skill, while the resulting evidence remains portable under `.adlc/`.',
    entryHeader: 'Codex entry',
  },
  enforcement: {
    session: {
      kicker: 'In the session',
      title: 'Fast feedback before a frozen rail changes',
      body: 'The PreToolUse hook automatically activates for the selected incomplete ticket. Conflicting or stale ticket state fails closed once enforcement is active.',
    },
    ci: {
      kicker: 'In CI',
      title: 'Authoritative proof over the committed diff',
      body: 'Hooks are immediate guardrails, not a complete security boundary. Keep the repository rails-guard job required so the trusted base ref decides what may merge.',
    },
  },
  railsSection: {
    kicker: 'Frozen rails',
    title: 'Immediate feedback, backed by merge-time proof',
  },
  installSection: {
    kicker: 'Install',
    title: 'Install the current native plugin from source',
  },
  operate: {
    title: 'operate: Codex plugin',
    lines: [
      '# Refresh the Git marketplace snapshot',
      'codex plugin marketplace upgrade adlc',
      'codex plugin list --json --available',
      '',
      '# Replace the older compatibility install',
      'codex plugin remove adlc@plugins-cli',
      'codex plugin add adlc-codex@adlc',
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
  tagline: 'Phase-routing skill, slash-command gates, rails-guard and build-gate hooks, and a multi-lens prosecutor panel — with Claude as the model via --prompt-only.',
  install: [
    'npx plugins add voodootikigod/adlc',
    'npm install -g @adlc/cli',
    '/adlc:adlc-init',
  ],
  note: 'The plugins installer auto-detects Claude Code and installs the native plugin. Prefer /adlc:adlc-init after the toolkit is on PATH. Native marketplace alternative: /plugin marketplace add voodootikigod/adlc then /plugin install adlc@adlc.',
  pluginDir: 'plugins/adlc-claude-code',
  hero: {
    kicker: 'Claude Code integration',
    title: 'The lifecycle, inside the editor',
    identity: 'No API keys for ADLC gates — Claude answers --prompt-only prompts in-session, and evidence stays under .adlc/.',
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
      { path: '└─ agents/', surfaceKey: 'agents', note: 'prosecutor roles' },
    ],
  },
  surfaces: [
    {
      key: 'commands',
      count: 5,
      label: 'commands',
      title: 'Slash commands for the gates you invoke',
      detail: 'Bootstrap, ticket authoring, multi-lens prosecution, distill, and maintenance each map to a dedicated /adlc:* command.',
      items: ['/adlc:adlc-init', '/adlc:adlc-ticket', '/adlc:adlc-prosecute', '/adlc:adlc-distill', '/adlc:adlc-maintain'],
    },
    {
      key: 'hooks',
      count: 4,
      label: 'hook events',
      title: 'Automatic preflight, rails, flail, and stop checks',
      detail: 'SessionStart warns on unreadiness; PreToolUse enforces rails and the build-gate; PostToolUse watches churn; Stop audits evidence and risk-gated review.',
      items: ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'],
    },
    {
      key: 'agents',
      count: 7,
      label: 'prosecutor agents',
      title: 'Independent lenses plus a verifier',
      detail: '/adlc:adlc-prosecute fans out five specialist lenses, dedupes findings, and keeps only what a sixth verifier confirms — looping until two dry rounds.',
      items: ['prosecutor', 'correctness', 'security', 'contract', 'diff', 'tests', 'verifier'],
    },
    {
      key: 'skill',
      count: 1,
      label: 'routing skill',
      title: 'Describe the work; get the right gate',
      detail: 'The adlc skill is a phase-routing flowchart so the model reaches for the correct gate without memorizing twenty tools.',
      items: ['adlc'],
    },
  ],
  surfacesSection: {
    kicker: 'Native surfaces',
    title: 'Claude Code sees the lifecycle where work happens',
  },
  phaseRoutes: [
    { phase: 'P0', entry: '/adlc:adlc-ticket', evidence: 'schema-valid ticket · coldstart' },
    { phase: 'P1–P2', entry: 'adlc skill', evidence: 'spec-lint · premortem · parallax · router' },
    { phase: 'P3–P4', entry: 'PreToolUse hooks', evidence: 'rails-guard · build-gate · flail' },
    { phase: 'P5–P6', entry: '/adlc:adlc-prosecute', evidence: 'multi-lens loop · hollow-test · behavior-diff' },
    { phase: 'P7', entry: '/adlc:adlc-distill', evidence: 'foundry · rejection mining · maintain' },
  ],
  phaseSection: {
    kicker: 'Phase routing',
    title: 'One entry point for each kind of evidence',
    intro: 'Ask the `adlc` skill what you are doing, or jump straight to a slash command. Evidence remains portable under `.adlc/`.',
    entryHeader: 'Claude Code entry',
  },
  enforcement: {
    session: {
      kicker: 'In the session',
      title: 'Structured edits to frozen rails are denied',
      body: 'PreToolUse rails-guard blocks Edit/Write/MultiEdit on frozen paths. Bash is not gated in-session — a shell cannot be reliably parsed — so pair the hook with CI.',
    },
    ci: {
      kicker: 'In CI',
      title: 'Authoritative proof over the committed diff',
      body: 'docs/ci/rails-guard.yml reads rails from the trusted base ref and rejects any PR that touches them, including shell-driven writes the hook never saw.',
    },
  },
  railsSection: {
    kicker: 'Frozen rails',
    title: 'Immediate feedback, backed by merge-time proof',
  },
  installSection: {
    kicker: 'Install',
    title: 'Install with the vendor-neutral plugins CLI',
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
  tagline: 'Marketplace plugin with a preToolUse rails dispatcher, afterFileEdit audit, advisory shell notice, /adlc-* commands, and a sequential five-lens prosecute loop — backstopped by CI.',
  install: [
    '# Cursor → Settings → Plugins → Add marketplace:',
    '#   https://github.com/voodootikigod/adlc',
    '# Install plugin: adlc-cursor',
    'npm install -g @adlc/cli',
    'adlc init --harness cursor',
  ],
  note: 'Marketplace install is preferred — the plugin brings hooks, skills, and /adlc-* commands. adlc init only bootstraps the .adlc/ runtime (do not commit a generated .adlc/config.json into a repo that already freezes that path). Legacy fallback: npx @adlc/cursor . Wire docs/ci/rails-guard.yml as the unbypassable control.',
  pluginDir: 'plugins/adlc-cursor',
  hero: {
    kicker: 'Cursor integration',
    title: 'The lifecycle, native in Cursor',
    identity: 'A Cursor marketplace plugin — hooks, skills, rules, and commands — not a translated Claude shim.',
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
      { path: '├─ command/', surfaceKey: 'commands', note: '/adlc-* commands' },
      { path: '├─ skills/', surfaceKey: 'skills', note: 'skills' },
      { path: '└─ rules/', surfaceKey: 'rules', note: 'phase-router rule' },
    ],
  },
  surfaces: [
    {
      key: 'hooks',
      count: 5,
      label: 'hook events',
      title: 'Dispatcher first, then audit and advisories',
      detail: 'preToolUse runs rails before anything else; afterFileEdit and beforeShellExecution observe; stop and beforeSubmitPrompt keep evidence and readiness visible.',
      items: ['preToolUse', 'afterFileEdit', 'beforeShellExecution', 'stop', 'beforeSubmitPrompt'],
    },
    {
      key: 'commands',
      count: 9,
      label: 'commands',
      title: 'Bare /adlc-* phase suite in the palette',
      detail: 'Init through maintain, including approve-spec, verify-build, and the sequential five-lens prosecute loop.',
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
      key: 'skills',
      count: 2,
      label: 'skills',
      title: 'Phase router plus bootstrap skill',
      detail: 'Marketplace skills land with the plugin so the agent discovers ADLC without a project-local copy step.',
      items: ['adlc', 'adlc-init'],
    },
    {
      key: 'rules',
      count: 1,
      label: 'rules',
      title: 'Always-on phase doctrine',
      detail: 'The adlc.mdc rule keeps phase routing in context for the agent across the session.',
      items: ['adlc.mdc'],
    },
  ],
  surfacesSection: {
    kicker: 'Native surfaces',
    title: 'Cursor sees the lifecycle where work happens',
  },
  phaseRoutes: [
    { phase: 'P0', entry: '/adlc-ticket', evidence: 'ticket in .adlc/tickets.json' },
    { phase: 'P1–P2', entry: '/adlc-spec · /adlc-decompose', evidence: 'spec-lint · premortem · coldstart' },
    { phase: 'P3–P4', entry: 'preToolUse dispatcher', evidence: 'rails deny · advisory buildgate · flail' },
    { phase: 'P5–P6', entry: '/adlc-prosecute', evidence: 'five-lens loop · hollow-test · behavior-diff' },
    { phase: 'P7', entry: '/adlc-distill', evidence: 'foundry · rejection mining · maintain' },
  ],
  phaseSection: {
    kicker: 'Phase routing',
    title: 'One entry point for each kind of evidence',
    intro: 'Use the `/adlc-*` palette for each phase. Prosecution is sequential in one context — pair it with cross-model `adversarial-review` when independence matters.',
    entryHeader: 'Cursor entry',
  },
  enforcement: {
    session: {
      kicker: 'In the session',
      title: 'Best-effort deny, never the sole control',
      body: 'preToolUse returns permission: deny on a frozen-rail edit, but Cursor deny reliability has open reports and failClosed is false so a hook bug cannot brick the editor. Shell writes are advisory-only.',
    },
    ci: {
      kicker: 'In CI',
      title: 'Authoritative proof over the committed diff',
      body: 'docs/ci/rails-guard.yml is the unbypassable control. It reads rails from the trusted base ref — freeze new rails in a separate merged commit before the build PR.',
    },
  },
  railsSection: {
    kicker: 'Frozen rails',
    title: 'Immediate feedback, backed by merge-time proof',
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
  tagline: 'Enforce-by-default rails-guard, full /adlc-* lifecycle commands, native adlc_gate/adlc_prosecute tools, and a deterministic multi-lens + verifier prosecution loop.',
  install: [
    'npm install -g @adlc/cli',
    'npx @adlc/opencode init',
  ],
  note: 'Restart OpenCode after bootstrap so hooks load. /adlc-init inside the TUI re-runs the same idempotent scaffold. Peer dependency: @opencode-ai/plugin ≥ 1.17.13.',
  pluginDir: 'plugins/adlc-opencode',
  hero: {
    kicker: 'OpenCode integration',
    title: 'The lifecycle, in the terminal agent',
    identity: 'Enforcing by default: a thrown denial in tool.execute.before aborts the tool call — documented host behavior, regression-tested against a real binary.',
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
      title: 'Full /adlc-* lifecycle in the TUI',
      detail: 'From init and ticket through verify-build, prosecute, distill, and maintain — scaffolded into .opencode/ idempotently.',
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
      title: 'Five lenses, a verifier, and a meta-agent',
      detail: 'Deterministic adlc_prosecute fans out write-disabled child sessions; @prosecutor runs hollow-test / behavior-diff / review-calibration.',
      items: ['correctness', 'security', 'contract', 'diff', 'tests', 'verifier', 'prosecutor'],
    },
    {
      key: 'tools',
      count: 2,
      label: 'native tools',
      title: 'Model-callable gates without shelling out',
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
    title: 'OpenCode sees the lifecycle where work happens',
  },
  phaseRoutes: [
    { phase: 'P0', entry: '/adlc-ticket', evidence: 'ticket · coldstart' },
    { phase: 'P1–P2', entry: '/adlc-spec · /adlc-decompose', evidence: 'parallax · spec-lint · premortem · forecast' },
    { phase: 'P3–P4', entry: 'rails-guard hook', evidence: 'enforcing deny · shell classifier · flail' },
    { phase: 'P5–P6', entry: 'adlc_prosecute', evidence: '5 lenses · verifier · behavior-diff' },
    { phase: 'P7', entry: '/adlc-distill', evidence: 'foundry · rejection mining · maintain' },
  ],
  phaseSection: {
    kicker: 'Phase routing',
    title: 'One entry point for each kind of evidence',
    intro: 'Slash commands and native tools produce the same `.adlc/` evidence as every other harness. P6 acceptance stays a human decision by design.',
    entryHeader: 'OpenCode entry',
  },
  enforcement: {
    session: {
      kicker: 'In the session',
      title: 'Thrown denial aborts the tool call',
      body: 'Enforcing by default on @opencode-ai/plugin ≥ 1.17.13. Unrecognized structured tools with a path fail closed. Downgrade only with the loud ADLC_ALLOW_ADVISORY_HOOKS=1 escape hatch.',
    },
    ci: {
      kicker: 'In CI',
      title: 'Authoritative proof over the committed diff',
      body: 'scripts/rails-guard-ci.mjs via docs/ci/rails-guard.yml still decides what may merge — including anything the in-session classifier cannot see.',
    },
  },
  railsSection: {
    kicker: 'Frozen rails',
    title: 'Immediate denial, backed by merge-time proof',
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
  note: 'The -l project install auto-installs for teammates on trusted startup. pi install npm:@adlc/pi (no -l) is user-global instead. Then /adlc-init inside pi finishes the repo scaffold. Requires Node ≥ 22.19.',
  pluginDir: 'plugins/adlc-pi',
  hero: {
    kicker: 'Pi integration',
    title: 'The lifecycle, as a native Pi extension',
    identity: 'Pi skips built-in orchestrators on purpose — ADLC slots in through the Extension API with proactive and reactive gates, not a wrapper script.',
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
      title: 'Phase-aware workflows wrapping the CLIs',
      detail: 'adlc routes; focused skills cover spec, rail-build, prosecute, and distill while hooks stay assistive and rails-guard remains the proof.',
      items: ['adlc', 'adlc-spec', 'adlc-rail-build', 'adlc-prosecute', 'adlc-distill'],
    },
    {
      key: 'gates',
      count: 2,
      label: 'gate layers',
      title: 'Proactive block and reactive revert',
      detail: 'tool_call blocks rail/scope/trust-root writes (including bash mutations). tool_result restores a pre-tool snapshot and scans for undeclared suppressions.',
      items: ['tool_call', 'tool_result'],
    },
    {
      key: 'tools',
      count: 2,
      label: 'native tools',
      title: 'In-session prosecution and keyless gates',
      detail: 'adlc_prosecute fans out write-disabled child sessions; adlc_gate runs LLM-backed gates through the session model.',
      items: ['adlc_prosecute', 'adlc_gate'],
    },
    {
      key: 'commands',
      count: 6,
      label: 'commands',
      title: 'Ticket lifecycle commands in the TUI',
      detail: '/ticket shows the active ticket; /adlc-ticket activates one. Init, approve-spec, accept, and rollback round out the human-driven surface, plus a live footer pill.',
      items: ['/ticket', '/adlc-ticket', '/adlc-init', '/adlc-approve-spec', '/adlc-accept', '/adlc-rollback'],
    },
  ],
  surfacesSection: {
    kicker: 'Native surfaces',
    title: 'Pi sees the lifecycle where work happens',
  },
  phaseRoutes: [
    { phase: 'P0–P2', entry: 'adlc-spec skill', evidence: 'parallax · spec-lint · coldstart · forecast' },
    { phase: 'P3–P4', entry: 'extension gates', evidence: 'tool_call block · snapshot revert · flail' },
    { phase: 'P5', entry: 'adlc_prosecute', evidence: 'fan-out · verify · loop-until-dry' },
    { phase: 'P6', entry: '/adlc-accept', evidence: 'behavior-diff · gate-manifest' },
    { phase: 'P7', entry: 'adlc-distill skill', evidence: 'foundry · rejection mining · rot' },
  ],
  phaseSection: {
    kicker: 'Phase routing',
    title: 'One entry point for each kind of evidence',
    intro: 'Activating a ticket is the switch — no `ADLC_P4_ENFORCEMENT` flag. Evidence stays under `.adlc/`; hooks assist, CI proves.',
    entryHeader: 'Pi entry',
  },
  enforcement: {
    session: {
      kicker: 'In the session',
      title: 'Fail closed once a ticket is active',
      body: 'Unresolved or unreadable ticket state blocks all tool calls. Bash writes are gated. Trust roots .adlc/tickets.json and .adlc/current-ticket.json are unconditionally blocked.',
    },
    ci: {
      kicker: 'In CI',
      title: 'Authoritative proof over the committed diff',
      body: 'The same harness-agnostic rails-guard CI job rejects PRs that edit rails frozen on the trusted base ref. Make it a required check.',
    },
  },
  railsSection: {
    kicker: 'Frozen rails',
    title: 'Block before disk, revert after if needed',
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
  tagline: 'Advisory PreToolUse rails-guard for agy, plus skills and a prosecutor agent — with the unbypassable CI rail-freeze gate as the real control.',
  install: [
    'agy plugin install /abs/path/to/adlc/plugins/adlc-antigravity',
  ],
  note: 'agy plugin install only takes a filesystem path. npm-assisted path: npm install @adlc/antigravity then agy plugin install ./node_modules/@adlc/antigravity. Marketplace and universal-installer support are still planned. Export ADLC_P4_ENFORCEMENT=1 with an active ticket.',
  pluginDir: 'plugins/adlc-antigravity',
  hero: {
    kicker: 'Antigravity integration',
    title: 'The lifecycle, for Google Antigravity',
    identity: 'In-session rails are advisory — agy fails open on hook failure — so CI is the guarantee, not an optional extra.',
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
      detail: 'Denies with allow_tool: false on exit 0. Non-zero exit is fail-open — a crash or timeout can let a rail write through.',
      items: ['PreToolUse'],
    },
    {
      key: 'skills',
      count: 4,
      label: 'skills',
      title: 'Doctrine, routing, prosecute, orchestrate',
      detail: 'Skills wrap the adlc CLIs for triage through distill while the hook only covers the rail moment.',
      items: ['adlc', 'adlc-doctrine', 'adlc-prosecutor', 'adlc-self-orchestrate'],
    },
    {
      key: 'commands',
      count: 1,
      label: 'commands',
      title: 'Bootstrap the .adlc/ runtime',
      detail: '/adlc-init finishes the repo scaffold. Prosecution is an agent role, not a second slash command.',
      items: ['/adlc-init'],
    },
    {
      key: 'agents',
      count: 1,
      label: 'agent',
      title: 'Prosecutor agent for pre-merge review',
      detail: 'Pairs with hollow-test and behavior-diff so P5 is not a vibes-based glance at the diff.',
      items: ['prosecutor'],
    },
  ],
  surfacesSection: {
    kicker: 'Native surfaces',
    title: 'Antigravity sees the lifecycle where work happens',
  },
  phaseRoutes: [
    { phase: 'P0', entry: '/adlc-init · adlc-ticket', evidence: 'ticket in .adlc/tickets.json' },
    { phase: 'P1–P2', entry: 'adlc CLI via skills', evidence: 'spec-lint · premortem · coldstart' },
    { phase: 'P3–P4', entry: 'PreToolUse + CI', evidence: 'advisory deny · rails-guard-ci' },
    { phase: 'P5–P6', entry: 'prosecutor agent', evidence: 'hollow-test · behavior-diff · manifest' },
    { phase: 'P7', entry: 'adlc skills', evidence: 'foundry · rejection mining' },
  ],
  phaseSection: {
    kicker: 'Phase routing',
    title: 'One entry point for each kind of evidence',
    intro: 'Skills and commands route work; the hook is only the in-session nudge. Treat CI as required before relying on this integration for enforcement.',
    entryHeader: 'Antigravity entry',
  },
  enforcement: {
    session: {
      kicker: 'In the session',
      title: 'Advisory deny — fail-open on hook failure',
      body: 'Advisory deny with fail-open on hook failure. POSIX-oriented command paths; Windows in-session is unsupported. Shell writes are not gated. Do not treat the hook as a hard block.',
    },
    ci: {
      kicker: 'In CI',
      title: 'The unbypassable, cross-platform control',
      body: 'scripts/rails-guard-ci.mjs is the guarantee for every platform, including Windows. Make docs/ci/rails-guard.yml a required check (or fold it into an existing required job on free private repos).',
    },
  },
  railsSection: {
    kicker: 'Frozen rails',
    title: 'Advisory in-session, authoritative at merge',
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

/** @type {IntegrationFact[]} */
export const INTEGRATIONS = [
  CLAUDE_CODE_INTEGRATION,
  CODEX_INTEGRATION,
  CURSOR_INTEGRATION,
  OPENCODE_INTEGRATION,
  PI_INTEGRATION,
  ANTIGRAVITY_INTEGRATION,
];

/**
 * @param {string} slug
 * @returns {IntegrationFact|undefined}
 */
export function integrationFor(slug) {
  return INTEGRATIONS.find((i) => i.slug === slug);
}

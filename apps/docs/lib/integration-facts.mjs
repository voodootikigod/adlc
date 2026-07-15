// Single source of truth for the native-integration marketing pages.
// Grounded in docs/integrations/<slug>.md — the test cross-checks existence.

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
      items: ['session context', 'rail guard', 'flail detection', 'stop verification'],
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
  phaseRoutes: [
    { phase: 'P0', entry: '$adlc', evidence: 'preflight' },
    { phase: 'P1–P2', entry: '$adlc-spec', evidence: 'spec-lint · premortem · coldstart' },
    { phase: 'P3–P4', entry: '$adlc-rail-build', evidence: 'hollow-test · rails-guard · phase manifest' },
    { phase: 'P5–P6', entry: '$adlc-prosecute', evidence: 'prosecution · behavior diff · acceptance' },
    { phase: 'P7', entry: '$adlc-distill', evidence: 'foundry · rejection mining · rot · ratchet' },
  ],
};

export const INTEGRATIONS = [
  {
    slug: 'claude-code',
    name: 'Claude Code',
    status: 'installer',
    tagline: 'Full plugin: gates as slash commands, rails-guard hooks, P5 prosecutor subagent.',
    install: [
      'npx plugins add voodootikigod/adlc',
      'npm install -g @adlc/cli',
      '/adlc:adlc-init',
    ],
  },
  CODEX_INTEGRATION,
  {
    slug: 'cursor',
    name: 'Cursor',
    status: 'marketplace',
    tagline: 'Native Cursor plugin: marketplace hooks, skills, rules, and /adlc-* commands with CI rail backstop.',
    install: [
      '# Cursor → Settings → Plugins → Add marketplace:',
      '#   https://github.com/voodootikigod/adlc',
      '# Install plugin: adlc-cursor',
      'npm install -g @adlc/cli',
      'adlc init --harness cursor',
    ],
    note: 'Marketplace install is preferred — the plugin brings hooks, skills, and /adlc-* commands. adlc init only bootstraps the .adlc/ runtime (do not commit a generated .adlc/config.json into a repo that already freezes that path). Legacy fallback: npx @adlc/cursor . Wire docs/ci/rails-guard.yml as the unbypassable control.',
  },
  {
    slug: 'opencode',
    name: 'OpenCode',
    status: 'installer',
    tagline: 'Rails-guard plugin plus /adlc-* commands and agents for OpenCode.',
    install: [
      'npm install -g @adlc/cli',
      'npx @adlc/opencode init',
    ],
    note: 'Restart OpenCode after bootstrap; `/adlc-init` inside the TUI re-runs the same idempotent scaffold.',
  },
  {
    slug: 'pi',
    name: 'Pi',
    status: 'installer',
    tagline: 'Proactive and reactive gating via Pi tool_call/tool_result hooks, with TUI gate display.',
    install: [
      'npm install -g @adlc/cli',
      'pi install -l npm:@adlc/pi',
    ],
    note: 'The `-l` project install auto-installs for teammates on trusted startup (the best team-install story of the six); `pi install npm:@adlc/pi` (no -l) installs user-global instead. Then `/adlc-init` inside pi finishes the repo scaffold. Requires Node >= 22.19 (the pi floor).',
  },
  {
    slug: 'antigravity',
    name: 'Google Antigravity',
    status: 'local',
    tagline: 'Advisory rails-guard PreToolUse hook plus a CI backstop for frozen rails.',
    install: [
      'agy plugin install /abs/path/to/adlc/plugins/adlc-antigravity',
    ],
    note: '`agy plugin install` only takes a filesystem path, so a local checkout is the install even though `@adlc/antigravity` is now published on npm (install it and point agy at node_modules for the npm-assisted path). Marketplace + universal-installer support are still planned.',
  },
];

export function integrationFor(slug) {
  return INTEGRATIONS.find((i) => i.slug === slug);
}

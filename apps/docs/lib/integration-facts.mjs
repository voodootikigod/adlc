// Single source of truth for the native-integration marketing pages.
// Grounded in docs/integrations/<slug>.md — the test cross-checks existence.

export const INTEGRATIONS = [
  {
    slug: 'claude-code',
    name: 'Claude Code',
    status: 'installer',
    tagline: 'Full plugin: gates as slash commands, rails-guard hooks, P5 prosecutor subagent.',
    install: [
      'npx plugins add voodootikigod/adlc',
      'npm install -g @adlc/cli',
    ],
  },
  {
    slug: 'codex',
    name: 'Codex',
    status: 'source',
    tagline: 'Native skills and hooks for the Codex CLI, including the prosecute review gate.',
    install: [
      'git clone https://github.com/voodootikigod/adlc && cd adlc',
      'node scripts/codex-install-smoke.mjs .',
    ],
    note: 'Git-backed marketplace install is not yet supported — install from a repo checkout.',
  },
  {
    slug: 'cursor',
    name: 'Cursor',
    status: 'source',
    tagline: 'Hooks, rules, and commands scaffolded into .cursor/ — no plugin runtime needed.',
    install: [
      'npm install -g @adlc/cli',
      'node /path/to/adlc/plugins/adlc-cursor/lib/scaffold-cli.mjs .',
    ],
    note: '@adlc/cursor-package is not yet on npm — scaffold from a repo checkout.',
  },
  {
    slug: 'opencode',
    name: 'OpenCode',
    status: 'source',
    tagline: 'Rails-guard plugin plus /adlc-* commands and agents for OpenCode.',
    install: [
      'git clone https://github.com/voodootikigod/adlc',
      '# register plugins/adlc-opencode in .opencode/opencode.json, then /adlc-init',
    ],
    note: '@adlc/opencode-package is not yet on npm — install from source.',
  },
  {
    slug: 'pi',
    name: 'Pi',
    status: 'source',
    tagline: 'Proactive and reactive gating via Pi tool_call/tool_result hooks, with TUI gate display.',
    install: [
      'git clone https://github.com/voodootikigod/adlc',
      '# package lives at plugins/adlc-pi — see the integration guide',
    ],
  },
  {
    slug: 'antigravity',
    name: 'Google Antigravity',
    status: 'local',
    tagline: 'Advisory rails-guard PreToolUse hook plus a CI backstop for frozen rails.',
    install: [
      'agy plugin install /abs/path/to/adlc/plugins/adlc-antigravity',
    ],
    note: 'Local-checkout install is the verified path; marketplace + universal installer are planned.',
  },
];

export function integrationFor(slug) {
  return INTEGRATIONS.find((i) => i.slug === slug);
}

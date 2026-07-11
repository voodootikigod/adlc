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
      '/adlc:adlc-init',
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
    note: 'No published package yet, and git-backed marketplace install is not supported either, so work from a repo checkout.',
  },
  {
    slug: 'cursor',
    name: 'Cursor',
    status: 'source',
    tagline: 'Hooks, rules, and commands scaffolded straight into .cursor/, no plugin runtime needed.',
    install: [
      'npm install -g @adlc/cli',
      'cd /path/to/adlc && npm install',
      'node /path/to/adlc/plugins/adlc-cursor/lib/scaffold-cli.mjs .',
      'node scripts/cursor-install-smoke.mjs .',
    ],
    note: '@adlc/cursor is not on npm yet, so scaffold from a repo checkout.',
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
      'pi install npm:@adlc/pi',
    ],
    note: 'Then run `/adlc-init` inside pi to finish the repo scaffold. Requires Node >= 22.19 (the pi floor).',
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

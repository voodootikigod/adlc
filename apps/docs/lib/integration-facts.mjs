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
    tagline: 'Native Codex plugin with six skills, lifecycle hooks, MCP gates, and project-scoped agents.',
    install: [
      'git clone https://github.com/voodootikigod/adlc.git && cd adlc',
      'npm install --ignore-scripts',
      'npm install -g @adlc/cli',
      'node packages/init/bin/adlc-init.mjs --root /absolute/path/to/project',
      'codex plugin marketplace add "$PWD"',
      'codex plugin add adlc-codex@adlc',
    ],
    note: 'This is the working-now source flow because the initializer change is not in the current registry release. Start a new Codex session in the target project and trust the bundled hooks when prompted. Until the matching release exists, rerun the checkout initializer to refresh the scaffold.',
  },
  {
    slug: 'cursor',
    name: 'Cursor',
    status: 'installer',
    tagline: 'Hooks, rules, and commands scaffolded straight into .cursor/, no plugin runtime needed.',
    install: [
      'npm install -g @adlc/cli',
      'npx @adlc/cursor .',
    ],
    note: '@adlc/cursor is published on npm. The scaffold is idempotent — re-run it (or `/adlc-init` inside Cursor) to refresh .adlc/config.json, .cursor/hooks.json, rules, and the /adlc-* command palette.',
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

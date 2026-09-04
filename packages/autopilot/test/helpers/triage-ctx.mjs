// The fake orchestrator context for the triage / attempts / effects suites:
// a temporary REPO_ROOT with a real `.adlc/autopilot-runs`, the real spawner
// over fake children (pinned claude / adlc / gh), the real record store,
// redactor and lock, a git fake answering `ls-tree`, and a static denylist.

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globMatch } from '@adlc/core';
import { createSpawner } from '../../lib/spawn.mjs';
import { createGh } from '../../lib/github.mjs';
import { createRedactor } from '../../lib/redact.mjs';
import { createRecordStore } from '../../lib/records.mjs';
import { autopilotPaths } from '../../lib/paths.mjs';
import { acquireLock } from '../../lib/lock.mjs';
import { fakeSpawnImpl } from './fake-children.mjs';
import { fakeGithub } from './triage-gh.mjs';

export const NOW = Date.parse('2026-08-28T12:00:00Z');
export const BASE_OID = 'b'.repeat(40);
export const PINNED = Object.freeze({ claude: '/opt/bin/claude', adlc: '/opt/bin/adlc', gh: '/opt/bin/gh', git: '/opt/bin/git', node: '/opt/bin/node', specLintBin: '/repo/packages/spec-lint/bin/spec-lint.mjs' });
export const BASE_ENV = Object.freeze({ PATH: '/opt/bin:/usr/bin', HOME: '/home/op', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' });
export const DEFAULT_TREE = Object.freeze([
  'README.md', 'package.json', 'docs/guide.md', 'scripts/preflight.mjs', 'scripts/rails-guard-ci.mjs',
  'packages/core/index.mjs', 'packages/fleet/lib/run.mjs', 'packages/cli/lib/registry.mjs', 'apps/docs/lib/toolkit-packages.mjs',
  'plugins/adlc-claude-code/plugin.json', '.adlc/config.json', '.github/workflows/ci.yml',
]);
export const DEFAULT_DENY = Object.freeze(['.adlc/**', '.github/**', 'scripts/preflight.mjs', 'scripts/rails-guard-ci.mjs', 'package.json', 'packages/core/**', 'packages/rails-guard/**']);

/** A valid shaped ticket for issue `n`, as the model would return it. */
export function shapedTicket(n, url, over = {}) {
  return {
    title: `#${n}: Add the widget`,
    body: `GitHub issue: ${url}\n\nImplement the widget in the fleet package.\n\n=== ACCEPTANCE CRITERIA ===\n- The widget renders. VERIFY: node --test packages/fleet/test/widget.test.mjs exits 0\n- Docs updated. VERIFY: grep -q widget docs/guide.md\n`,
    scope: ['packages/fleet/**', 'docs/guide.md'], rails: [], category: 'feature', duration: 1, ...over,
  };
}

/** The `claude -p --output-format json` result document wrapping a ticket. */
export const claudeResult = (ticket, extra = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: typeof ticket === 'string' ? ticket : JSON.stringify(ticket), ...extra });

/**
 * @param o.claude   handler (args, {stdin, env, cwd}) → child result (default: a valid ticket)
 * @param o.adlc     handler override; default: `ticket create` dry run and `spec-lint` both exit 0
 * @param o.schemaFail / o.specLintFail  make the default adlc fake fail the named gate
 */
export function makeTriageCtx({ issues = [], prs = [], claude = null, adlc = null, schemaFail = false, specLintFail = false, tree = DEFAULT_TREE, denyGlobs = DEFAULT_DENY, model = 'opus', secretValues = [], redactor = null, now = NOW } = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ap-triage-'));
  const paths = autopilotPaths(repoRoot);
  mkdirSync(paths.runsDir, { recursive: true });
  const gh = fakeGithub({ issues, prs });
  const claudeCalls = [];
  const defaultClaude = (args, io) => {
    // The prompt names the issue URL; answer for THAT issue (the body must begin "GitHub issue: <url>").
    const m = /^Issue URL: (\S+\/issues\/(\d+))$/m.exec(io.stdin ?? '');
    const n = m ? Number(m[2]) : (issues[0]?.number ?? 1);
    return { stdout: claudeResult(shapedTicket(n, m ? m[1] : `https://github.com/o/r/issues/${n}`)) };
  };
  const adlcCalls = [];
  const defaultAdlc = (args) => {
    if (args[0] === 'ticket' && args[1] === 'create') {
      if (schemaFail) return { status: 2, stderr: JSON.stringify({ ok: false, kind: 'invalid', code: 'INVALID_TICKET', message: 'scope: expected array of strings' }) };
      return { stdout: JSON.stringify({ operation: 'create', dryRun: true }) };
    }
    if (args[0] === 'spec-lint') {
      if (specLintFail) return { status: 2, stdout: JSON.stringify({ wishes: [{ line: 3, text: 'The widget renders nicely', status: 'WISH' }] }) };
      return { stdout: JSON.stringify({ criteria: 2, wishes: 0 }) };
    }
    return { status: 1, stderr: `unhandled adlc ${args.join(' ')}` };
  };
  const kills = [];
  const { spawnImpl, kill } = fakeSpawnImpl({
    [PINNED.claude]: (args, io) => { claudeCalls.push({ args, stdin: io.stdin, env: io.env, cwd: io.cwd }); return (claude ?? defaultClaude)(args, io); },
    [PINNED.adlc]: (args, io) => { adlcCalls.push({ args, stdin: io.stdin, env: io.env, cwd: io.cwd }); return (adlc ?? defaultAdlc)(args, io); },
    [PINNED.gh]: gh.handler,
  }, { kills });
  const recorder = [];
  const spawn = createSpawner({ recorder, spawnImpl, kill });
  const red = redactor ?? createRedactor({ secretValues });
  const records = createRecordStore({ paths, redactor: red });
  const lock = acquireLock(paths.adlc, { self: { pid: process.pid, pidStartTime: '1' }, probes: { pidAlive: () => true, pidStartTimeOf: () => '1' }, now: () => now });
  let clock = now;
  const ctx = {
    repoRoot, paths, spawn, recorder, pinned: PINNED, env: { base: { ...BASE_ENV }, path: BASE_ENV.PATH, home: BASE_ENV.HOME },
    key: 'orchestrator-manifest-key-0123456789abcdef', redactor: red, records, lock, baseOid: BASE_OID,
    local: { model }, now: () => clock, log: () => {}, dryRun: false,
    gh: createGh({ spawn, gh: PINNED.gh, host: 'github.com', repo: 'o/r', env: BASE_ENV, cwd: repoRoot, sleep: async () => {} }),
    git: { localOut: (cwd, args) => (args[0] === 'ls-tree' ? tree.join('\n') : ''), local: async () => ({ status: 0, stdout: '', stderr: '' }) },
    denylist: { globs: [...denyGlobs], matches: (p) => denyGlobs.some((g) => globMatch(g, p)) },
  };
  return {
    ctx, gh, recorder, kills, claudeCalls, adlcCalls, paths, repoRoot,
    setNow: (t) => { clock = t; },
    spawnsOf: (exe) => recorder.filter((r) => r.argv[0] === exe),
    cleanup: () => { try { lock.release(); } catch { /* released */ } rmSync(repoRoot, { recursive: true, force: true }); },
  };
}

/** An OWNER-authorized issue with a trusted block and (optionally) a criteria list. */
export function trustedIssue(n, { criteria = true, scope = ['packages/fleet/**'], category = 'feature', extraBody = '' } = {}) {
  const block = `<!-- adlc:begin v=1 -->\n\`\`\`json\n${JSON.stringify({ scope, rails: [], edges: [], duration: 2, category }, null, 2)}\n\`\`\`\n<!-- adlc:end -->`;
  const ac = criteria ? '\n\n## Acceptance criteria\n\n- The widget renders. VERIFY: node --test packages/fleet/test/widget.test.mjs exits 0\n- Docs mention it. VERIFY: grep -q widget docs/guide.md\n' : '';
  return { number: n, title: 'Add the widget', body: `Please add the widget.${extraBody}\n\n${block}${ac}`, url: `https://github.com/o/r/issues/${n}` };
}

export const AUTHORIZED = Object.freeze({ ok: true, rule: null, clause: 'author' });
export const NOT_AUTHORIZED = Object.freeze({ ok: false, rule: 'not-authorized', clause: null });

// AC3 pin (#242 / W5-T2): the Copilot and Codex hook adapters must NOT
// re-implement rail or risk-tier logic — they import ./generated-shell.mjs and
// ./generated-risk-tier.mjs (built from @adlc/core via
// scripts/generate-canonical-readers.mjs) rather than keeping hand-inlined
// copies. This test pins both the source-level wire-up and behavioral parity
// across @adlc/core, adlc-codex, and adlc-copilot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..', '..');
const CORE_SHELL = join(REPO_ROOT, 'packages', 'core', 'lib', 'shell.mjs');

const CLASSIFIERS = [
  // boolean classifiers — signature (text)
  'shellHasMutation',
  'hasUnquotedFileRedirect',
  'shellHasOpaqueMutation',
  'shellIsPositivelyReadOnly',
  'shellHasWriteOption',
  'shellChangesCwd',
  'shellHasExpansion',
  // path extraction — these decide which literal paths get matched against rails
  'shellTokens',
  'collectShellPaths',
  'collectPatchPaths',
  'looksPathLike',
  'looksBarePathLike',
  'keyValuePath',
];

const RISK_TIER_FNS = [
  'matchRiskTier',
  'classifyRiskTier',
  'decideAdversarialReviewNotice',
];

test('copilot and codex hooks import generated-shell.mjs and generated-risk-tier.mjs (no inline re-implementation)', () => {
  const core = readFileSync(CORE_SHELL, 'utf8');
  const extract = (src, fn) => {
    const m = src.match(new RegExp(`function ${fn}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(m, `${fn} found`);
    return m[0].replace(/\s+/g, ' ');
  };

  for (const plugin of ['adlc-copilot', 'adlc-codex']) {
    const hooksDir = join(REPO_ROOT, 'plugins', plugin, 'hooks');
    const hook = readFileSync(join(hooksDir, 'adlc-rails-guard.mjs'), 'utf8');
    const genShell = readFileSync(join(hooksDir, 'generated-shell.mjs'), 'utf8');
    const lifecycle = readFileSync(join(hooksDir, 'adlc-lifecycle.mjs'), 'utf8');

    assert.match(hook, /from ['"]\.\/generated-shell\.mjs['"]/, `${plugin}/adlc-rails-guard.mjs must import ./generated-shell.mjs`);
    for (const fn of CLASSIFIERS) {
      assert.doesNotMatch(
        hook,
        new RegExp(`function ${fn}\\s*\\(`),
        `${plugin}/adlc-rails-guard.mjs must not define inline function ${fn}`,
      );
      assert.equal(
        extract(genShell, fn),
        extract(core, fn),
        `${fn} drifted between ${plugin}/generated-shell.mjs and @adlc/core`,
      );
    }

    assert.match(lifecycle, /from ['"]\.\/generated-risk-tier\.mjs['"]/, `${plugin}/adlc-lifecycle.mjs must import ./generated-risk-tier.mjs`);
    assert.doesNotMatch(lifecycle, /const RISK_TIER_PATTERNS\s*=/, `${plugin}/adlc-lifecycle.mjs must not define inline RISK_TIER_PATTERNS`);
    for (const fn of RISK_TIER_FNS) {
      assert.doesNotMatch(
        lifecycle,
        new RegExp(`function ${fn}\\s*\\(`),
        `${plugin}/adlc-lifecycle.mjs must not define inline function ${fn}`,
      );
    }
  }
});

test('behavioral parity across @adlc/core, adlc-codex, and adlc-copilot for shell and risk-tier classifiers', async () => {
  const coreShell = await import('../../../packages/core/lib/shell.mjs');
  const codexRailsGuard = await import('../../adlc-codex/hooks/adlc-rails-guard.mjs');
  const codexGenShell = await import('../../adlc-codex/hooks/generated-shell.mjs');
  const copilotGenShell = await import('../hooks/generated-shell.mjs');

  const commands = [
    'git status',
    'echo x > test/frozen.test.mjs',
    'cat payload.txt>test/frozen.test.mjs',
    'git diff "--output=.adlc/handoffs/x"',
    "sed -n '10w test/frozen.test.mjs' /dev/null",
    'cd sub && echo x > f',
    'echo $HOME > f',
    'git checkout -- test/x.mjs',
  ];

  for (const mod of [codexRailsGuard, codexGenShell, copilotGenShell]) {
    for (const cmd of commands) {
      assert.deepEqual(mod.classifyShellCommand(cmd), coreShell.classifyShellCommand(cmd));
      for (const fn of [
        'shellHasMutation',
        'hasUnquotedFileRedirect',
        'shellHasOpaqueMutation',
        'shellIsPositivelyReadOnly',
        'shellHasWriteOption',
        'shellChangesCwd',
        'shellHasExpansion',
      ]) {
        assert.equal(mod[fn](cmd), coreShell[fn](cmd), `${fn}(${cmd})`);
      }
      assert.deepEqual(mod.shellTokens(cmd), coreShell.shellTokens(cmd));
      const p1 = new Set();
      const p2 = new Set();
      mod.collectShellPaths(cmd, p1);
      coreShell.collectShellPaths(cmd, p2);
      assert.deepEqual([...p1], [...p2]);
    }
    const patch = '*** Update File: src/a.mjs\n*** Add File: test/b.mjs\n';
    const pp1 = new Set();
    const pp2 = new Set();
    mod.collectPatchPaths(patch, pp1);
    coreShell.collectPatchPaths(patch, pp2);
    assert.deepEqual([...pp1], [...pp2]);
    for (const tok of ['src/a.mjs', 'Makefile', '--output=test/x.mjs', '-f']) {
      assert.equal(mod.looksPathLike(tok), coreShell.looksPathLike(tok));
      assert.equal(mod.looksBarePathLike(tok), coreShell.looksBarePathLike(tok));
      assert.equal(mod.keyValuePath(tok), coreShell.keyValuePath(tok));
    }
  }

  const coreRisk = await import('../../../packages/core/lib/risk-tier.mjs');
  const codexLifecycle = await import('../../adlc-codex/hooks/adlc-lifecycle.mjs');
  const copilotLifecycle = await import('../hooks/adlc-lifecycle.mjs');

  const paths = ['src/auth/login.js', '.env', 'src/security/guard.mjs', 'README.md', '.github/workflows/ci.yml'];
  for (const mod of [codexLifecycle, copilotLifecycle]) {
    assert.deepEqual(mod.RISK_TIER_PATTERNS, coreRisk.RISK_TIER_PATTERNS);
    for (const p of paths) {
      assert.deepEqual(mod.matchRiskTier(p), coreRisk.matchRiskTier(p));
    }
    assert.deepEqual(mod.classifyRiskTier(paths), coreRisk.classifyRiskTier(paths));
    const noticeInput = { changedPaths: paths, manifestEntries: [], ticketId: 'T1' };
    assert.deepEqual(mod.decideAdversarialReviewNotice(noticeInput), coreRisk.decideAdversarialReviewNotice(noticeInput));
  }
});

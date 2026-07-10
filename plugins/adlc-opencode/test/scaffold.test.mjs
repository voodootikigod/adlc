// scaffold.test.mjs — Phase A (T2) coverage: deterministic /adlc-init scaffolding
// and the gate-bin dependency mapping. Offline, temp-dir only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureConfig,
  deployDir,
  scaffold,
  ensurePluginRegistered,
  ensureGitignore,
  ensureFormatterIgnores,
} from '../lib/scaffold.mjs';
import {
  ensureGitignore as coreEnsureGitignore,
  ensureFormatterIgnores as coreEnsureFormatterIgnores,
} from '@adlc/core';
import { ALL_BINS, GATE_BINS, DISPATCHERS } from '../gate-bins.mjs';

const PKG = dirname(dirname(fileURLToPath(import.meta.url))); // plugins/adlc-opencode
const mkroot = () => mkdtempSync(join(tmpdir(), 'oc-t2-'));

// ---- ensureConfig ----
test('ensureConfig creates .adlc/config.json with defaults when absent', () => {
  const root = mkroot();
  try {
    const r = ensureConfig(root);
    assert.equal(r.created, true);
    const cfg = JSON.parse(readFileSync(r.path, 'utf8'));
    assert.equal(cfg.securityMode, 'unsigned-fallback');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ensureConfig never clobbers an existing config (idempotent)', () => {
  const root = mkroot();
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'config.json'), '{"securityMode":"signed","mine":true}\n');
    const r = ensureConfig(root);
    assert.equal(r.created, false);
    const cfg = JSON.parse(readFileSync(r.path, 'utf8'));
    assert.equal(cfg.mine, true); // untouched
    assert.equal(cfg.securityMode, 'signed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- ensurePluginRegistered (so the rails-guard hook actually loads) ----
test('ensurePluginRegistered: adds the plugin to .opencode/opencode.json', () => {
  const root = mkroot();
  try {
    const r = ensurePluginRegistered(root);
    assert.equal(r.registered, true);
    const cfg = JSON.parse(readFileSync(join(root, '.opencode', 'opencode.json'), 'utf8'));
    assert.ok(cfg.plugin.includes('@adlc/opencode-package'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ensurePluginRegistered: idempotent + preserves existing settings/plugins', () => {
  const root = mkroot();
  try {
    mkdirSync(join(root, '.opencode'), { recursive: true });
    writeFileSync(join(root, '.opencode', 'opencode.json'), JSON.stringify({ theme: 'x', plugin: ['other-plugin'] }));
    const r1 = ensurePluginRegistered(root);
    assert.equal(r1.registered, true);
    const r2 = ensurePluginRegistered(root);
    assert.equal(r2.alreadyPresent, true); // idempotent
    const cfg = JSON.parse(readFileSync(join(root, '.opencode', 'opencode.json'), 'utf8'));
    assert.equal(cfg.theme, 'x'); // preserved
    assert.deepEqual(cfg.plugin, ['other-plugin', '@adlc/opencode-package']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scaffold registers the plugin (rails-guard hook will load)', () => {
  const root = mkroot();
  try {
    const out = scaffold(root, PKG);
    assert.equal(out.plugin.registered, true);
    const cfg = JSON.parse(readFileSync(join(root, '.opencode', 'opencode.json'), 'utf8'));
    // T30 contract: from a source checkout the RESOLVED PATH is registered
    // (the npm name only when running out of node_modules — it must resolve).
    assert.ok(cfg.plugin.includes(PKG));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- deployDir / scaffold ----
test('scaffold deploys the real command files into .opencode/commands', () => {
  const root = mkroot();
  try {
    const out = scaffold(root, PKG);
    assert.ok(out.commands.includes('adlc-init.md'), 'adlc-init.md deployed');
    assert.ok(out.commands.includes('adlc-ticket.md'), 'adlc-ticket.md deployed');
    assert.ok(existsSync(join(root, '.opencode', 'commands', 'adlc-spec.md')));
    // Native Agent Skill shape: .opencode/skills/<name>/SKILL.md (plural dir)
    assert.ok(existsSync(join(root, '.opencode', 'skills', 'adlc', 'SKILL.md')));
    assert.ok(out.skills.includes('adlc/SKILL.md'));
    assert.equal(out.config.created, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scaffold migrates a PRISTINE legacy flat skill deployment (.opencode/skill/adlc.md)', () => {
  const root = mkroot();
  try {
    // Simulate a pre-native deployment: pristine legacy file + an unrelated file.
    const source = readFileSync(join(PKG, 'skill', 'adlc.md'), 'utf8');
    mkdirSync(join(root, '.opencode', 'skill'), { recursive: true });
    writeFileSync(join(root, '.opencode', 'skill', 'adlc.md'), source);
    writeFileSync(join(root, '.opencode', 'skill', 'users-own.md'), 'keep me');
    const out = scaffold(root, PKG);
    assert.ok(existsSync(join(root, '.opencode', 'skills', 'adlc', 'SKILL.md')));
    assert.ok(!existsSync(join(root, '.opencode', 'skill', 'adlc.md')), 'pristine legacy copy removed');
    assert.ok(existsSync(join(root, '.opencode', 'skill', 'users-own.md')), 'unrelated file untouched');
    assert.deepEqual(out.preservedLegacySkills, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scaffold PRESERVES a user-modified legacy skill file (no silent data loss)', () => {
  const root = mkroot();
  try {
    mkdirSync(join(root, '.opencode', 'skill'), { recursive: true });
    writeFileSync(join(root, '.opencode', 'skill', 'adlc.md'), 'team-customized content');
    const out = scaffold(root, PKG);
    assert.ok(existsSync(join(root, '.opencode', 'skills', 'adlc', 'SKILL.md')), 'native skill still deployed');
    assert.equal(readFileSync(join(root, '.opencode', 'skill', 'adlc.md'), 'utf8'), 'team-customized content');
    assert.deepEqual(out.preservedLegacySkills, ['.opencode/skill/adlc.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scaffold removes the legacy skill dir when migration leaves it empty', () => {
  const root = mkroot();
  try {
    const source = readFileSync(join(PKG, 'skill', 'adlc.md'), 'utf8');
    mkdirSync(join(root, '.opencode', 'skill'), { recursive: true });
    writeFileSync(join(root, '.opencode', 'skill', 'adlc.md'), source);
    scaffold(root, PKG);
    assert.ok(!existsSync(join(root, '.opencode', 'skill')), 'empty legacy dir removed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scaffold is idempotent (re-run overwrites from source, no throw)', () => {
  const root = mkroot();
  try {
    scaffold(root, PKG);
    const second = scaffold(root, PKG);
    assert.equal(second.config.created, false); // config preserved
    assert.ok(second.commands.length >= 5); // commands re-deployed from source
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deployDir on a missing source dir returns [] (no throw)', () => {
  const root = mkroot();
  try {
    assert.deepEqual(deployDir(PKG, root, 'does-not-exist'), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Issue #97: ensureGitignore/ensureFormatterIgnores used to be independently
// hand-duplicated here and in plugins/adlc-cursor, and drifted out of sync
// across #92's review rounds. Both are now re-exported from @adlc/core's
// shared implementation (see packages/core/test/scaffold-hygiene.test.mjs for
// the behavioral coverage) — assert reference equality so a future edit that
// reintroduces a local copy in only one plugin fails this test instead of
// silently drifting again.
test('scaffold.mjs delegates ensureGitignore/ensureFormatterIgnores to the shared @adlc/core implementation', () => {
  assert.strictEqual(ensureGitignore, coreEnsureGitignore);
  assert.strictEqual(ensureFormatterIgnores, coreEnsureFormatterIgnores);
});

test('scaffold() wires ensureGitignore in so /adlc-init tracks specs/ by default', () => {
  const root = mkroot();
  try {
    const out = scaffold(root, PKG);
    const body = readFileSync(join(root, '.gitignore'), 'utf8');
    assert.match(body, /^!\.adlc\/specs\/$/m);
    assert.equal(out.gitignore.changed, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- gate-bins dependency mapping ----
test('gate-bins declares the 19 gates + 2 dispatchers, no duplicates', () => {
  assert.equal(GATE_BINS.length, 19);
  assert.deepEqual(DISPATCHERS, ['adlc', 'adlc-runner']);
  assert.equal(ALL_BINS.length, 21);
  assert.equal(new Set(ALL_BINS).size, 21, 'no duplicate bins');
  for (const b of ['rails-guard', 'spec-lint', 'coldstart', 'merge-forecast', 'preflight']) {
    assert.ok(GATE_BINS.includes(b), `${b} present`);
  }
});

// ---- every shipped command file is a valid OpenCode command (frontmatter) ----
test('every command/*.md has a description frontmatter field', () => {
  const cmdDir = join(PKG, 'command');
  for (const f of readdirSync(cmdDir).filter((n) => n.endsWith('.md'))) {
    const body = readFileSync(join(cmdDir, f), 'utf8');
    assert.match(body, /^---\n[\s\S]*?description:\s*\S+[\s\S]*?\n---/, `${f} has description frontmatter`);
  }
});

// ---- T30: registration entry must be RESOLVABLE — npm name only when loaded from npm ----
test('T30: scaffold from a source checkout registers the resolved local path, not the unpublished npm name', () => {
  const root = mkroot();
  try {
    scaffold(root, PKG); // PKG is a source path (not under node_modules)
    const cfg = JSON.parse(readFileSync(join(root, '.opencode', 'opencode.json'), 'utf8'));
    assert.ok(cfg.plugin.includes(PKG), `registered source path, got: ${JSON.stringify(cfg.plugin)}`);
    assert.ok(!cfg.plugin.includes('@adlc/opencode-package'), 'npm name not registered from source');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T30: scaffold from node_modules registers the npm package name', () => {
  const root = mkroot();
  const fakeNm = mkroot();
  try {
    // simulate the package living in node_modules by copying the minimal shape
    const nmPkg = join(fakeNm, 'node_modules', '@adlc', 'opencode-package');
    mkdirSync(nmPkg, { recursive: true });
    for (const sub of ['command', 'agent', 'skill']) {
      mkdirSync(join(nmPkg, sub), { recursive: true });
      writeFileSync(join(nmPkg, sub, 'x.md'), 'stub');
    }
    scaffold(root, nmPkg);
    const cfg = JSON.parse(readFileSync(join(root, '.opencode', 'opencode.json'), 'utf8'));
    assert.ok(cfg.plugin.includes('@adlc/opencode-package'), `registered npm name, got: ${JSON.stringify(cfg.plugin)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeNm, { recursive: true, force: true });
  }
});

test('T30: no duplicate registration when the OTHER form (or a tuple) is already present', () => {
  const root = mkroot();
  try {
    // pre-register the npm name as a tuple with options
    mkdirSync(join(root, '.opencode'), { recursive: true });
    writeFileSync(join(root, '.opencode', 'opencode.json'),
      JSON.stringify({ plugin: [['@adlc/opencode-package', { advisoryHooks: true }]] }) + '\n');
    const r = scaffold(root, PKG); // source path — but npm-name tuple already covers the plugin
    const cfg = JSON.parse(readFileSync(join(root, '.opencode', 'opencode.json'), 'utf8'));
    assert.equal(cfg.plugin.length, 1, `no duplicate entry: ${JSON.stringify(cfg.plugin)}`);
    assert.equal(r.plugin.alreadyPresent, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- T30: skills dedup — opencode also discovers .claude/skills/** ----
test('T30: an existing .claude/skills/<name> defers deployment (no duplicate skill listing)', () => {
  const root = mkroot();
  try {
    mkdirSync(join(root, '.claude', 'skills', 'adlc'), { recursive: true });
    writeFileSync(join(root, '.claude', 'skills', 'adlc', 'SKILL.md'), '# claude-code copy\n');
    const r = scaffold(root, PKG);
    assert.ok(!existsSync(join(root, '.opencode', 'skills', 'adlc', 'SKILL.md')),
      'opencode copy not deployed when .claude copy exists');
    assert.ok(r.deferredToClaudeSkills.includes('adlc'), `reported: ${JSON.stringify(r.deferredToClaudeSkills)}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('T30: a PRISTINE pre-existing .opencode copy is removed when .claude covers the skill; a modified one is kept', () => {
  const root = mkroot();
  try {
    const source = readFileSync(join(PKG, 'skill', 'adlc.md'), 'utf8');
    mkdirSync(join(root, '.claude', 'skills', 'adlc'), { recursive: true });
    writeFileSync(join(root, '.claude', 'skills', 'adlc', 'SKILL.md'), '# claude-code copy\n');
    // pristine .opencode copy from a previous scaffold
    mkdirSync(join(root, '.opencode', 'skills', 'adlc'), { recursive: true });
    writeFileSync(join(root, '.opencode', 'skills', 'adlc', 'SKILL.md'), source);
    scaffold(root, PKG);
    assert.ok(!existsSync(join(root, '.opencode', 'skills', 'adlc', 'SKILL.md')), 'pristine duplicate removed');
    // user-modified copy is preserved
    mkdirSync(join(root, '.opencode', 'skills', 'adlc'), { recursive: true });
    writeFileSync(join(root, '.opencode', 'skills', 'adlc', 'SKILL.md'), source + '\nuser edit\n');
    scaffold(root, PKG);
    assert.ok(existsSync(join(root, '.opencode', 'skills', 'adlc', 'SKILL.md')), 'modified copy kept');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- T30 round-2: registration must never clobber, never double-register ----
test('R2: unparseable opencode.json → THROW and leave the file untouched (no clobber)', () => {
  const root = mkroot();
  try {
    mkdirSync(join(root, '.opencode'), { recursive: true });
    const broken = '{ "theme": "x", "plugin": ["other"], }'; // trailing comma
    writeFileSync(join(root, '.opencode', 'opencode.json'), broken);
    assert.throws(() => ensurePluginRegistered(root), /not valid JSON.*Refusing to overwrite/s);
    assert.equal(readFileSync(join(root, '.opencode', 'opencode.json'), 'utf8'), broken, 'file untouched');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('R2: stale path entry is REPLACED (not appended) when re-scaffolding under a new spelling', () => {
  const root = mkroot();
  try {
    mkdirSync(join(root, '.opencode'), { recursive: true });
    writeFileSync(join(root, '.opencode', 'opencode.json'),
      JSON.stringify({ theme: 'x', plugin: ['other-plugin', '/old/checkout/plugins/adlc-opencode'] }) + '\n');
    // moved checkout: path A → npm name
    const r = ensurePluginRegistered(root, '@adlc/opencode-package');
    assert.equal(r.registered, true);
    assert.deepEqual(r.replaced, ['/old/checkout/plugins/adlc-opencode']);
    const cfg = JSON.parse(readFileSync(join(root, '.opencode', 'opencode.json'), 'utf8'));
    assert.deepEqual(cfg.plugin, ['other-plugin', '@adlc/opencode-package'], 'single entry, other plugin preserved');
    assert.equal(cfg.theme, 'x');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('R2: path A → path B re-scaffold replaces; tuple OPTIONS ride onto the new entry', () => {
  const root = mkroot();
  try {
    mkdirSync(join(root, '.opencode'), { recursive: true });
    writeFileSync(join(root, '.opencode', 'opencode.json'),
      JSON.stringify({ plugin: [['/old/checkout/plugins/adlc-opencode', { advisoryHooks: true }]] }) + '\n');
    const r = ensurePluginRegistered(root, '/new/checkout/plugins/adlc-opencode');
    assert.equal(r.registered, true);
    const cfg = JSON.parse(readFileSync(join(root, '.opencode', 'opencode.json'), 'utf8'));
    assert.deepEqual(cfg.plugin, [['/new/checkout/plugins/adlc-opencode', { advisoryHooks: true }]],
      'replaced with options preserved');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('R2: canonical npm name already registered → a source scaffold does NOT displace it', () => {
  const root = mkroot();
  try {
    mkdirSync(join(root, '.opencode'), { recursive: true });
    writeFileSync(join(root, '.opencode', 'opencode.json'),
      JSON.stringify({ plugin: ['@adlc/opencode-package'] }) + '\n');
    const r = ensurePluginRegistered(root, '/some/checkout/plugins/adlc-opencode');
    assert.equal(r.alreadyPresent, true);
    const cfg = JSON.parse(readFileSync(join(root, '.opencode', 'opencode.json'), 'utf8'));
    assert.deepEqual(cfg.plugin, ['@adlc/opencode-package']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- T30 round-2: bin argv guards ----
test('R2: cliMain rejects flag-looking roots and extra positionals; init failure is a clean exit 1', async () => {
  const { cliMain } = await import('../bin/cli.mjs');
  const errors = [];
  const logs = [];
  const origErr = console.error; const origLog = console.log;
  console.error = (m) => errors.push(String(m)); console.log = (m) => logs.push(String(m));
  const root = mkroot();
  try {
    assert.equal(cliMain(['init', '--dry-run']), 1, 'flag-looking root rejected');
    assert.match(errors.at(-1), /unknown option "--dry-run"/);
    assert.equal(cliMain(['init', root, 'extra']), 1, 'extra positional rejected');
    assert.match(errors.at(-1), /unexpected argument/);
    // clean failure path: unparseable opencode.json → message, not a stack trace
    mkdirSync(join(root, '.opencode'), { recursive: true });
    writeFileSync(join(root, '.opencode', 'opencode.json'), '{ broken');
    assert.equal(cliMain(['init', root]), 1);
    assert.match(errors.at(-1), /init failed: .*not valid JSON/);
  } finally {
    console.error = origErr; console.log = origLog;
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- T30 round-3: the matcher must not claim strangers, must claim all our spellings ----
test('R3: third-party entries colliding on the adlc-opencode suffix are NEVER touched', () => {
  const root = mkroot();
  try {
    mkdirSync(join(root, '.opencode'), { recursive: true });
    const strangers = [
      'adlc-opencode',                                   // bare npm package of that name
      '@other/adlc-opencode',                            // different org, same suffix
      ['@evil/adlc-opencode', { thirdParty: true }],     // tuple — options must NOT graft onto ours
    ];
    writeFileSync(join(root, '.opencode', 'opencode.json'), JSON.stringify({ plugin: strangers }) + '\n');
    const r = ensurePluginRegistered(root, '@adlc/opencode-package');
    assert.equal(r.registered, true);
    assert.deepEqual(r.replaced, [], 'no stranger was claimed as ours');
    const cfg = JSON.parse(readFileSync(join(root, '.opencode', 'opencode.json'), 'utf8'));
    assert.deepEqual(cfg.plugin, [...strangers, '@adlc/opencode-package'],
      'strangers intact, ours appended WITHOUT grafted options');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('R3: our own path spellings with either package-dir basename ARE claimed (no double-register)', () => {
  const root = mkroot();
  try {
    mkdirSync(join(root, '.opencode'), { recursive: true });
    // a source checkout whose dir basename is the npm package dir name
    writeFileSync(join(root, '.opencode', 'opencode.json'),
      JSON.stringify({ plugin: ['/work/opencode-package'] }) + '\n');
    const r = ensurePluginRegistered(root, '@adlc/opencode-package');
    assert.deepEqual(r.replaced, ['/work/opencode-package'], 'opencode-package basename claimed');
    const cfg = JSON.parse(readFileSync(join(root, '.opencode', 'opencode.json'), 'utf8'));
    assert.deepEqual(cfg.plugin, ['@adlc/opencode-package'], 'single entry');
    // and an exact same-path re-scaffold stays idempotent
    const again = ensurePluginRegistered(root, '@adlc/opencode-package');
    assert.equal(again.alreadyPresent, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

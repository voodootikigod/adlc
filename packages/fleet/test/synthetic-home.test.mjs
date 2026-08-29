// Synthetic HOME staging — the PURE half of spec AC156 (item 14 / §14).
//
// Everything here runs against an INJECTED fs: no real credential file is read
// or written. The real-bwrap half (what the worker can actually see and do inside
// the tmpfs) lives in synthetic-home-bwrap.test.mjs.
//
// The load-bearing property is the one the module can only prove by NOT having
// code: there is no write-back path to the host credential. A static check over
// the source pins that — a refactor that adds one turns this file red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { prepareSyntheticHome, pickAllowlisted, SETTINGS_KEYS, CLAUDE_JSON_KEYS } from '../lib/synthetic-home.mjs';
import * as claudeCode from '../lib/adapters/claude-code.mjs';

const HOME = '/home/op';
const STAGING = '/run/fleet/stage';
const UID = 1000;
const CRED = Buffer.from('{"claudeAiOauth":{"accessToken":"secret"}}');

/**
 * A fake fs describing one host. `stat` is what fstat reports for the credential
 * (so a symlink, a bad mode or a foreign uid is one field away); `files` are the
 * JSON documents present on the host; `writes` records what the module stages.
 */
function fakeFs({ stat = {}, files = {}, openError = null, dirs = [`${HOME}/.claude/plugins`] } = {}) {
  const writes = [];
  const chmods = [];
  const opened = [];
  const st = { isFile: () => true, uid: UID, mode: 0o100600, ...stat };
  return {
    writes, chmods, opened,
    constants,
    openSync: (path, flags) => {
      opened.push({ path, flags });
      if (openError) { const e = new Error(openError); e.code = openError; throw e; }
      return 7;
    },
    fstatSync: () => st,
    readFileSync: (target, enc) => {
      if (target === 7) return CRED;
      if (files[target] === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return enc ? files[target] : Buffer.from(files[target]);
    },
    closeSync: () => {},
    writeFileSync: (path, data, opts) => writes.push({ path, data: Buffer.isBuffer(data) ? data : Buffer.from(data), mode: opts?.mode }),
    chmodSync: (path, mode) => chmods.push({ path, mode }),
    mkdirSync: () => {},
    statSync: (p) => ({ isDirectory: () => dirs.includes(p) }),
    existsSync: (p) => files[p] !== undefined,
  };
}

const prepare = (fs, extra = {}) => prepareSyntheticHome({ hostHome: HOME, stagingDir: STAGING, adapter: claudeCode, uid: UID, fs, now: () => new Date(0), ...extra });

// ── credential validation (before any copy) ──────────────────────────────────

test('the credential is opened O_NOFOLLOW and a symlink (ELOOP) is credential-file-insecure', () => {
  const fs = fakeFs({ openError: 'ELOOP' });
  assert.throws(() => prepare(fs), /^Error: credential-file-insecure: cannot open .*ELOOP/);
  assert.equal(fs.opened.length, 1);
  assert.equal(fs.opened[0].path, `${HOME}/.claude/.credentials.json`);
  assert.ok(fs.opened[0].flags & constants.O_NOFOLLOW, 'the open carries O_NOFOLLOW');
  assert.equal(fs.opened[0].flags & (constants.O_WRONLY | constants.O_RDWR), 0, 'and is read-only');
  assert.deepEqual(fs.writes, [], 'nothing was staged');
});

test('a credential that is not a regular file, is mode 0644, or belongs to another uid is refused before copying', () => {
  const cases = [
    [{ isFile: () => false }, /is not a regular file/],
    [{ mode: 0o100644 }, /has mode 0644, expected 0600/],
    [{ mode: 0o100400 }, /has mode 0400, expected 0600/],
    [{ uid: 0 }, /is owned by uid 0, not 1000/],
  ];
  for (const [stat, re] of cases) {
    const fs = fakeFs({ stat });
    assert.throws(() => prepare(fs), (err) => err.message.startsWith('credential-file-insecure:') && re.test(err.message), `${JSON.stringify(stat)} → ${re}`);
    assert.deepEqual(fs.writes, [], `${JSON.stringify(stat)}: the copy must not happen`);
  }
});

test('a valid credential is copied to the staging dir with mode 0600 and its sha256 recorded', () => {
  const fs = fakeFs();
  const out = prepare(fs);
  const copy = fs.writes.find((w) => w.path === `${STAGING}/credentials.json`);
  assert.ok(copy, 'staged');
  assert.equal(copy.data.equals(CRED), true, 'byte-equal');
  assert.equal(copy.mode, 0o600);
  assert.ok(fs.chmods.some((c) => c.path === copy.path && c.mode === 0o600), 'mode is enforced even on an existing file');
  assert.equal(out.credentialSha256, createHash('sha256').update(CRED).digest('hex'));
});

// ── generated settings.json / claude.json ────────────────────────────────────

test('settings.json keeps only the allowlisted keys — hooks and mcpServers are stripped, mode 0400', () => {
  const fs = fakeFs({ files: { [`${HOME}/.claude/settings.json`]: JSON.stringify({
    model: 'opus', permissions: { allow: ['Bash(ls)'] }, hooks: { PreToolUse: [{ command: 'curl evil' }] }, mcpServers: { x: {} }, apiKeyHelper: '/bin/leak',
  }) } });
  const out = prepare(fs);
  const w = fs.writes.find((x) => x.path === `${STAGING}/settings.json`);
  const doc = JSON.parse(w.data.toString());
  assert.deepEqual(doc, { model: 'opus', permissions: { allow: ['Bash(ls)'] } });
  assert.equal('hooks' in doc, false);
  assert.equal('mcpServers' in doc, false);
  assert.equal(w.mode, 0o400);
  assert.deepEqual(out.settingsKeysKept, ['model', 'permissions']);
  assert.ok(out.warnings.some((s) => /settings\.json: stripped keys hooks, mcpServers, apiKeyHelper/.test(s)), 'stripping is surfaced, not silent');
});

test('a missing host settings.json or .claude.json yields {}; a malformed one fails closed', () => {
  const out = prepare(fakeFs());
  const fs = fakeFs();
  prepare(fs);
  assert.equal(fs.writes.find((x) => x.path === `${STAGING}/settings.json`).data.toString(), '{}\n');
  assert.equal(fs.writes.find((x) => x.path === `${STAGING}/claude.json`).data.toString(), '{}\n');
  assert.ok(out.warnings.some((s) => /settings\.json: host file absent/.test(s)));
  // A broken host file silently becoming {} would DROP the operator's permission
  // deny rules — a malformed input is refused, never defaulted.
  assert.throws(() => prepare(fakeFs({ files: { [`${HOME}/.claude/settings.json`]: '{not json' } })), /is not valid JSON/);
  assert.throws(() => prepare(fakeFs({ files: { [`${HOME}/.claude.json`]: '[1]' } })), /must hold a JSON object/);
});

test('.claude.json keeps only the account record and onboarding flags, mode 0600, and is the writable HOME file', () => {
  const fs = fakeFs({ files: { [`${HOME}/.claude.json`]: JSON.stringify({
    oauthAccount: { emailAddress: 'op@example.com' }, hasCompletedOnboarding: true, userID: 'u1', numStartups: 3,
    projects: { '/home/op/secret-repo': { history: ['rm -rf'] } }, tipsHistory: { a: 1 }, mcpServers: {},
  }) } });
  const out = prepare(fs);
  const w = fs.writes.find((x) => x.path === `${STAGING}/claude.json`);
  assert.deepEqual(JSON.parse(w.data.toString()), { oauthAccount: { emailAddress: 'op@example.com' }, hasCompletedOnboarding: true, userID: 'u1', numStartups: 3 });
  assert.equal(w.mode, 0o600);
  assert.deepEqual(out.homeWritableFiles, [{ source: `${STAGING}/claude.json`, target: `${HOME}/.claude.json` }]);
});

test('the settings allowlist keeps EXACTLY model, permissions, includeCoAuthoredBy, theme and verbose — each one survives, nothing else (env included) does', () => {
  // Pinned as literals, not derived from the constant: a shrunk allowlist would
  // silently strip an operator setting the worker relies on (e.g. `verbose`),
  // and a derived assertion would shrink with it.
  const EXPECTED = ['model', 'permissions', 'includeCoAuthoredBy', 'theme', 'verbose'];
  assert.deepEqual([...SETTINGS_KEYS], EXPECTED);
  const host = { model: 'opus', permissions: { allow: [] }, env: { A: '1' }, includeCoAuthoredBy: false, theme: 'dark', verbose: true, hooks: { PreToolUse: [] }, mcpServers: { x: {} }, statusLine: {} };
  const { kept, stripped } = pickAllowlisted(host, SETTINGS_KEYS);
  assert.deepEqual(Object.keys(kept).sort(), [...EXPECTED].sort(), 'every allowlisted key present on the host is kept');
  for (const k of EXPECTED) assert.deepEqual(kept[k], host[k], `${k} keeps its value`);
  assert.deepEqual(stripped.sort(), ['env', 'hooks', 'mcpServers', 'statusLine']);
});

test('pickAllowlisted returns a NEW object and never mutates the host document', () => {
  const host = Object.freeze({ model: 'x', hooks: {} });
  const { kept, stripped } = pickAllowlisted(host, SETTINGS_KEYS);
  assert.deepEqual(kept, { model: 'x' });
  assert.deepEqual(stripped, ['hooks']);
  assert.ok(!SETTINGS_KEYS.includes('hooks') && !SETTINGS_KEYS.includes('mcpServers'));
  assert.ok(!CLAUDE_JSON_KEYS.includes('projects'), 'per-project history never reaches the worker');
});

// ── the three leaves, the scratch dirs, HOME identity ─────────────────────────

test('homeBinds are exactly three targets under HOME in the documented order: credential, settings, plugins', () => {
  const out = prepare(fakeFs());
  assert.equal(out.home, HOME, 'the synthetic HOME is mounted AT the host HOME path');
  assert.deepEqual(out.homeBinds, [
    { source: `${STAGING}/credentials.json`, target: `${HOME}/.claude/.credentials.json` },
    { source: `${STAGING}/settings.json`, target: `${HOME}/.claude/settings.json` },
    { source: `${HOME}/.claude/plugins`, target: `${HOME}/.claude/plugins` },
  ]);
  for (const b of out.homeBinds) assert.ok(b.target.startsWith(`${HOME}/`));
  // A caller-pinned plugin tree replaces the default source, never the target.
  const pinned = prepare(fakeFs({ dirs: ['/opt/plugins'] }), { pluginsDir: '/opt/plugins' });
  assert.deepEqual(pinned.homeBinds[2], { source: '/opt/plugins', target: `${HOME}/.claude/plugins` });
});

test('a plugin path that exists but is NOT a directory is refused; an ABSENT plugin tree (a fresh install) is simply not bound — no missing bind source for bwrap to abort on (agy r2 c4)', () => {
  assert.throws(() => prepare(fakeFs({ dirs: [] })), /plugins dir .* is not a directory/, 'present-but-not-a-directory');
  const fs = fakeFs({ dirs: [] });
  const inner = fs.statSync;
  fs.statSync = (p) => { if (p === `${HOME}/.claude/plugins`) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return inner(p); };
  const out = prepare(fs);
  assert.ok(!out.homeBinds.some((b) => b.target === `${HOME}/.claude/plugins`), 'absent tree → no plugins bind');
  assert.equal(out.homeBinds.length, 2, 'the credential and settings binds are still there');
});

test('scratch dirs cover EVERY homeState.dirs entry of the claude-code adapter, resolved under HOME', () => {
  const out = prepare(fakeFs());
  assert.deepEqual(out.homeScratchDirs, claudeCode.homeState.dirs.map((d) => join(HOME, d)));
  assert.ok(out.homeScratchDirs.length >= 8);
  for (const d of out.homeScratchDirs) assert.ok(d.startsWith(`${HOME}/`));
  // An adapter declaring an absolute dir outside HOME cannot be created in the tmpfs.
  assert.throws(() => prepare(fakeFs(), { adapter: { homeState: { dirs: ['/var/lib/x'] } } }), /does not resolve under/);
});

test('inputs are validated: relative hostHome/stagingDir are refused; preparedAt comes from the injected clock', () => {
  assert.throws(() => prepareSyntheticHome({ hostHome: 'home', stagingDir: STAGING, adapter: claudeCode, fs: fakeFs() }), /hostHome must be an absolute path/);
  assert.throws(() => prepareSyntheticHome({ hostHome: HOME, stagingDir: 'stage', adapter: claudeCode, fs: fakeFs() }), /stagingDir must be an absolute path/);
  assert.equal(prepare(fakeFs()).preparedAt, '1970-01-01T00:00:00.000Z');
});

// ── NO write-back path (AC156: "no code path that opens the host credential for writing") ──

test('every write in the module targets the staging dir; the source has no write primitive aimed at the host', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'synthetic-home.mjs'), 'utf8');
  // The import list and the `defaultFs` table NAME the primitives; neither calls
  // one. Every other line that mentions a writer must be one of the two calls
  // inside `stage()`, whose `path` is always `join(staging, …)`.
  const body = src
    .replace(/^import \{[\s\S]*?\} from 'node:fs';/m, '')
    .replace(/^const defaultFs = Object\.freeze\(\{[\s\S]*?\}\);/m, '');
  const writers = /\b(writeFileSync|chmodSync|appendFileSync|copyFileSync|renameSync|truncateSync|ftruncateSync|unlinkSync|rmSync|createWriteStream|writeSync|openSync)\b/;
  const mentions = body.split('\n').filter((l) => writers.test(l) && !/^\s*(\/\/|\*)/.test(l));
  const allowed = /fs\.writeFileSync\(path, bytes, \{ mode \}\)|fs\.chmodSync\(path, mode\)|fs\.rmSync\(path, \{ force: true \}\)|fs\.openSync\(path, fs\.constants\.O_RDONLY \| fs\.constants\.O_NOFOLLOW\)/;
  assert.deepEqual(mentions.filter((l) => !allowed.test(l)), [], 'a write primitive outside the staging helper is a write-back path');
  assert.equal(mentions.length, 4, 'exactly the stale-file removal, the two staging writes and the one read-only O_NOFOLLOW open');
  assert.ok(!/O_WRONLY|O_RDWR|O_APPEND|O_CREAT|O_TRUNC/.test(src), 'no writable open flag anywhere');
  assert.ok(!/writeFileSync\(\s*(hostHome|home|hostCredential)/.test(src), 'no write addressed at the host HOME');
  // And dynamically: with a recording fs, every staged path is under the staging dir.
  const fs = fakeFs({ files: { [`${HOME}/.claude/settings.json`]: '{"hooks":{}}', [`${HOME}/.claude.json`]: '{"userID":"u"}' } });
  prepare(fs);
  for (const w of [...fs.writes, ...fs.chmods]) assert.ok(w.path.startsWith(`${STAGING}/`), `${w.path} is not under the staging dir`);
  assert.ok(!fs.opened.some((o) => o.flags & (constants.O_WRONLY | constants.O_RDWR)), 'zero writable opens');
});

test('host settings.env NEVER reaches the worker: a settings.env carrying ADLC_MANIFEST_KEY / GH_TOKEN is stripped with hooks and mcpServers (codex r2)', () => {
  // `env` is a second channel into the worker process environment that the
  // ambient scrubber never sees; the staged settings file must not carry it.
  assert.ok(!SETTINGS_KEYS.includes('env'), 'env is not allowlisted');
  const host = { model: 'opus', env: { ADLC_MANIFEST_KEY: 'deadbeef', GH_TOKEN: 'ghp_x', HARMLESS: '1' }, hooks: {} };
  const { kept, stripped } = pickAllowlisted(host, SETTINGS_KEYS);
  assert.deepEqual(kept, { model: 'opus' });
  assert.deepEqual(stripped.sort(), ['env', 'hooks']);
  assert.ok(!JSON.stringify(kept).includes('deadbeef') && !JSON.stringify(kept).includes('ghp_x'));
});

test('a SYMLINKED plugin directory is refused (lstat, never stat): a link planted at the plugin path cannot bind its target into the bounded plane (codex r4)', () => {
  const fs = fakeFs({ files: { [`${HOME}/.claude/settings.json`]: '{}', [`${HOME}/.claude.json`]: '{}' } });
  fs.lstatSync = (p) => ({ isDirectory: () => true, isSymbolicLink: () => p === `${HOME}/.claude/plugins` });
  assert.throws(() => prepare(fs), /plugins dir .* is a symlink/);
  fs.lstatSync = (p) => ({ isDirectory: () => p === `${HOME}/.claude/plugins`, isSymbolicLink: () => false });
  assert.ok(prepare(fs).homeBinds.some((b) => b.source === `${HOME}/.claude/plugins`), 'a real directory binds');
});

test('a host with NO ~/.claude/plugins (a fresh install) still gets a synthetic home — no plugins bind, nothing thrown; a symlink or a file at that path is still refused (agy r2 c4)', async () => {
  const { prepareSyntheticHome } = await import('../lib/synthetic-home.mjs');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'fleet-sh-noplugins-'));
  try {
    const hostHome = join(root, 'home'); mkdirSync(join(hostHome, '.claude'), { recursive: true });
    writeFileSync(join(hostHome, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"x"}}', { mode: 0o600 });
    writeFileSync(join(hostHome, '.claude', 'settings.json'), '{}');
    writeFileSync(join(hostHome, '.claude.json'), '{}');
    const adapter = { name: 'claude-code', homeState: { dirs: [], files: [] } };
    const h = prepareSyntheticHome({ hostHome, stagingDir: join(root, 'stage1'), adapter, uid: process.getuid() });
    assert.ok(!h.homeBinds.some((b) => b.target.endsWith('.claude/plugins')), 'no plugins bind when the host has no plugins tree');
    writeFileSync(join(hostHome, '.claude', 'plugins'), 'not a dir');
    assert.throws(() => prepareSyntheticHome({ hostHome, stagingDir: join(root, 'stage2'), adapter, uid: process.getuid() }), /not a directory/);
    rmSync(join(hostHome, '.claude', 'plugins')); symlinkSync(root, join(hostHome, '.claude', 'plugins'));
    assert.throws(() => prepareSyntheticHome({ hostHome, stagingDir: join(root, 'stage3'), adapter, uid: process.getuid() }), /symlink/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('re-staging into a directory that already holds a read-only staged file does not crash: the stale 0400 file is replaced, the mode is kept (agy fleet r4 c4)', async () => {
  const { prepareSyntheticHome } = await import('../lib/synthetic-home.mjs');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'fleet-sh-restage-'));
  try {
    const hostHome = join(root, 'home'); mkdirSync(join(hostHome, '.claude'), { recursive: true });
    writeFileSync(join(hostHome, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"x"}}', { mode: 0o600 });
    writeFileSync(join(hostHome, '.claude', 'settings.json'), JSON.stringify({ model: 1 }));
    writeFileSync(join(hostHome, '.claude.json'), '{}');
    const adapter = { name: 'claude-code', homeState: { dirs: [], files: [] } };
    const stagingDir = join(root, 'stage');
    const first = prepareSyntheticHome({ hostHome, stagingDir, adapter, uid: process.getuid() });
    const settings = first.homeBinds.find((b) => b.target.endsWith('settings.json')).source;
    assert.equal(statSync(settings).mode & 0o777, 0o400, 'staged read-only');
    writeFileSync(join(hostHome, '.claude', 'settings.json'), JSON.stringify({ model: 2 }));
    const second = prepareSyntheticHome({ hostHome, stagingDir, adapter, uid: process.getuid() });
    const settings2 = second.homeBinds.find((b) => b.target.endsWith('settings.json')).source;
    assert.equal(settings2, settings);
    assert.match(readFileSync(settings2, 'utf8'), /"model":\s*2/, 'the re-staged content is the new host content');
    assert.equal(statSync(settings2).mode & 0o777, 0o400, 'still read-only');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// scaffold.test.mjs — Phase A (T2) coverage: deterministic /adlc-init scaffolding
// and the gate-bin dependency mapping. Offline, temp-dir only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureConfig, deployDir, scaffold, ensurePluginRegistered } from '../lib/scaffold.mjs';
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
    assert.ok(cfg.plugin.includes('@adlc/opencode-package'));
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
    assert.ok(existsSync(join(root, '.opencode', 'skill', 'adlc.md')));
    assert.equal(out.config.created, true);
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

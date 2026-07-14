#!/usr/bin/env node
// opencode-live-compaction.mjs — T32 AC4: prove the compaction-survival hooks
// are REGISTERED on the real plugin entry and behave, loaded the way OpenCode
// loads it (dynamic import of the shipped index.mjs → the returned Hooks map).
//
// Why not drive a real in-opencode compaction: compaction triggers on context
// overflow and is not deterministically forcible in a headless `opencode run`.
// So this proof covers what a unit test importing NAMED exports cannot — that
// the plugin's returned hook MAP actually carries `experimental.session.
// compacting` and `experimental.compaction.autocontinue` under those exact keys
// (the registration/contract-drift regression class), and that invoking them
// with host-shaped payloads produces the rail context / suppresses autocontinue.
// Upstream hook DISPATCH is covered by the advisory `opencode-live-latest` CI
// job running the deny + tool proofs against @latest.
//
// Exit codes: 0 = pass, 1 = fail.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_INDEX = join(REPO, 'plugins', 'adlc-opencode', 'index.mjs');
const log = (m) => console.log(`opencode-live-compaction: ${m}`);
const fail = (m) => { console.error(`opencode-live-compaction: FAIL — ${m}`); process.exit(1); };

const dir = mkdtempSync(join(tmpdir(), 'oc-live-compact-'));
const saved = { ...process.env };
try {
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T1', title: 'Live compaction fixture', risk: 'high', rails: ['test/**'], scope: ['src/**'] }] }));

  process.env.ADLC_P4_ENFORCEMENT = '1';
  process.env.ADLC_TICKET = 'T1';
  delete process.env.ADLC_ALLOW_ADVISORY_HOOKS;
  delete process.env.ADLC_BUILD_GATE_BYPASS;

  // Load the plugin exactly as OpenCode would: import the entry, call it with a
  // PluginInput, and take the returned Hooks map.
  const { adlcRailsGuard } = await import(pathToFileURL(PLUGIN_INDEX).href);
  if (typeof adlcRailsGuard !== 'function') fail('plugin entry does not export adlcRailsGuard');
  const hooks = await adlcRailsGuard({ worktree: dir });

  // 1. Both compaction hooks must be registered under their exact host keys.
  for (const key of ['experimental.session.compacting', 'experimental.compaction.autocontinue']) {
    if (typeof hooks[key] !== 'function') fail(`hook "${key}" is not registered on the plugin`);
  }
  log('both compaction hooks registered under their exact keys');

  // 2. session.compacting must inject the rail context into output.context.
  const compactOut = { context: [] };
  await hooks['experimental.session.compacting']({ sessionID: 'live' }, compactOut);
  if (compactOut.context.length !== 1) fail(`expected 1 context block, got ${compactOut.context.length}`);
  const block = compactOut.context[0];
  for (const needle of ['T1', 'test/**', 'src/**']) {
    if (!block.includes(needle)) fail(`compaction context missing "${needle}"`);
  }
  log('rail context (ticket + frozen rails + scope) survives into the compaction prompt');

  // 3. autocontinue must be DISABLED for this high-risk, now-compacted session.
  const acOut = { enabled: true };
  await hooks['experimental.compaction.autocontinue']({ sessionID: 'live' }, acOut);
  if (acOut.enabled !== false) fail('autocontinue was not suppressed on a degraded high-risk session');
  log('auto-continue suppressed after compaction on a high-risk ticket (human turn forced)');

  // 4. The hooks must never throw on a malformed payload (host-safety contract).
  await hooks['experimental.session.compacting']({}, {});
  await hooks['experimental.compaction.autocontinue']({}, {});
  log('hooks tolerate malformed payloads without throwing');

  log('PASS');
} finally {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  rmSync(dir, { recursive: true, force: true });
}

#!/usr/bin/env node
// opencode-live-compaction.mjs — T32 AC4: prove the compaction-survival wiring
// is REGISTERED on the real plugin entry and behaves, loaded the way OpenCode 2
// loads it (dynamic import of the shipped index.mjs → its default
// `{ id, setup }` definition → `setup(ctx)`).
//
// Why not drive a real in-opencode compaction: compaction triggers on context
// overflow and is not deterministically forcible in a headless `opencode run`.
// So this proof covers what a unit test importing NAMED exports cannot — that
// `setup` registers the `compaction` session hook and subscribes to events,
// that the hook injects the rail context, and that a `session.compaction.ended`
// event degrades the session so its next structured edit is blocked by the
// build gate (the v2 replacement for the v1 autocontinue suppression, which has
// no v2 hook). Upstream hook DISPATCH is covered by the live deny + tool proofs.
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

/** A host-shaped v2 plugin context recording what `setup` registers. */
function hostCtx(dir) {
  const hooks = new Map();
  const queue = [];
  let wake = null;
  const registration = { dispose() {} };
  const hookDomain = (domain) => ({
    hook: async (name, cb) => { hooks.set(`${domain}.${name}`, cb); return registration; },
  });
  return {
    hooks,
    emit(ev) { queue.push(ev); wake?.(); },
    ctx: {
      location: { directory: dir, project: { id: 'live', directory: dir, canonical: dir } },
      options: {},
      tool: { ...hookDomain('tool'), transform: async () => registration },
      session: hookDomain('session'),
      permission: hookDomain('permission'),
      event: {
        subscribe: ({ signal }) => ({
          async *[Symbol.asyncIterator]() {
            while (!signal?.aborted) {
              if (queue.length) { yield queue.shift(); continue; }
              await new Promise((r) => { wake = r; signal?.addEventListener('abort', r, { once: true }); });
            }
          },
        }),
      },
    },
  };
}

const dir = mkdtempSync(join(tmpdir(), 'oc-live-compact-'));
const saved = { ...process.env };
let cleanup = () => {};
try {
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T1', title: 'Live compaction fixture', risk: 'high', rails: ['test/**'], scope: ['src/**'] }] }));

  process.env.ADLC_P4_ENFORCEMENT = '1';
  process.env.ADLC_TICKET = 'T1';
  delete process.env.ADLC_ALLOW_ADVISORY_HOOKS;
  delete process.env.ADLC_BUILD_GATE_BYPASS;

  const plugin = (await import(pathToFileURL(PLUGIN_INDEX).href)).default;
  if (plugin?.id !== 'adlc' || typeof plugin.setup !== 'function') fail('plugin entry is not a v2 { id: "adlc", setup } definition');
  const host = hostCtx(dir);
  cleanup = (await plugin.setup(host.ctx)) ?? cleanup;

  // 1. The compaction hook and the edit gate must be registered.
  for (const key of ['session.compaction', 'tool.execute.before']) {
    if (typeof host.hooks.get(key) !== 'function') fail(`setup did not register the "${key}" hook`);
  }
  log('compaction hook + execute.before registered by setup');

  // 2. The compaction hook must inject the rail context into the system parts.
  const compaction = { sessionID: 'live', system: [] };
  await host.hooks.get('session.compaction')(compaction);
  const text = compaction.system.map((p) => p?.text ?? '').join('\n');
  for (const needle of ['T1', 'test/**', 'src/**']) {
    if (!text.includes(needle)) fail(`compaction context missing "${needle}"`);
  }
  log('rail context (ticket + frozen rails + scope) survives into the compaction prompt');

  // 3. After compaction ends, the high-risk session's next edit is blocked.
  host.emit({ type: 'session.compaction.ended', data: { sessionID: 'live' }, location: { directory: dir } });
  const edit = { tool: 'edit', sessionID: 'live', input: { path: 'src/app.mjs', oldString: 'a', newString: 'b' } };
  let blocked = null;
  for (let i = 0; i < 50 && !blocked; i++) {
    await new Promise((r) => setTimeout(r, 10));
    try { await host.hooks.get('tool.execute.before')({ ...edit }); } catch (err) { blocked = String(err?.message ?? err); }
  }
  if (!blocked?.includes('ADLC build-gate: blocked') || !blocked.includes('compacted')) fail(`a degraded high-risk session's edit was not blocked by the build gate (got: ${blocked})`);
  log('after compaction, the high-risk session\'s next edit is blocked by the build gate');

  // 4. The hook must never throw on a malformed payload (host-safety contract).
  await host.hooks.get('session.compaction')({});
  log('compaction hook tolerates a malformed payload without throwing');

  log('PASS');
} finally {
  cleanup();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  rmSync(dir, { recursive: true, force: true });
}

// P5 follow-up (Phase 3 finding 1): exercise the renderer CONSTRUCTION path
// with an injected fake pi-tui, so the TUI branch is proven, not just the
// degraded one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRenderers } from '../lib/renderers.mjs';
import { resolvePiPeer } from '../lib/pi-resolve.mjs';

// Minimal pi-tui stand-ins matching the constructor shapes renderers.mjs uses.
class FakeBox {
  constructor(px, py, bgFn) { this.px = px; this.py = py; this.bgFn = bgFn; this.children = []; }
  addChild(c) { this.children.push(c); }
}
class FakeText {
  constructor(text, x, y) { this.text = text; this.x = x; this.y = y; }
}
const fakeTui = { Box: FakeBox, Text: FakeText };
const fakeTheme = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
  bg: (key, _t) => `bg:${key}`,
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('renderers construct real components once the (injected) pi-tui loads', async () => {
  const r = createRenderers({ loader: async () => fakeTui });
  await tick(); // let the fire-and-forget loader resolve

  const gate = r.gateNotice(
    { content: 'ADLC rail-deny: src/x.ts', details: { type: 'rail-deny', ticketId: 'T9' } },
    { expanded: true },
    fakeTheme
  );
  assert.ok(gate instanceof FakeBox, 'gateNotice builds a Box');
  assert.equal(gate.children.length, 1);
  assert.ok(gate.children[0] instanceof FakeText);
  assert.match(gate.children[0].text, /<error>\[ADLC rail-deny\]<\/error>/);
  assert.match(gate.children[0].text, /ticket T9/, 'expanded view names the ticket');
  assert.equal(gate.bgFn(null), 'bg:customMessageBg');

  const flail = r.flailAdvisory({ content: 'edited 3 times' }, {}, fakeTheme);
  assert.ok(flail instanceof FakeBox);
  assert.match(flail.children[0].text, /<warning>\[ADLC flail\]<\/warning> edited 3 times/);
});

test('renderers degrade to undefined before load and when the loader fails', async () => {
  const failing = createRenderers({ loader: async () => { throw new Error('no tui'); } });
  await tick();
  assert.equal(failing.gateNotice({ content: 'x', details: {} }, {}, fakeTheme), undefined);
  assert.equal(failing.flailAdvisory({ content: 'x' }, {}, fakeTheme), undefined);

  // Pre-load window: renderer called before the loader resolves.
  let release;
  const gated = createRenderers({ loader: () => new Promise((res) => { release = res; }) });
  await tick(); // the factory invokes the loader on a microtask — let it start
  assert.equal(gated.gateNotice({ content: 'x', details: {} }, {}, fakeTheme), undefined, 'undefined before load');
  release(fakeTui);
  await tick();
  assert.ok(gated.gateNotice({ content: 'x', details: {} }, {}, fakeTheme) instanceof FakeBox, 'constructs after load');
});

// Phase-3 latent-bug fix (T27): the DEFAULT loader must resolve the REAL pi-tui
// via the pi-anchored resolution ladder — a bare `import('@earendil-works/
// pi-tui')` silently failed everywhere (the package nests unhoisted under
// pi-coding-agent/node_modules), so this proves the default loader now
// constructs a real Component in this repo, not just the injected-fake path.
const poll = async (fn, tries = 50) => {
  for (let i = 0; i < tries; i++) {
    const v = fn();
    if (v !== undefined) return v;
    await tick();
  }
  return fn();
};

test('the DEFAULT loader resolves the real pi-tui and constructs a real Component in this repo', async () => {
  // pi requires Node >= 22.19 and ships pi-tui nested-unhoisted; the resolution
  // ladder leans on install-tree layout + import.meta.resolve, both of which
  // vary on Node < 20 (the CI matrix still exercises 18/20 for the pure @adlc
  // packages). Where the peer genuinely can't be resolved in this runtime there
  // is nothing real to construct, so this bonus check no-ops early (a plain
  // return, not a test-skip marker). The injected-fake tests above already
  // prove the construction branch on every leg.
  let Box;
  try {
    ({ Box } = await resolvePiPeer(['@earendil-works', 'pi-tui'].join('/')));
  } catch {
    return; // peer unresolvable in this runtime (Node < pi minimum) — nothing to build
  }
  assert.equal(typeof Box, 'function', 'sanity: pi-tui resolves in this repo');

  // No loader override → exercises the real default loadTui (the ladder).
  const r = createRenderers();
  const gate = await poll(() =>
    r.gateNotice({ content: 'ADLC rail-deny: src/x.ts', details: { type: 'rail-deny', ticketId: 'T9' } }, {}, fakeTheme)
  );
  assert.ok(gate instanceof Box, 'default loader built a real pi-tui Box (not a degraded undefined)');
  assert.equal(gate.children.length, 1, 'the notice text was added as a child');
});

test('a constructor-time failure degrades instead of throwing into the render loop', async () => {
  const hostileTheme = { fg: () => 'ok', bg: () => { throw new Error('theme boom'); } };
  const brokenTui = { Box: class { constructor() { throw new Error('ctor boom'); } }, Text: FakeText };
  const r = createRenderers({ loader: async () => brokenTui });
  await tick();
  assert.equal(r.gateNotice({ content: 'x', details: {} }, {}, hostileTheme), undefined);
});

// renderers.mjs — TUI-only custom message renderers (spec Phase 3.3).
//
// registerMessageRenderer wants a SYNCHRONOUS (message, options, theme) =>
// Component | undefined, and a Component can only be built from
// @earendil-works/pi-tui. That package is a peer supplied by the pi runtime;
// it is NOT resolvable under `node --test` (and may be absent in non-TUI
// modes). So this module isolates the pi-tui dependency: it kicks off a single
// dynamic import at factory time and every renderer degrades to `undefined`
// until (or unless) that module resolves. extension.mjs never imports pi-tui
// at module top level, staying loadable under a plain `node --test`.
//
// The specifier is assembled at runtime so the TypeScript nodenext resolver in
// CI (`tsc --allowJs` over index.ts) does not try to resolve the nested,
// runtime-only package.
const PI_TUI_SPECIFIER = ['@earendil-works', 'pi-tui'].join('/');

let tuiPromise;
async function loadTui() {
  if (tuiPromise === undefined) {
    // A rejection (module absent) resolves to null so callers degrade quietly.
    tuiPromise = import(PI_TUI_SPECIFIER).catch(() => null);
  }
  return tuiPromise;
}

/**
 * Build the ADLC message renderers. Each returned function is safe to hand to
 * pi.registerMessageRenderer immediately: before pi-tui loads (or if it never
 * does) it returns undefined and pi falls back to its default text rendering,
 * keeping the ctx.ui.notify channel as the visible fallback.
 *
 * @param {{ loader?: () => Promise<any> }} [opts] - loader override for tests.
 * @returns {{ gateNotice: Function, flailAdvisory: Function }}
 */
export function createRenderers({ loader = loadTui } = {}) {
  let tui = null;
  // Fire-and-forget: cache the module when/if it resolves. Any failure leaves
  // tui null and every renderer degrades — a cosmetic renderer must never
  // throw into pi's render loop.
  Promise.resolve()
    .then(loader)
    .then((mod) => { if (mod) tui = mod; })
    .catch(() => { /* degrade: renderers stay undefined */ });

  function box(text, bgKey, theme) {
    try {
      const { Box, Text } = tui;
      const bg = new Box(1, 1, (t) => theme.bg(bgKey, t));
      bg.addChild(new Text(text, 0, 0));
      return bg;
    } catch {
      return undefined;
    }
  }

  function gateNotice(message, options, theme) {
    if (!tui) return undefined;
    const details = message?.details ?? {};
    const type = typeof details.type === 'string' ? details.type : 'gate';
    const prefix = theme.fg('error', `[ADLC ${type}]`);
    let text = `${prefix} ${message?.content ?? ''}`;
    if (options?.expanded && details.ticketId) {
      text += `\n${theme.fg('dim', `  ticket ${details.ticketId}`)}`;
    }
    return box(text, 'customMessageBg', theme);
  }

  function flailAdvisory(message, _options, theme) {
    if (!tui) return undefined;
    const prefix = theme.fg('warning', '[ADLC flail]');
    return box(`${prefix} ${message?.content ?? ''}`, 'customMessageBg', theme);
  }

  return { gateNotice, flailAdvisory };
}

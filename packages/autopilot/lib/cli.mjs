// Subcommand dispatch (spec §13.0). The bin parses argv; this module turns a
// subcommand + flags into `{ exitCode, document, text }` so every subcommand is
// unit-testable without process.exit. Heavy lifting lives in lib/loop.mjs.

import { runOnce, runLoop, statusCommand, selectCommand, quotaCommand, triageCommand, resetCommand, initCommand } from './loop.mjs';

const HANDLERS = { loop: runLoop, once: runOnce, status: statusCommand, select: selectCommand, quota: quotaCommand, triage: triageCommand, reset: resetCommand, init: initCommand };

/**
 * @returns {Promise<{ exitCode: number, document?: object, text?: string }>}
 */
export async function dispatch(sub, flags, { env, cwd, deps = {} } = {}) {
  const handler = HANDLERS[sub];
  if (!handler) return { exitCode: 1, text: `unknown subcommand: ${sub}` };
  try {
    return await handler({ flags, env, cwd, deps });
  } catch (e) {
    // Every library error carries `code` and `exitCode` (1 operational / 2 gate);
    // anything else is an operational error. The message is redacted upstream
    // before it reaches a log or a document by the modules that produce it.
    const exitCode = Number.isInteger(e?.exitCode) ? e.exitCode : 1;
    const code = e?.code ?? 'error';
    return { exitCode, document: { ok: false, code, message: String(e?.message ?? e) }, text: `adlc-autopilot: ${code}: ${e?.message ?? e}` };
  }
}

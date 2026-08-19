// WorkerAdapter: Google Antigravity CLI wrapper delegation.
import { dispatch as geminiDispatch } from './gemini.mjs';

export const name = 'agy';
export const pool = 'default';

/**
 * 7.3 model-plane filesystem policy (#395). This adapter delegates dispatch to
 * gemini's but runs the Antigravity CLI, which keeps its own state, so it declares
 * both rather than inheriting one.
 */
export const homeState = Object.freeze({
  dirs: Object.freeze(['.antigravity', '.gemini/tmp', '.gemini/sessions', '.cache/gemini']),
  files: Object.freeze(['.gemini/oauth_creds.json', '.gemini/google_accounts.json']),
});
export const aliases = Object.freeze(['default']);
export const forcesModel = true;
export const attestsResolvedModel = false;

/**
 * §4b transport classes this harness can serve (issue #396).
 * Session-based; no metered path is verified here, so none is declared.
 */
export const transports = Object.freeze({
  subscription: Object.freeze({}),
});

export function dispatch(opts) {
  return geminiDispatch({ command: 'agy', ...opts });
}

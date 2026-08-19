// WorkerAdapter: Google JetSki CLI wrapper delegation.
import { dispatch as geminiDispatch } from './gemini.mjs';

export const name = 'jetski';
export const pool = 'default';

/**
 * 7.3 model-plane filesystem policy (#395). Delegates dispatch to gemini's but
 * runs the JetSki CLI, which keeps its own state, so it declares both.
 */
export const homeState = Object.freeze({
  dirs: Object.freeze(['.jetski', '.gemini/tmp', '.gemini/sessions', '.cache/gemini']),
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
  return geminiDispatch({ command: 'jetski', ...opts });
}

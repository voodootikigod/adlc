// WorkerAdapter: Google JetSki CLI wrapper delegation.
import { dispatch as geminiDispatch } from './gemini.mjs';

export const name = 'jetski';
export const pool = 'default';
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

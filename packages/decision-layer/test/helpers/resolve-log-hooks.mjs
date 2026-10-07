// Module-resolution hooks for the isolation test: every URL resolved inside
// packages/decision-layer is appended to the file named by DECISION_RESOLVE_LOG.
import { appendFileSync } from 'node:fs';

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.url.includes('/packages/decision-layer/') && process.env.DECISION_RESOLVE_LOG) {
    appendFileSync(process.env.DECISION_RESOLVE_LOG, `${result.url}\n`);
  }
  return result;
}

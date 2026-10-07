// Module-resolution hooks for the end-to-end request test: the CLI's import of
// lib/mock-provider.mjs resolves to recording-mock-provider.mjs, which wraps the
// real mock and appends every request it receives to DECISION_REQUEST_LOG.
// Production code is unchanged; only module resolution in the test process is.
const RECORDER = new URL('./recording-mock-provider.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.url.endsWith('/packages/decision-layer/lib/mock-provider.mjs')) return { url: RECORDER, shortCircuit: true };
  return result;
}

// Pure, zero-dependency model-id -> vendor-family inference.
// Used to resolve multi-family router providers (e.g. agy:<model>) to their
// underlying vendor family ('anthropic' | 'google' | 'openai') without growing
// llm.mjs or duplicating heuristics across packages.

/**
 * Infer the canonical vendor provider family from a model identifier.
 * Normalizes via NFKC, strips all whitespace, and lowercases before matching.
 *
 * @param {unknown} modelId
 * @returns {'anthropic' | 'google' | 'openai' | ''}
 */
export function inferModelProviderFamily(modelId) {
  if (typeof modelId !== 'string') return '';
  const folded = modelId.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  if (/^(?:claude|anthropic)/.test(folded)) return 'anthropic';
  if (/^(?:gemini|gemma)/.test(folded)) return 'google';
  if (/^(?:gpt|o1|o3|o4|codex)/.test(folded)) return 'openai';
  return '';
}

/**
 * Prior success rate computation from the manifest ledger.
 *
 * We read entries where entry.type === 'build' and that carry { model, category, firstPass }.
 * For each (model, category?) we compute a Laplace-smoothed success rate:
 *   rate = (passes + 1) / (n + 2)
 *
 * Per-category rates are only returned when a (model, category) bucket has >= 3 samples.
 * The global (per-model) rate is always available.
 */

const TIERS = ['cheap', 'mid', 'frontier'];

/**
 * Build a prior success map from manifest entries.
 * @param {Array} entries - All manifest ledger entries
 * @returns {{
 *   global: { [model]: { passes, n, rate } },
 *   byCategory: { [category]: { [model]: { passes, n, rate } } }
 * }}
 */
export function buildPriors(entries) {
  // Count passes globally and per-category per-model
  const global = {};    // { model: { passes, n } }
  const byCat = {};     // { category: { model: { passes, n } } }

  for (const entry of entries) {
    if (entry.type !== 'build') continue;
    const { model, category, firstPass } = entry;
    if (typeof model !== 'string') continue;
    if (typeof firstPass !== 'boolean') continue;

    // Global bucket
    if (!global[model]) global[model] = { passes: 0, n: 0 };
    global[model].n += 1;
    if (firstPass) global[model].passes += 1;

    // Category bucket (only if category is a string)
    if (typeof category === 'string') {
      if (!byCat[category]) byCat[category] = {};
      if (!byCat[category][model]) byCat[category][model] = { passes: 0, n: 0 };
      byCat[category][model].n += 1;
      if (firstPass) byCat[category][model].passes += 1;
    }
  }

  // Compute Laplace-smoothed rates
  const globalRates = {};
  for (const [model, bucket] of Object.entries(global)) {
    globalRates[model] = {
      passes: bucket.passes,
      n: bucket.n,
      rate: (bucket.passes + 1) / (bucket.n + 2),
    };
  }

  const catRates = {};
  for (const [cat, models] of Object.entries(byCat)) {
    catRates[cat] = {};
    for (const [model, bucket] of Object.entries(models)) {
      if (bucket.n >= 3) {
        catRates[cat][model] = {
          passes: bucket.passes,
          n: bucket.n,
          rate: (bucket.passes + 1) / (bucket.n + 2),
        };
      }
    }
  }

  return { global: globalRates, byCategory: catRates };
}

/**
 * Given priors and an optional category, find the best tier (highest rate)
 * among tiers with >= 3 samples. Falls back to 'mid' if no tier qualifies.
 *
 * Tier → typical model mapping (for lookup purposes, we treat tier names
 * directly as "models" in the prior data — callers should store model names
 * that correspond to tier identifiers, or callers can just check by tier name).
 *
 * In the AIDLC context, the manifest stores the model *name*, not the tier.
 * So we look for any model in the prior data and pick the best-performing one,
 * then map it back to a tier via the TIERS list.
 *
 * We treat the model value as the tier identifier when it exactly matches
 * 'cheap', 'mid', or 'frontier'. Otherwise we cannot map it to a tier.
 *
 * @param {{ global, byCategory }} priors
 * @param {string} [category]
 * @returns {'cheap'|'mid'|'frontier'}
 */
export function bestTierFromPriors(priors, category) {
  // Try per-category rates first if category provided and has data
  if (category && priors.byCategory[category]) {
    const catData = priors.byCategory[category];
    const best = pickBestTier(catData);
    if (best) return best;
  }

  // Fall back to global rates
  const best = pickBestTier(priors.global);
  if (best) return best;

  return 'mid';
}

/**
 * From a { [model]: { passes, n, rate } } map, pick the tier-name with
 * the highest rate, only considering tiers that appear in the TIERS list.
 */
function pickBestTier(modelMap) {
  let bestTier = null;
  let bestRate = -1;
  for (const tier of TIERS) {
    if (modelMap[tier] && modelMap[tier].n >= 3 && modelMap[tier].rate > bestRate) {
      bestRate = modelMap[tier].rate;
      bestTier = tier;
    }
  }
  return bestTier;
}

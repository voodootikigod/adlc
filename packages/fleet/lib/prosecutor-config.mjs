// Trust boundaries for fleet host binaries and prosecutor configuration.
//
// Host executable paths (`adlcBin`, `reviewBin`) are strictly operator-local CLI flags
// (`--adlc-bin`, `--review-bin`): a repo-committed `.adlc/config.json` must never redirect
// gate or prosecution execution to a candidate-chosen binary.
//
// Prosecution knobs (`prosecuteFailOn`, `reviewProvider`) follow the narrowing / cross-family
// trust rules:
//   - Repo config may tighten `prosecuteFailOn` (`low` or `medium`) but never weaken it
//     (`high` or `critical` clamp to `medium`); operator CLI `--prosecute-fail-on` may set any
//     valid severity.
//   - `reviewProvider` must match a strict identifier grammar (blocking leading-dash flag
//     injection) and a repo-committed `reviewProvider` cannot force same-family self-review
//     against the resolved builder harness/model.

export const PROSECUTE_SEVERITIES = Object.freeze(['low', 'medium', 'high', 'critical']);
const REPO_ALLOWED_FAIL_ON = new Set(['low', 'medium']);

/** Strict provider token: alphanumeric start, up to 64 safe identifier chars; never a `-flag`. */
export const REVIEW_PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isNonEmptySafeString(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0');
}

/** Infer the canonical model family (`anthropic` | `openai` | `google` | null) of a provider name. */
export function inferProviderFamily(provider) {
  if (typeof provider !== 'string' || provider.length === 0) return null;
  const p = provider.trim().toLowerCase();
  if (
    p === 'claude' ||
    p === 'claude-code' ||
    p === 'anthropic' ||
    p.startsWith('claude-') ||
    p.startsWith('anthropic.') ||
    p.startsWith('anthropic_') ||
    p.startsWith('anthropic/') ||
    p.startsWith('anthropic:')
  ) {
    return 'anthropic';
  }
  if (
    p === 'codex' ||
    p === 'openai' ||
    p === 'chatgpt' ||
    p === 'o1' ||
    p === 'o3' ||
    p === 'o4' ||
    p.startsWith('gpt-') ||
    p.startsWith('chatgpt-') ||
    p.startsWith('o1-') ||
    p.startsWith('o3-') ||
    p.startsWith('o4-') ||
    p.startsWith('openai.') ||
    p.startsWith('openai_') ||
    p.startsWith('openai/') ||
    p.startsWith('openai:') ||
    p.startsWith('codex-') ||
    p.startsWith('codex_')
  ) {
    return 'openai';
  }
  if (
    p === 'gemini' ||
    p === 'google' ||
    p === 'vertex' ||
    p === 'vertexai' ||
    p === 'agy' ||
    p === 'jetski' ||
    p.startsWith('gemini-') ||
    p.startsWith('google.') ||
    p.startsWith('google_') ||
    p.startsWith('google/') ||
    p.startsWith('google:')
  ) {
    return 'google';
  }
  return null;
}

/** Infer the canonical model family (`anthropic` | `openai` | `google` | null) of a builder. */
export function inferBuilderFamily({ adapter, model, provider } = {}) {
  if (typeof model === 'string' && model.length > 0) {
    const m = model.trim().toLowerCase();
    if (m === 'opus' || m === 'sonnet' || m === 'haiku' || m.includes('claude') || m.includes('anthropic')) {
      return 'anthropic';
    }
    if (
      m.includes('gpt-') ||
      m.includes('chatgpt') ||
      m.includes('codex') ||
      m.includes('openai') ||
      /(?:^|[/:._-])o[134](?:$|[/:._-])/.test(m)
    ) {
      return 'openai';
    }
    if (m.includes('gemini') || m.includes('google')) {
      return 'google';
    }
  }
  const fromProvider = inferProviderFamily(provider);
  if (fromProvider) return fromProvider;
  return inferProviderFamily(adapter);
}

/** Validate operator CLI flags (`--adlc-bin`, `--review-bin`, `--review-provider`, `--prosecute-fail-on`). */
export function validateProsecutorFlags(flags = {}) {
  const errors = [];
  if (flags.adlcBin !== undefined && (!isNonEmptySafeString(flags.adlcBin) || flags.adlcBin.startsWith('-'))) {
    errors.push('--adlc-bin must be a non-empty path or binary name without NUL bytes or a leading "-"');
  }
  if (flags.reviewBin !== undefined && (!isNonEmptySafeString(flags.reviewBin) || flags.reviewBin.startsWith('-'))) {
    errors.push('--review-bin must be a non-empty path or binary name without NUL bytes or a leading "-"');
  }
  if (flags.prosecuteFailOn !== undefined && !PROSECUTE_SEVERITIES.includes(flags.prosecuteFailOn)) {
    errors.push(`--prosecute-fail-on must be one of ${PROSECUTE_SEVERITIES.join('|')}`);
  }
  if (flags.reviewProvider !== undefined && (typeof flags.reviewProvider !== 'string' || !REVIEW_PROVIDER_RE.test(flags.reviewProvider))) {
    errors.push('--review-provider must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/');
  }
  if (errors.length > 0) throw new Error(errors.join('; '));
  return true;
}

/**
 * Resolve `adlcBin`, `reviewBin`, `prosecuteFailOn`, and `reviewProvider` from repo config + CLI flags.
 */
export function resolveProsecutorConfig(config = {}, flags = {}, {
  defaultFailOn = 'medium',
  effectiveAdapter = 'claude-code',
  effectiveModel = null,
  warnings = [],
} = {}) {
  if (config.adlcBin != null) {
    warnings.push(
      'SECURITY: .adlc/config.json set fleet.adlcBin; host executable paths are operator-local (--adlc-bin) only — ' +
        'a repo-committed value could redirect gate or flail execution to an untrusted binary — ignored.'
    );
  }
  if (config.reviewBin != null) {
    warnings.push(
      'SECURITY: .adlc/config.json set fleet.reviewBin; host executable paths are operator-local (--review-bin) only — ' +
        'a repo-committed value could redirect prosecution to an untrusted binary — ignored.'
    );
  }
  const adlcBin = isNonEmptySafeString(flags.adlcBin) && !flags.adlcBin.startsWith('-') ? flags.adlcBin : null;
  const reviewBin = isNonEmptySafeString(flags.reviewBin) && !flags.reviewBin.startsWith('-') ? flags.reviewBin : null;

  let prosecuteFailOn = defaultFailOn;
  if (flags.prosecuteFailOn != null) {
    if (PROSECUTE_SEVERITIES.includes(flags.prosecuteFailOn)) prosecuteFailOn = flags.prosecuteFailOn;
    else throw new Error(`--prosecute-fail-on must be one of ${PROSECUTE_SEVERITIES.join('|')}`);
  } else if (config.prosecuteFailOn != null) {
    if (REPO_ALLOWED_FAIL_ON.has(config.prosecuteFailOn)) {
      prosecuteFailOn = config.prosecuteFailOn;
    } else if (PROSECUTE_SEVERITIES.includes(config.prosecuteFailOn)) {
      warnings.push(
        `SECURITY: .adlc/config.json fleet.prosecuteFailOn "${config.prosecuteFailOn}" is weaker than the minimum ` +
          `repo-configurable severity "${defaultFailOn}" — clamping to "${defaultFailOn}" (use --prosecute-fail-on to relax).`
      );
    } else {
      warnings.push(
        `warning: .adlc/config.json fleet.prosecuteFailOn must be "low" or "medium" — using "${defaultFailOn}".`
      );
    }
  }

  let reviewProvider = null;
  let reviewProviderSource = null;
  let repoReviewProvider = null;
  if (flags.reviewProvider != null) {
    if (typeof flags.reviewProvider === 'string' && REVIEW_PROVIDER_RE.test(flags.reviewProvider)) {
      reviewProvider = flags.reviewProvider;
      reviewProviderSource = 'cli';
    } else {
      throw new Error('--review-provider must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/');
    }
  } else if (config.reviewProvider != null) {
    if (typeof config.reviewProvider !== 'string' || !REVIEW_PROVIDER_RE.test(config.reviewProvider)) {
      warnings.push(
        'SECURITY: .adlc/config.json fleet.reviewProvider is not a valid provider identifier — ignored.'
      );
    } else {
      const builderFamily = inferBuilderFamily({ adapter: effectiveAdapter, model: effectiveModel });
      const reviewerFamily = inferProviderFamily(config.reviewProvider);
      if (!reviewerFamily) {
        warnings.push(
          `SECURITY: .adlc/config.json fleet.reviewProvider "${config.reviewProvider}" does not map to a canonical ` +
            'model family (anthropic|openai|google); repo config cannot select an unverified router/provider — ignored.'
        );
      } else {
        repoReviewProvider = config.reviewProvider;
        if (!builderFamily) {
          warnings.push(
            `SECURITY: .adlc/config.json fleet.reviewProvider "${config.reviewProvider}" cannot be verified as cross-family ` +
              `against builder (${effectiveAdapter}${effectiveModel ? `/${effectiveModel}` : ''}) with unresolved model family; ` +
              'repo config cannot choose the prosecutor when builder family is unknown — ignored.'
          );
        } else if (builderFamily === reviewerFamily) {
          warnings.push(
            `SECURITY: .adlc/config.json fleet.reviewProvider "${config.reviewProvider}" shares model family "${reviewerFamily}" ` +
              `with builder (${effectiveAdapter}${effectiveModel ? `/${effectiveModel}` : ''}); repo config cannot force same-family self-review — ignored.`
          );
        } else {
          reviewProvider = config.reviewProvider;
          reviewProviderSource = 'config';
        }
      }
    }
  }

  return { adlcBin, reviewBin, prosecuteFailOn, reviewProvider, reviewProviderSource, repoReviewProvider };
}

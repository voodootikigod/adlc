// Rail density computation for P3 gate enforcement.
//
// railDensity = Math.min(1, rails.length / codeScope.length)
//   - If a ticket has no rails → 0 (unless category is contract/spec/architecture,
//     checked by the caller before invoking this or via the P3 check).
//   - If a ticket has no scope → 0 (unbounded scope cannot be considered railed;
//     it would let an un-scoped ticket pass the P3 floor and reach cheap/ladder).
//   - Non-code config and documentation paths (JSON, YAML, TOML, Markdown, lockfiles,
//     CI workflows, docs/) are excluded from the scope denominator when code paths
//     are present so config-heavy tickets do not artificially fall under the floor;
//     when all scope entries are non-code, the denominator falls back to scope.length.
//   - Clamped to [0, 1].

const INVISIBLE = /[\s\p{Cf}\p{Cc}\p{Default_Ignorable_Code_Point}]/gu;

const NON_CODE_SCOPE_PATTERN =
  /(?:\.(?:md|markdown|mdx|txt|json|jsonc|ya?ml|toml|lock|snap|diff|patch)|(?:^|\/)(?:README(?:\.[^/]+)?|CHANGELOG(?:\.[^/]+)?|LICENSE(?:\.[^/]+)?|CODEOWNERS|Dockerfile|Makefile|\.(?:gitignore|nvmrc|npmrc|editorconfig)|\.github\/.+|docs\/.+))$/i;

/**
 * True when a scope pattern names a non-code config or documentation file that
 * cannot be directly railed with unit tests (e.g. package.json, README.md,
 * tsconfig.json, .github/workflows/ci.yml).
 */
export function isNonCodeScopePattern(pattern) {
  return NON_CODE_SCOPE_PATTERN.test(String(pattern).replace(INVISIBLE, ''));
}

/**
 * The distinct, readable path patterns in a rails/scope field. Raw array
 * length is not coverage: rails [""], ["\u200b"] or ["a","a","a"] would score
 * a ticket as fully railed and route unbounded work to the cheap tier. A
 * pattern counts only if, with invisibles removed, it still names something —
 * a letter, a digit, or a glob metacharacter (`**` is a legitimate if blunt
 * rail; the Braille blank U+2800 is not).
 */
function usablePatterns(field) {
  if (!Array.isArray(field)) return [];
  const seen = new Set();
  for (const item of field) {
    if (typeof item !== 'string') continue;
    const visible = item.replace(INVISIBLE, '');
    if (!/[\p{L}\p{N}*?]/u.test(visible)) continue;
    seen.add(visible);
  }
  return [...seen];
}

/** Compute the rail density for a single ticket. */
export function railDensity(ticket) {
  const rails = usablePatterns(ticket.rails);
  if (rails.length === 0) return 0;

  const scope = usablePatterns(ticket.scope);
  if (scope.length === 0) return 0;

  const codeScope = scope.filter((p) => !isNonCodeScopePattern(p));
  const denominator = codeScope.length > 0 ? codeScope.length : scope.length;

  return Math.min(1, rails.length / denominator);
}

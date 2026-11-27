// Rail density computation for P3 gate enforcement.
//
// railDensity = Math.min(1, effectiveRails.length / denominator)
//   - If a ticket has no rails → 0 (unless category is contract/spec/architecture,
//     checked by the caller before invoking this or via the P3 check).
//   - If a ticket has no scope → 0 (unbounded scope cannot be considered railed;
//     it would let an un-scoped ticket pass the P3 floor and reach cheap/ladder).
//   - Non-code config and documentation paths (JSON, YAML, TOML, Markdown, lockfiles,
//     CI workflows, docs/) are excluded from the scope denominator when code paths
//     are present so config-heavy tickets do not artificially fall under the floor;
//     when all scope entries are non-code, the denominator falls back to scope.length.
//   - Documentation-only rails (README, LICENSE, docs/, .md, .txt) receive 0 numerator
//     credit when codeScope.length > 0.
//   - Clamped to [0, 1].

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { globMatch } from '@adlc/core';

const INVISIBLE = /[\s\p{Cf}\p{Cc}\p{Default_Ignorable_Code_Point}]/gu;

const NON_CODE_SCOPE_PATTERN =
  /(?:\.(?:md|markdown|mdx|txt|json|jsonc|ya?ml|toml|lock|snap|diff|patch)|(?:^|\/)(?:README(?:\.[^/]+)?|CHANGELOG(?:\.[^/]+)?|LICENSE(?:\.[^/]+)?|CODEOWNERS|Dockerfile|Makefile|\.(?:gitignore|nvmrc|npmrc|editorconfig)|\.github\/.+|docs\/.+))$/i;

export const DOC_RAIL_PATTERN =
  /(?:\.(?:md|markdown|mdx|txt)|(?:^|\/)(?:README(?:\.[^/]+)?|CHANGELOG(?:\.[^/]+)?|LICENSE(?:\.[^/]+)?|CODEOWNERS|\.gitignore|docs\/.+))$/i;

const REAL_ASSERTION_PATTERN =
  /\b(?:assert(?:\.|\(|!\s*\(|_eq!|_ne!|\s)|expect\s*\(|\.should\b|t\.(?:Fatal|Fatalf|Error|Errorf)\s*\()/;

const SKIP_WALK_DIRS = new Set(['node_modules', '.git', '.worktrees']);

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

function walkRepoFiles(root) {
  const files = [];
  if (typeof root !== 'string' || !root) return files;
  function walk(dir, relDir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (SKIP_WALK_DIRS.has(ent.name)) continue;
      const fullPath = join(dir, ent.name);
      const relPath = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(fullPath, relPath);
      } else if (ent.isFile()) {
        files.push(relPath);
      }
    }
  }
  walk(root, '');
  return files;
}

function fileHasRealAssertion(fullPath, relFile) {
  let content;
  try {
    content = readFileSync(fullPath, 'utf8');
  } catch {
    return false;
  }
  let cleaned = content.replace(/\/\*[\s\S]*?\*\//g, ' ');
  cleaned = cleaned.replace(/^\s*\/\/.*$/gm, ' ').replace(/\s\/\/.*$/gm, ' ');
  if (relFile.endsWith('.py')) {
    cleaned = cleaned.replace(/^\s*#.*$/gm, ' ').replace(/\s#.*$/gm, ' ');
  }
  cleaned = cleaned
    .replace(/^\s*import\b[^;\n]*\bfrom\s+['"][^'"]+['"]\s*;?/gm, ' ')
    .replace(/^\s*(?:const|let|var)\s+assert\b[^\n;]*/gm, ' ')
    .replace(/\bassert(?:\.ok)?\s*\(\s*true\s*\)/g, ' ')
    .replace(/\bassert!\s*\(\s*true\s*\)/g, ' ')
    .replace(/\bexpect\s*\(\s*true\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(\s*true\s*\)/g, ' ')
    .replace(/\bassert\s+True\b/g, ' ');

  return REAL_ASSERTION_PATTERN.test(cleaned);
}

/** Compute the rail density for a single ticket. */
export function railDensity(ticket) {
  const rails = usablePatterns(ticket.rails);
  if (rails.length === 0) return 0;

  const scope = usablePatterns(ticket.scope);
  if (scope.length === 0) return 0;

  const codeScope = scope.filter((p) => !isNonCodeScopePattern(p));
  const denominator = codeScope.length > 0 ? codeScope.length : scope.length;
  const effectiveRails = codeScope.length > 0 ? rails.filter((p) => !DOC_RAIL_PATTERN.test(p)) : rails;

  return Math.min(1, effectiveRails.length / denominator);
}

/**
 * Compute assertion-weighted behavioral rail density against on-disk files in root.
 */
export function behavioralRailDensity(ticket, { root } = {}) {
  const rails = usablePatterns(ticket.rails);
  if (rails.length === 0) return 0;

  const scope = usablePatterns(ticket.scope);
  if (scope.length === 0) return 0;

  const codeScope = scope.filter((p) => !isNonCodeScopePattern(p));
  const denominator = codeScope.length > 0 ? codeScope.length : scope.length;
  const effectiveRails = codeScope.length > 0 ? rails.filter((p) => !DOC_RAIL_PATTERN.test(p)) : rails;
  if (effectiveRails.length === 0) return 0;

  const repoFiles = walkRepoFiles(root);
  const assertionCache = new Map();

  let creditedRails = 0;
  for (const r of effectiveRails) {
    let credited = false;
    for (const relFile of repoFiles) {
      if (!globMatch(r, relFile)) continue;
      let hasAssertion = assertionCache.get(relFile);
      if (hasAssertion === undefined) {
        hasAssertion = fileHasRealAssertion(join(root, relFile), relFile);
        assertionCache.set(relFile, hasAssertion);
      }
      if (hasAssertion) {
        credited = true;
        break;
      }
    }
    if (credited) creditedRails += 1;
  }

  return Math.min(1, creditedRails / denominator);
}

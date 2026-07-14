// scaffold-hygiene.mjs — shared /adlc-init hygiene logic used by every harness
// integration's scaffolder (adlc-cursor, adlc-opencode, and any future one).
// Extracted (issue #97) from two independently hand-duplicated copies that had
// drifted apart across #92's review rounds — every .gitignore edge case found
// there had to be fixed twice to keep the copies in sync. One implementation
// now; a fix here reaches every harness at once.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeTicketStores } from '@adlc/tickets';

// ---------------------------------------------------------------------------
// .gitignore: track the ticket contract AND the P1 spec contract, ignore the
// rest of the runtime (issue #46). Never clobbers unrelated gitignore
// content — only appends the stanza, or the specific negation lines missing
// from an existing stanza.
// ---------------------------------------------------------------------------

const GITIGNORE_STANZA = [
  '.adlc/*',
  '!.adlc/tickets.json',
  '!.adlc/tickets/',
  '!.adlc/tickets/**',
  '!.adlc/ticket-archive/',
  '!.adlc/ticket-archive/**',
  '!.adlc/specs/',
];

/** Initialize sharded stores for a new repo; preserve a legacy store for consent-based migration. */
export function ensureTicketStore(root) {
  return initializeTicketStores(root);
}

/**
 * Ensure `.gitignore` ignores all of `.adlc/` except the tracked contracts
 * (`tickets.json` and the `specs/` directory). Idempotent: if the stanza is
 * fully present AND correctly ordered, nothing is written. If `.adlc/*` is
 * present but a negation line (e.g. `!.adlc/specs/`) is missing, only the
 * missing line(s) are inserted right after the existing block — the rest of
 * the file is untouched. Returns { path, added: string[], changed: boolean }.
 *
 * Git applies `.gitignore` patterns with last-match-wins semantics: a
 * negation line (e.g. `!.adlc/tickets.json`) only has effect if it comes
 * AFTER the `.adlc/*` anchor that would otherwise re-ignore it. A stanza
 * negation line found BEFORE the anchor — from a hand edit, a merge, or a
 * differently-ordered legacy stanza — is therefore relocated to after the
 * anchor rather than left in place (checked unconditionally, even when
 * every stanza line is nominally "present somewhere" in the file).
 *
 * A file can also end up with MORE THAN ONE `.adlc/*` line (e.g. a merge of
 * two branches that each independently appended the stanza, or a second
 * tool emitting its own copy). Because last-match-wins applies across the
 * WHOLE file, a later `.adlc/*` anchor re-ignores any negation that
 * precedes it — including one that was already correctly placed right
 * after an earlier anchor. Every anchor beyond the first is therefore
 * collapsed away (not just misplaced negations) before this function
 * reasons about ordering, so only one anchor ever needs to be considered.
 */
export function ensureGitignore(root) {
  const path = join(root, '.gitignore');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const hadTrailingNewline = existing.endsWith('\n');
  let lines = existing.length ? existing.split('\n') : [];
  if (hadTrailingNewline && lines[lines.length - 1] === '') lines.pop();

  const anchorCount = lines.filter((line) => line === '.adlc/*').length;

  if (anchorCount === 0) {
    const missing = GITIGNORE_STANZA.filter((entry) => !lines.includes(entry));
    // The `.adlc/*` anchor is absent. A pre-existing negation line (e.g. a
    // lone `!.adlc/tickets.json` left over from a partial/legacy edit) may
    // already be present standalone, earlier in the file. Simply pushing
    // the missing entries (which always includes `.adlc/*` itself here) to
    // the END of the file would place the broad ignore AFTER that earlier
    // negation — git applies patterns with last-match-wins semantics, so
    // the later `.adlc/*` would re-ignore the file the negation was meant
    // to keep tracked. To guarantee correct order, strip out any
    // pre-existing standalone stanza lines and re-append the complete
    // stanza together, in its canonical anchor-first order.
    lines = lines.filter((line) => !GITIGNORE_STANZA.includes(line));
    if (lines.length > 0) lines.push('');
    lines.push(...GITIGNORE_STANZA);
    writeFileSync(path, lines.join('\n') + '\n');
    return { path, added: missing, changed: true };
  }

  // One or more anchors are present. Collapse every `.adlc/*` line beyond
  // the first — keeping the earliest occurrence — so the rest of this
  // function only ever has to reason about a single anchor position. This
  // is itself a repair (dropping a duplicate anchor changes the file), even
  // when no negation line is missing or relocated below.
  let dedupedAnchor = false;
  if (anchorCount > 1) {
    let seenAnchors = 0;
    lines = lines.filter((line) => {
      if (line !== '.adlc/*') return true;
      seenAnchors += 1;
      return seenAnchors === 1;
    });
    dedupedAnchor = true;
  }

  const anchorIdx = lines.indexOf('.adlc/*');

  // The anchor IS present. Relocate any stanza negation line that sits
  // BEFORE it — leaving it there would be silently overridden by the
  // anchor (last-match-wins), re-ignoring the file it was meant to protect.
  const beforeCount = lines.length;
  lines = lines.filter(
    (line, idx) => !(idx < anchorIdx && line !== '.adlc/*' && GITIGNORE_STANZA.includes(line))
  );
  const relocated = lines.length !== beforeCount;

  const newAnchorIdx = lines.indexOf('.adlc/*');
  const missing = GITIGNORE_STANZA.filter((entry) => !lines.includes(entry));
  if (missing.length === 0 && !relocated && !dedupedAnchor) return { path, added: [], changed: false };

  let insertAt = newAnchorIdx + 1;
  while (insertAt < lines.length && lines[insertAt].startsWith('!')) insertAt++;
  lines.splice(insertAt, 0, ...missing);

  writeFileSync(path, lines.join('\n') + '\n');
  return { path, added: missing, changed: true };
}

// ---------------------------------------------------------------------------
// Formatter/linter ignores: `.adlc/tickets.json` is a machine-written,
// frozen trust root once rails exist — a repo formatter reformatting it on a
// ticket branch trips rails-guard. Add `.adlc/` to whichever formatter/linter
// configs are ALREADY present in the repo (never invent a new tool). (#42)
// ---------------------------------------------------------------------------

/** Add a line to a plain-text ignore file (gitignore-style) if not already present. */
function ensureTextIgnoreFile(root, filename, entry) {
  const path = join(root, filename);
  if (!existsSync(path)) return { path, detected: false, changed: false };
  const existing = readFileSync(path, 'utf8');
  const lines = existing.split('\n');
  if (lines.includes(entry)) return { path, detected: true, changed: false };
  const needsNewline = existing.length > 0 && !existing.endsWith('\n');
  writeFileSync(path, existing + (needsNewline ? '\n' : '') + entry + '\n');
  return { path, detected: true, changed: true };
}

/** Add a `.adlc/**` override entry to `biome.json` (Biome 1.x `overrides` shape) if present. */
function ensureBiomeIgnore(root) {
  const path = join(root, 'biome.json');
  if (!existsSync(path)) return { path, detected: false, changed: false };
  let config;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { path, detected: true, changed: false, skipped: 'unparseable JSON — add manually' };
  }
  const overrides = Array.isArray(config.overrides) ? config.overrides : [];
  const already = overrides.some(
    (o) => Array.isArray(o?.include) && o.include.includes('.adlc/**')
  );
  if (already) return { path, detected: true, changed: false };
  const next = {
    ...config,
    overrides: [
      ...overrides,
      { include: ['.adlc/**'], formatter: { enabled: false }, linter: { enabled: false } },
    ],
  };
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
  return { path, detected: true, changed: true };
}

/** Add an `ignorePatterns` entry to a legacy JSON `.eslintrc*` config if present. */
function ensureEslintRcIgnore(root) {
  for (const filename of ['.eslintrc.json', '.eslintrc']) {
    const path = join(root, filename);
    if (!existsSync(path)) continue;
    let config;
    try {
      config = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return { path, detected: true, changed: false, skipped: 'unparseable JSON — add manually' };
    }
    const ignorePatterns = Array.isArray(config.ignorePatterns) ? config.ignorePatterns : [];
    if (ignorePatterns.includes('.adlc/**')) return { path, detected: true, changed: false };
    const next = { ...config, ignorePatterns: [...ignorePatterns, '.adlc/**'] };
    writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
    return { path, detected: true, changed: true };
  }
  // Flat config (eslint.config.js/.mjs/.cjs) is executable JS — safe text
  // mutation isn't reliable, so only report detection; document the manual
  // fallback (an `{ ignores: ['.adlc/**'] }` object in the exported array).
  for (const filename of ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs']) {
    if (existsSync(join(root, filename))) {
      return {
        path: join(root, filename),
        detected: true,
        changed: false,
        skipped: 'flat config — add { ignores: [".adlc/**"] } manually',
      };
    }
  }
  return { path: null, detected: false, changed: false };
}

/**
 * Combine the independent `.eslintrc*` and `.eslintignore` outcomes into one
 * report. Both are always checked/mutated unconditionally by
 * `ensureFormatterIgnores` — a pre-flat-config repo commonly has BOTH files
 * at once — so picking only one would silently under-report a real mutation
 * made to the other. When only one is detected, that single result is
 * returned unchanged (keeping the common single-file case simple); when
 * both are detected, `sources` exposes each outcome individually so nothing
 * is dropped.
 */
function mergeEslintReports(eslintrc, eslintignore) {
  if (!eslintrc.detected) return eslintignore;
  if (!eslintignore.detected) return eslintrc;
  const skipped = [eslintrc.skipped, eslintignore.skipped].filter(Boolean).join('; ');
  return {
    detected: true,
    changed: eslintrc.changed || eslintignore.changed,
    path: [eslintrc.path, eslintignore.path],
    ...(skipped ? { skipped } : {}),
    sources: { eslintrc, eslintignore },
  };
}

/**
 * Detect and update whichever formatter/linter configs already exist in the
 * repo so none of them touch `.adlc/`: Biome (`biome.json` overrides),
 * Prettier (`.prettierignore`), ESLint (`ignorePatterns` in a JSON
 * `.eslintrc*`, `.eslintignore`, or detection-only for flat config). Never
 * creates a config for a tool that isn't already in use. Returns a summary
 * keyed by tool. `eslint` reflects BOTH `.eslintrc*` and `.eslintignore`
 * when a repo has both (see `mergeEslintReports`) — `eslint.sources` carries
 * the per-file detail in that case.
 */
export function ensureFormatterIgnores(root) {
  const biome = ensureBiomeIgnore(root);
  const prettier = ensureTextIgnoreFile(root, '.prettierignore', '.adlc/');
  const eslintrc = ensureEslintRcIgnore(root);
  const eslintignore = ensureTextIgnoreFile(root, '.eslintignore', '.adlc/');
  return { biome, prettier, eslint: mergeEslintReports(eslintrc, eslintignore) };
}

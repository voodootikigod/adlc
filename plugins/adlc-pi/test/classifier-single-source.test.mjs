import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, lstatSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guard for #307 (T73): pi must enforce shell rails through the ONE canonical
// classifier in @adlc/core (single source of truth, ADR-0004), never a local
// fork. A forked/weaker copy is exactly how the pre-#290 `cat a>rail` no-space
// redirect bypass survived in the vestigial index.js after core was fixed.
//
// Two layers, strongest first:
//   1. BEHAVIORAL (load-bearing): drive pi's live `checkShellCommand` over the
//      #290 bypass corpus and assert the DECISIONS. This proves the live path is
//      wired to a classifier that actually has the fix — independent of how a
//      fork might be named, typed, or spelled. A renamed/re-authored fork that a
//      source scan could never catch fails HERE, on behavior.
//   2. STRUCTURAL tripwire (best-effort): no pi source file defines, or imports
//      from a non-core specifier, one of the named core shell primitives. This
//      catches the common copy-paste reintroduction early; it is explicitly NOT
//      a proof of non-existence (a fork under wholly new names evades it — that
//      case is owned by layer 1).
//
// The scan reads the WORKING TREE, not `git ls-files`: an untracked on-disk copy
// still loads at runtime, so the working tree is the surface to police.

const PI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.mts', '.cts', '.ts', '.jsx', '.tsx']);
const CORE = '@adlc/core';

// Named primitives assembled from parts so these lines are RULES, not matches.
const NAMES = ['shellHas' + 'Mutation', 'hasUnquotedFile' + 'Redirect', 'classifyShell' + 'Command', 'collectShell' + 'Paths'];

// -------------------------------------------------------------------------
// Layer 1 — behavioral: the live path denies the pre-#290 redirect bypass.
// -------------------------------------------------------------------------
test('live checkShellCommand denies the #290 redirect bypass into a frozen rail (#307 AC2/AC4)', async () => {
  const { checkShellCommand } = await import('../lib/rails-checker.mjs');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-307-')));
  try {
    mkdirSync(join(root, 'guard'), { recursive: true });
    writeFileSync(join(root, 'guard', 'rail.txt'), 'frozen\n');
    const ticket = { id: 'T-307-guard', title: 'guard', body: '', scope: ['**'], rails: ['guard/**'] };
    const rail = 'guard/rail.txt';

    // These use a read-only-ALLOWLISTED prefix (`cat`), so a classifier missing
    // the #290 fix classifies them read-only and ALLOWS them. Each flips
    // allow->deny exactly on `hasUnquotedFileRedirect` — genuinely load-bearing
    // for pi's live path (the echo case below is NOT: echo is not allowlisted,
    // so its SPACED redirect is caught by the legacy whitespace-anchored regex
    // and denied via the rail-hit branch regardless of #290).
    const mustDeny290 = [
      `cat x>${rail}`,     // no space before >  (the exact pre-#290 bypass)
      `cat x>"${rail}"`,   // quoted no-space target
      `cat x>>${rail}`,    // no-space APPEND (the s[i+1] === '>' branch of the fix)
    ];
    for (const cmd of mustDeny290) {
      assert.equal(
        checkShellCommand(cmd, ticket, root).decision,
        'deny',
        `#290 fix must DENY a no-space redirect into a frozen rail: ${cmd}`,
      );
    }

    // Sanity: a non-allowlisted prefix writing to a rail is denied too — here via
    // the rail-hit branch (the spaced redirect trips the legacy whitespace-
    // anchored regex, so this holds independent of #290). Kept only as a sanity
    // check; it is NOT load-bearing for the #290 fix.
    assert.equal(
      checkShellCommand(`echo hi > ${rail}`, ticket, root).decision,
      'deny',
      'any recognized write to a frozen rail must be denied',
    );

    // Negative control: a quoted '>' in a read-only grep is NOT a redirect.
    assert.equal(
      checkShellCommand(`grep '>' ${rail}`, ticket, root).decision,
      'allow',
      'a quoted > in a read-only command must not be treated as a redirect',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------------
// Layer 2 — structural tripwire against verbatim reintroduction.
// -------------------------------------------------------------------------

// Whole-file scan (not per-line) so a def or specifier split across newlines is
// still seen; `\s` crosses newlines. Flags: a local function/const/let/var
// definition of a named primitive (async/generator/generic/typed tolerated), or
// a named import/re-export of one from any specifier that is not exactly
// @adlc/core. Call sites and the canonical core import are deliberately allowed.
function structuralOffenders(src) {
  const hits = [];
  for (const name of NAMES) {
    if (new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s*\\*?\\s+${name}(?:\\s*<[^>]*>)?\\s*\\(`).test(src)) {
      hits.push(`local function definition of ${name}`);
    }
    if (new RegExp(`(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*(?::[^=\\n]+)?=`).test(src)) {
      hits.push(`local const/let/var definition of ${name}`);
    }
  }
  const importRe = /(?:import|export)\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g;
  let m;
  while ((m = importRe.exec(src)) !== null) {
    const [, names, , specifier] = m;
    if (specifier === CORE) continue; // consuming the canon is the point
    for (const name of NAMES) {
      if (new RegExp(`\\b${name}\\b`).test(names)) {
        hits.push(`imports/re-exports ${name} from non-core '${specifier}'`);
      }
    }
  }
  return hits;
}

// lstat (never follows symlinks → no cycles, no dangling-link throw). Excludes
// node_modules (any depth) and the TOP-LEVEL test dir (this guard + fixtures).
function walkSource(dir, rel = '') {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const relPath = rel ? `${rel}/${entry}` : entry;
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (entry === 'node_modules') continue;
      if (relPath === 'test') continue;
      found.push(...walkSource(full, relPath));
    } else if (SOURCE_EXT.has(extname(entry))) {
      found.push(full);
    }
  }
  return found;
}

test('structural detector is load-bearing — positive/negative controls (#307)', () => {
  const mustFlag = [
    'export const classifyShell' + 'Command = (t) => t',                      // untyped arrow
    'export const classifyShell' + 'Command: Classifier = (t) => t',          // typed arrow (TS house style)
    'function shellHas' + 'Mutation(x){ return true; }',                      // function decl
    'function classifyShell' + 'Command<T>(x){ return x; }',                  // generic function
    "export {\n  collectShell" + "Paths\n} from './forked-classifier.mjs'",   // multi-line re-export from fork
    "import { classifyShell" + "Command } from './local-fork.mjs'",           // import fork under canonical name
    "export { classifyShell" + "Command } from '@adlc/core-shim'",            // look-alike specifier
  ];
  for (const s of mustFlag) {
    assert.ok(structuralOffenders(s).length > 0, `detector must flag: ${s}`);
  }
  const mustAllow = [
    "import { classifyShell" + "Command, collectShell" + "Paths } from '@adlc/core';",  // the canon
    'const c = classifyShell' + 'Command(cmd);',                                        // a call site
    "export { checkShellCommand } from './rails-checker.mjs';",                          // a non-primitive symbol
  ];
  for (const s of mustAllow) {
    assert.equal(structuralOffenders(s).length, 0, `detector must NOT flag: ${s}`);
  }
});

test('pi ships no vestigial index monolith, only index.ts (#307 AC1)', () => {
  // Anchor PI_ROOT: the real entry MUST exist, so a mis-resolved root fails loudly
  // rather than passing the ENOENT assertions vacuously.
  assert.doesNotThrow(() => statSync(join(PI_ROOT, 'index.ts')), 'index.ts (the real pi entry) must exist');
  for (const name of ['index.js', 'index.mjs', 'index.cjs', 'index.mts', 'index.cts']) {
    assert.throws(
      () => statSync(join(PI_ROOT, name)),
      /ENOENT/,
      `plugins/adlc-pi/${name} is a dead monolith (superseded by index.ts -> lib/*.mjs) and must not exist`,
    );
  }
});

test('no pi source defines or non-core-imports a shell classifier primitive (#307 AC2/AC3)', () => {
  const files = walkSource(PI_ROOT);
  assert.ok(files.length > 0, 'expected to discover pi source files to scan'); // AC3: never vacuous
  const offenders = files
    .map((file) => ({ file, hits: structuralOffenders(readFileSync(file, 'utf-8')) }))
    .filter((o) => o.hits.length > 0);
  assert.deepEqual(
    offenders.map((o) => o.file),
    [],
    `pi source must consume the @adlc/core shell classifier, not fork it:\n` +
      offenders.map((o) => `  ${o.file}: ${o.hits.join('; ')}`).join('\n'),
  );
});

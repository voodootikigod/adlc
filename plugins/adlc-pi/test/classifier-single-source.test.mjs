import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, lstatSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guard for #307 (T73): pi must carry NO second copy of the shell-command
// classifier. The live enforcement path (lib/rails-checker.mjs) IMPORTS the
// canonical classifier from @adlc/core (single source of truth, ADR-0004). A
// forked copy is exactly how the pre-#290 `cat a>rail` bypass survived in the
// vestigial index.js after core was fixed.
//
// Scope of this guard, stated honestly (it is a strong tripwire, not a proof of
// non-existence). It makes RED:
//   (a) any local DEFINITION — function / const / arrow / re-export — of a named
//       core shell primitive;
//   (b) any copy of the whitespace-anchored redirect regex that WAS the bypass,
//       regardless of the surrounding identifier; and it asserts
//   (c) the live path still IMPORTS the classifier from @adlc/core.
// It cannot catch a semantically-equivalent classifier re-authored under wholly
// new names with a different redirect implementation — the inherent limit of
// name-based scanning. Combined with (c), the realistic drift surface is closed.
//
// The scan reads the WORKING TREE, not `git ls-files`, on purpose: an untracked
// on-disk copy would still load at runtime, so the working tree is the surface a
// runtime-safety guard must police.

const PI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Any executable-source extension pi's loader (jiti) can run.
const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.mts', '.cts', '.ts', '.jsx', '.tsx']);

// Recursive walk. lstat (never follows symlinks → no cycles, no dangling-link
// throw). Only node_modules (any depth) and the TOP-LEVEL test dir (this guard +
// fixtures) are outside the runtime surface; everything else is scanned so a
// classifier cannot hide under skills/, prompts/, or a nested directory.
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

// The core shell primitives pi must import, never define. Assembled from parts so
// these source lines are detection RULES, not matchable local definitions.
const NAMES = ['shellHas' + 'Mutation', 'hasUnquotedFile' + 'Redirect', 'classifyShell' + 'Command', 'collectShell' + 'Paths'];
const NAME_ALT = NAMES.join('|');

// Local DEFINITION forms (declaration, assignment/arrow, re-export from a
// non-core specifier). Call sites (`classifyShellCommand(cmd)`) and imports are
// deliberately NOT matched — they are the legitimate way to consume the canon.
const DEF_PATTERNS = [
  new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s*\\*?\\s+(?:${NAME_ALT})\\s*\\(`),
  new RegExp(`(?:export\\s+)?(?:const|let|var)\\s+(?:${NAME_ALT})\\s*=`),
  new RegExp(`export\\s*\\{[^}]*\\b(?:${NAME_ALT})\\b[^}]*\\}\\s*from\\s*(?!['"]@adlc/core)`),
];

// Signature of the pre-#290 vulnerable redirect regex: a start-or-separator
// anchor `(^|[…;&|…])` immediately governing a `>`/`>>`/fd redirect alternation.
// Independent of any function name, so an inlined const/embedded copy is caught.
const REDIRECT_REGEX_SIG = /\(\s*\^\s*\|\s*\[[^\]]*[\s;&|][^\]]*\]\s*\)[^\n]*>>?/;

function offendingLines(src) {
  return src.split('\n').filter((line) => {
    if (/^\s*import\b/.test(line)) return false; // imports/consumers are allowed
    return DEF_PATTERNS.some((re) => re.test(line)) || REDIRECT_REGEX_SIG.test(line);
  });
}

test('guard detectors are load-bearing — positive/negative controls (#307)', () => {
  const BAD = [
    'export const classifyShell' + 'Command = (t) => t',
    'function shellHas' + 'Mutation(x){ return true; }',
    "export { collectShell" + "Paths } from './forked-classifier.mjs'",
    'const RE = /(^|[\\s;&|])(?:>>?|[0-9]>>?|[0-9]>)\\s*\\S+/;', // the vulnerable regex, any name
  ];
  for (const s of BAD) {
    assert.ok(offendingLines(s).length > 0, `detector must flag a reintroduced classifier: ${s}`);
  }
  // The legitimate consume-the-canon shape must NOT be flagged.
  const GOOD = "import { classifyShell" + "Command } from '@adlc/core';\nconst c = classifyShell" + 'Command(cmd);';
  assert.equal(offendingLines(GOOD).length, 0, 'importing + calling the @adlc/core classifier must be allowed');
});

test('pi ships no vestigial index monolith (#307 AC1)', () => {
  // index.ts is the legitimate entry; only a JS/compiled monolith is forbidden.
  for (const name of ['index.js', 'index.mjs', 'index.cjs', 'index.mts', 'index.cts']) {
    assert.throws(
      () => statSync(join(PI_ROOT, name)),
      /ENOENT/,
      `plugins/adlc-pi/${name} is a dead monolith (superseded by index.ts -> lib/*.mjs) and must not exist`,
    );
  }
});

test('live enforcement path imports the classifier from @adlc/core (#307 AC4)', () => {
  const railsChecker = readFileSync(join(PI_ROOT, 'lib', 'rails-checker.mjs'), 'utf-8');
  assert.match(
    railsChecker,
    /import\s*\{[^}]*\bclassifyShellCommand\b[^}]*\}\s*from\s*['"]@adlc\/core['"]/,
    'lib/rails-checker.mjs must import classifyShellCommand from @adlc/core (single source, ADR-0004)',
  );
});

test('no pi source defines a local shell classifier or the vulnerable redirect regex (#307 AC2/AC3)', () => {
  const files = walkSource(PI_ROOT);
  // AC3: the scan must inspect a non-empty, glob-discovered set, never pass vacuously.
  assert.ok(files.length > 0, 'expected to discover pi source files to scan');

  const offenders = files
    .map((f) => ({ file: f, lines: offendingLines(readFileSync(f, 'utf-8')) }))
    .filter((o) => o.lines.length > 0);

  assert.deepEqual(
    offenders.map((o) => o.file),
    [],
    `pi source must import the shell classifier from @adlc/core, not define it locally:\n` +
      offenders.map((o) => `  ${o.file}: ${o.lines[0].trim()}`).join('\n'),
  );
});

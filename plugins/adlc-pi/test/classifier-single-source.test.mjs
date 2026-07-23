import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guard for #307 (T73): pi must carry NO local copy of the shell-command
// classifier. The live enforcement path (lib/rails-checker.mjs) IMPORTS the
// canonical classifier from @adlc/core (single source of truth, ADR-0004). A
// second, forked copy is exactly how the pre-#290 `cat a>rail` bypass survived
// in the vestigial index.js after core was fixed. This test fails if any pi
// source file DEFINES one of the core shell primitives locally instead of
// importing it, so the drift surface cannot come back.

const PI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Directories that are not pi runtime source (this test dir included, so the
// detection tokens below never flag the guard itself).
const EXCLUDED_DIRS = new Set(['test', 'node_modules', 'skills', 'prompts']);
const SOURCE_EXT = new Set(['.js', '.mjs', '.ts', '.cjs']);

// The core shell primitives pi must import, never define. Assembled from parts
// so this source line is a detection RULE, not a matchable local definition.
const PRIMITIVES = ['shellHasMutation', 'hasUnquotedFileRedirect', 'classifyShellCommand', 'collectShellPaths'];
const LOCAL_DEF = new RegExp(`(?:export\\s+)?function\\s+(?:${PRIMITIVES.join('|')})\\s*\\(`);

/** Recursive walk (no fs.globSync / recursive readdir — Node 18 floor, per #325). */
function walkSource(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      found.push(...walkSource(full));
    } else if (SOURCE_EXT.has(extname(entry))) {
      found.push(full);
    }
  }
  return found;
}

test('pi ships no vestigial index.js monolith (#307 AC1)', () => {
  assert.throws(
    () => statSync(join(PI_ROOT, 'index.js')),
    /ENOENT/,
    'plugins/adlc-pi/index.js is dead code (superseded by index.ts -> lib/*.mjs) and must not exist',
  );
});

test('pi source defines no local shell classifier — it imports @adlc/core (#307 AC2/AC4)', () => {
  const files = walkSource(PI_ROOT);

  // AC3: the scan must inspect a non-empty, glob-discovered set, never pass vacuously.
  assert.ok(files.length > 0, 'expected to discover pi source files to scan');

  const offenders = files.filter((f) => LOCAL_DEF.test(readFileSync(f, 'utf-8')));
  assert.deepEqual(
    offenders,
    [],
    `pi source must import the shell classifier from @adlc/core, not define it locally. ` +
      `Local definition(s) found in:\n  ${offenders.join('\n  ')}`,
  );
});

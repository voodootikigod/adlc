// source-hygiene.test.mjs — byte-level well-formedness of tracked text files.
//
// Issue #215. A literal U+0000 was authored into scripts/release.mjs and
// committed. It was VALID JavaScript (a control character inside a string
// literal is legal), the code behaved correctly, and every gate passed:
// `node --check`, `npm test` at 46/46, diff-scoped mutation testing, two
// independent P5 lens agents, and a cross-model adversarial review.
//
// It surfaced only when a tool consumed the file as TEXT: execFileSync refuses
// to spawn a process with an argument containing the byte
// (ERR_INVALID_ARG_VALUE), and the review prompt embedded the diff. The cost was
// a silently lost gate — a required cross-model review simply did not run, and
// the failure looked like a bug in the external tool.
//
// The audit that followed found the idiom was NOT a one-off: packages/core/lib/
// git.mjs and plugins/adlc-pi/lib/reactive-gate.mjs both used a raw NUL as a
// composite-key separator, dating to the founding commit. Verified consequence:
// passing git.mjs's contents as an argv argument throws ERR_INVALID_ARG_VALUE,
// so adversarial-review could not review ANY diff touching core.
//
// Every gate in this repo inspects semantics or behavior. This one inspects the
// bytes, because that is the layer where the defect lived.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Scoped by extension rather than by content sniffing. A naive UTF-8 scan
// reports every PNG and .ico in apps/docs as a hit, and git's own "NUL in the
// first 8000 bytes" heuristic would have classified the very files this test
// exists to catch as binary.
const TEXT_EXTENSIONS = new Set([
  '.mjs', '.cjs', '.js', '.ts', '.tsx', '.jsx',
  '.json', '.md', '.mdx', '.yml', '.yaml', '.toml', '.sh', '.txt',
]);

/**
 * Control characters that must never appear raw in source.
 * Tab, newline and carriage return are the legitimate ones — CR is permitted so
 * a Windows contributor's CRLF does not trip the gate.
 */
const isForbiddenControl = (code) => code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;

/**
 * Bidirectional override / isolate characters — the Trojan Source class
 * (CVE-2021-42574). These make rendered source differ from compiled source, so
 * a reviewer can approve code that does something else entirely. Strictly worse
 * than the NUL that prompted this file: that one only broke tooling, this one
 * breaks the trustworthiness of review itself.
 */
const BIDI = new Set([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]);

function trackedTextFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\u0000').filter((p) => p !== '' && TEXT_EXTENSIONS.has(extname(p)));
}

function scan(relPath) {
  let source;
  try {
    source = readFileSync(join(REPO_ROOT, relPath), 'utf8');
  } catch {
    return []; // deleted or unreadable in this working tree — not this gate's concern
  }
  const hits = [];
  let line = 1;
  for (const ch of source) {
    const code = ch.codePointAt(0);
    if (code === 0x0a) line++;
    else if (isForbiddenControl(code) || BIDI.has(code)) {
      hits.push(`${relPath}:${line}: U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
    }
  }
  return hits;
}

test('no tracked text file contains a raw control character', () => {
  const files = trackedTextFiles();
  // DENOMINATOR: an empty file list would make the assertion below vacuous, and
  // "scanned nothing" is exactly what a broken glob produces.
  assert.ok(files.length > 100, `expected to scan the repo, got ${files.length} files`);
  assert.ok(files.includes('scripts/release.mjs'), 'the file the defect shipped in must be in scope');
  assert.ok(files.includes('packages/core/lib/git.mjs'), 'core must be in scope');

  const offenders = files.flatMap(scan);
  assert.deepEqual(offenders, [],
    'use a \\uXXXX escape, never a raw control byte — see issue #215');
});

test('this guard covers the file it lives in', () => {
  // The first version of this check (in release-artifact.test.mjs) inspected
  // three named files while its OWN comment carried the byte it warns about.
  // A guard that cannot see itself is half a guard.
  const files = trackedTextFiles();
  assert.ok(files.includes('scripts/test/source-hygiene.test.mjs'),
    'source-hygiene.test.mjs must be scanned by its own check');
});

test('the scanner detects a planted control character and a planted bidi override', () => {
  // Absence-only assertions prove nothing about a scanner that returns nothing.
  // These two prove it is awake, without writing a bad byte to disk.
  const NUL = String.fromCharCode(0);
  const RLO = String.fromCharCode(0x202e);

  const probe = (body) => {
    const hits = [];
    let line = 1;
    for (const ch of body) {
      const code = ch.codePointAt(0);
      if (code === 0x0a) line++;
      else if (isForbiddenControl(code) || BIDI.has(code)) hits.push(`line ${line}: U+${code.toString(16)}`);
    }
    return hits;
  };

  assert.equal(probe(`const a = 'x${NUL}y';\n`).length, 1, 'a raw NUL must be detected');
  assert.equal(probe(`const a = 'x${RLO}y';\n`).length, 1, 'a bidi override must be detected');
  assert.deepEqual(probe('const ok = `a\\u0000b`;\n\tindented\r\n'), [],
    'escapes, tabs, newlines and CR must all be accepted');
});

test('the composite-key separator survives the escape rewrite', () => {
  // git.mjs and reactive-gate.mjs used a raw NUL as a key separator. Rewriting
  // it as an escape is representation-only — this pins that the RUNTIME value is
  // unchanged, so the fix cannot have altered key semantics.
  const source = readFileSync(join(REPO_ROOT, 'packages', 'core', 'lib', 'git.mjs'), 'utf8');
  assert.match(source, /\\u0000/, 'the separator must be written as an escape');

  const key = `a\u0000b`;
  assert.deepEqual([...key].map((c) => c.charCodeAt(0)), [97, 0, 98],
    'the escape must still produce the NUL byte at runtime');
});

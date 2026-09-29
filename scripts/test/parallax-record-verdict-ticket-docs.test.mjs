// parallax-record-verdict-ticket-docs.test.mjs — every documented
// `parallax ... --record-verdict` invocation must also pass `--ticket`.
//
// The parallax CLI refuses --record-verdict without --ticket (exit 1, nothing
// recorded), because an unbound record could satisfy any ticket's P1 gate. A
// harness command or README that spells the invocation without --ticket sends
// an agent following it verbatim straight into that refusal, so the P1 evidence
// the step exists to produce is never written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC_ROOTS = ['plugins', '.claude', 'packages', 'apps/docs/content', 'docs'];
const DOC_EXT = /\.(md|mdx|mdc)$/;

function trackedDocs() {
  const out = execFileSync('git', ['ls-files', '--', ...DOC_ROOTS], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').filter((p) => DOC_EXT.test(p) && !p.includes('/test/'));
}

// Inline code spans (which may wrap across lines) plus every line inside a
// fenced block: the places a reader copies a command from.
export function commandSnippets(text) {
  const fenced = [];
  const withoutFences = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, body) => {
    fenced.push(...body.split('\n'));
    return '';
  });
  const inline = [...withoutFences.matchAll(/`([^`]+)`/g)].map((m) => m[1].replace(/\s+/g, ' '));
  return [...inline, ...fenced];
}

export function unboundParallaxRecords(text) {
  return commandSnippets(text).filter(
    (s) => /\bparallax\b/.test(s) && /--record-verdict\b/.test(s) && !/--ticket\b/.test(s)
  );
}

test('commandSnippets/unboundParallaxRecords flag an inline and a fenced unbound invocation', () => {
  const doc = 'Run `adlc parallax --request "x"\n--prompt-only --record-verdict f`.\n\n```sh\nparallax --prompt-only --record-verdict -\nparallax --prompt-only --record-verdict - --ticket T1\n```\n';
  assert.deepEqual(unboundParallaxRecords(doc), [
    'adlc parallax --request "x" --prompt-only --record-verdict f',
    'parallax --prompt-only --record-verdict -',
  ]);
});

test('the guard premise holds: parallax refuses --record-verdict without --ticket', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parallax-ticket-docs-'));
  try {
    const r = spawnSync(process.execPath, [join(ROOT, 'packages/parallax/bin/parallax.mjs'),
      '--request', 'Add login', '--prompt-only', '--record-verdict', 'v.txt'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--record-verdict requires --ticket/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no tracked doc documents parallax --record-verdict without --ticket', () => {
  const offenders = trackedDocs().flatMap((rel) =>
    unboundParallaxRecords(readFileSync(join(ROOT, rel), 'utf8')).map((s) => `${rel}: ${s}`)
  );
  assert.deepEqual(offenders, [], `add --ticket <id> to:\n  ${offenders.join('\n  ')}`);
});

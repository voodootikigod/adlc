// The ambiguous-width opt-in, exercised the way an operator actually gets it:
// as an environment variable on a launched process.
//
// display-width.test.mjs passes { ambiguousWide } explicitly, which proves the
// measurement but not the WIRING — board-render reads process.env once at module
// load, so nothing in-process can show that the variable reaches the renderer.
// A subprocess can.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PLUGIN = join(HERE, '..');

/** Render one board in a fresh process with the given env, return its rows. */
function renderIn(env) {
  const script = `
    import { renderBoard } from ${JSON.stringify(join(PLUGIN, 'lib/board-render.mjs'))};
    const out = renderBoard({
      width: 40,
      repoRoot: '/r',
      active: { state: 'active', id: 't-b' },
      phase: 'P4',
      groups: { ready: [{ id: 't-x', title: '\\u2460'.repeat(60) }], inFlight: [], blocked: [] },
      paneRows: [],
      ledger: [],
    });
    process.stdout.write(JSON.stringify(out.split('\\n').map((l) => l.replace(/\\x1b\\[[0-9;]*m/g, ''))));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

/** Glyph count of the ambiguous run — an oracle independent of displayWidth. */
const circled = (rows) => Math.max(...rows.map((row) => [...row].filter((ch) => ch === '①').length));

test('ADLC_HERDR_AMBIGUOUS_WIDTH=wide halves the ambiguous glyphs a row keeps', () => {
  // Counting glyphs rather than asking displayWidth: on an ambiguous-wide
  // terminal each circled digit occupies two cells, so a 40-column row can hold
  // at most twenty of them. The default keeps twice that.
  const narrow = circled(renderIn({ ADLC_HERDR_AMBIGUOUS_WIDTH: '' }));
  const wide = circled(renderIn({ ADLC_HERDR_AMBIGUOUS_WIDTH: 'wide' }));

  assert.ok(narrow > 20, `default should fill the pane with ${narrow} glyphs`);
  assert.ok(wide <= 20, `wide mode must keep at most twenty glyphs, kept ${wide}`);
  assert.ok(wide < narrow, 'the variable must actually change what is emitted');
});

test('any other value keeps the narrow default', () => {
  for (const value of ['', 'narrow', 'true', '1']) {
    assert.ok(circled(renderIn({ ADLC_HERDR_AMBIGUOUS_WIDTH: value })) > 20, `${JSON.stringify(value)} must not enable wide mode`);
  }
});

test('the README documents the variable and how to pass it', () => {
  // The only remediation for an affected terminal is this flag; undocumented,
  // it does not exist for the operator who needs it.
  const readme = readFileSync(join(PLUGIN, 'README.md'), 'utf8');
  assert.match(readme, /ADLC_HERDR_AMBIGUOUS_WIDTH=wide/);
  assert.match(readme, /--env ADLC_HERDR_AMBIGUOUS_WIDTH=wide/, 'and show it on the pane-open command');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const APPROVED = new Set([
  'packages/core/lib/scaffold-hygiene.mjs',
  'packages/ticket-prune/lib/store.mjs', // 1.x legacy compatibility adapter
  'packages/ticket-sync/lib/store.mjs', // 1.x legacy compatibility adapter
  'plugins/adlc-claude-code/hooks/adlc-hook.mjs',
  'plugins/adlc-codex/hooks/adlc-rails-guard.mjs',
  'plugins/adlc-copilot/hooks/adlc-rails-guard.mjs',
  'plugins/adlc-cursor/hooks/adlc-pretool.mjs',
  'plugins/adlc-pi/lib/commands.mjs',
  'plugins/adlc-antigravity/build-gate-inline.mjs',
  // Reader, not a writer: fleet loads the plan (read-only) and reports the
  // '.adlc/tickets.json' path only in an error string; its writeFileSync/mkdirSync/
  // rmSync calls target sandbox temp dirs (mkdtempSync), never the ticket store.
  'packages/fleet/bin/fleet.mjs',
]);

function filesBelow(path) {
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'test') continue;
    const full = join(path, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(full));
    else if (entry.name.endsWith('.mjs')) files.push(full);
  }
  return files;
}

export function isDirectWriterBypass(name, body) {
  const mutation = /\b(?:writeFileSync|renameSync|rmSync|unlinkSync|appendFileSync|mkdirSync)\b/;
  const trustRoot = /\.adlc\/tickets(?:\.json|\/)/;
  if (name.startsWith('packages/tickets/') || name.startsWith('scripts/ticket-readers/') || name.includes('/generated-ticket-reader.mjs') || name.endsWith('-install-smoke.mjs')) return false;
  return mutation.test(body) && trustRoot.test(body) && !APPROVED.has(name);
}

export function directWriterBypasses(files) {
  return files.filter((path) => {
    const name = relative(ROOT, path).replaceAll('\\', '/');
    return isDirectWriterBypass(name, readFileSync(path, 'utf8'));
  }).map((path) => relative(ROOT, path).replaceAll('\\', '/')).sort();
}

test('production ticket-store filesystem writers are confined to approved adapters', () => {
  const files = ['packages', 'plugins', 'scripts'].flatMap((path) => filesBelow(join(ROOT, path)));
  assert.deepEqual(directWriterBypasses(files), []);
});

// ---------------------------------------------------------------------------
// The active-ticket pointer has exactly ONE reader.
//
// It used to have ten hand-copied ones. They drifted into two key sets and three
// hash-strictness levels, so the same .adlc/current-ticket.json enforced in some
// harnesses and read as "no active ticket" — ALLOW — in others. A grep for "KEEP
// IN SYNC" cannot catch that (the comments were present and still wrong); the
// only durable check is that nobody parses the pointer themselves.
// ---------------------------------------------------------------------------

/** Only these may name the pointer path AND parse JSON: the canonical source and its generated copies. */
const POINTER_SOURCES = [
  'packages/tickets/lib/pointer.mjs',
  'packages/tickets/lib/pointer-write.mjs',
];

export function isPointerParseBypass(name, body) {
  if (POINTER_SOURCES.includes(name) || name.includes('/generated-active-ticket.mjs')) return false;
  if (name.startsWith('scripts/ticket-readers/')) return false;

  // Proximity, not mere co-occurrence. Naming the pointer is legitimate (it is a
  // rail glob and it appears in messages), and `x.id ?? '?'` is ordinary ticket
  // handling. The bypass is READING THE POINTER PATH and picking an id key out of
  // that read — so only count the two when they sit together.
  //
  // Both halves must stay SYNTAX-AGNOSTIC. An earlier version required
  // `JSON.parse(readFileSync` adjacent and an `??` id pick, which a prosecution
  // pass walked straight through: `||` instead of `??`, destructuring, an
  // if-statement fallback, and the two-statement read/parse form — the last being
  // the idiom packages/tickets/lib/pointer.mjs itself uses, so a harness author
  // copying the canonical style was invisible. Match the INTENT (read the pointer,
  // reach for an id key), not one spelling of it.
  const WINDOW = 600;
  const reads = /readFileSync|readFile\b|JSON\.parse|read(?:Optional|Required)?Json\s*\(/;
  const picksIdKey = new RegExp(
    [
      String.raw`\.\s*(?:id|ticket|ticketId)\b`, // data.id / data.ticketId (any operator after)
      String.raw`\[\s*['"](?:id|ticket|ticketId)['"]\s*\]`, // data['id']
      String.raw`\{[^}]*\b(?:id|ticket|ticketId)\b[^}]*\}\s*=`, // const { id, ticketId } = data
    ].join('|'),
  );

  for (const match of body.matchAll(/current-ticket\.json/g)) {
    const near = body.slice(Math.max(0, match.index - WINDOW), match.index + WINDOW);
    if (reads.test(near) && picksIdKey.test(near)) return true;
  }
  return false;
}

test('the active-ticket pointer is parsed in exactly one place', () => {
  const files = ['packages', 'plugins'].flatMap((path) => filesBelow(join(ROOT, path)));
  const offenders = files
    .filter((path) => isPointerParseBypass(relative(ROOT, path).replaceAll('\\', '/'), readFileSync(path, 'utf8')))
    .map((path) => relative(ROOT, path).replaceAll('\\', '/'))
    .sort();
  assert.deepEqual(offenders, [], 'these hand-parse the pointer instead of using the generated reader');
});

test('the pointer-parse detector catches every realistic hand-rolled shape', () => {
  // Each of these evaded an earlier, syntax-bound version of this detector while
  // the whole suite stayed green. They are pinned here so it cannot narrow again:
  // a guard that only catches ONE spelling of the defect is not a guard.
  const evasions = {
    'nullish (the original shape)': `
      const data = JSON.parse(readFileSync('.adlc/current-ticket.json', 'utf8'));
      const raw = data.id ?? data.ticket;`,
    'logical-or instead of nullish': `
      const data = JSON.parse(readFileSync('.adlc/current-ticket.json', 'utf8'));
      const raw = data.id || data.ticket;`,
    'two-statement read then parse (the canonical module s own idiom)': `
      const text = readFileSync('.adlc/current-ticket.json', 'utf8');
      const data = JSON.parse(text);
      const raw = data.id;`,
    'destructuring': `
      const data = JSON.parse(readFileSync('.adlc/current-ticket.json', 'utf8'));
      const { id, ticketId } = data;`,
    'if-statement fallback': `
      const data = JSON.parse(readFileSync('.adlc/current-ticket.json', 'utf8'));
      let raw = data.id;
      if (!raw) raw = data.ticketId;`,
    'bracket access': `
      const data = JSON.parse(readFileSync('.adlc/current-ticket.json', 'utf8'));
      const raw = data['ticketId'];`,
  };
  for (const [label, source] of Object.entries(evasions)) {
    assert.equal(
      isPointerParseBypass('plugins/adlc-whatever/rails-checker.mjs', source),
      true,
      `a hand-rolled pointer reader using ${label} evaded the boundary check`,
    );
  }
});

test('the pointer-parse detector rejects a planted hand-rolled reader', () => {
  // The exact shape that caused the outage: an id-key guess that misses is read as
  // "no active ticket" and allows the build.
  const planted = `
    const data = JSON.parse(readFileSync('.adlc/current-ticket.json', 'utf8'));
    const raw = data.id ?? data.ticket;
  `;
  assert.equal(isPointerParseBypass('plugins/adlc-whatever/rails-checker.mjs', planted), true);
  assert.equal(isPointerParseBypass('packages/tickets/lib/pointer.mjs', planted), false);
  assert.equal(isPointerParseBypass('plugins/adlc-codex/hooks/generated-active-ticket.mjs', planted), false);

  // And it must not fire on the legitimate shapes that live in the same files:
  // naming the pointer as a rail glob, and ordinary `ticket.id ?? '?'` handling
  // hundreds of lines away from any pointer read.
  const legitimate = `
    const rails = [...declaredRails, '.adlc/current-ticket.json'];
    ${'// filler\\n'.repeat(60)}
    errors.push(\`\${ticket.id ?? '?'}: missing string title\`);
  `;
  assert.equal(isPointerParseBypass('plugins/adlc-codex/hooks/adlc-rails-guard.mjs', legitimate), false);
});

test('the boundary detector rejects a planted direct writer', () => {
  const source = "import { writeFileSync } from 'node:fs'; writeFileSync('.adlc/tickets/evil.json', '{}');";
  assert.equal(isDirectWriterBypass('packages/evil.mjs', source), true);
  assert.equal(statSync(ROOT).isDirectory(), true);
});

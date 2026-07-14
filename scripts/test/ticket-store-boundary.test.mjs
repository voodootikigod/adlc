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
  'plugins/adlc-cursor/hooks/adlc-pretool.mjs',
  'plugins/adlc-pi/lib/commands.mjs',
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

test('the boundary detector rejects a planted direct writer', () => {
  const source = "import { writeFileSync } from 'node:fs'; writeFileSync('.adlc/tickets/evil.json', '{}');";
  assert.equal(isDirectWriterBypass('packages/evil.mjs', source), true);
  assert.equal(statSync(ROOT).isDirectory(), true);
});

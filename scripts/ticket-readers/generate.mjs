import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const source = join(root, 'scripts/ticket-readers/read-only-loader.mjs');
const body = readFileSync(source, 'utf8').replace('// GENERATED-LOADER SOURCE.', '// GENERATED FILE — DO NOT EDIT DIRECTLY.');
const outputs = [
  'plugins/adlc-codex/hooks/generated-ticket-reader.mjs',
  'plugins/adlc-claude-code/hooks/generated-ticket-reader.mjs',
  'plugins/adlc-antigravity/generated-ticket-reader.mjs',
];
const check = process.argv.includes('--check');
const drift = [];
for (const relative of outputs) {
  const output = join(root, relative);
  if (check) {
    if (!existsSync(output) || readFileSync(output, 'utf8') !== body) drift.push(relative);
    continue;
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, body);
}
if (check && drift.length) {
  console.error(`generated ticket readers are stale: ${drift.join(', ')}`);
  process.exitCode = 2;
} else if (check) console.log(`verified ${outputs.length} generated ticket readers`);
else console.log(`generated ${outputs.length} ticket readers`);

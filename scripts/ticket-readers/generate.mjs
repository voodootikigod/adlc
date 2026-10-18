import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

// Each artifact is copied verbatim from ONE canonical source into every harness
// that cannot resolve @adlc/* at runtime (spec §14). Hand-maintained copies are
// forbidden: the resolver used to be hand-ported into nine hooks with "KEEP IN
// SYNC" comments, and they drifted into two key sets and three hash-strictness
// levels — which silently disabled enforcement wherever a pointer used a key a
// given copy did not know.
const ARTIFACTS = [
  {
    source: 'scripts/ticket-readers/read-only-loader.mjs',
    marker: '// GENERATED-LOADER SOURCE.',
    outputs: [
      'plugins/adlc-codex/hooks/generated-ticket-reader.mjs',
      'plugins/adlc-claude-code/hooks/generated-ticket-reader.mjs',
      'plugins/adlc-gemini/generated-ticket-reader.mjs',
      'plugins/adlc-copilot/hooks/generated-ticket-reader.mjs',
    ],
  },
  {
    source: 'packages/core/lib/glob.mjs',
    marker: '// GENERATED-GLOB SOURCE.',
    outputs: [
      'plugins/adlc-codex/hooks/generated-glob-match.mjs',
      'plugins/adlc-claude-code/hooks/generated-glob-match.mjs',
      'plugins/adlc-copilot/hooks/generated-glob-match.mjs',
      'plugins/adlc-gemini/generated-glob-match.mjs',
      // @adlc/tickets cannot import @adlc/core — core depends on IT, so the
      // copy goes the same way as the harnesses' rather than inverting that.
      'packages/tickets/lib/generated-glob-match.mjs',
      'packages/core/lib/generated-glob-match.mjs',
    ],
  },
  {
    source: 'packages/tickets/lib/pointer.mjs',
    marker: '// GENERATED-POINTER SOURCE.',
    outputs: [
      'plugins/adlc-codex/hooks/generated-active-ticket.mjs',
      'plugins/adlc-claude-code/hooks/generated-active-ticket.mjs',
      'plugins/adlc-gemini/generated-active-ticket.mjs',
      'plugins/adlc-opencode/generated-active-ticket.mjs',
      'plugins/adlc-cursor/generated-active-ticket.mjs',
      'plugins/adlc-pi/lib/generated-active-ticket.mjs',
      'plugins/adlc-copilot/hooks/generated-active-ticket.mjs',
      'plugins/adlc-herdr/lib/generated-active-ticket.mjs',
    ],
  },
  {
    source: 'packages/core/lib/shell.mjs',
    marker: '// GENERATED-SHELL SOURCE.',
    outputs: [
      'plugins/adlc-codex/hooks/generated-shell.mjs',
      'plugins/adlc-copilot/hooks/generated-shell.mjs',
    ],
  },
  {
    source: 'packages/core/lib/risk-tier.mjs',
    marker: '// GENERATED-RISK-TIER SOURCE.',
    outputs: [
      'plugins/adlc-codex/hooks/generated-risk-tier.mjs',
      'plugins/adlc-copilot/hooks/generated-risk-tier.mjs',
    ],
  },
  {
    source: 'packages/core/lib/trusted-binary.mjs',
    marker: '// GENERATED-TRUSTED-BINARY SOURCE.',
    outputs: [
      'plugins/adlc-claude-code/hooks/generated-trusted-binary.mjs',
      'plugins/adlc-codex/hooks/generated-trusted-binary.mjs',
      'plugins/adlc-copilot/hooks/generated-trusted-binary.mjs',
    ],
  },
];

const check = process.argv.includes('--check');
const drift = [];
let count = 0;

for (const artifact of ARTIFACTS) {
  const source = readFileSync(join(root, artifact.source), 'utf8');
  if (!source.startsWith(artifact.marker)) {
    console.error(`${artifact.source} must start with "${artifact.marker}"`);
    process.exit(1);
  }
  const body = source.replace(artifact.marker, '// GENERATED FILE — DO NOT EDIT DIRECTLY.');
  for (const relative of artifact.outputs) {
    const output = join(root, relative);
    count += 1;
    if (check) {
      if (!existsSync(output) || readFileSync(output, 'utf8') !== body) drift.push(relative);
      continue;
    }
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, body);
  }
}

if (check && drift.length) {
  console.error(`generated ticket readers are stale: ${drift.join(', ')}`);
  process.exitCode = 2;
} else if (check) console.log(`verified ${count} generated ticket readers`);
else console.log(`generated ${count} ticket readers`);

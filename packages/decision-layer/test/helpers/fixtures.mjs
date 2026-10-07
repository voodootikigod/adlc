// Fixtures shared by the CLI and evaluation tests: a git repository whose
// feature branch makes a known change, and a hermetic way to run the CLI.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitRepo, runBin, tmp } from '@adlc/core/test-kit';
import { NO_NETWORK_PRELOAD } from './no-network.mjs';

export const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'adlc-decision.mjs');
export const TICKET_CATEGORY_MARKER = 'category-marker-7f3a';
const CLI_TIMEOUT_MS = 60_000;

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/**
 * A repository on `feature`, branched from `main`, whose change is
 * src/a.mjs (+3), docs/b.md (+1), Makefile (+1) and a binary img.png: four
 * files, five lines added, extensions { mjs, md, none, png }. Its ticket store
 * holds T-1 (category TICKET_CATEGORY_MARKER, two rails), and `.adlc/*` is
 * ignored as in this repository.
 */
export function changeRepo(t) {
  const repo = gitRepo(t, 'decision-repo-');
  const { dir, git } = repo;
  write(dir, '.gitignore', '.adlc/*\n!.adlc/tickets.json\n');
  write(dir, '.adlc/tickets.json', JSON.stringify({
    schema: 1,
    tickets: [{ id: 'T-1', title: 'fixture ticket', category: TICKET_CATEGORY_MARKER, rails: ['src/a.mjs', 'docs/b.md'] }],
  }));
  write(dir, 'README.md', 'base\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature');
  write(dir, 'src/a.mjs', 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
  write(dir, 'docs/b.md', '# b\n');
  write(dir, 'Makefile', 'all:\n');
  writeFileSync(join(dir, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  return repo;
}

/** Write `body` (JSON-encoded unless a string) to a scratch file and return its path. */
export function responseFile(t, body) {
  const path = join(tmp(t, 'decision-response-'), 'response.json');
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  return path;
}

/**
 * Run the CLI with no provider credentials and fetch made fatal.
 * @param {object} t test context
 * @param {string[]} args
 * @param {{ cwd: string, env?: Record<string, string> }} options
 */
export function runCli(t, args, { cwd, env = {} }) {
  return runBin(BIN, args, {
    cwd,
    timeout: CLI_TIMEOUT_MS,
    env: {
      HOME: tmp(t, 'decision-home-'),
      TYPESAFE_API_KEY: '',
      JEV_API_KEY: '',
      TYPESAFE_API_URL: '',
      NODE_OPTIONS: `--import=${NO_NETWORK_PRELOAD}`,
      ...env,
    },
  });
}

/** A reply from the mock that the reducer turns into `outcome`. */
export const REPLIES = {
  allow: { answers: [{ id: 'risk', value: 'low', probability: 0.9 }, { id: 'needs-deeper-interrogation', value: 'no', probability: 0.9 }] },
  escalate: { answers: [{ id: 'risk', value: 'high', probability: 0.9 }, { id: 'needs-deeper-interrogation', value: 'no', probability: 0.9 }] },
  unknown: { simulate: 'timeout' },
  error: { answers: [{ id: 'risk', value: 'extreme' }, { id: 'needs-deeper-interrogation', value: 'no' }] },
};

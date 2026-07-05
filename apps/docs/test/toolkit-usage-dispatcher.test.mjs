import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Getting Started tells users to install ONLY the @adlc/cli dispatcher, so every
// command a toolkit page shows must go through `adlc <tool>` — a bare tool binary
// (`hollow-test …`, `$ premortem …`) is "command not found" on a machine that
// followed the quickstart. This guard was distilled from an adversarial-review
// finding; see the review notes on the 2026-07-05 docs fan-out.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const toolkitDir = path.join(__dirname, '..', 'content', 'docs', 'toolkit');

// Pages that document the dispatcher/foundation itself, not a dispatched tool.
const NON_TOOL_PAGES = new Set(['index', 'cli', 'core']);

const slugs = readdirSync(toolkitDir)
  .filter((f) => f.endsWith('.mdx'))
  .map((f) => f.replace(/\.mdx$/, ''))
  .filter((slug) => !NON_TOOL_PAGES.has(slug));

function shBlocks(content) {
  const blocks = [];
  const re = /```sh\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(content)) !== null) blocks.push(m[1]);
  return blocks;
}

// A block with `$ ` lines is an example transcript: only the `$ ` lines are
// commands (the rest is program output). A block without them is a usage
// synopsis: every non-empty line is a command.
function commandLines(block) {
  const lines = block.split('\n');
  const dollar = lines.filter((l) => l.startsWith('$ '));
  if (dollar.length > 0) return dollar.map((l) => l.slice(2));
  return lines.filter((l) => l.trim() !== '');
}

test('every toolkit-page command dispatches through `adlc <tool>` — no bare tool binaries', () => {
  const violations = [];

  for (const file of readdirSync(toolkitDir).filter((f) => f.endsWith('.mdx'))) {
    const content = readFileSync(path.join(toolkitDir, file), 'utf8');
    for (const block of shBlocks(content)) {
      for (const cmd of commandLines(block)) {
        const firstToken = cmd.trim().split(/\s+/)[0];
        if (slugs.includes(firstToken)) {
          violations.push(`${file}: "${cmd.trim()}" — use \`adlc ${firstToken} …\``);
        }
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `bare tool binaries in toolkit docs (Getting Started installs only @adlc/cli):\n  ${violations.join('\n  ')}`
  );
});

test('the guard itself detects a planted bare binary (self-test)', () => {
  const planted = '```sh\nhollow-test --test-cmd "npm test"\n```';
  const block = shBlocks(planted)[0];
  const cmds = commandLines(block);
  assert.ok(
    cmds.some((c) => slugs.includes(c.trim().split(/\s+/)[0])),
    'a bare `hollow-test` command must be recognized as a violation'
  );
});

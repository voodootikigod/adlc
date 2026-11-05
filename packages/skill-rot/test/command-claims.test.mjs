/**
 * What counts as a command claim (T-01M6MX48CNWXSXRSQ7R9Y5GVHW,
 * .adlc/specs/skill-rot-command-claims.md).
 *
 * Both directions are pinned: names written in backticks must NOT become
 * command claims (AC1, AC3, AC4, AC6), and invocations must (AC2, AC3, AC5),
 * so a skill that documents a removed CLI still fails the gate.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp } from '@adlc/core/test-kit';

import { extractClaims } from '../lib/extract-claims.mjs';

const BIN = fileURLToPath(new URL('../bin/skill-rot.mjs', import.meta.url));
const OPENCODE_ROUTER = fileURLToPath(new URL('../../../plugins/adlc-opencode/skill/adlc.md', import.meta.url));

const commands = (content) => extractClaims(content).filter((c) => c.type === 'command').map((c) => c.value);
const paths = (content) => extractClaims(content).filter((c) => c.type === 'path').map((c) => c.value);

// Measured false positives: the deployed OpenCode router, and a consumer repo's skills.
const NAMES = [
  'execute.before',
  'advisoryHooks',
  'edit',
  'write',
  'adversarial-review',
  'followUp.implementationSkill',
  'typescript',
  'node_modules',
  'SKILL.md',
  'github.blobBaseUrl',
  'untranslated-string-audit.profile.yml',
  'gpt-5.6-terra-high',
  'claude-opus-4-8-thinking-high',
  'spec_hash',
  'PreToolUse',
  'compare before.json after.json',
  'refname is ambiguous',
];

describe('inline spans: names are not commands (AC1)', () => {
  for (const name of NAMES) {
    test(`\`${name}\` gives no command claim`, () => {
      assert.deepEqual(commands(`Set \`${name}\` in the config.`), []);
    });
  }

  test('a dotted, camelCase or uppercase first word disqualifies a span even with a flag', () => {
    assert.deepEqual(commands('`execute.before --x`, `advisoryHooks --on`, `Gate --x`'), []);
  });
});

describe('inline spans: invocations are commands (AC2)', () => {
  const cases = [
    ['ls -la', 'ls'],
    ['definitely-not-a-binary-xyz --flag', 'definitely-not-a-binary-xyz'],
    ['npx adversarial-review', 'npx'],
    ['git', 'git'],
    ['$ removed-cli-xyz', 'removed-cli-xyz'],
    ['pg_dump -Fc db', 'pg_dump'],
  ];
  for (const [span, value] of cases) {
    test(`\`${span}\` claims ${value}`, () => {
      assert.deepEqual(commands(`Run \`${span}\` first.`), [value]);
    });
  }

  test('every listed launcher claims itself as a bare word', () => {
    const launchers = 'adlc npx npm pnpm yarn bun bunx node deno git gh docker make python python3 pip cargo go curl sh bash'.split(' ');
    for (const launcher of launchers) {
      assert.deepEqual(commands(`Use \`${launcher}\`.`), [launcher], launcher);
    }
  });

  test('a single-dash and a double-dash flag both mark an invocation; a lone dash does not', () => {
    assert.deepEqual(commands('`mytool -v`'), ['mytool']);
    assert.deepEqual(commands('`mytool --verbose`'), ['mytool']);
    assert.deepEqual(commands('`mytool - x`'), []);
    assert.deepEqual(commands('`mytool x -- y`'), []);
  });

  test('`$ ` must be followed by a command-shaped word', () => {
    assert.deepEqual(commands('`$ Foo`'), []);
    assert.deepEqual(commands('`$ removed.cli`'), []);
  });
});

describe('fenced blocks (AC3)', () => {
  test('non-shell fences give no claims', () => {
    for (const lang of ['ts', 'json', 'text', 'yaml', 'tsx', 'md']) {
      const content = `\`\`\`${lang}\nconst x = 1\nawait run()\nremoved-cli-xyz build\nsrc/missing.mjs\n\`\`\``;
      assert.deepEqual(extractClaims(content), [], lang);
    }
  });

  test('the info string is read case-insensitively and by its first word', () => {
    assert.deepEqual(commands('```Bash title="setup"\nremoved-cli-xyz build\n```'), ['removed-cli-xyz']);
  });

  test('a box-drawing diagram in an unlabelled fence gives no claim', () => {
    const content = '```\nVague request, no ticket yet? ───→ P0  adlc ticket create\nIdle-time maintenance? ──→ —   adlc skill-rot\n```';
    assert.deepEqual(commands(content), []);
  });

  test('shell fences and unlabelled fences still give command claims', () => {
    assert.deepEqual(commands('```bash\nremoved-cli-xyz build\n```'), ['removed-cli-xyz']);
    assert.deepEqual(commands('```console\n$ git status\n```'), ['git']);
    assert.deepEqual(commands('```\ngit status\n```'), ['git']);
    for (const lang of ['sh', 'zsh', 'shell', 'shell-session', 'terminal', 'fish', 'ksh']) {
      assert.deepEqual(commands(`\`\`\`${lang}\nremoved-cli-xyz build\n\`\`\``), ['removed-cli-xyz'], lang);
    }
  });

  test('a path line in a shell fence is still a path claim', () => {
    assert.deepEqual(paths('```bash\n./scripts/setup.sh --fast\n```'), ['./scripts/setup.sh']);
  });
});

describe('linked code spans (AC4)', () => {
  test('a code span that is the whole text of an absolute-URL link gives no claim', () => {
    const content = 'See [`docs/x.md`](https://github.com/o/r/blob/main/docs/x.md) and [`npx foo --bar`](http://example.com).';
    assert.deepEqual(extractClaims(content), []);
  });

  test('a relative link and a bare span still give a path claim', () => {
    assert.deepEqual(paths('See [`docs/x.md`](../docs/x.md).'), ['docs/x.md']);
    assert.deepEqual(paths('See `docs/x.md`.'), ['docs/x.md']);
  });

  test('a span that is only part of the link text is still a claim', () => {
    assert.deepEqual(paths('See [the `docs/x.md` file](https://example.com).'), ['docs/x.md']);
  });
});

describe('end to end through the real CLI (AC5)', () => {
  function run(dir) {
    return spawnSync(process.execPath, [BIN, 'skills', '--json'], { cwd: dir, encoding: 'utf8' });
  }
  function skill(dir, body) {
    mkdirSync(join(dir, 'skills', 's'), { recursive: true });
    writeFileSync(join(dir, 'skills', 's', 'SKILL.md'), body, 'utf8');
  }

  test('a skill documenting a removed CLI in a bash fence fails the gate', (t) => {
    const dir = tmp(t, 'skill-rot-command-claims-');
    skill(dir, '# S\n\n```bash\nremoved-cli-xyz --version\n```\n');
    const r = run(dir);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /command not found: removed-cli-xyz/);
  });

  test('a skill whose only spans are names passes with no claims', (t) => {
    const dir = tmp(t, 'skill-rot-command-claims-');
    skill(dir, `# S\n\n${NAMES.map((n) => `- \`${n}\``).join('\n')}\n`);
    const r = run(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const summary = JSON.parse(r.stdout).summary;
    assert.equal(summary.noClaims, 1);
    assert.equal(summary.stale, 0);
  });
});

describe('the real deployed OpenCode router (AC6)', () => {
  test('no command claim from the names it mentions', () => {
    const found = commands(readFileSync(resolve(OPENCODE_ROUTER), 'utf8'));
    for (const name of ['adversarial-review', 'execute.before', 'edit', 'write', 'advisoryHooks']) {
      assert.ok(!found.includes(name), `router yields command claim ${name}: ${found.join(', ')}`);
    }
  });
});

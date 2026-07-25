// skills-catalog.test.mjs — the top-level skills/ catalog is what skills.sh
// installs (`npx skills add voodootikigod/adlc`).
//
// That channel delivers SKILLS ONLY: no hooks, no MCP tools, no agents, no
// in-session rail enforcement. It is a strictly weaker install than any native
// plugin, so two things have to stay true or the catalog becomes a liability:
//
//   1. It must be harness-NEUTRAL. A `/adlc:` or `$adlc-` reference is a broken
//      instruction in 69 of the ~70 harnesses the skills CLI supports.
//   2. It must not DRIFT from the per-harness plugin skills. A gate added to
//      the Claude Code router and forgotten here silently ships a catalog that
//      routes agents to a lifecycle missing a phase.
//
// Both are asserted mechanically here rather than left to review.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { TOOLS } from '../../packages/cli/lib/registry.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalogDir = path.join(repoRoot, 'skills');
const read = (abs) => readFileSync(abs, 'utf8');

/** Every skill in the top-level catalog, as { name, dir, abs, text }. */
function catalogSkills() {
  return readdirSync(catalogDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => {
      const abs = path.join(catalogDir, entry.name, 'SKILL.md');
      return { dir: entry.name, abs, text: read(abs) };
    });
}

/**
 * The frontmatter block the skills CLI parses. Deliberately a narrow reader —
 * it asserts the shape the CLI needs (leading `---` fence, `key: value` lines),
 * not general YAML, so a file that only parses under a lenient parser fails.
 */
function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  assert.ok(match, 'SKILL.md must open with a --- fenced frontmatter block');
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w.-]*):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

const CANONICAL_TOOLS = TOOLS.map((tool) => tool.name);

/**
 * A tool name counts as "named" only when it is invoked, not when it appears
 * inside a path. `packages/ticket-prune|ticket-sync/` names two PACKAGES in a
 * trust-root tier list; it does not route to those gates. The lookbehind
 * excludes any path-ish leading character so a directory listing can never be
 * mistaken for a route.
 */
function namesTool(text, tool) {
  return new RegExp(`(?<![\\w./-])${tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text);
}

test('catalog exists and every skill has CLI-parseable frontmatter', () => {
  assert.ok(existsSync(catalogDir), 'skills/ must exist — it is what `npx skills add` discovers');
  const skills = catalogSkills();
  assert.ok(skills.length > 0, 'skills/ must contain at least one skill directory');

  const routerNames = skills.map((skill) => {
    const fields = frontmatter(skill.text);
    assert.ok(fields.name, `${skill.dir}: frontmatter needs a non-empty name`);
    assert.ok(fields.description, `${skill.dir}: frontmatter needs a non-empty description`);
    // The CLI keys installs off the directory; a mismatch installs under a name
    // the description does not describe.
    assert.equal(fields.name, skill.dir, `${skill.dir}: frontmatter name must match its directory`);
    return fields.name;
  });

  assert.ok(routerNames.includes('adlc'), 'the catalog must ship the `adlc` phase router');
});

test('catalog skills are harness-neutral', () => {
  // Each of these is a real invocation form in a native plugin, and each is
  // wrong everywhere else: Claude Code's `/adlc:*`, Codex's `$adlc-*`, and the
  // Cursor/OpenCode `/adlc-*` command families.
  //
  // The leading lookbehind matters: a bare `/adlc-` substring also matches the
  // PATH `docs/ci/adlc-maintenance.yml`. A slash command's `/` is preceded by
  // whitespace, a backtick, or start-of-line — never by a path character.
  const HARNESS_SYNTAX = [
    { label: '/adlc:', pattern: /(?<![\w./-])\/adlc:/ },
    { label: '$adlc-', pattern: /\$adlc-/ },
    { label: '/adlc-', pattern: /(?<![\w./-])\/adlc-/ },
  ];

  for (const skill of catalogSkills()) {
    for (const { label, pattern } of HARNESS_SYNTAX) {
      assert.ok(
        !pattern.test(skill.text),
        `skills/${skill.dir}/SKILL.md contains harness-specific syntax ${JSON.stringify(label)} — ` +
          'the catalog installs into ~70 harnesses and must drive the ADLC through the `adlc` CLI only',
      );
    }
  }
});

/**
 * Everything after the frontmatter fence. The drift check runs against the BODY
 * because the frontmatter `description` is a trigger list, not a route: a gate
 * deleted from the routing table but left in the trigger string would otherwise
 * still read as "named" and the drift would ship.
 */
function body(text) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(text);
  assert.ok(match, 'SKILL.md must open with a --- fenced frontmatter block');
  return match[1];
}

test('the neutral router does not drift from the Claude Code phase router', () => {
  const neutral = body(read(path.join(catalogDir, 'adlc', 'SKILL.md')));
  const claude = body(read(path.join(repoRoot, 'plugins/adlc-claude-code/skills/adlc/SKILL.md')));

  // Anchor on the dispatcher's own registry rather than on prose parsing: any
  // canonical tool the Claude router routes to must also be routable from the
  // neutral one. Adding a gate to one and not the other fails here.
  const routedByClaude = CANONICAL_TOOLS.filter((tool) => namesTool(claude, tool));
  assert.ok(routedByClaude.length > 5, 'sanity: the Claude router should name many canonical tools');

  const missing = routedByClaude.filter((tool) => !namesTool(neutral, tool));
  assert.deepEqual(
    missing,
    [],
    `skills/adlc/SKILL.md is missing gate(s) the Claude Code router routes to: ${missing.join(', ')}`,
  );

  for (const phase of ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7']) {
    assert.ok(namesTool(neutral, phase), `skills/adlc/SKILL.md must route phase ${phase}`);
  }
});

test('every catalog skill teaches commands that actually exist', () => {
  // The name-level drift check above covers routing coverage, not command
  // CORRECTNESS: a skill can name every gate and still teach an invocation that
  // cannot run. That is not hypothetical — a published skill shipped
  // `adlc prosecute --ticket <id>` while the CLI requires `--input`.
  //
  // Every `adlc <tool>` invocation in the catalog is checked against the
  // dispatcher's real registry, and any tool with required flags is checked for
  // them. Scoped to what is mechanically verifiable offline; the broader
  // semantic-drift gap is recorded in the spec rather than claimed as covered.
  const REQUIRED_FLAGS = new Map([['prosecute', ['--input']]]);

  for (const skill of catalogSkills()) {
    const text = body(skill.text);
    // Fenced command lines only — prose mentions a tool without invoking it.
    const invocations = [...text.matchAll(/^\s*adlc ([a-z][\w-]*)([^\n]*)$/gm)];

    for (const [, tool, rest] of invocations) {
      // Subcommands of the dispatcher itself (run/accept) and ticket verbs are
      // not registry tools.
      if (['run', 'accept', 'init', 'ticket'].includes(tool)) continue;
      assert.ok(
        CANONICAL_TOOLS.includes(tool),
        `skills/${skill.dir}/SKILL.md invokes "adlc ${tool}", which is not a registered tool`,
      );

      const required = REQUIRED_FLAGS.get(tool);
      if (!required) continue;
      // record-cross-model is a subcommand with its own flag contract.
      if (rest.includes('record-cross-model')) continue;
      for (const flag of required) {
        assert.ok(
          rest.includes(flag),
          `skills/${skill.dir}/SKILL.md invokes "adlc ${tool}" without required ${flag}`,
        );
      }
    }
  }
});

test('the skills smoke resolves its target from argv, and refuses a tree with no catalog', () => {
  // Offline coverage for the smoke script's own argument handling. Without it,
  // an off-by-one in argv silently retargets the smoke at the CWD — it would
  // still "pass" against this repo while testing nothing the operator asked
  // about. The repo's mutation-gate caught exactly that mutant surviving.
  const emptyDir = mkdtempSync(path.join(tmpdir(), 'adlc-no-catalog-'));
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'scripts/skills-add-smoke.mjs'), emptyDir],
      { encoding: 'utf8', cwd: repoRoot, timeout: 30_000 },
    );

    assert.equal(result.status, 1, 'a tree with no skills/ must fail the smoke, not pass it');
    assert.ok(
      result.stdout.includes(emptyDir),
      `the smoke must report the target it resolved from argv; stdout was:\n${result.stdout}`,
    );
    assert.match(
      result.stderr,
      /does not exist/,
      'the smoke must say why it refused, naming the missing catalog',
    );
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('every surface that recommends skills.sh states the channel is skills only', () => {
  // ADR-0009 Decision 4: we document only the coverage a channel actually has.
  // skills.sh installs no hooks, no MCP, no agents, and no rail enforcement, so
  // any file that sends a reader there has to say so.
  const CANDIDATES = [
    'README.md',
    'skills/adlc/SKILL.md',
    'skills/adlc-init/SKILL.md',
    'skills/adlc-prosecute/SKILL.md',
    'docs/integrations/index.md',
    'apps/docs/content/docs/integrations/index.mdx',
  ];

  let checked = 0;
  for (const relative of CANDIDATES) {
    const abs = path.join(repoRoot, relative);
    if (!existsSync(abs)) continue;
    const text = read(abs);
    // Trigger on the install command for OUR catalog, not on the word
    // "skills.sh". Two other mentions are legitimate and unrelated:
    // `npx skills add voodootikigod/skill-mining` is the P7 mining tool, and
    // the router cites the skills.sh registry as what skill-mining dedups
    // against. Neither is a recommendation to install ADLC through the channel.
    if (!text.includes('skills add voodootikigod/adlc')) continue;
    checked += 1;
    assert.match(
      text,
      /skills only/i,
      `${relative} recommends the skills.sh channel without stating it is "skills only"`,
    );
  }

  assert.ok(checked > 0, 'expected at least one surface to recommend the skills.sh channel');
});

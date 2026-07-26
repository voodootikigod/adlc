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
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { TOOLS } from '../../packages/cli/lib/registry.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// The workspace dispatcher, so `--help` reflects THIS tree rather than whatever
// @adlc/cli happens to be installed globally on the runner.
const ADLC_BIN = path.join(repoRoot, 'packages/cli/bin/adlc.mjs');
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

/**
 * The parts of a skill that present runnable commands: inline `code` spans and
 * ```sh fenced blocks. Bare ``` fences (the ASCII phase-routing table) are
 * excluded — they route, they do not instruct.
 */
function commandContexts(text) {
  const parts = [];
  for (const [, lang, code] of text.matchAll(/```(\w*)\n([\s\S]*?)```/g)) {
    if (lang === 'sh' || lang === 'bash') parts.push(code);
  }
  const withoutFences = text.replace(/```[\s\S]*?```/g, '');
  for (const [, span] of withoutFences.matchAll(/`([^`\n]+)`/g)) parts.push(span);
  return parts.join('\n');
}

/**
 * Required arguments for a tool, DERIVED from its own `--help` rather than
 * hard-coded here. Hard-coding is what let `adlc build-gate` (needs a positional
 * ticket id) and `adlc prosecute` (needs --input) ship in published skills: a
 * fixed list only catches the mistakes someone already thought of.
 *
 * Usage-line convention: `<foo>` is required, `[bar]` is optional.
 */
function helpTextFor(tool) {
  // Some tools reject `--help` and print usage on stderr with exit 1 instead
  // (behavior-diff is one), so BOTH streams are read and a non-zero exit is not
  // treated as "no help". Falling back to a bare invocation catches the rest.
  // Tools print usage in several shapes: bare at line start, "usage: <tool> …",
  // and — when a bare invocation is itself the error — "error: usage: <tool> …".
  // Anchoring too strictly silently demotes a tool to "undeterminable".
  const looksLikeUsage = (text) =>
    new RegExp(`^\\s*((error|usage):\\s*)*(adlc-)?${tool}\\s`, 'im').test(text);

  // Probing a tool by running it BARE is only safe when the tool fails fast on
  // missing required arguments. It is not safe in general: `adlc
  // rejection-mining` with no args actually runs and queries the GitHub API, so
  // a blanket bare probe turned this offline unit test into a network client.
  // Only tools verified to reject-and-exit are probed that way; everything else
  // is --help only, and lands in the explicit undeterminable list if that fails.
  const SAFE_BARE_PROBE = new Set(['consensus-fix', 'behavior-diff']);
  const attempts = SAFE_BARE_PROBE.has(tool)
    ? [[ADLC_BIN, tool, '--help'], [ADLC_BIN, tool]]
    : [[ADLC_BIN, tool, '--help']];
  let fallback = '';
  for (const argv of attempts) {
    const run = spawnSync(process.execPath, argv, { encoding: 'utf8', cwd: repoRoot, timeout: 20_000 });
    const text = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    if (looksLikeUsage(text)) return text;
    // Keep the most INFORMATIVE non-usage output, not the longest: a tool that
    // rejects --help emits a Node stack trace (long, useless) while its bare
    // invocation emits "--test-cmd is required" (short, exactly what we need).
    const informative = /is required|requires\s+--/i.test(text);
    if (informative || fallback === '') fallback = informative ? text : fallback || text;
  }
  return fallback;
}

function requiredArgsFor(tool) {
  const text = helpTextFor(tool);
  const usage = text
    .split(/\r?\n/)
    .find((line) => new RegExp(`(^|\\s)(adlc-)?${tool}\\s`).test(line));
  if (!usage) {
    // Not every tool exposes a usage line — `consensus-fix` rejects --help
    // outright. But each one still FAILS CLOSED with its own message naming what
    // it needs ("--test-cmd is required", "capture requires --config <…>"), so
    // derive from that instead. Using the tool's own error text keeps this
    // honest as the CLI changes, where a hard-coded table would rot.
    // Both shapes appear: "--test-cmd is required" and the bare-word
    // "ticket is required for P6 acceptance evidence".
    const demanded = [
      ...text.matchAll(/(--[a-z][\w-]*)\s+is required/gi),
      ...text.matchAll(/requires\s+(--[a-z][\w-]*)/gi),
      ...text.matchAll(/(?:^|;|\s)([a-z][\w-]*) is required/gi),
    ].map((m) => m[1]);

    // null means UNDETERMINABLE, which is different from "no requirements".
    // Conflating them is what let `behavior-diff capture` (needs --config) ship
    // unrunnable in a published skill. The caller records these instead of
    // quietly passing them — see the known-gap assertion below.
    if (demanded.length === 0) return null;
    return { positionals: [], flags: [...new Set(demanded)] };
  }

  // Strip optional groups, then read what survives.
  const after = usage.slice(usage.indexOf(tool) + tool.length);
  const withoutOptional = after.replace(/\[[^\]]*\]/g, '');
  const flags = [...withoutOptional.matchAll(/(--[a-z][\w-]*)/g)].map((m) => m[1]);
  // A `<foo>` that follows a flag is that FLAG'S argument, not a standalone
  // positional: in `--input <passes.json> --ticket id`, <passes.json> belongs to
  // --input. Drop flag+argument pairs before reading positionals, or every
  // flag-taking tool reports a phantom missing positional.
  const positionalsOnly = withoutOptional
    .replace(/--[a-z][\w-]*\s+<[^>]+>/g, '')
    .replace(/--[a-z][\w-]*\s+\S+/g, '');
  return {
    positionals: [...positionalsOnly.matchAll(/<([^>]+)>/g)].map((m) => m[1]),
    flags,
  };
}

test('every catalog skill teaches invocations that satisfy each tool\'s required arguments', () => {
  // Scans EVERY `adlc <tool>` occurrence — fenced blocks, inline backticks, and
  // routing-table rows alike. An earlier version scanned only fenced lines, which
  // is precisely how `adlc build-gate` (invalid without a ticket id) survived in
  // the router's routing table.
  // Dispatcher verbs are valid invocations without being registry TOOLS, so
  // they need the two concepts kept apart: `accept` is legitimate, and it still
  // has required arguments. Blanket-exempting the whole class is what hid a
  // published bare `adlc accept`, which the dispatcher rejects with
  // "ticket is required … packet is required".
  const NO_ARG_VERBS = new Set(['init', 'ticket', '--version', '--help']);
  const ARG_CHECKED_VERBS = new Set(['run', 'accept']);
  const problems = [];
  const undeterminable = new Set();

  for (const skill of catalogSkills()) {
    // Only look where the docs TEACH a command: inline `code` spans and ```sh
    // blocks. The phase-routing table lives in a bare ``` fence and is
    // navigation — "P4  adlc consensus-fix" points at a gate, it does not claim
    // to be a runnable line, and flagging it would train the next author to
    // silence this test rather than fix a command.
    const text = commandContexts(body(skill.text));
    for (const [, tool, rest] of text.matchAll(/adlc ([a-z][\w-]*)([^\n`]*)/g)) {
      if (NO_ARG_VERBS.has(tool)) continue;
      if (!CANONICAL_TOOLS.includes(tool) && !ARG_CHECKED_VERBS.has(tool)) {
        problems.push(`skills/${skill.dir}: "adlc ${tool}" is not a registered tool`);
        continue;
      }

      const derived = requiredArgsFor(tool);
      if (derived === null) {
        undeterminable.add(tool);
        continue;
      }
      const { positionals, flags } = derived;
      // A bare mention inside prose ("the adlc prosecute runner") is not an
      // invocation; only treat it as one when it is followed by args or ends a
      // command-looking span.
      const args = rest.trim();
      if (args === '' && positionals.length === 0 && flags.length === 0) continue;

      // Subcommands carry their own contract: `prosecute record-cross-model`
      // does not need the parent's --input. Recognised by asking the tool's own
      // help, so a subcommand that disappears upstream is caught as an invalid
      // command rather than silently exempted.
      const leading = args.split(/\s+/).filter(Boolean)[0];
      if (leading && !leading.startsWith('-') && helpTextFor(tool).includes(leading)) continue;

      for (const flag of flags) {
        if (!args.includes(flag)) {
          problems.push(`skills/${skill.dir}: "adlc ${tool}" is missing required ${flag}`);
        }
      }
      if (positionals.length > 0) {
        const firstToken = args.split(/\s+/).filter(Boolean)[0];
        if (!firstToken || firstToken.startsWith('-')) {
          problems.push(
            `skills/${skill.dir}: "adlc ${tool}" is missing required positional <${positionals[0]}>`,
          );
        }
      }
    }
  }

  assert.deepEqual(problems, [], `published skills teach invalid commands:\n  ${problems.join('\n  ')}`);

  // No silent coverage gaps. These tools expose neither a parseable usage line
  // nor a "X is required" message, so their invocations cannot be argument-
  // checked here. Each was verified by hand to take NO required arguments
  // (`adlc <tool> --json` produces no required-arg error), so the gap is
  // currently harmless — but it is asserted EXACTLY, so a tool that newly stops
  // exposing its contract fails here and forces a decision rather than quietly
  // dropping out of coverage.
  assert.deepEqual(
    [...undeterminable].sort(),
    ['lesson-foundry', 'model-router', 'preflight', 'rejection-mining', 'skill-rot'],
    'the set of argument-unchecked tools changed — verify the new tool by hand, then update this list',
  );
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

// Coverage for scripts/skills-add-smoke.mjs lives in scripts/test/skills-add-smoke.test.mjs.
// The filename is not cosmetic: mutation-gate maps `scripts/<name>.mjs` to
// `scripts/test/<name>.test.mjs` and only takes the fast path when that exact
// file exists. Hosting those assertions here left the smoke script with "no
// known fast test target", forcing the gate onto the full-suite fallback.

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

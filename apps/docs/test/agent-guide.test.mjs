// agent-guide.test.mjs — /agent-guide.md is the surface a stranger's agent
// reads and then ACTS on, with that human's privileges, on their machine.
//
// Two things therefore have to hold. The install commands must be generated
// from integration-facts.mjs, because a hand-maintained seventh copy rots
// against the six rendered on the integration pages and an agent following a
// stale one fails in a way the human cannot debug. And the guide must constrain
// the agent: an onboarding document that reads as "install everything" invites
// exactly that.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildAgentGuide, agentGuideResponse } from '../lib/agent-guide.mjs';
import { INTEGRATIONS } from '../lib/integration-facts.mjs';
import { AGENT_PROMPT, AGENT_GUIDE_URL } from '../lib/install-commands.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const docsRoot = path.join(repoRoot, 'apps/docs');
const INDEX = path.join(docsRoot, 'app/(home)/integrations/page.tsx');
const GUIDE_ROUTE = path.join(docsRoot, 'app/agent-guide.md/route.ts');
const LLMS_ROUTE = path.join(docsRoot, 'app/llms.txt/route.ts');

// The route handlers are .ts and import through Next's `@/` alias, which Node
// cannot resolve outside a Next build. The GENERATOR is .mjs and holds all the
// behavior, so it is exercised directly; the routes are thin and are checked by
// source, the same way codex-docs-current.test.mjs checks its components.

test('the guide generator produces a substantial markdown document', () => {
  const body = buildAgentGuide();
  assert.ok(body.length > 2000, `guide is suspiciously short (${body.length} chars)`);
  assert.match(body, /^# ADLC — a guide for agents/, 'the guide must address agents up front');
});

test('the served response is a 200 markdown document', async () => {
  // Exercised for real. hollow-test showed that with this logic in the .ts
  // route, `return null` survived every test — an unimportable route is an
  // untestable one, so the response is built in .mjs and asserted here.
  const response = agentGuideResponse();
  assert.ok(response instanceof Response, 'agentGuideResponse must return a Response');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/markdown/);

  const body = await response.text();
  assert.equal(body, buildAgentGuide(), 'the response body must be the generated guide');
});

test('the route delegates to the tested response builder', () => {
  const source = readFileSync(GUIDE_ROUTE, 'utf8');
  assert.match(source, /export function GET/, 'the route must export a GET handler');
  // Assert the RETURN, not just a mention: `agentGuideResponse` also appears on
  // the import line, so a route whose body was replaced by `return null` would
  // still satisfy a bare mention — hollow-test proved exactly that mutant lived.
  assert.match(
    source,
    /return agentGuideResponse\(\);/,
    'the route must return the generated response, not a placeholder',
  );
  // Static forever: the guide is generated at build time from repo data, so
  // revalidation would only add cost and cache churn.
  assert.match(source, /export const revalidate = false/, 'the guide must be statically generated');
});

test('every code fence in the guide is closed', () => {
  // The guide is consumed by an agent as markdown. An unterminated fence turns
  // the remainder of the document into one code block, so the agent reads the
  // install commands as prose and the rules as decoration. hollow-test found
  // this: dropping the closing fence from the generator survived every test.
  const guide = buildAgentGuide();
  const fences = guide.split('\n').filter((line) => line.trimEnd() === '```' || line.trimEnd() === '```sh');

  assert.ok(fences.length > 0, 'the guide must contain fenced command blocks');
  assert.equal(
    fences.length % 2,
    0,
    `unbalanced code fences: ${fences.length} fence lines, so at least one block is never closed`,
  );

  // Balance alone is not enough — ```sh followed by ```sh is also "even".
  for (let i = 0; i < fences.length; i += 1) {
    const expected = i % 2 === 0 ? '```sh' : '```';
    assert.equal(
      fences[i].trimEnd(),
      expected,
      `fence #${i} should be ${expected}; fences must alternate open/close`,
    );
  }
});

test('every per-harness install line is generated verbatim from integration-facts', () => {
  const guide = buildAgentGuide();

  for (const integration of INTEGRATIONS) {
    for (const line of integration.install) {
      assert.ok(
        guide.includes(line),
        `${integration.slug}: install line is missing from the agent guide: ${JSON.stringify(line)}\n` +
          '  The guide must be generated from integration-facts.mjs, never hand-maintained.',
      );
    }
  }
});

test('every per-harness note reaches the guide', () => {
  // The notes carry the caveats that make an install actually work — Codex's
  // minimum CLI version and "start a new thread", Cursor's marketplace-over-
  // scaffold preference, pi's Node floor. Dropping them leaves commands that
  // look complete and fail in ways the agent cannot diagnose. Asserting only the
  // install LINES let the whole note block be deleted silently: mutation-gate
  // caught exactly that (`integration.note ? ['', …] : []` shrunk to `['']`).
  const guide = buildAgentGuide();

  for (const integration of INTEGRATIONS) {
    if (!integration.note) continue;
    assert.ok(
      guide.includes(integration.note),
      `${integration.slug}: note missing from the agent guide.\n  ${integration.note}`,
    );
  }
});

test('the guide tells the agent to detect its harness and names every one', () => {
  const guide = buildAgentGuide();

  assert.match(
    guide,
    /Detect which harness you are running in/i,
    'the guide must direct the agent to identify its harness before installing',
  );
  assert.match(guide, /do not install for a harness you are not/i);

  for (const integration of INTEGRATIONS) {
    assert.ok(guide.includes(integration.slug), `the guide must name the ${integration.slug} harness`);
    assert.ok(guide.includes(integration.name), `the guide must name ${integration.name}`);
  }
});

test('the guide constrains the agent from acting without consent', () => {
  const guide = buildAgentGuide();

  const rulesAt = guide.indexOf('## Rules for you');
  assert.notEqual(rulesAt, -1, 'the guide must carry a "Rules for you" section');
  const rules = guide.slice(rulesAt);

  assert.match(
    rules,
    /Do not run any install command until the human confirms/i,
    'the agent must not install before the human confirms',
  );
  assert.match(rules, /Never use `sudo` on your own initiative/i);
  assert.match(rules, /Do not install for harnesses that are not present/i);
  assert.match(
    rules,
    /Do not weaken a gate to make it pass/i,
    'an agent told to set up a gate system must be told not to defeat it',
  );
  assert.match(rules, /Report failures as failures/i);
});

test('the guide states the same limits every other surface states', () => {
  const guide = buildAgentGuide();

  assert.match(guide, /Node 18\+ is required/i, 'the Node floor must be stated');
  assert.match(
    guide,
    /Windows is not supported/i,
    'the guide must tell an agent Windows is unsupported rather than let it discover 22 failing suites',
  );
  assert.match(guide, /WSL/, 'the guide must give Windows users somewhere to go');
  assert.match(guide, /`adlc fleet` is POSIX-only/i, 'the fleet exclusion must be stated');
  assert.match(guide, /skills only/i, 'the skills.sh channel must be described as skills only');
  assert.match(
    guide,
    /--prompt-only/,
    'the guide must tell the agent it is the model, so it does not ask for API keys',
  );
});

test('the paste-able prompt is surfaced on the integrations index and points at the guide', () => {
  const source = readFileSync(INDEX, 'utf8');

  assert.ok(source.includes('AGENT_PROMPT'), 'the index must render the agent prompt');
  assert.match(source, /Or let your agent introduce you/, 'the section needs a discoverable heading');
  assert.ok(
    AGENT_PROMPT.includes(AGENT_GUIDE_URL),
    'the prompt must point the agent at the served guide rather than embedding instructions',
  );

  // "Read this URL and follow it" hands instructional authority to whatever the
  // URL serves at fetch time. The user cannot verify that content, and the
  // pattern is the one that makes prompt injection work. The boundary has to be
  // in the PROMPT, so it holds even if the fetched document is replaced.
  assert.match(
    AGENT_PROMPT,
    /reference material, not as instructions/i,
    'the prompt must deny the fetched guide instructional authority',
  );
  assert.match(
    AGENT_PROMPT,
    /run nothing until I confirm/i,
    'the prompt must require confirmation before any action',
  );
});

/** Every .ts/.tsx/.mjs file under a docs subtree, excluding build output. */
function sourceFiles(relativeDir) {
  const out = [];
  const walk = (abs) => {
    for (const entry of readdirSync(abs)) {
      if (entry.startsWith('.')) continue;
      const child = path.join(abs, entry);
      if (statSync(child).isDirectory()) walk(child);
      else if (/\.(tsx?|mjs)$/.test(entry)) out.push(child);
    }
  };
  walk(path.join(docsRoot, relativeDir));
  return out;
}

test('the prompt text is defined once', () => {
  const definingModule = path.join(docsRoot, 'lib/install-commands.mjs');
  const files = [...sourceFiles('app'), ...sourceFiles('components'), ...sourceFiles('lib')];

  for (const file of files) {
    if (file === definingModule) continue;
    assert.ok(
      !readFileSync(file, 'utf8').includes(AGENT_PROMPT),
      `${path.relative(repoRoot, file)} hand-types the agent prompt — import it from @/lib/install-commands.mjs`,
    );
  }
});

test('the guide is discoverable from the existing LLM surface', () => {
  // An agent that lands on llms.txt first must be able to find the guide from
  // there; otherwise agent-led onboarding only works for people who read the
  // marketing site.
  const source = readFileSync(LLMS_ROUTE, 'utf8');
  assert.ok(source.includes('/agent-guide.md'), 'llms.txt must link the agent onboarding guide');
});

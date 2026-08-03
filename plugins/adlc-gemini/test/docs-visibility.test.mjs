import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// Issue #62(b): the in-session PreToolUse hook fails OPEN on a non-zero exit.
// This is already documented in SKILL.md and the hook shim, but wasn't surfaced
// anywhere more visible -- an operator skimming install docs could assume the
// hook is a hard block. These tests pin that visibility so it can't silently
// regress back to "buried SKILL.md line only".

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

function section(markdown, heading) {
  // Extract the body of a level-2 (##) markdown section up to the next ## heading.
  const lines = markdown.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === heading);
  assert.ok(startIdx !== -1, `heading "${heading}" not found`);
  const rest = lines.slice(startIdx + 1);
  const endIdx = rest.findIndex((l) => /^## /.test(l));
  return (endIdx === -1 ? rest : rest.slice(0, endIdx)).join('\n');
}

test('gemini.md Install section foregrounds the fail-open risk near the top', () => {
  const doc = readFileSync(
    join(REPO_ROOT, 'docs', 'integrations', 'gemini.md'),
    'utf8'
  );
  const install = section(doc, '## Install');
  assert.match(
    install,
    /fail(s)?\s*\*{0,2}open/i,
    'Install section should state the hook fails OPEN'
  );
  assert.match(
    install,
    /CI\b.*(backstop|real (guarantee|control))|(backstop|real (guarantee|control)).*CI\b/is,
    'Install section should name CI as the real backstop'
  );
});

test('gemini.md Install section callout appears before the install commands, not buried after them', () => {
  const doc = readFileSync(
    join(REPO_ROOT, 'docs', 'integrations', 'gemini.md'),
    'utf8'
  );
  const install = section(doc, '## Install');
  const calloutIdx = install.search(/fail(s)?\s*\*{0,2}open/i);
  const firstCommandIdx = install.indexOf('npx @adlc/gemini@latest install');
  assert.ok(calloutIdx !== -1, 'callout not found');
  assert.ok(firstCommandIdx !== -1, 'install command not found');
  assert.ok(
    calloutIdx < firstCommandIdx,
    'fail-open callout should appear before the first install command, i.e. near the top'
  );
});

test('the Gemini plugin points at scripts/rails-guard-ci.mjs as a required-check recommendation', () => {
  // plugins/adlc-gemini has no README.md (matches the rest of the plugins/
  // directory, none of which have one) -- commands/adlc-init.md is the closest
  // equivalent (it is the plugin's own install/bootstrap doc).
  const initDoc = readFileSync(
    join(REPO_ROOT, 'plugins', 'adlc-gemini', 'commands', 'adlc-init.md'),
    'utf8'
  );
  assert.match(
    initDoc,
    /scripts\/rails-guard-ci\.mjs/,
    'adlc-init.md should link scripts/rails-guard-ci.mjs by path'
  );
  assert.match(
    initDoc,
    /required check/i,
    'the rails-guard-ci.mjs reference should be framed as a required-check recommendation'
  );
});

test('no shipped surface tells a user to run `agy plugin install <path>` directly', () => {
  // The whole point of this integration's install path is that agy resolves its
  // target as `plugin@marketplace` BEFORE treating it as a filesystem path, so an
  // `@` ANYWHERE in the argument is read as the separator. Every npm location for
  // a scoped package has one, and a source checkout is not safe either — a clone
  // under /home/user@example.com/... reproduces it exactly.
  //
  // Prose that QUOTES the broken command to explain the hazard is fine and
  // expected; an instruction a user copies is not. So only fenced code blocks are
  // scanned: that is the difference between explaining the trap and setting it.
  //
  // This caught the shipped /adlc-init command still teaching the raw-path form
  // while every guide around it warned against exactly that.
  const SURFACES = [
    'plugins/adlc-gemini/commands/adlc-init.md',
    'plugins/adlc-gemini/README.md',
    'docs/integrations/gemini.md',
    'apps/docs/content/docs/integrations/gemini.mdx',
  ];

  let scanned = 0;
  for (const relative of SURFACES) {
    const text = readFileSync(join(REPO_ROOT, relative), 'utf8');
    scanned += 1;
    for (const [, block] of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
      for (const line of block.split('\n')) {
        const match = line.match(/(?:agy|jetski|\[agent\])\s+plugin\s+install\s+(\S+)/);
        if (!match) continue;
        assert.fail(
          `${relative} instructs a user to pass a path to the agent directly: "${line.trim()}"\n` +
            'Route it through the helper (bin/cli.mjs install), which stages under an @-free path.'
        );
      }
    }
  }
  assert.equal(scanned, SURFACES.length, 'every listed surface must exist and be scanned');
});

test('the ADLC_AGY_TIMEOUT_MS recovery knob is discoverable, not comment-only', () => {
  // The implementation accepts that a legitimate install can exceed 120s and adds
  // this knob as the remedy. A knob documented only in a source comment is not a
  // remedy: a user who hits the bound sees an elapsed duration and retries the same
  // published command forever. So every surface that tells someone how to install
  // has to name it, and so does the failure message itself.
  const SURFACES = [
    'plugins/adlc-gemini/README.md',
    'docs/integrations/gemini.md',
    'apps/docs/content/docs/integrations/gemini.mdx',
    'plugins/adlc-gemini/bin/cli.mjs',
  ];
  for (const relative of SURFACES) {
    const text = readFileSync(join(REPO_ROOT, relative), 'utf8');
    assert.match(text, /ADLC_AGY_TIMEOUT_MS/, `${relative} never names the timeout knob`);
    assert.match(
      text,
      /millisecond/i,
      `${relative} names the knob without its units — "300" is 300ms or 5min depending on the guess`,
    );
  }

  // And the error a user actually sees must point at it, since that is the moment
  // they need it.
  const cli = readFileSync(join(REPO_ROOT, 'plugins/adlc-gemini/bin/cli.mjs'), 'utf8');
  assert.match(
    cli,
    /timed out after[\s\S]{0,200}ADLC_AGY_TIMEOUT_MS/,
    'the timeout error must name the knob that fixes it'
  );
});

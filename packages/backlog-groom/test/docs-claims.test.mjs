// docs-claims.test.mjs — what the package's own documentation claims about it.
//
// Four surfaces describe this tool: the README, the docs-site page, the skill,
// and `--help`. Each claim pinned here is one the code decides, and each was
// once stated more strongly than the code supports:
//  - the package WRITES when `--apply` is given, so "read-only" / "writes nothing"
//    describes only the default mode;
//  - the gate ledger is gitignored per-checkout state, so its one-shot refusal
//    holds within one checkout, and removing the file or starting from a fresh
//    checkout forgets every spent review;
//  - the floor baseline is anchored to `origin` as `.git/config` names it, so a
//    caller who can rewrite that config can move the baseline; the ledger key is
//    the boundary against such a caller;
//  - the verb is registered, so `adlc backlog-groom` works.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderUsage } from '../lib/usage.mjs';
import { isTool } from '../../cli/lib/registry.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(PKG, '..', '..');
const read = (p) => readFileSync(p, 'utf8').replace(/\s+/g, ' ');

const SURFACES = {
  README: read(join(PKG, 'README.md')),
  'docs page': read(join(REPO, 'apps', 'docs', 'content', 'docs', 'toolkit', 'backlog-groom.mdx')),
  SKILL: read(join(REPO, '.claude', 'skills', 'backlog-groom', 'SKILL.md')),
};
const BIN = readFileSync(join(PKG, 'bin', 'backlog-groom.mjs'), 'utf8');

test('help does not call the command read-only — --apply writes', () => {
  const [title] = renderUsage().split('\n');
  assert.doesNotMatch(title, /read-only/i);
  assert.match(renderUsage(), /--apply/);
});

test('no surface says the package or binary writes nothing', () => {
  for (const [name, text] of Object.entries(SURFACES)) {
    assert.doesNotMatch(text, /This package is the \*?\*?read path/i, `${name} still calls the package the read path`);
    assert.doesNotMatch(text, /Gate:\*?\*? none\. Read-only/i, `${name} still calls the tool read-only`);
    assert.doesNotMatch(text, /description: [^\n]*Read-only\. ---/, `${name} front matter still calls the tool read-only`);
  }
  assert.doesNotMatch(BIN, /This half WRITES NOTHING/, 'the binary header still says it writes nothing');
});

test('the README documents --apply and --set', () => {
  assert.match(SURFACES.README, /--apply/);
  assert.match(SURFACES.README, /--set/);
});

test('every surface states the ledger is per-checkout, so its one-shot rule is too', () => {
  for (const [name, text] of Object.entries(SURFACES)) {
    assert.match(text, /per-checkout/i, `${name} must say the ledger is per-checkout state`);
    assert.match(text, /fresh checkout|new worktree/i, `${name} must say a fresh checkout forgets spent reviews`);
  }
});

test('every surface states the baseline remote comes from local git config', () => {
  for (const [name, text] of Object.entries(SURFACES)) {
    assert.match(text, /\.git\/config/, `${name} must say origin is whatever .git/config names`);
    assert.match(text, /key is the (?:write )?boundary/i, `${name} must name the key as the boundary against such a caller`);
  }
});

test('the verb is registered, and no surface says it is not', () => {
  assert.equal(isTool('backlog-groom'), true);
  for (const [name, text] of Object.entries(SURFACES)) {
    assert.doesNotMatch(text, /not registered yet|Not yet routed through|no `adlc backlog-groom` subcommand/i, `${name} still says the verb is unregistered`);
  }
});

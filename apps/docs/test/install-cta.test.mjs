// install-cta.test.mjs — install has to be the first actionable thing on the
// page, and the command has to exist in exactly one place.
//
// Both properties decay silently. A section reorder that pushes install back
// below the fold looks like a harmless refactor in review, and a hand-typed
// `curl | sh` in a second component keeps working right up until the served
// script moves and one copy is left pointing at a 404.
//
// These assert over component SOURCE ORDER, matching the convention in
// codex-docs-current.test.mjs. The docs app has no React test renderer, and
// adding one to check ordering that is statically determined would buy nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { UNIVERSAL_INSTALL, SKILLS_INSTALL } from '../lib/install-commands.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const docsRoot = path.join(repoRoot, 'apps/docs');
const read = (relative) => readFileSync(path.join(repoRoot, relative), 'utf8');

const DETAIL = 'apps/docs/components/marketing/integration-detail.tsx';
const INDEX = 'apps/docs/app/(home)/integrations/page.tsx';
const HOME = 'apps/docs/app/(home)/page.tsx';

/** Source index of a needle, asserted present so an ordering check can never pass vacuously. */
function indexOf(source, needle, where) {
  const at = source.indexOf(needle);
  assert.notEqual(at, -1, `${where}: expected to find ${JSON.stringify(needle)}`);
  return at;
}

test('the integration hero leads with install, above the surfaces section', () => {
  const source = read(DETAIL);
  const heroInstall = indexOf(source, '<IntegrationCard integration={integration} />', DETAIL);
  const surfaces = indexOf(source, 'integration.surfacesSection.kicker', DETAIL);

  assert.ok(
    heroInstall < surfaces,
    'the install card must render in the hero, before the Native surfaces section',
  );
});

test('the native bundle tree still renders, relocated below the hero install', () => {
  const source = read(DETAIL);
  const heroInstall = indexOf(source, '<IntegrationCard integration={integration} />', DETAIL);
  const bundle = indexOf(source, '<NativeBundle integration={integration} />', DETAIL);

  assert.ok(bundle > heroInstall, 'the bundle tree must move below the hero install card');
  assert.match(source, /function NativeBundle/, 'the bundle tree must not be deleted, only moved');
});

test('the full install section stays at the bottom with operate commands and resource nav', () => {
  const source = read(DETAIL);
  const installSection = indexOf(source, 'integration.installSection.kicker', DETAIL);
  const operate = indexOf(source, '<OperatingCommands integration={integration} />', DETAIL);
  const resources = indexOf(source, '<ResourceNav integration={integration} />', DETAIL);

  assert.ok(installSection < operate, 'operate commands belong inside the install section');
  assert.ok(operate < resources, 'the resource nav closes the page');

  // The bottom section must remain the LAST section — moving install up is not
  // licence to strand a reader who scrolled the whole page.
  const surfaces = indexOf(source, 'integration.surfacesSection.kicker', DETAIL);
  const phases = indexOf(source, 'integration.phaseSection.kicker', DETAIL);
  const rails = indexOf(source, 'integration.railsSection.kicker', DETAIL);
  assert.ok(
    installSection > surfaces && installSection > phases && installSection > rails,
    'the full install section must remain the last section on the page',
  );
});

// Match the RENDERED usage, never the bare identifier: every one of these files
// imports the constant at the top, so `indexOf(source, 'UNIVERSAL_INSTALL')`
// resolves to the import line and any "install comes before X" assertion built
// on it is vacuous — deleting the actual <InstallCommand> would still pass.
const RENDERS_UNIVERSAL = 'command={UNIVERSAL_INSTALL}';

test('the integrations index leads with the universal install command', () => {
  const source = read(INDEX);
  const install = indexOf(source, RENDERS_UNIVERSAL, INDEX);
  const grid = indexOf(source, 'INTEGRATIONS.map(', INDEX);

  assert.ok(install < grid, 'the universal install must render before the harness picker');
  assert.ok(
    !source.includes('UNIVERSAL_INSTALL_WINDOWS'),
    'no Windows command may be offered while the toolkit fails on Windows (6/28 suites)',
  );
});

test('the surface that sells the one-liner also names its exceptions', () => {
  // ADR-0009 Decision 4: we document only the coverage a channel actually has.
  // The installer cannot automate Cursor (in-app marketplace only) or Copilot
  // (@adlc/copilot unpublished). "Installs for every harness" would be a claim
  // we cannot back, and an adopter discovering the gap after running a
  // `curl | sh` has every reason to distrust the rest of the page.
  const source = read(INDEX);

  // The exceptions are the harnesses that genuinely cannot be automated from a
  // machine-level installer: Cursor (in-app marketplace only) and OpenCode
  // (scaffolds the CURRENT directory, so it belongs inside the repo).
  assert.match(source, /Cursor/, 'the index must name the Cursor exception');
  assert.match(source, /OpenCode/, 'the index must name the OpenCode exception');
  assert.match(source, /manual\s*\n?\s*step/, 'the exceptions must be described as a manual step');
  // Copilot installs from a Git marketplace that does not use npm, so the
  // installer automates it. Listing it as manual was an inaccurate coverage
  // claim derived from an unexamined assumption about npm publication.
  assert.ok(
    !/Copilot/.test(source),
    'Copilot is installed automatically — it must not be listed as a manual exception',
  );
  assert.match(
    source,
    /Windows isn&apos;t supported|Windows is not supported/,
    'the index must state plainly that Windows is unsupported, not leave it to be discovered',
  );
});

test('the homepage hero carries the install command without over-promising', () => {
  const source = read(HOME);
  const install = indexOf(source, RENDERS_UNIVERSAL, HOME);
  const problem = indexOf(source, 'The problem', HOME);

  assert.ok(install < problem, 'install must appear in the hero, before the first content section');

  // The most prominent CTA on the site must not claim coverage the script does
  // not deliver: Cursor and OpenCode are manual, and pi is skipped below its own
  // Node floor. "Install for every agent you have" read as a guarantee that
  // native enforcement was wired up everywhere.
  assert.ok(
    !/for every agent you have/i.test(source),
    'the hero must not claim installation for every agent when two are manual',
  );
  assert.match(source, /Cursor/, 'the hero must name the manual exceptions');
  assert.match(source, /OpenCode/, 'the hero must name the manual exceptions');
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

test('install commands are defined once and imported, never hand-typed into a page', () => {
  const definingModule = path.join(docsRoot, 'lib/install-commands.mjs');
  const COMMANDS = [
    ['UNIVERSAL_INSTALL', UNIVERSAL_INSTALL],
    ['SKILLS_INSTALL', SKILLS_INSTALL],
  ];

  const files = [...sourceFiles('app'), ...sourceFiles('components'), ...sourceFiles('lib')];

  for (const file of files) {
    if (file === definingModule) continue;
    const source = readFileSync(file, 'utf8');
    for (const [name, literal] of COMMANDS) {
      assert.ok(
        !source.includes(literal),
        `${path.relative(repoRoot, file)} hand-types the ${name} command.\n` +
          `  Import it from @/lib/install-commands.mjs instead — a second copy drifts the moment the served script moves.`,
      );
    }
  }
});

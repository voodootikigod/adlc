// npm-install-warning.test.mjs — regression coverage for issue #58
// (`npm warn Unknown user config "min-release-age"` during the documented
// Claude Code install flow).
//
// Root cause (reproduced by actually running the documented commands, see
// docs/specs/npm-install-warning.md for the full trace): NOTHING in this repo
// — not root package.json, not any plugins/adlc-claude-code install step, not
// an .npmrc — sets `min-release-age`. Every documented install command
// (`npx plugins add …`, `npm install -g @adlc/cli`) was run from a clean
// environment against the real registry and never emitted the warning.
//
// The warning is a real npm behavior, just not one @adlc causes: `min-release-age`
// is a genuine npm config (the "install cooldown" supply-chain-safety feature).
// npm only *recognizes* it as of npm 11.10.0. Any npm in the 11.x line *before*
// 11.10.0 (confirmed empirically against 11.0.0 through 11.9.0) treats a
// pre-existing `min-release-age` entry in the user's OWN `~/.npmrc` as unknown
// and warns on every single `npm install`/`npm install -g` — including the
// `npm install -g @adlc/cli` step from our docs, which is simply the first npm
// command the reporter happened to run. Node 20's bundled npm (10.x) predates
// the unknown-config check entirely (no warning); npm >= 11.10.0 recognizes the
// key (no warning). Only the 11.x-pre-11.10 window is affected, and it is
// triggered by the user's own userconfig, not by anything @adlc ships.
//
// Since there is no misconfiguration in this repo to delete, the fix is to make
// this a documented, discoverable non-issue: docs/integrations/claude-code.md
// gets a Troubleshooting entry naming the exact warning text, the real cause,
// and the actual remedy (upgrade npm), so a reporter can self-diagnose instead
// of filing it against @adlc/core.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC_PATH = join(ROOT, 'docs', 'integrations', 'claude-code.md');

test('claude-code.md Troubleshooting explains the min-release-age npm warning', () => {
  const doc = readFileSync(DOC_PATH, 'utf8');

  assert.match(
    doc,
    /min-release-age/,
    'docs/integrations/claude-code.md should name the exact npm config key ("min-release-age") that triggers issue #58\'s warning',
  );

  assert.match(
    doc,
    /11\.10\.0/,
    'the doc should cite the npm version (11.10.0) where npm started recognizing min-release-age, so users know which npm version fixes it',
  );

  assert.match(
    doc,
    /npm install -g npm@latest/,
    'the doc should give the concrete remedy: upgrading npm',
  );

  // The doc must be explicit that this is not an @adlc-caused misconfiguration
  // — the whole point of this ticket is not to leave the reporter thinking our
  // install step is broken.
  assert.match(
    doc,
    /not caused by @adlc|unrelated to @adlc/i,
    'the doc should clarify the warning is not caused by @adlc itself',
  );
});

// trusted-adlc.mjs — a PATH directory holding the workspace's adlc outside node_modules.
//
// The hook never runs an adlc found inside a node_modules directory (a repository
// could plant one there), so tests that need the real CLI reach the same file
// through a plain directory instead.

import { after } from 'node:test';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE_ADLC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'node_modules', '.bin', 'adlc');

const fixtureDirs = new Set();
after(() => { for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true }); });

function linkWorkspaceAdlc() {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-trusted-bin-'));
  fixtureDirs.add(dir);
  symlinkSync(realpathSync(WORKSPACE_ADLC), join(dir, 'adlc'));
  return dir;
}

/** A directory whose `adlc` is the workspace CLI, for prepending to a test's PATH. */
export const TRUSTED_ADLC_DIR = linkWorkspaceAdlc();

#!/usr/bin/env node
// gen-routers.mjs — render the six ADLC phase-router files from the single canonical
// source (router-model.mjs). Run on any change to the model; the committed router
// files are drift-gated against this generator in scripts/test/router-drift.test.mjs
// and in .github/workflows/router-drift.yml.
//
//   node scripts/router/gen-routers.mjs            # write the six router files
//   node scripts/router/gen-routers.mjs --check    # exit non-zero if any file drifted
//
// Importable: generateAll() returns { relPath: content } WITHOUT writing, so the drift
// test compares in-memory output to the committed files (the gen-schema.mjs idiom).

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { routerModel } from './router-model.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Resolve one layout section id to its text, applying per-harness slot substitutions. */
function renderSection(id, harness) {
  let text = routerModel.shared[id];
  if (text === undefined) text = harness.local?.[id];
  if (text === undefined) throw new Error(`unknown section id "${id}" for ${harness.path}`);
  for (const [slot, value] of Object.entries(harness.slots ?? {})) {
    text = text.split(`{{${slot}}}`).join(value);
  }
  return text;
}

/** Render one harness's full file content. */
export function renderHarness(harness) {
  const body = harness.layout.map((id) => renderSection(id, harness)).join('');
  return harness.frontmatter + body;
}

/** All six routers as { relPath: content } — no writes (used by the drift test). */
export function generateAll() {
  const out = {};
  for (const harness of Object.values(routerModel.harnesses)) {
    out[harness.path] = renderHarness(harness);
  }
  return out;
}

/** The six target paths, repo-relative. */
export const TARGETS = Object.values(routerModel.harnesses).map((h) => h.path);

function main(argv) {
  const check = argv.includes('--check');
  const all = generateAll();
  if (check) {
    const drifted = [];
    for (const [rel, content] of Object.entries(all)) {
      let committed = null;
      try {
        committed = readFileSync(join(REPO_ROOT, rel), 'utf8');
      } catch {
        drifted.push(`${rel} (missing on disk)`);
        continue;
      }
      if (committed !== content) drifted.push(rel);
    }
    if (drifted.length) {
      console.error('ROUTER DRIFT — the following files differ from the canonical source:');
      for (const d of drifted) console.error(`  - ${d}`);
      console.error('\nRun: node scripts/router/gen-routers.mjs   to regenerate, then review the diff.');
      process.exit(2);
    }
    console.log(`router drift check passed — all ${Object.keys(all).length} routers match the canonical source.`);
    return;
  }
  for (const [rel, content] of Object.entries(all)) {
    writeFileSync(join(REPO_ROOT, rel), content);
  }
  console.log(`wrote ${Object.keys(all).length} router files from scripts/router/router-model.mjs`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}

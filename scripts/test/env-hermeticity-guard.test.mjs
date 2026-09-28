// env-hermeticity-guard.test.mjs — lightweight drift gate for ambient-env spawn hermeticity
// (T-01M3M4GR027W9CYPNMS9BE3Q0G, replacing heavyweight 1,650-line Acorn AST parser).
//
// Background: scripts/run-tests.mjs already scrubs ADLC_MANIFEST_KEY, RAILS_BASE, BASE_REF,
// and bypass variables before executing every segment. This guard serves as a lightweight
// drift backstop against new test suites spawning ADLC entrypoints with an unqualified
// `...process.env` spread without neutralizing sensitive variables or recording a suppression.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Return sensitive variables for a matched ADLC entrypoint path.
 * @param {string} pathText
 * @returns {string[]|null}
 */
export function sensitiveVarsForEntrypoint(pathText) {
  if (!pathText) return null;
  if (pathText.includes('rails-guard-ci.mjs')) return ['RAILS_BASE', 'BASE_REF'];
  // rails-guard.mjs entrypoint (e.g. packages/rails-guard/bin/rails-guard.mjs), not hook adlc-rails-guard.mjs
  if (/(?:^|[/'"`])rails-guard\.mjs(?:$|['"`])/.test(pathText)) return ['ADLC_MANIFEST_KEY'];
  if (/bin\/adlc-[\w-]+\.mjs/.test(pathText)) return ['ADLC_MANIFEST_KEY'];
  return null;
}

function resolveVariable(source, varName) {
  if (!varName || !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(varName)) return null;
  const re = new RegExp('(?:const|let|var)\\s+' + varName + '\\s*=\\s*([^;\\n]+)');
  const match = source.match(re);
  return match ? match[1].trim() : null;
}

function resolveObjectLiteral(source, varName) {
  if (!varName || !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(varName)) return null;
  const re = new RegExp('(?:const|let|var)\\s+' + varName + '\\s*=\\s*\\{([\\s\\S]*?)\\};');
  const match = source.match(re);
  return match ? match[1] : null;
}

/**
 * Scan source text for ambient environment leaks when spawning ADLC entrypoints.
 * @param {string} filePath
 * @param {string} source
 * @returns {{file: string, variable: string, message: string}[]}
 */
export function findViolationsInSource(filePath, source) {
  const violations = [];
  if (!/(?:rails-guard(?:-ci)?\.mjs|bin\/adlc-[\w-]+\.mjs)/.test(source)) return violations;
  if (!/\bprocess\.env\b/.test(source)) return violations;

  const spawnRe = /\b(?:execFileSync|spawnSync|exec|spawn)\s*\(/g;
  let match;
  while ((match = spawnRe.exec(source)) !== null) {
    const callStart = match.index;
    const lineNum = source.slice(0, callStart).split('\n').length;
    const snippet = source.slice(callStart, callStart + 500);

    if (!/\.\.\.process\.env\b/.test(snippet)) continue;

    let targetText = null;
    const nodeLaunchMatch = snippet.match(/\b(?:execFileSync|spawnSync)\s*\(\s*(?:process\.execPath|['"]node['"])\s*,\s*\[\s*([^,\s\]]+)/);
    if (nodeLaunchMatch) {
      targetText = nodeLaunchMatch[1].trim();
    } else {
      const directMatch = snippet.match(/\b(?:execFileSync|spawnSync|exec|spawn)\s*\(\s*([^,\s)]+)/);
      if (directMatch) {
        targetText = directMatch[1].trim();
      }
    }

    if (!targetText) continue;

    let sensitiveVars = sensitiveVarsForEntrypoint(targetText);
    if (!sensitiveVars) {
      const resolved = resolveVariable(source, targetText);
      if (resolved) sensitiveVars = sensitiveVarsForEntrypoint(resolved);
    }

    if (!sensitiveVars) continue;

    for (const v of sensitiveVars) {
      const inlineNeutralized = new RegExp('\\b' + v + "\\s*:\\s*['\"`][^'\"`]*['\"`]").test(snippet);
      let templateNeutralized = false;
      const templateMatch = snippet.match(/\.\.\.([A-Z_]+)\b/g);
      if (templateMatch) {
        for (const tm of templateMatch) {
          const tName = tm.slice(3);
          if (tName === 'process.env') continue;
          const tDef = resolveObjectLiteral(source, tName) || resolveVariable(source, tName);
          if (tDef && new RegExp('\\b' + v + "\\s*:\\s*['\"`][^'\"`]*['\"`]").test(tDef)) {
            templateNeutralized = true;
            break;
          }
        }
      }
      const modulePin = new RegExp('process\\.env\\.' + v + "\\s*=\\s*['\"`][^'\"`]*['\"`]").test(source);
      const suppression = new RegExp('//[ \\t]*env-hermeticity:[ \\t]*inherits[ \\t]+' + v + '[ \\t]*—[ \\t]*\\S+').test(
        source.slice(Math.max(0, callStart - 500), callStart + 200)
      );

      if (!inlineNeutralized && !templateNeutralized && !modulePin && !suppression) {
        violations.push({
          file: filePath,
          variable: v,
          message: `${filePath}:${lineNum} spawns an ADLC entrypoint with an ambient env spread but never neutralizes ${v} ` +
            `(add a literal ${v}: '' to the env object it actually uses, ordered AFTER any ambient spread, or pin ` +
            `process.env.${v} = '<literal>') ` +
            `nor suppresses it (// env-hermeticity: inherits ${v} — <reason>).`,
        });
      }
    }
  }

  return violations;
}

/** *.test.mjs files directly under `dir`. */
function testFilesIn(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.test.mjs'))
      .map((e) => join(dir, e.name));
  } catch { return []; }
}

/** Every candidate test file this guard covers: packages/*\/test and scripts/test. */
export function candidateFiles(repoRoot) {
  const files = [];
  for (const pkg of readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    files.push(...testFilesIn(join(repoRoot, 'packages', pkg.name, 'test')));
  }
  files.push(...testFilesIn(join(repoRoot, 'scripts', 'test')));
  return files;
}

/**
 * Scan the given absolute file paths and return every violation.
 * @param {string[]} filePaths
 * @param {string} [repoRoot]
 * @returns {{file: string, variable: string, message: string}[]}
 */
export function findEnvHermeticityViolations(filePaths, repoRoot = REPO_ROOT) {
  const out = [];
  for (const abs of filePaths) {
    const rel = abs.startsWith(repoRoot) ? abs.slice(repoRoot.length + 1) : abs;
    out.push(...findViolationsInSource(rel, readFileSync(abs, 'utf8')));
  }
  return out;
}

// ── Tests ─────────────────────────────────────────────────────────────────────────

test('a spawn of bin/adlc-prosecute.mjs with an ambient env spread and no neutralization is flagged for ADLC_MANIFEST_KEY', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    function runBin(args, cwd) {
      return execFileSync(process.execPath, [BIN, ...args], { cwd, env: { ...process.env } });
    }
  `;
  const violations = findViolationsInSource('fixtures/violating.test.mjs', fixture);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].variable, 'ADLC_MANIFEST_KEY');
  assert.match(violations[0].message, /never neutralizes ADLC_MANIFEST_KEY/);
  assert.match(violations[0].message, /ADLC_MANIFEST_KEY: ''/);
  assert.match(violations[0].message, /env-hermeticity: inherits ADLC_MANIFEST_KEY/);
});

test('a spawn of rails-guard-ci.mjs with an ambient env spread and no neutralization is flagged for RAILS_BASE and BASE_REF', () => {
  const fixture = `
    import { spawnSync } from 'node:child_process';
    const GATE_BIN = join(ROOT, 'packages', 'rails-guard', 'bin', 'rails-guard-ci.mjs');
    function run(args) {
      return spawnSync(process.execPath, [GATE_BIN, ...args], { env: { ...process.env } });
    }
  `;
  const violations = findViolationsInSource('fixtures/violating-rails.test.mjs', fixture);
  assert.deepEqual(violations.map((v) => v.variable).sort(), ['BASE_REF', 'RAILS_BASE']);
});

test('the guard finds NO violations across the real repo tree', () => {
  const violations = findEnvHermeticityViolations(
    candidateFiles(REPO_ROOT).filter((f) => !f.endsWith('env-hermeticity-guard.test.mjs')),
  );
  assert.deepEqual(
    violations.map((v) => v.message),
    [],
    `env-hermeticity guard found violations:\n${violations.map((v) => v.message).join('\n')}`,
  );
});

test('a suppression marker with no reason text still flags', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-tickets.mjs', import.meta.url).pathname;
    function runBin(args) {
      // env-hermeticity: inherits ADLC_MANIFEST_KEY —
      return execFileSync(process.execPath, [BIN, ...args], { env: { ...process.env } });
    }
  `;
  const violations = findViolationsInSource('fixtures/empty-reason.test.mjs', fixture);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].variable, 'ADLC_MANIFEST_KEY');
});

test('a suppression marker WITH a reason near the spawn suppresses the finding', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-tickets.mjs', import.meta.url).pathname;
    function runBin(args) {
      // env-hermeticity: inherits ADLC_MANIFEST_KEY — intentional for testing
      return execFileSync(process.execPath, [BIN, ...args], { env: { ...process.env } });
    }
  `;
  assert.deepEqual(findViolationsInSource('fixtures/reasoned.test.mjs', fixture), []);
});

test('an inline literal neutralization satisfies the guard', () => {
  const fixture = `
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    function runBin(args) {
      return execFileSync(process.execPath, [BIN, ...args], { env: { ...process.env, ADLC_MANIFEST_KEY: 'test-key' } });
    }
  `;
  assert.deepEqual(findViolationsInSource('fixtures/literal.test.mjs', fixture), []);
});

test('a module top-level process.env pin satisfies the guard', () => {
  const fixture = `
    process.env.ADLC_MANIFEST_KEY = 'pinned-key';
    import { execFileSync } from 'node:child_process';
    const BIN = new URL('../bin/adlc-prosecute.mjs', import.meta.url).pathname;
    function runBin(args) {
      return execFileSync(process.execPath, [BIN, ...args], { env: { ...process.env } });
    }
  `;
  assert.deepEqual(findViolationsInSource('fixtures/pinned.test.mjs', fixture), []);
});

// gate-fuzzing/lib/gate-adapter.mjs
// Suite loader + argv-templated gate runner + surface/claim check (§7).
// Adapts external gates (0/2/1 CLIs) to gate-fuzzing's uniform interface.

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_SUITE_PATH = '.adlc/gate-suite.json';

/**
 * Load the gate suite from a JSON file.
 * Refuses with error if suite not found (§7.2 — no empty suite).
 *
 * @param {string|null} suitePath - explicit path or null to use default
 * @param {string} [cwd]
 * @returns {object} suite descriptor
 */
export function loadSuite(suitePath, cwd = '.') {
  const path = suitePath ?? join(cwd, DEFAULT_SUITE_PATH);
  const resolved = resolve(path);

  if (!existsSync(resolved)) {
    throw new Error(
      `Gate suite not found: ${resolved}\n` +
      'Create .adlc/gate-suite.json or pass --suite <path>.\n' +
      'gate-fuzzing refuses to fuzz an empty suite (degenerate-vacuous-pass prevention).'
    );
  }

  let raw;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch (e) {
    throw new Error(`Failed to read suite: ${resolved}: ${e.message}`);
  }

  let suite;
  try {
    suite = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Failed to parse suite JSON: ${resolved}: ${e.message}`);
  }

  if (!Array.isArray(suite.gates) || suite.gates.length === 0) {
    throw new Error(
      `Suite ${resolved} has no gates. gate-fuzzing refuses to fuzz an empty suite.`
    );
  }

  return suite;
}

/**
 * Substitute template tokens in gate run argv.
 * Tokens: {{clone}} → cloneDir, {{baseline}} → baselineRef, {{rails}} → railsGlob
 *
 * @param {string[]} argv
 * @param {{clone:string, baseline:string, rails?:string}} tokens
 * @returns {string[]}
 */
export function substituteTokens(argv, tokens) {
  return argv.map((arg) => {
    return arg
      .replace(/\{\{clone\}\}/g, tokens.clone ?? '')
      .replace(/\{\{baseline\}\}/g, tokens.baseline ?? '')
      .replace(/\{\{rails\}\}/g, tokens.rails ?? '');
  });
}

/**
 * Run a gate against the post-setup clone directory.
 * Returns { exitCode, stdout, stderr }.
 * Uses spawnSync shell:false (anti-injection, §7).
 *
 * @param {object} gate - Gate descriptor
 * @param {string} cloneDir
 * @param {string} baselineRef
 * @param {{sandboxFn?:Function, timeout?:number}} opts
 * @returns {{exitCode:number, stdout:string, stderr:string}}
 */
export function runGate(gate, cloneDir, baselineRef, opts = {}) {
  const { sandboxFn, timeout = 120_000 } = opts;

  const argv = substituteTokens(gate.run ?? [], {
    clone: cloneDir,
    baseline: baselineRef,
  });

  const cwd = substituteTokens([gate.cwd ?? cloneDir], {
    clone: cloneDir,
    baseline: baselineRef,
  })[0];

  if (argv.length === 0) {
    return { exitCode: 1, stdout: '', stderr: 'gate has no run command' };
  }

  const [cmd, ...args] = argv;

  if (sandboxFn) {
    return sandboxFn(argv, cloneDir);
  }

  const r = spawnSync(cmd, args, {
    cwd,
    timeout,
    encoding: 'utf8',
    stdio: 'pipe',
    shell: false,
  });

  return {
    exitCode: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    timedOut: r.signal === 'SIGTERM' || r.status === null,
  };
}

/**
 * Check if a candidate's changed files intersect the gate's surface.
 * @param {string[]} changedFiles
 * @param {object} gate
 * @returns {boolean}
 */
export function intersectsGateSurface(changedFiles, gate) {
  const surface = gate.surface ?? [];
  if (surface.includes('**')) return true;
  if (surface.length === 0) return false;

  for (const file of changedFiles) {
    for (const pattern of surface) {
      // Simple glob match: * matches within segment, ** matches across segments
      const regex = new RegExp(
        '^' +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '§STARSTAR§')
          .replace(/\*/g, '[^/]*')
          .replace(/§STARSTAR§/g, '.*') +
        '$'
      );
      if (regex.test(file)) return true;
    }
  }
  return false;
}

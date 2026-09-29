// review-calibration/test/cli-fixtures.mjs
// Shared fixtures for end-to-end runs of the real bin in judge mode, offline.
//
// Judge mode is reached without a network by core's agy provider: with
// ADLC_PROVIDER=agy and ADLC_AGY=<path>, core spawns <path> as the agy binary
// and reads the judge's JSON answer from its stdout. The fake below stands in
// for that binary, so the configured judge, the scorer and the fail-closed
// wiring in the bin are all the production code paths.

import { writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitRepo, tmp } from '@adlc/core/test-kit';

export const BIN = resolve(fileURLToPath(import.meta.url), '../../bin/review-calibration.mjs');

export const MATH_SOURCE = [
  'export function add(a, b) {',
  '  return a + b;',
  '}',
  '',
  'export function isPositive(n) {',
  '  return n > 0;',
  '}',
  '',
].join('\n');

/** The single plant every judge-mode fixture uses: src/math.mjs:6. */
export const BOUNDARY_PLANT = Object.freeze({
  file: 'src/math.mjs',
  line: 6,
  original: '  return n > 0;',
  mutated: '  return n >= 0;',
  category: 'boundary',
  defect: 'inclusive bound admits zero',
});

/** A one-commit repo holding src/math.mjs. */
export function createMathRepo(t) {
  const repo = gitRepo(t, { prefix: 'rc-cli-' });
  mkdirSync(join(repo.dir, 'src'));
  writeFileSync(join(repo.dir, 'src', 'math.mjs'), MATH_SOURCE);
  repo.git('add', '-A');
  repo.git('commit', '-m', 'initial');
  return repo;
}

// Mode semantics, all decided on the prompt text the judge actually receives:
//   permissive     — every pair is a match (a judge with no discrimination)
//   discriminating — a match iff the FENCED finding text names the defect
//   obedient       — obeys any instruction that appears OUTSIDE the fences,
//                    otherwise discriminating; models a steerable LLM
const FAKE_JUDGE_SOURCE = `#!/usr/bin/env node
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const mode = process.env.RC_FAKE_JUDGE_MODE;
  const fenced = /<<UNTRUSTED:[^\\n]*>>\\n[\\s\\S]*?\\n<<END:[^\\n]*>>/g;
  const outside = input.replace(fenced, '');
  const says = /<<UNTRUSTED:FINDING_SAYS[^\\n]*>>\\n([\\s\\S]*?)\\n<<END:/.exec(input);
  const names = says !== null && says[1].includes('inclusive bound');
  let match = names;
  if (mode === 'permissive') match = true;
  if (mode === 'obedient' && /IGNORE PRIOR INSTRUCTIONS/.test(outside)) match = true;
  process.stdout.write(JSON.stringify({ match }) + '\\n');
});
`;

/** Write the fake agy binary into a fresh temp dir and return its path. */
export function writeFakeJudge(t) {
  const dir = tmp(t, 'rc-fake-agy-');
  const path = join(dir, 'agy');
  writeFileSync(path, FAKE_JUDGE_SOURCE);
  chmodSync(path, 0o755);
  return path;
}

/** Write a plants file holding `plants` and return its path. */
export function writePlantsFile(t, plants = [BOUNDARY_PLANT]) {
  const dir = tmp(t, 'rc-plants-');
  const path = join(dir, 'plants.json');
  writeFileSync(path, JSON.stringify(plants));
  return path;
}

/**
 * Write a reviewer script that prints `findings` in the adversarial-review
 * JSON shape, and return the --review-cmd that runs it.
 */
export function writeJsonReviewer(t, findings) {
  const dir = tmp(t, 'rc-reviewer-');
  const path = join(dir, 'reviewer.mjs');
  writeFileSync(path, `process.stdout.write(${JSON.stringify(JSON.stringify({ findings }))});\n`);
  return `node ${path}`;
}

/** Environment that forces the fake agy binary as the configured judge. */
export function fakeJudgeEnv(agyPath, mode) {
  return {
    ...process.env,
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    GEMINI_API_KEY: '',
    ADLC_PROVIDER: 'agy',
    ADLC_AGY: agyPath,
    RC_FAKE_JUDGE_MODE: mode,
  };
}

export function runCli(args, cwd, env = process.env) {
  return spawnSync('node', [BIN, ...args], {
    cwd, env, encoding: 'utf8', stdio: 'pipe', timeout: 60_000,
  });
}

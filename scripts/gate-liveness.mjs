#!/usr/bin/env node
// scripts/gate-liveness.mjs — verify that declared merge-blocking gates are required in branch protection.
//
// Pure evaluator and CLI for checking the live GitHub ruleset against docs/ci/required-gates.json.
// Imports only node: builtins.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const VALID_REVIEW_MODES = Object.freeze(['none', 'code-owner', 'approving', 'either']);

const USAGE = `Usage: gate-liveness [options]

Compares live GitHub branch protection rules against declared required gates in docs/ci/required-gates.json.

Options:
  --repo <owner/name>     Repository in owner/name format (default: {owner}/{repo})
  --branch <name>         Branch name (default from required-gates.json)
  --pull-request <mode>   Override pullRequestReview mode (none|code-owner|approving|either)
  --json                  Output JSON verdict on stdout for exit 0 and 2
  --contexts              Print declared blocking contexts as JSON array and exit 0
  -h, --help              Show this help message and exit
`;

/**
 * Extracts declared merge-blocking contexts in file order from required-gates.json.
 * Throws if the document is invalid.
 */
export function declaredContexts(gates) {
  if (!gates || typeof gates !== 'object') {
    throw new Error('Invalid required-gates document: not an object');
  }
  if (!VALID_REVIEW_MODES.includes(gates.pullRequestReview)) {
    throw new Error(`Invalid pullRequestReview mode: "${gates.pullRequestReview}". Must be one of ${VALID_REVIEW_MODES.join(', ')}`);
  }
  if (!gates.workflows || typeof gates.workflows !== 'object') {
    throw new Error('Invalid required-gates document: missing workflows object');
  }

  const contexts = [];
  const seen = new Set();

  for (const [wfPath, jobs] of Object.entries(gates.workflows)) {
    if (!jobs || typeof jobs !== 'object') {
      throw new Error(`Invalid workflow entry "${wfPath}": not an object`);
    }
    for (const [jobId, jobDef] of Object.entries(jobs)) {
      if (!jobDef || typeof jobDef !== 'object') {
        throw new Error(`Invalid job entry "${jobId}" in "${wfPath}": not an object`);
      }
      if (typeof jobDef.blocking !== 'boolean') {
        throw new Error(`Job "${jobId}" in "${wfPath}" must specify boolean blocking`);
      }
      if (jobDef.blocking) {
        if (!Array.isArray(jobDef.contexts) || jobDef.contexts.length === 0) {
          throw new Error(`Job "${jobId}" in "${wfPath}" is blocking but lacks a non-empty contexts array`);
        }
        for (const ctx of jobDef.contexts) {
          if (typeof ctx !== 'string' || ctx.trim() === '') {
            throw new Error(`Job "${jobId}" in "${wfPath}" contains an invalid context`);
          }
          if (seen.has(ctx)) {
            throw new Error(`Duplicate context "${ctx}" in "${wfPath}" job "${jobId}"`);
          }
          seen.add(ctx);
          contexts.push(ctx);
        }
      } else {
        if (typeof jobDef.why !== 'string' || jobDef.why.trim() === '') {
          throw new Error(`Job "${jobId}" in "${wfPath}" is non-blocking but lacks a non-empty why`);
        }
      }
    }
  }

  if (contexts.length === 0) {
    throw new Error('No blocking context declared in required-gates document');
  }

  return contexts;
}

/**
 * Extracts required status check contexts from an array of rule objects.
 * Union over every rule of type "required_status_checks" of parameters.required_status_checks[].context.
 */
export function requiredContexts(rules) {
  if (!Array.isArray(rules)) {
    throw new Error('Rules payload must be an array');
  }

  const contexts = [];
  const seen = new Set();

  for (const rule of rules) {
    if (rule?.type === 'required_status_checks') {
      const checks = rule.parameters?.required_status_checks;
      if (!Array.isArray(checks)) {
        throw new Error('required_status_checks rule parameters.required_status_checks is not an array');
      }
      for (const check of checks) {
        const ctx = check?.context;
        if (typeof ctx === 'string' && ctx && !seen.has(ctx)) {
          seen.add(ctx);
          contexts.push(ctx);
        }
      }
    }
  }

  return contexts;
}

/**
 * Evaluates live rules against declared gates.
 * Returns { ok, missing, undeclared, review: { mode, ok, observed } }.
 */
export function evaluate({ gates, rules }) {
  const declared = declaredContexts(gates);
  const required = requiredContexts(rules);

  const missing = declared.filter((c) => !required.includes(c));
  const undeclared = required.filter((c) => !declared.includes(c));

  const mode = gates.pullRequestReview;
  const prRules = rules.filter((r) => r?.type === 'pull_request');
  const observed = prRules.length === 1 ? (prRules[0].parameters ?? null) : prRules.map((r) => r.parameters ?? null);

  const reviewOk = mode === 'none'
    ? true
    : mode === 'code-owner'
      ? prRules.some((r) => r.parameters?.require_code_owner_review === true)
      : mode === 'approving'
        ? prRules.some((r) => typeof r.parameters?.required_approving_review_count === 'number' && r.parameters.required_approving_review_count >= 1)
        : prRules.some((r) => r.parameters?.require_code_owner_review === true || (typeof r.parameters?.required_approving_review_count === 'number' && r.parameters.required_approving_review_count >= 1));

  const ok = missing.length === 0 && undeclared.length === 0 && reviewOk;

  return {
    ok,
    missing,
    undeclared,
    review: {
      mode,
      ok: reviewOk,
      observed,
    },
  };
}

/**
 * Default runner for `gh api` with spawnSync.
 */
export function defaultRunGh(args, { spawn = spawnSync } = {}) {
  const res = spawn('gh', args, { encoding: 'utf8', timeout: 30000 });
  if (res.error) {
    return { ok: false, reason: `gh execution error: ${res.error.message}` };
  }
  if (res.signal || res.status === null) {
    return { ok: false, reason: `gh process terminated by signal ${res.signal || 'timeout'}` };
  }
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || '').trim();
    return { ok: false, reason: `gh exited with status ${res.status}${detail ? `: ${detail}` : ''}` };
  }
  return { ok: true, stdout: res.stdout || '' };
}

function defaultReadGates() {
  const gatesPath = fileURLToPath(new URL('../docs/ci/required-gates.json', import.meta.url));
  return JSON.parse(readFileSync(gatesPath, 'utf8'));
}

/**
 * Main CLI entry point.
 */
export function main(
  argv = [],
  {
    runGh = defaultRunGh,
    readGates = defaultReadGates,
    stdout = process.stdout.write.bind(process.stdout),
    stderr = process.stderr.write.bind(process.stderr),
  } = {},
) {
  let repo = '{owner}/{repo}';
  let branch = null;
  let json = false;
  let contexts = false;
  let pullRequest = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      stdout(USAGE);
      return 0;
    }
    if (arg === '--json') {
      json = true;
    } else if (arg === '--contexts') {
      contexts = true;
    } else if (arg === '--repo') {
      i++;
      if (i >= argv.length) {
        stderr('gate-liveness: cannot verify the ruleset (missing argument for --repo) - failing closed\n');
        return 1;
      }
      repo = argv[i];
    } else if (arg.startsWith('--repo=')) {
      repo = arg.slice('--repo='.length);
    } else if (arg === '--branch') {
      i++;
      if (i >= argv.length) {
        stderr('gate-liveness: cannot verify the ruleset (missing argument for --branch) - failing closed\n');
        return 1;
      }
      branch = argv[i];
    } else if (arg.startsWith('--branch=')) {
      branch = arg.slice('--branch='.length);
    } else if (arg === '--pull-request') {
      i++;
      if (i >= argv.length) {
        stderr('gate-liveness: cannot verify the ruleset (missing argument for --pull-request) - failing closed\n');
        return 1;
      }
      pullRequest = argv[i];
    } else if (arg.startsWith('--pull-request=')) {
      pullRequest = arg.slice('--pull-request='.length);
    } else {
      stderr(`gate-liveness: cannot verify the ruleset (unknown flag "${arg}") - failing closed\n`);
      return 1;
    }
  }

  if (repo !== '{owner}/{repo}' && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    stderr(`gate-liveness: cannot verify the ruleset (invalid --repo "${repo}") - failing closed\n`);
    return 1;
  }

  if (pullRequest !== null && !VALID_REVIEW_MODES.includes(pullRequest)) {
    stderr(`gate-liveness: cannot verify the ruleset (invalid --pull-request "${pullRequest}") - failing closed\n`);
    return 1;
  }

  let gates;
  try {
    gates = readGates();
  } catch (e) {
    stderr(`gate-liveness: cannot verify the ruleset (failed to read required-gates.json: ${e.message}) - failing closed\n`);
    return 1;
  }

  if (pullRequest !== null) {
    gates = { ...gates, pullRequestReview: pullRequest };
  }

  let declared;
  try {
    declared = declaredContexts(gates);
  } catch (e) {
    stderr(`gate-liveness: cannot verify the ruleset (${e.message}) - failing closed\n`);
    return 1;
  }

  if (contexts) {
    stdout(JSON.stringify(declared) + '\n');
    return 0;
  }

  const effectiveBranch = branch || gates.branch;
  if (!effectiveBranch || !/^[A-Za-z0-9._\/-]+$/.test(effectiveBranch)) {
    stderr(`gate-liveness: cannot verify the ruleset (invalid --branch "${effectiveBranch}") - failing closed\n`);
    return 1;
  }

  const ghRes = runGh(['api', `repos/${repo}/rules/branches/${effectiveBranch}?per_page=100`]);
  if (!ghRes.ok) {
    stderr(`gate-liveness: cannot verify the ruleset (${ghRes.reason}) - failing closed\n`);
    return 1;
  }

  let rules;
  try {
    rules = JSON.parse(ghRes.stdout);
  } catch {
    stderr('gate-liveness: cannot verify the ruleset (non-JSON response from gh api) - failing closed\n');
    return 1;
  }

  if (!Array.isArray(rules)) {
    stderr('gate-liveness: cannot verify the ruleset (expected JSON array from gh api) - failing closed\n');
    return 1;
  }

  let verdict;
  try {
    verdict = evaluate({ gates, rules });
  } catch (e) {
    stderr(`gate-liveness: cannot verify the ruleset (${e.message}) - failing closed\n`);
    return 1;
  }

  if (json) {
    const payload = {
      ok: verdict.ok,
      branch: effectiveBranch,
      declared,
      required: requiredContexts(rules),
      missing: verdict.missing,
      undeclared: verdict.undeclared,
      review: verdict.review,
    };
    stdout(JSON.stringify(payload, null, 2) + '\n');
  } else {
    if (verdict.review.mode === 'none') {
      stdout('gate-liveness: note - pull-request approval is declared "none"; not asserted\n');
    }
    if (verdict.ok) {
      stdout(`gate-liveness: PASS - all declared merge-blocking contexts required on ${effectiveBranch}\n`);
    }
  }

  if (!verdict.ok) {
    if (verdict.missing.length > 0) {
      stderr(`gate-liveness: DENY - declared merge-blocking context(s) not required on ${effectiveBranch}: ${verdict.missing.join(', ')}\n`);
    }
    if (verdict.undeclared.length > 0) {
      stderr(`gate-liveness: DENY - context(s) required on ${effectiveBranch} but not declared in docs/ci/required-gates.json: ${verdict.undeclared.join(', ')}\n`);
    }
    if (!verdict.review.ok) {
      stderr(`gate-liveness: DENY - pull-request review policy "${verdict.review.mode}" not satisfied on ${effectiveBranch}\n`);
    }
    stderr('The ruleset is changed by a repository admin, never by this tool: see docs/ci/required-gates.md\n');
    return 2;
  }

  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const code = main(process.argv.slice(2));
  process.exit(code);
}

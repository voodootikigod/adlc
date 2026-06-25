#!/usr/bin/env node
// CI rail-freeze backstop. This is the unbypassable commit-time gate the
// in-session PreToolUse rail hook relies on: a Bash write form the hook does not
// recognize (node -e, python, cp, perl -i, …) still lands in the diff, and this
// gate rejects the PR if that diff touches a frozen rail.
//
// The rail set is read from the TRUSTED BASE version of .adlc/tickets.json (via
// `git show <base>:…`), never the PR's working tree — otherwise a PR could edit
// the ticket file to remove rails and self-disable the gate in the same change.
// Once the base is bootstrapped, immutable ADLC trust roots are protected even
// when no ticket rails exist yet. Existing base tickets must remain semantically
// identical by id, while ordinary PRs may add new ticket entries. Manifest
// evidence is append-only after it exists; a non-empty initial manifest cannot
// be seeded by an ordinary PR. Malformed base tickets fail closed.
//
//   node scripts/rails-guard-ci.mjs [base-ref]      (default base: origin/main)
//
// Exit: 0 = no rails at base OR no rail touched · 2 = a rail was modified ·
//       1 = operational error / unverifiable rails (fails the CI job).
//
// WARNING: this standalone script is not a security-complete replacement for
// docs/ci/rails-guard.yml. It performs the rail-glob diff gate plus the
// config-integrity checks that can run without GitHub Actions context, but it
// DOES NOT verify CODEOWNERS self-protection, signed runner-pool probing, or the
// first-bootstrap acknowledgement ceremony. Non-GitHub CI integrations must
// port the YAML bootstrap step before treating this as an enforcement boundary.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const base = process.argv[2] || process.env.RAILS_BASE || 'origin/main';

function fail(msg) {
  console.error(`rails-guard-ci: ${msg}`);
  process.exit(1);
}

function deny(msg) {
  console.error(`rails-guard-ci: ${msg}`);
  process.exit(2);
}

function git(args, label) {
  const result = spawnSync('git', args, { encoding: 'utf8', timeout: 60000 });
  if (result.error) fail(`${label} failed: ${result.error.message}`);
  if (result.signal) fail(`${label} timed out or was killed by ${result.signal}`);
  return result;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(`cannot parse ${label}: ${err.message}`);
  }
}

function signerRoles(entry, key) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    fail(`signer ${key} must remain an object`);
  }
  return new Set((Array.isArray(entry.roles) ? entry.roles : [entry.role]).filter((role) => role !== undefined));
}

function stable(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(stable(item))));
  if (value && typeof value === 'object') {
    return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, JSON.parse(stable(value[key]))])));
  }
  return JSON.stringify(value);
}

function validateTicketsEnvelope(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.tickets)) {
    fail(`${label} .adlc/tickets.json is not in the { "tickets": [...] } shape — failing closed.`);
  }
  const seen = new Set();
  for (const t of value.tickets) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) fail(`a ${label} ticket entry is not an object — failing closed.`);
    if (typeof t.id !== 'string' || !t.id) fail(`a ${label} ticket is missing a string id — failing closed.`);
    if (seen.has(t.id)) fail(`${label} .adlc/tickets.json has duplicate ticket id ${t.id} — failing closed.`);
    seen.add(t.id);
    if (t.rails !== undefined && !Array.isArray(t.rails)) fail(`a ${label} ticket has a non-array "rails" field — failing closed.`);
    for (const r of t.rails ?? []) {
      if (typeof r !== 'string') fail(`a ${label} ticket has a non-string rail entry — failing closed.`);
    }
  }
  return value.tickets;
}

function assertBaseTicketContractsPreserved(baseTickets, headTickets) {
  const headById = new Map(headTickets.map((ticket) => [ticket.id, ticket]));
  for (const baseTicket of baseTickets) {
    const headTicket = headById.get(baseTicket.id);
    if (!headTicket) deny(`base ticket ${baseTicket.id} cannot be removed from .adlc/tickets.json in a PR`);
    if (stable(headTicket) !== stable(baseTicket)) {
      deny(`base ticket ${baseTicket.id} contract cannot change in .adlc/tickets.json in a PR`);
    }
  }
}

function assertArraySuperset(name, trustedValue, headValue) {
  if (!Array.isArray(trustedValue)) return;
  if (!Array.isArray(headValue)) fail(`${name} must remain an array`);
  const headSet = new Set(headValue.map(stable));
  for (const item of trustedValue) {
    if (!headSet.has(stable(item))) fail(`${name} cannot remove trusted entry ${stable(item)}`);
  }
}

function validateNewSigners(trustedSigners, headSigners) {
  if (headSigners === undefined) return;
  if (!headSigners || typeof headSigners !== 'object' || Array.isArray(headSigners)) fail('signers must be an object or absent');
  const allowedNewRoles = new Set(['builder', 'critic']);
  const allowedNewFields = new Set(['role', 'roles']);
  for (const key of Object.keys(headSigners)) {
    if (trustedSigners && Object.prototype.hasOwnProperty.call(trustedSigners, key)) continue;
    const entry = headSigners[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`new signer ${key} must be an object`);
    for (const field of Object.keys(entry)) {
      if (!allowedNewFields.has(field)) fail(`new signer ${key} has undeclared property ${field}`);
    }
    if (entry.role === undefined && entry.roles === undefined) fail(`new signer ${key} must declare a role or roles field`);
    if (entry.role !== undefined && entry.roles !== undefined) fail(`new signer ${key} must use either role or roles, not both`);
    const roles = Array.isArray(entry.roles) ? entry.roles : [entry.role];
    if (!roles.length || roles.some((role) => typeof role !== 'string' || !allowedNewRoles.has(role))) {
      fail(`new signer ${key} can only use builder or critic roles in this CI path; grant approver roles through the protected-base admin ceremony`);
    }
  }
}

function rejectNewSigners(trustedSigners, headSigners) {
  if (!headSigners || typeof headSigners !== 'object' || Array.isArray(headSigners)) {
    fail('signers must remain an object');
  }
  for (const key of Object.keys(headSigners)) {
    if (!trustedSigners || !Object.prototype.hasOwnProperty.call(trustedSigners, key)) {
      fail(`new signer ${key} requires the protected-base admin ceremony`);
    }
  }
}

function validateConfigIntegrity() {
  if (!baseHasConfig) return;
  const baseConfig = git(['show', `${base}:.adlc/config.json`], 'git show base config');
  if (baseConfig.status !== 0) {
    fail(`git show failed for an existing base config file (operational error) — failing closed.`);
  }
  if (!existsSync('.adlc/config.json')) {
    fail('missing .adlc/config.json; standalone config-integrity gate cannot verify downgrade safety');
  }
  const trusted = parseJson(baseConfig.stdout, `${base}:.adlc/config.json`);
  const head = parseJson(readFileSync('.adlc/config.json', 'utf8'), 'head .adlc/config.json');
  if (trusted.acknowledgedNewRailBypass !== true) {
    fail('acknowledgedNewRailBypass must already be set on the base branch');
  }
  if (head.acknowledgedNewRailBypass !== true) {
    fail('missing acknowledgedNewRailBypass: true');
  }
  if (trusted.trustedCodeownersAttested === true && head.trustedCodeownersAttested !== true) {
    fail('trustedCodeownersAttested cannot be removed in a PR');
  }
  if (!['signed', 'unsigned-fallback'].includes(trusted.securityMode)) {
    fail('base .adlc/config.json has an unrecognized securityMode; cannot verify downgrade safety');
  }
  if (!['signed', 'unsigned-fallback'].includes(head.securityMode)) {
    fail('head .adlc/config.json has an unrecognized securityMode');
  }
  if (trusted.securityMode === 'signed' && head.securityMode !== 'signed') {
    fail('cannot downgrade securityMode from signed to unsigned-fallback');
  }
  if (trusted.signedEvidenceRequired === true && head.signedEvidenceRequired !== true) {
    fail('cannot remove signedEvidenceRequired from a base config that requires it');
  }
  if ((head.securityMode === 'signed' || head.signedEvidenceRequired === true) && trusted.securityMode !== 'signed' && trusted.signedEvidenceRequired !== true) {
    fail('signed mode upgrade requires a protected-base runner ceremony');
  }
  if (typeof trusted.runnerBinarySha256 === 'string' && head.runnerBinarySha256 !== trusted.runnerBinarySha256) {
    fail('runnerBinarySha256 cannot change in a PR');
  }
  if (trusted.signers && typeof trusted.signers === 'object' && !Array.isArray(trusted.signers)) {
    if (!head.signers || typeof head.signers !== 'object' || Array.isArray(head.signers)) {
      fail('signers must remain an object');
    }
    for (const key of Object.keys(trusted.signers)) {
      const trustedRoles = signerRoles(trusted.signers[key], key);
      const headRoles = signerRoles(head.signers[key], key);
      for (const field of Object.keys(trusted.signers[key])) {
        if (!Object.prototype.hasOwnProperty.call(head.signers[key], field)) {
          fail(`signers.${key}.${field} cannot remove trusted signer property`);
        }
        if (stable(head.signers[key][field]) !== stable(trusted.signers[key][field])) {
          fail(`signers.${key}.${field} cannot change trusted signer property`);
        }
      }
      for (const field of Object.keys(head.signers[key])) {
        if (!Object.prototype.hasOwnProperty.call(trusted.signers[key], field)) {
          fail(`signers.${key}.${field} is an undeclared signer property`);
        }
      }
      if (trustedRoles.size !== headRoles.size) fail(`existing signer ${key} roles cannot change`);
      for (const role of trustedRoles) {
        if (!headRoles.has(role)) fail(`existing signer ${key} roles cannot change`);
      }
    }
  }
  if (head.signers !== undefined) rejectNewSigners(trusted.signers ?? {}, head.signers);
  assertArraySuperset('revokedKeys', trusted.revokedKeys, head.revokedKeys);
  assertArraySuperset('securitySensitivePatterns', trusted.securitySensitivePatterns, head.securitySensitivePatterns);
  if (typeof trusted.maxBundleAgeDays === 'number' && (typeof head.maxBundleAgeDays !== 'number' || head.maxBundleAgeDays > trusted.maxBundleAgeDays)) {
    fail('maxBundleAgeDays can only decrease or stay the same');
  }
}

// First confirm the base REF resolves. `git show <ref>:<path>` returns non-zero
// for BOTH "ref does not resolve" and "path absent at ref" — conflating them
// would fail OPEN (an unfetched/typo'd base would look like "no rails"). An
// unresolvable base means rails cannot be verified → fail closed.
const ref = git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], 'git rev-parse base');
if (ref.status !== 0) {
  fail(`base ref '${base}' does not resolve — rails cannot be verified. Fetch it (or pass the correct base).`);
}

const configLs = git(['ls-tree', '--name-only', base, '--', '.adlc/config.json'], 'git ls-tree base config');
if (configLs.status !== 0) {
  fail(`git ls-tree failed for '${base}' config (operational error) — failing closed.`);
}
const baseHasConfig = Boolean(configLs.stdout.trim());
validateConfigIntegrity();

// Distinguish "the file is genuinely absent at base" from an operational git
// error. `git ls-tree` lists the path in the base tree: a non-zero status is an
// operational failure (lock, IO) → fail closed; empty output means the file is
// truly absent → nothing was frozen. Only `git show` an existing file, so a
// failure THERE is also operational → fail closed (never read as "no rails").
const ls = git(['ls-tree', '--name-only', base, '--', '.adlc/tickets.json'], 'git ls-tree base tickets');
if (ls.status !== 0) {
  fail(`git ls-tree failed for '${base}' (operational error) — failing closed.`);
}
if (!ls.stdout.trim()) {
  if (baseHasConfig) {
    console.log(`rails-guard-ci: no .adlc/tickets.json at ${base} — protecting ADLC trust roots only.`);
  } else {
    if (existsSync('.adlc/manifest.jsonl') && readFileSync('.adlc/manifest.jsonl', 'utf8').trim()) {
      fail('first bootstrap PR cannot introduce pre-populated .adlc/manifest.jsonl evidence');
    }
    console.log(`rails-guard-ci: no .adlc/tickets.json at ${base} — nothing was frozen.`);
    process.exit(0);
  }
}

let show = { stdout: '{"tickets":[]}', status: 0 };
if (ls.stdout.trim()) {
  show = git(['show', `${base}:.adlc/tickets.json`], 'git show base tickets');
  if (show.status !== 0) {
    fail(`git show failed for an existing base ticket file (operational error) — failing closed.`);
  }
}

let data;
try {
  data = JSON.parse(show.stdout);
} catch (e) {
  fail(`cannot parse ${base}:.adlc/tickets.json (${e.message}) — failing closed.`);
}
const baseTickets = validateTicketsEnvelope(data, 'base');

const rails = [];
for (const t of baseTickets) {
  for (const r of t.rails ?? []) {
    rails.push(r);
  }
}

if (ls.stdout.trim()) {
  if (!existsSync('.adlc/tickets.json')) {
    deny('.adlc/tickets.json exists at base but is absent at HEAD');
  }
  const headTickets = parseJson(readFileSync('.adlc/tickets.json', 'utf8'), 'head .adlc/tickets.json');
  assertBaseTicketContractsPreserved(baseTickets, validateTicketsEnvelope(headTickets, 'head'));
}

const manifestLs = git(['ls-tree', '--name-only', base, '--', '.adlc/manifest.jsonl'], 'git ls-tree base manifest');
if (manifestLs.status !== 0) {
  fail(`git ls-tree failed for '${base}' manifest (operational error) — failing closed.`);
}
if (manifestLs.stdout.trim()) {
  if (!existsSync('.adlc/manifest.jsonl')) {
    deny('.adlc/manifest.jsonl exists at base but is absent at HEAD');
  }
  const baseManifest = git(['show', `${base}:.adlc/manifest.jsonl`], 'git show base manifest');
  if (baseManifest.status !== 0) fail('git show failed for an existing base manifest (operational error) — failing closed.');
  const headManifest = readFileSync('.adlc/manifest.jsonl', 'utf8');
  if (!headManifest.startsWith(baseManifest.stdout)) {
    deny('.adlc/manifest.jsonl must be append-only in PRs');
  }
} else if (existsSync('.adlc/manifest.jsonl') && readFileSync('.adlc/manifest.jsonl', 'utf8').trim()) {
  deny('.adlc/manifest.jsonl cannot be created with evidence in a PR; create it empty during bootstrap or use the protected-base runner ceremony');
}

const immutableTrustRoots = rails.length || baseHasConfig
  ? [
      '.adlc/config.json',
      '.github/workflows/adlc-rails-guard.yml',
      'CODEOWNERS',
      '.github/CODEOWNERS',
      'docs/CODEOWNERS',
      'docs/ci/rails-guard.yml',
      'scripts/rails-guard-ci.mjs',
      'scripts/test/rails-guard-workflow-hashes.json',
    ]
  : [];
const unique = [...new Set([...rails, ...immutableTrustRoots])];
if (unique.length === 0) {
  console.log(`rails-guard-ci: no rails declared at ${base} — nothing frozen.`);
  process.exit(0);
}

if (immutableTrustRoots.length) {
  const trustRootDiff = git(['diff', '--name-status', '-M', `${base}...HEAD`, '--', ...immutableTrustRoots], 'git diff trust roots');
  if (trustRootDiff.status !== 0) {
    fail('git diff trust roots failed (operational error) — failing closed.');
  }
  if (trustRootDiff.stdout.trim()) {
    deny(`ADLC trust root changed, deleted, or renamed:\n${trustRootDiff.stdout.trim()}`);
  }
}

const argv = ['--base', base, ...unique.flatMap((r) => ['--rails', r])];

// Prefer the in-repo bin (this repo); fall back to a globally installed `adlc`.
const localBin = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'rails-guard',
  'bin',
  'rails-guard.mjs'
);
const result = existsSync(localBin)
  ? spawnSync(process.execPath, [localBin, ...argv], { stdio: 'inherit', timeout: 120000 })
  : spawnSync('adlc', ['rails-guard', ...argv], { stdio: 'inherit', timeout: 120000 });

if (result.error) fail(`could not run rails-guard: ${result.error.message}`);
if (result.signal) fail(`rails-guard timed out or was killed by ${result.signal}`);
process.exit(typeof result.status === 'number' ? result.status : 1);

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { runBin } from '@adlc/core/test-kit';
import { buildRepoFacts } from '../lib/repo-context.mjs';
import { buildSpecReaderPrompt, buildEdgePrompt, buildRouteAnswerPrompt } from '../lib/prompts.mjs';
import { runSpecMode, runEdgeMode, runRouteMode } from '../lib/modes.mjs';

const BIN = fileURLToPath(new URL('../bin/parallax.mjs', import.meta.url));

function makeTmpDir(t, prefix = 'parallax-repo-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeRel(root, relPath, content = '') {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

describe('buildRepoFacts', () => {
  test('emits ordered lines for manifests, top-level dirs, workspaces, and test script, with maxChars truncation', (t) => {
    const emptyRepo = makeTmpDir(t);
    assert.equal(buildRepoFacts(emptyRepo), 'Stack manifests: none\nTop-level directories: none');

    const repo = makeTmpDir(t);
    writeRel(repo, 'package.json', JSON.stringify({ name: 'root-monorepo', scripts: { test: 'node --test' } }));
    writeRel(repo, 'tsconfig.json', '{}');
    writeRel(repo, 'Cargo.toml', '[package]\nname = "demo"\n');
    writeRel(repo, 'go.mod', 'module demo\n');
    writeRel(repo, 'pyproject.toml', '[project]\nname = "demo"\n');
    writeRel(repo, 'packages/zeta/package.json', JSON.stringify({ name: '@demo/zeta' }));
    writeRel(repo, 'packages/alpha/package.json', JSON.stringify({ name: '@demo/alpha' }));
    for (const d of ['src', '.git', 'node_modules', 'dist', 'target', 'build']) {
      mkdirSync(join(repo, d), { recursive: true });
    }

    const facts = buildRepoFacts(repo);
    assert.equal(
      facts,
      [
        'Stack manifests: Cargo.toml, go.mod, package.json, pyproject.toml, tsconfig.json',
        'Top-level directories: packages, src',
        'Workspaces: @demo/alpha, @demo/zeta',
        'Test script: node --test',
      ].join('\n'),
    );

    const capped = buildRepoFacts(repo, { maxChars: 30 });
    assert.equal(capped.length, 30);
    assert.ok(capped.endsWith('...'));
  });
});

describe('prompts and modes with repoFacts and onCompleteMeta', () => {
  test('omits Repository facts when repoFacts is falsy and head-fences REPO_FACTS when provided', () => {
    const tA = { id: 'T1', title: 'Alpha', body: `OPEN_${'a'.repeat(100)}_END` };
    const tB = { id: 'T2', title: 'Beta', body: 'Body B' };
    const ctx = [{ path: 'README.md', content: `${'p'.repeat(100)}TAIL_CTX` }];
    const stripNonces = (s) => s.replace(/:[0-9a-f-]{36}>>/g, ':NONCE>>');

    assert.equal(stripNonces(buildSpecReaderPrompt('add caching')), stripNonces(buildSpecReaderPrompt('add caching', {})));
    assert.equal(stripNonces(buildEdgePrompt(tA, tB)), stripNonces(buildEdgePrompt(tA, tB, { repoFacts: '' })));
    assert.equal(stripNonces(buildRouteAnswerPrompt('which?', ctx)), stripNonces(buildRouteAnswerPrompt('which?', ctx, { repoFacts: undefined })));

    const longFacts = `HEAD_FACTS_${'f'.repeat(4100)}_DROPPED_TAIL`;
    const specPrompt = buildSpecReaderPrompt('add caching', { repoFacts: longFacts });
    assert.match(specPrompt, /obey it\.\nRepository facts:\n<<UNTRUSTED:REPO_FACTS \(truncated, showing first 4000/);
    assert.ok(specPrompt.includes('HEAD_FACTS_'));
    assert.ok(!specPrompt.includes('_DROPPED_TAIL'));

    const edgePrompt = buildEdgePrompt(tA, tB, { bodyCap: 20, repoFacts: 'Stack manifests: go.mod' });
    assert.ok(edgePrompt.includes('Stack manifests: go.mod'));
    assert.ok(!edgePrompt.includes('_END'));

    const routePrompt = buildRouteAnswerPrompt('which?', ctx, { contextCap: 20, repoFacts: 'Stack manifests: Cargo.toml' });
    assert.ok(routePrompt.includes('Stack manifests: Cargo.toml'));
    assert.ok(routePrompt.includes('TAIL_CTX'));
    assert.match(routePrompt, /showing last 20 chars only/);
  });

  test('runSpecMode, runEdgeMode, and runRouteMode thread repoFacts, caps, and onCompleteMeta', async () => {
    const seenPrompts = [];
    const seenMetas = [];
    const onCompleteMeta = (m) => seenMetas.push(m);
    const deps = {
      async fan(opts, count) {
        seenPrompts.push(opts.prompt);
        for (let i = 0; i < count; i++) opts.onCompleteMeta?.({ provider: 'stub', model: 'm-cheap', tier: opts.tier });
        if (opts.prompt.includes('technical analyst')) {
          return Array.from({ length: count }, (_, i) => ({ ok: true, value: `Answer ${i}` }));
        }
        const r = JSON.stringify({ spec: 'S', assumptions: [], decisions: [] });
        return Array.from({ length: count }, () => ({ ok: true, value: r }));
      },
      async complete(opts) {
        opts.onCompleteMeta?.({ provider: 'stub', model: 'm-mid', tier: opts.tier });
        if (opts.prompt.includes('semantically equivalent')) {
          return JSON.stringify({ equivalent: true, answer: 'Unified answer', variants: [] });
        }
        return JSON.stringify({ agreements: ['A1'], divergences: [] });
      },
    };

    await runSpecMode('feature req', { n: 2, repoFacts: 'Stack manifests: go.mod', onCompleteMeta, deps });
    await runEdgeMode(
      { id: 'T1', title: 'One', body: `HEAD_${'x'.repeat(80)}_TAIL` },
      { id: 'T2', title: 'Two', body: 'B2' },
      { n: 2, bodyCap: 15, repoFacts: 'Stack manifests: Cargo.toml', onCompleteMeta, deps },
    );
    await runRouteMode(
      'question?',
      [{ path: 'ctx.txt', content: `${'y'.repeat(80)}KEEP` }],
      { n: 2, contextCap: 10, repoFacts: 'Stack manifests: pyproject.toml', onCompleteMeta, deps },
    );

    assert.equal(seenPrompts.length, 3);
    assert.ok(seenPrompts[0].includes('Stack manifests: go.mod'));
    assert.ok(seenPrompts[1].includes('Stack manifests: Cargo.toml') && !seenPrompts[1].includes('_TAIL'));
    assert.ok(seenPrompts[2].includes('Stack manifests: pyproject.toml') && seenPrompts[2].includes('showing last 10 chars only'));
    assert.equal(seenMetas.length, 9);
  });
});

describe('parallax CLI --repo and witnessed manifest recording', () => {
  test('validates --repo and embeds REPO_FACTS across spec, edge, and route --prompt-only runs', (t) => {
    const dir = makeTmpDir(t);
    writeRel(dir, 'package.json', JSON.stringify({ name: 'sample', scripts: { test: 'node --test' } }));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeRel(dir, '.adlc/tickets.json', JSON.stringify({
      tickets: [
        { id: 'T1', title: 'First', body: 'First body' },
        { id: 'T2', title: 'Second', body: 'Second body' },
      ],
    }));

    const badRepo = runBin(BIN, ['--request', 'build widget', '--repo', join(dir, 'missing'), '--prompt-only'], { cwd: dir });
    assert.equal(badRepo.status, 1);

    const plainSpec = runBin(BIN, ['--request', 'build widget', '--prompt-only'], { cwd: dir });
    assert.equal(plainSpec.status, 0);
    assert.ok(!plainSpec.stdout.includes('REPO_FACTS'));

    const repoSpec = runBin(BIN, ['--request', 'build widget', '--repo', dir, '--prompt-only'], { cwd: dir });
    assert.equal(repoSpec.status, 0);
    assert.match(repoSpec.stdout, /<<UNTRUSTED:REPO_FACTS:/);

    const ticketsFile = join(dir, '.adlc/tickets.json');
    const repoEdge = runBin(BIN, ['--edge', 'T1', 'T2', '--tickets', ticketsFile, '--repo', dir, '--prompt-only'], { cwd: dir });
    assert.equal(repoEdge.status, 0);
    assert.match(repoEdge.stdout, /<<UNTRUSTED:REPO_FACTS:/);

    const repoRoute = runBin(BIN, ['--route', 'which test runner?', '--repo', dir, '--prompt-only'], { cwd: dir });
    assert.equal(repoRoute.status, 0);
    assert.match(repoRoute.stdout, /<<UNTRUSTED:REPO_FACTS:/);
  });

  test('records witnessed manifest entries for reported and unreported usage only when --ticket is passed', (t) => {
    const dir = makeTmpDir(t);
    writeRel(dir, 'package.json', JSON.stringify({ name: 'live-repo' }));
    const adlcDir = join(dir, 'custom-adlc');
    const fakeReported = join(dir, 'fake-claude.mjs');
    writeFileSync(fakeReported, [
      '#!/usr/bin/env node',
      "let input = ''; process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (c) => { input += c; });",
      "process.stdin.on('end', () => {",
      "  const payload = input.includes('independent readings') ? { agreements: ['use sqlite'], divergences: [] } : { spec: 'sqlite store', assumptions: [], decisions: [] };",
      '  process.stdout.write(JSON.stringify({ result: JSON.stringify(payload), usage: { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 5 } }));',
      '});',
    ].join('\n'), 'utf8');
    chmodSync(fakeReported, 0o755);

    const claudeEnv = { ADLC_PROVIDER: 'claude-cli', ADLC_CLAUDE_CLI: fakeReported };
    const noTicketRes = runBin(BIN, ['--request', 'store items', '--n', '2', '--dir', adlcDir, '--json'], { cwd: dir, env: claudeEnv });
    assert.equal(noTicketRes.status, 0);
    assert.equal(existsSync(join(adlcDir, 'manifest.jsonl')), false);

    const reportedRes = runBin(BIN, ['--request', 'store items', '--n', '2', '--ticket', 'T-LIVE-1', '--repo', dir, '--dir', adlcDir, '--json'], { cwd: dir, env: claudeEnv });
    assert.equal(reportedRes.status, 0, `stderr: ${reportedRes.stderr}`);

    const fakeUnreported = join(dir, 'fake-codex.mjs');
    writeFileSync(fakeUnreported, [
      '#!/usr/bin/env node',
      "let input = ''; process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (c) => { input += c; });",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(input.includes('semantically equivalent') ? JSON.stringify({ equivalent: true, answer: 'Use node --test', variants: [] }) : 'Use node --test');",
      '});',
    ].join('\n'), 'utf8');
    chmodSync(fakeUnreported, 0o755);

    const codexEnv = { ADLC_PROVIDER: 'codex-cli', ADLC_CODEX_CLI: fakeUnreported };
    const unreportedRes = runBin(BIN, ['--route', 'how to test?', '--n', '2', '--ticket', 'T-LIVE-2', '--repo', dir, '--dir', adlcDir, '--json'], { cwd: dir, env: codexEnv });
    assert.equal(unreportedRes.status, 0, `stderr: ${unreportedRes.stderr}`);

    const lines = readFileSync(join(adlcDir, 'manifest.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0].data, {
      mode: 'spec',
      provider: 'claude-cli',
      model: 'claude-sonnet-4-6',
      tier: 'mid',
      attestationMode: 'headless-cli',
      executionWitnessed: true,
      usageStatus: 'reported',
      usage: { inputTokens: 120, outputTokens: 30, cachedTokens: 15 },
    });
    assert.deepEqual(lines[1].data, {
      mode: 'route',
      provider: 'codex-cli',
      model: 'gpt-5-mini',
      tier: 'cheap',
      attestationMode: 'headless-cli',
      executionWitnessed: true,
      usageStatus: 'unreported',
    });
  });
});

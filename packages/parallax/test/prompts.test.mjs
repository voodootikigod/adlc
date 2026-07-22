// Tests for lib/prompts.mjs — pure functions, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSpecReaderPrompt,
  buildDivergencePrompt,
  buildEdgePrompt,
  buildRouteAnswerPrompt,
  buildRouteJudgePrompt,
} from '../lib/prompts.mjs';

test('buildSpecReaderPrompt: includes the request text', () => {
  const prompt = buildSpecReaderPrompt('Add a search feature to the homepage');
  assert.ok(prompt.includes('Add a search feature to the homepage'));
  assert.ok(prompt.includes('spec'));
  assert.ok(prompt.includes('assumptions'));
  assert.ok(prompt.includes('decisions'));
  assert.ok(prompt.includes('do NOT ask questions'));
});

test('buildSpecReaderPrompt: instructs to commit to ONE reading', () => {
  const prompt = buildSpecReaderPrompt('some request');
  assert.ok(prompt.includes('ONE reading'));
});

test('buildSpecReaderPrompt: requests JSON output', () => {
  const prompt = buildSpecReaderPrompt('some request');
  assert.ok(prompt.includes('Output JSON'));
});

test('buildDivergencePrompt: includes all readings', () => {
  const readings = [
    { spec: 'Spec A', assumptions: [], decisions: [] },
    { spec: 'Spec B', assumptions: [], decisions: [] },
  ];
  const prompt = buildDivergencePrompt(readings);
  assert.ok(prompt.includes('Reading 1'));
  assert.ok(prompt.includes('Reading 2'));
  assert.ok(prompt.includes('Spec A'));
  assert.ok(prompt.includes('Spec B'));
});

test('buildDivergencePrompt: mentions agreements and divergences', () => {
  const readings = [
    { spec: 'A', assumptions: [], decisions: [] },
    { spec: 'B', assumptions: [], decisions: [] },
  ];
  const prompt = buildDivergencePrompt(readings);
  assert.ok(prompt.includes('agreements'));
  assert.ok(prompt.includes('divergences'));
});

test('buildDivergencePrompt: count appears in prompt', () => {
  const readings = [
    { spec: 'A', assumptions: [], decisions: [] },
    { spec: 'B', assumptions: [], decisions: [] },
    { spec: 'C', assumptions: [], decisions: [] },
  ];
  const prompt = buildDivergencePrompt(readings);
  assert.ok(prompt.includes('3 independent readings'));
});

test('buildEdgePrompt: includes both ticket IDs and titles', () => {
  const ticketA = { id: 'T1', title: 'Auth Service', body: 'Build the auth service' };
  const ticketB = { id: 'T2', title: 'API Gateway', body: 'Route requests through the API' };
  const prompt = buildEdgePrompt(ticketA, ticketB);
  assert.ok(prompt.includes('T1'));
  assert.ok(prompt.includes('Auth Service'));
  assert.ok(prompt.includes('T2'));
  assert.ok(prompt.includes('API Gateway'));
  assert.ok(prompt.includes('Build the auth service'));
  assert.ok(prompt.includes('Route requests through the API'));
});

test('buildEdgePrompt: handles missing body gracefully', () => {
  const ticketA = { id: 'T1', title: 'Auth', body: undefined };
  const ticketB = { id: 'T2', title: 'Gate', body: null };
  const prompt = buildEdgePrompt(ticketA, ticketB);
  assert.ok(prompt.includes('(no body)'));
});

test('buildEdgePrompt: requests interface/contract output', () => {
  const ticketA = { id: 'T1', title: 'A', body: 'body A' };
  const ticketB = { id: 'T2', title: 'B', body: 'body B' };
  const prompt = buildEdgePrompt(ticketA, ticketB);
  assert.ok(prompt.includes('interface/contract'));
  assert.ok(prompt.includes('function signatures'));
});

test('buildRouteAnswerPrompt: includes the question', () => {
  const prompt = buildRouteAnswerPrompt('What is the retry policy?', []);
  assert.ok(prompt.includes('What is the retry policy?'));
  assert.ok(prompt.includes('commit to one answer'));
});

test('buildRouteAnswerPrompt: includes context file contents', () => {
  const contextFiles = [
    { path: 'spec.md', content: 'retry 3 times with exponential backoff' },
  ];
  const prompt = buildRouteAnswerPrompt('What is the retry policy?', contextFiles);
  assert.ok(prompt.includes('spec.md'));
  assert.ok(prompt.includes('retry 3 times with exponential backoff'));
});

test('buildRouteAnswerPrompt: no context = no context section', () => {
  const prompt = buildRouteAnswerPrompt('What is the retry policy?', []);
  assert.ok(!prompt.includes('==='));
});

// ── context capping (issue #280) ────────────────────────────────────────────

test('buildRouteAnswerPrompt: an oversized context file is capped to the default (6000 chars) and marked truncated in-prompt', () => {
  const bigContent = 'x'.repeat(20_000);
  const contextFiles = [{ path: 'big.mjs', content: bigContent }];
  const prompt = buildRouteAnswerPrompt('question', contextFiles);

  assert.ok(prompt.length < bigContent.length, 'the whole prompt must be smaller than the raw oversized file');
  assert.match(prompt, /showing last 6000 chars only/);
  // Exactly 6000 x's should appear in the embedded block, not the full 20,000.
  const embedded = prompt.match(/big\.mjs[^\n]*\n(x+)/)[1];
  assert.equal(embedded.length, 6000);
});

test('buildRouteAnswerPrompt: a file within the cap is shown whole and NOT marked truncated', () => {
  const content = 'small content';
  const contextFiles = [{ path: 'small.mjs', content }];
  const prompt = buildRouteAnswerPrompt('question', contextFiles);

  assert.ok(prompt.includes(content));
  assert.ok(!prompt.includes('truncated'));
});

test('buildRouteAnswerPrompt: every file block states its real char and line count', () => {
  const content = 'line one\nline two\nline three';
  const contextFiles = [{ path: 'f.mjs', content }];
  const prompt = buildRouteAnswerPrompt('question', contextFiles);
  assert.match(prompt, /f\.mjs \(28 chars, 3 lines\)/);
});

test('buildRouteAnswerPrompt: --context-cap override applies a different cap', () => {
  const content = 'y'.repeat(1000);
  const contextFiles = [{ path: 'f.mjs', content }];
  const prompt = buildRouteAnswerPrompt('question', contextFiles, { contextCap: 100 });

  assert.match(prompt, /showing last 100 chars only/);
  const embedded = prompt.match(/f\.mjs[^\n]*\n(y+)/)[1];
  assert.equal(embedded.length, 100);
});

test('buildRouteAnswerPrompt: keeps the TAIL of an oversized file (the relevant answer is more likely near the end of a long doc)', () => {
  const content = `${'PREFIX_NOISE'.repeat(1000)}RELEVANT_ANSWER_HERE`;
  const contextFiles = [{ path: 'f.mjs', content }];
  const prompt = buildRouteAnswerPrompt('question', contextFiles, { contextCap: 50 });
  assert.match(prompt, /RELEVANT_ANSWER_HERE/);
});

test('AC: parallax route prompts contain no direct un-capped f.content join (grep-style source assertion)', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const source = readFileSync(fileURLToPath(new URL('../lib/prompts.mjs', import.meta.url)), 'utf8');
  assert.ok(
    !/f\.content\}/.test(source) && !/\$\{f\.content\}/.test(source),
    'prompts.mjs must not embed f.content directly without going through tail()/the cap'
  );
});

test('buildRouteJudgePrompt: includes all answers', () => {
  const answers = ['PostgreSQL is recommended', 'Use PostgreSQL', 'SQLite for testing'];
  const prompt = buildRouteJudgePrompt('Which DB?', answers);
  assert.ok(prompt.includes('PostgreSQL is recommended'));
  assert.ok(prompt.includes('Use PostgreSQL'));
  assert.ok(prompt.includes('SQLite for testing'));
  assert.ok(prompt.includes('Which DB?'));
});

test('buildRouteJudgePrompt: asks for equivalent/answer/variants JSON', () => {
  const prompt = buildRouteJudgePrompt('Q?', ['A1', 'A2']);
  assert.ok(prompt.includes('"equivalent"'));
  assert.ok(prompt.includes('"answer"'));
  assert.ok(prompt.includes('"variants"'));
});

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

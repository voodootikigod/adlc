// Concern: model-id -> vendor-family inference (T-REV-01) and @adlc/core re-exports.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inferModelProviderFamily as fromCore } from '../index.mjs';
import { inferModelProviderFamily as fromLlm } from '../lib/llm.mjs';
import { inferModelProviderFamily } from '../lib/model-family.mjs';

describe('inferModelProviderFamily', () => {
  it('is re-exported identically from model-family.mjs, llm.mjs, and @adlc/core index', () => {
    assert.equal(fromCore, inferModelProviderFamily);
    assert.equal(fromLlm, inferModelProviderFamily);
  });

  it('maps Anthropic / Claude model ids (including NFKC and whitespace)', () => {
    for (const id of [
      'Claude Opus 4.6 (Thinking)',
      'Claude Sonnet 4.6 (Thinking)',
      'claude-haiku-4-5',
      'anthropic/claude-3-7-sonnet',
      '  Ｃｌａｕｄｅ  4  ',
    ]) {
      assert.equal(inferModelProviderFamily(id), 'anthropic', id);
    }
  });

  it('maps Google / Gemini / Gemma model ids', () => {
    for (const id of [
      'Gemini 3.5 Flash (Medium)',
      'gemini-2.5-pro',
      'gemma-3-27b-it',
      '  Ｇｅｍｉｎｉ 2.5 Flash ',
    ]) {
      assert.equal(inferModelProviderFamily(id), 'google', id);
    }
  });

  it('maps OpenAI / GPT / o-series / Codex model ids', () => {
    for (const id of [
      'gpt-5.1',
      'gpt-5-mini',
      'o1-preview',
      'o3-mini',
      'o4-mini',
      'codex-mini-latest',
      '  ＧＰＴ-5.1 ',
    ]) {
      assert.equal(inferModelProviderFamily(id), 'openai', id);
    }
  });

  it('returns empty string for empty, non-string, or unknown model ids', () => {
    for (const id of ['', '   ', null, undefined, 42, {}, 'llama-3.3-70b', 'mistral-large', 'deepseek-r1']) {
      assert.equal(inferModelProviderFamily(id), '', String(id));
    }
  });
});

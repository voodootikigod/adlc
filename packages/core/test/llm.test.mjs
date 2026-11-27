// Concern: model-id -> vendor-family inference (T-REV-01), @adlc/core re-exports,
// and agy subprocess environment sanitization.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inferModelProviderFamily as fromCore } from '../index.mjs';
import { complete, inferModelProviderFamily as fromLlm } from '../lib/llm.mjs';
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

  it('agySend strips ADLC_MANIFEST_KEY, ADLC_MANIFEST_PRIVATE_KEY, and ADLC_ADMIN_* from subprocess env', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'adlc-agy-env-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const fakeAgy = join(dir, 'fake-agy');
    writeFileSync(
      fakeAgy,
      `#!${process.execPath}\nconsole.log(JSON.stringify({ key: process.env.ADLC_MANIFEST_KEY ?? null, priv: process.env.ADLC_MANIFEST_PRIVATE_KEY ?? null, admin: process.env.ADLC_ADMIN_TOKEN ?? null, keep: process.env.SAFE_TEST_VAR ?? null }));\n`,
      'utf8',
    );
    chmodSync(fakeAgy, 0o755);
    const res = await complete(
      { prompt: 'ping', provider: 'agy' },
      {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ADLC_PROVIDER: 'agy',
        ADLC_AGY: fakeAgy,
        ADLC_MANIFEST_KEY: 'secret-hmac-key',
        ADLC_MANIFEST_PRIVATE_KEY: 'ed25519-priv:secret-ed25519-key',
        ADLC_ADMIN_TOKEN: 'secret-admin-token',
        SAFE_TEST_VAR: 'kept',
      },
    );
    const observed = JSON.parse(typeof res === 'string' ? res : res.text);
    assert.deepEqual(observed, { key: null, priv: null, admin: null, keep: 'kept' });
  });
});

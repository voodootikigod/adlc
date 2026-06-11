// LLM provider detection and completion. Zero dependencies, native fetch.
//
// Tiers: 'cheap' | 'mid' | 'frontier'. Defaults below are overridable:
//   AIDLC_PROVIDER        force provider: anthropic | openai | gemini | agy
//   AIDLC_MODEL_CHEAP     model id for the cheap tier
//   AIDLC_MODEL_MID       model id for the mid tier
//   AIDLC_MODEL_FRONTIER  model id for the frontier tier
//
// The 'agy' provider runs completions through the Antigravity CLI
// (`agy --print`) instead of an HTTP API — quota comes from the user's
// Antigravity plan, no API key. Opt-in: set AIDLC_AGY=1 (or a path to the
// agy binary) or force with AIDLC_PROVIDER=agy. Extra knobs:
//   AIDLC_AGY_TIMEOUT   print-timeout passed to agy (default 300s)
//   AIDLC_AGY_SANDBOX   set to 1 to pass --sandbox

import { spawn } from 'node:child_process';

// agy's timeout marker is its ENTIRE output on failure. Matching it as a
// bare substring would false-trip whenever a model quotes the phrase in a
// legitimate answer, so require it to be the only meaningful content (last
// non-empty line, output short). Exported for tests.
export function isAgyTimeout(out) {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1) ?? '';
  return /^Error: timed out waiting for response\.?$/.test(last) && out.length < 200;
}

// Env values that explicitly DISABLE a feature flag. 'false'/'0' are truthy
// strings in JS, so a plain existence check would enable on AIDLC_AGY=false.
function envEnabled(v) {
  return v !== undefined && v !== '' && !['0', 'false', 'no', 'off', 'disabled'].includes(v.toLowerCase());
}

function agySend({ apiKey, model, system, prompt }, env = process.env) {
  // apiKey carries the binary path ('1'/'true' mean default 'agy').
  const bin = apiKey === '1' || apiKey === 'true' ? 'agy' : apiKey;
  const args = ['--print', '--print-timeout', env.AIDLC_AGY_TIMEOUT ?? '300s', '--model', model];
  if (env.AIDLC_AGY_SANDBOX === '1') args.push('--sandbox');
  const input = system ? `${system}\n\n---\n\n${prompt}` : prompt;
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => reject(new Error(`agy spawn failed: ${e.message}`)));
    p.stdin.end(input);
    p.on('close', (code) => {
      // agy exits 0 even on print-timeout; the error surfaces in the output.
      if (code !== 0) return reject(new Error(`agy exit ${code}: ${(err || out).slice(-400)}`));
      if (isAgyTimeout(out)) {
        return reject(new Error('agy: timed out waiting for response'));
      }
      resolve(out.replace(/\s+$/, ''));
    });
  });
}

const PROVIDERS = [
  {
    name: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    models: {
      cheap: 'claude-haiku-4-5',
      mid: 'claude-sonnet-4-6',
      frontier: 'claude-opus-4-8',
    },
    async send({ apiKey, model, system, prompt, maxTokens }) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          ...(system ? { system } : {}),
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return (data.content ?? []).map((b) => b.text ?? '').join('');
    },
  },
  {
    name: 'openai',
    envKey: 'OPENAI_API_KEY',
    models: {
      cheap: 'gpt-5-mini',
      mid: 'gpt-5.1',
      frontier: 'gpt-5.1',
    },
    async send({ apiKey, model, system, prompt, maxTokens }) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_completion_tokens: maxTokens,
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: prompt },
          ],
        }),
      });
      if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content ?? '';
    },
  },
  {
    name: 'gemini',
    envKey: 'GEMINI_API_KEY',
    models: {
      cheap: 'gemini-2.5-flash',
      mid: 'gemini-2.5-pro',
      frontier: 'gemini-2.5-pro',
    },
    async send({ apiKey, model, system, prompt, maxTokens }) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxTokens },
        }),
      });
      if (!res.ok) throw new Error(`gemini ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    },
  },
  {
    // Antigravity CLI subprocess provider. Last in the list so API-key
    // providers win during auto-detection; force with AIDLC_PROVIDER=agy.
    name: 'agy',
    envKey: 'AIDLC_AGY',
    models: {
      cheap: 'Gemini 3.5 Flash (Medium)',
      mid: 'Claude Sonnet 4.6 (Thinking)',
      frontier: 'Claude Opus 4.6 (Thinking)',
    },
    send: agySend,
  },
];

/**
 * Detect the first available provider (or the one forced via AIDLC_PROVIDER).
 * Returns { name, apiKey, models } or null when no key is present.
 */
export function detectProvider(env = process.env) {
  const forced = env.AIDLC_PROVIDER;
  const candidates = forced ? PROVIDERS.filter((p) => p.name === forced) : PROVIDERS;
  for (const p of candidates) {
    const apiKey = env[p.envKey];
    // agy is gated on a feature flag (truthy-but-not-"false"); API-key
    // providers are gated on a non-empty key.
    if (p.name === 'agy') {
      if (envEnabled(apiKey)) return { ...p, apiKey };
      if (forced === 'agy') return { ...p, apiKey: '1' }; // explicit force needs no key
    } else if (apiKey) {
      return { ...p, apiKey };
    }
  }
  return null;
}

/** Resolve a tier ('cheap'|'mid'|'frontier') or explicit model id to a model id. */
export function resolveModel(provider, { tier = 'mid', model } = {}, env = process.env) {
  if (model) return model;
  const override = env[`AIDLC_MODEL_${tier.toUpperCase()}`];
  if (override) return override;
  const resolved = provider.models[tier];
  if (!resolved) throw new Error(`unknown tier: ${tier}`);
  return resolved;
}

/**
 * Single completion. Throws on missing provider or HTTP error.
 * opts: { tier, model, system, prompt, maxTokens }
 */
export async function complete(opts) {
  const provider = detectProvider();
  if (!provider) {
    throw new Error(
      'no LLM provider configured — set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY (or use --prompt-only)'
    );
  }
  const model = resolveModel(provider, opts);
  return provider.send({
    apiKey: provider.apiKey,
    model,
    system: opts.system,
    prompt: opts.prompt,
    maxTokens: opts.maxTokens ?? 4096,
  });
}

/**
 * Fan out N independent completions of the same prompt (fresh "contexts" by
 * construction — each call is stateless). Settles all; returns array of
 * { ok, value | error } in order.
 */
export async function fan(opts, n) {
  const results = await Promise.allSettled(
    Array.from({ length: n }, () => complete(opts))
  );
  return results.map((r) =>
    r.status === 'fulfilled' ? { ok: true, value: r.value } : { ok: false, error: String(r.reason) }
  );
}

/**
 * Extract the first JSON value ({...} or [...]) from model output.
 * Strips code fences, balances braces while respecting strings.
 * Throws if nothing parseable is found.
 */
export function extractJson(text) {
  if (typeof text !== 'string') throw new Error('extractJson: input is not a string');
  const cleaned = text.replace(/```(?:json)?/g, '');
  const start = cleaned.search(/[[{]/);
  if (start === -1) throw new Error('extractJson: no JSON object or array found');
  const open = cleaned[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return JSON.parse(cleaned.slice(start, i + 1));
    }
  }
  throw new Error('extractJson: unbalanced JSON in model output');
}

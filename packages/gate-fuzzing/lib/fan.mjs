// gate-fuzzing/lib/fan.mjs
// Model-driven adversary fan (§2). Injectable completeFn for tests.
// The adversary is N fanned cheap/mid models (frontier-free, E2).
// Each call is stateless — fresh contexts by construction.

import { sampleSeeds, NOVEL_SEED } from './seeds.mjs';

/**
 * Build the adversary system prompt for a specific gate target.
 *
 * @param {object} gate - Gate descriptor
 * @param {object[]} priorDefeats - Confirmed defeats from earlier rounds (for feedback)
 * @returns {string}
 */
export function buildSystemPrompt(gate, priorDefeats = []) {
  const lines = [
    `You are a red-team adversary against ONE CI gate: "${gate.name}".`,
    '',
    `Goal: produce a code change that "${gate.name}" PASSES (exit 0) while GENUINELY`,
    `violating the property "${gate.name}" claims to protect.`,
    '',
    `The gate protects: ${(gate.claims ?? []).join(', ')}`,
    `The gate surface (paths it guards): ${(gate.surface ?? []).join(', ')}`,
    '',
    'Your change MUST touch a path the gate guards (its surface).',
    'Your change MUST compile/lint/typecheck (passes ALL validity gates).',
    '',
    'WITNESS RULES (critical):',
    'Propose a witness command that PASSES on the ORIGINAL tree and FAILS on YOUR changed tree.',
    'An INDEPENDENT verifier re-derives or re-approves the witness.',
    'A witness contrived to your specific diff (not pinning a genuine defect) will be REJECTED.',
    'Be correct about the gate blind spot, not clever about the witness.',
    '',
    'OUTPUT: Only the candidate JSON matching this exact schema:',
    JSON.stringify({
      strategy: '<taxonomy class name>',
      target: gate.name,
      claimKind: '<one of: ' + (gate.claims ?? []).join(', ') + '>',
      rationale: '<why the gate has this hole>',
      diff: '<unified diff against baseline>',
      witnessProposal: { cmd: '<node|git|npm|npx>', args: ['<arg1>'] },
      setup: [['git', 'add', '-A'], ['git', 'commit', '-m', 'x', '--no-verify']],
    }, null, 2),
    '',
    'IMPORTANT: setup must be an array of argv arrays (no shell strings).',
    'cmd must be one of: node, git, npm, npx',
  ];

  if (priorDefeats.length > 0) {
    lines.push('');
    lines.push(`Prior confirmed defeats (${priorDefeats.length}) — find ADJACENT classes:`);
    for (const d of priorDefeats.slice(-3)) { // last 3 defeats as feedback
      lines.push(`- ${d.strategy}: ${d.rationale ?? d.verdict?.reason ?? ''}`);
    }
  }

  return lines.join('\n');
}

/**
 * Build the user prompt for one fan instance with a specific seed strategy.
 *
 * @param {object} gate - Gate descriptor with docs, surface, claims
 * @param {object} seed - Taxonomy seed assigned to this instance
 * @param {string} baselineManifest - Brief manifest of files in gate surface
 * @returns {string}
 */
export function buildUserPrompt(gate, seed, baselineManifest = '') {
  const lines = [
    `Target gate: ${gate.name}`,
    `Surface: ${(gate.surface ?? []).join(', ')}`,
    `Claims: ${(gate.claims ?? []).join(', ')}`,
    '',
  ];

  if (seed.name !== 'novel') {
    lines.push(`Assigned strategy class: ${seed.name}`);
    lines.push(`Strategy prior: ${seed.prior}`);
    lines.push('');
    lines.push('Generalize: find a NEW instance of this class, or a class not in the list.');
  } else {
    lines.push('Assigned strategy: NOVEL (find a class not in the standard list)');
    lines.push('There is no prior — you must discover a genuinely new bypass class.');
  }

  if (baselineManifest) {
    lines.push('');
    lines.push('Baseline tree (gate surface files):');
    lines.push(baselineManifest);
  }

  if (gate.docs && gate.docs.length > 0) {
    lines.push('');
    lines.push('Gate source/docs (open-box — attack the actual implementation):');
    lines.push(gate.docs.join('\n---\n'));
  }

  return lines.join('\n');
}

/**
 * Fan the adversary across N instances with seeded strategies (default), or
 * across DISTINCT named provider families when `providerNames` is supplied
 * (issue #63) — one candidate per requested provider instead of N resamples
 * of one auto-detected provider. Each instance gets a different seed from
 * the 12-class taxonomy, cycling through gates.
 * Injectable completeFn for offline tests (never calls real LLM in tests).
 *
 * @param {object} opts
 * @param {object[]} opts.gates - Gate descriptors to target
 * @param {object[]} [opts.priorDefeats] - For feedback prompting
 * @param {number} [opts.n] - Fan width, default 6. Ignored when `providerNames`
 *   is supplied (fan width becomes providerNames.length instead).
 * @param {string|null} [opts.provider] - single-provider override (mirrors a
 *   CLI `--provider` flag): every fan instance uses this SAME provider
 *   instead of letting `complete()` auto-detect. Ignored when `providerNames`
 *   is also supplied (mutually exclusive at the CLI layer).
 * @param {string[]|null} [opts.providerNames] - e.g. ['anthropic', 'openai'];
 *   when supplied, assigns one distinct provider per fan instance instead of
 *   letting every instance auto-detect the same provider. Additive only —
 *   omit it and behavior is unchanged.
 * @param {string} [opts.tier] - Model tier, default 'mid'
 * @param {number} [opts.maxTokens] - Max tokens per response, default 4096
 * @param {Function|null} [opts.completeFn] - Injectable: async (fanOpts) => string,
 *   called once per fan instance. If null, uses core `complete()` per instance
 *   (dynamic import keeps @adlc/core optional for pure prompt-builder tests).
 * @returns {Promise<Array<{ok:boolean, value?:string, error?:string, provider?:string, promptChars:number}>>}
 *   `promptChars` is the system+user prompt length actually SENT for that
 *   instance (system and prompt differ per instance — different gate/seed
 *   pairing), so the loop's token estimator can charge input, not just
 *   output (see loop.mjs `estimateTokens`).
 */
export async function fanAdversary(opts) {
  const {
    gates,
    priorDefeats = [],
    n = 6,
    provider = null,
    providerNames = null,
    tier = 'mid',
    maxTokens = 4096,
    completeFn = null,
  } = opts;

  const fanWidth = providerNames ? providerNames.length : n;

  // Sample fanWidth seeds for this round
  const seeds = sampleSeeds(fanWidth);

  // Build prompts for each fan instance, cycling through gates. When
  // providerNames is supplied, each instance also gets a distinct provider
  // override — genuinely different model families, not resamples. When only
  // the singular `provider` override is supplied, every instance uses that
  // same forced provider (still n resamples, just not auto-detected).
  const fanCalls = seeds.map((seed, i) => {
    const gate = gates[i % gates.length];
    const system = buildSystemPrompt(gate, priorDefeats);
    const prompt = buildUserPrompt(gate, seed);
    return {
      tier,
      system,
      prompt,
      maxTokens,
      ...(providerNames ? { provider: providerNames[i] } : provider ? { provider } : {}),
    };
  });

  // Injectable: completeFn(call) => Promise<string>, one call per fan
  // instance. Real: core `complete()` per instance.
  const runOne = completeFn
    ? (call) => completeFn(call)
    : (call) => import('@adlc/core').then(({ complete }) => complete(call));

  const results = await Promise.allSettled(fanCalls.map(runOne));

  return results.map((r, i) => {
    const call = fanCalls[i];
    const promptChars = (call.system?.length ?? 0) + (call.prompt?.length ?? 0);
    return r.status === 'fulfilled'
      ? { ok: true, value: r.value, provider: call.provider, promptChars }
      : { ok: false, error: String(r.reason), provider: call.provider, promptChars };
  });
}

/**
 * Build --prompt-only output (print all prompts and exit, §8).
 * @param {object[]} gates
 * @param {number} n
 * @returns {string[]} Array of prompt strings
 */
export function buildPromptOnlyOutput(gates, n = 6) {
  const seeds = sampleSeeds(n);
  return seeds.map((seed, i) => {
    const gate = gates[i % gates.length];
    const system = buildSystemPrompt(gate);
    const prompt = buildUserPrompt(gate, seed);
    return `=== Fan instance ${i + 1}/${n} | Gate: ${gate.name} | Strategy: ${seed.name} ===\n\n` +
           `SYSTEM:\n${system}\n\nUSER:\n${prompt}`;
  });
}

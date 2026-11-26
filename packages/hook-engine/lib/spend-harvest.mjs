// spend-harvest.mjs — harvest host-harness session token usage.
import { sha256, readBoundedRegularFile } from '@adlc/core';

export function harvestTranscriptUsage(transcriptPath, { maxBytes = 10 * 1024 * 1024 } = {}) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.trim()) return null;

  let rawContent;
  try {
    rawContent = readBoundedRegularFile(transcriptPath.trim(), maxBytes);
  } catch {
    return null;
  }

  if (typeof rawContent !== 'string' || !rawContent.trim()) return null;

  const trimmed = rawContent.trim();
  const transcriptSha256 = sha256(rawContent);

  const rawEntries = [];
  if (trimmed.startsWith('{') && !trimmed.includes('\n')) {
    try {
      rawEntries.push(JSON.parse(trimmed));
    } catch {
      return null;
    }
  } else if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) {
        rawEntries.push(...arr);
      } else {
        return null;
      }
    } catch {
      return null;
    }
  } else {
    // JSONL or mixed lines
    for (const line of rawContent.split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;
      try {
        rawEntries.push(JSON.parse(l));
      } catch {
        // ignore unparseable line or treat as non-usage
      }
    }
  }

  // Deduplicate repeated message.id streaming snapshots, keeping the latest snapshot per unique message.id
  // Also collect non-id usage objects
  const idToSnapshot = new Map();
  const standaloneSnapshots = [];

  for (const entry of rawEntries) {
    if (!entry || typeof entry !== 'object') continue;

    // Check message id
    const msgId = entry.message?.id ?? entry.id ?? (entry.type === 'message' ? entry.message_id : null);
    // Find where usage lives
    const usageObj = entry.usage ?? entry.message?.usage ?? entry.response?.usage ?? entry.metadata?.usage ?? null;

    if (!usageObj || typeof usageObj !== 'object') continue;

    const snapshot = {
      model: entry.model ?? entry.message?.model ?? entry.response?.model ?? usageObj.model ?? null,
      provider: entry.provider ?? entry.message?.provider ?? entry.response?.provider ?? usageObj.provider ?? null,
      usage: usageObj,
    };

    if (msgId && typeof msgId === 'string') {
      idToSnapshot.set(msgId, snapshot);
    } else {
      standaloneSnapshots.push(snapshot);
    }
  }

  const allSnapshots = [...idToSnapshot.values(), ...standaloneSnapshots];
  if (allSnapshots.length === 0) return null;

  let calls = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedTokens = 0;
  let detectedProvider = 'unknown';
  let detectedModel = 'unknown';

  for (const snap of allSnapshots) {
    const u = snap.usage;
    // inputTokens sums Claude input_tokens / Codex input_tokens / Gemini promptTokenCount / OpenAI prompt_tokens
    const inTok = Number(u.input_tokens ?? u.promptTokenCount ?? u.prompt_tokens ?? u.inputTokens ?? 0) || 0;
    // outputTokens sums Claude output_tokens / Codex output_tokens / Gemini candidatesTokenCount + thoughtsTokenCount / OpenAI completion_tokens
    const geminiCandidates = Number(u.candidatesTokenCount ?? 0) || 0;
    const geminiThoughts = Number(u.thoughtsTokenCount ?? 0) || 0;
    const outTok = geminiCandidates > 0 || geminiThoughts > 0
      ? (geminiCandidates + geminiThoughts)
      : (Number(u.output_tokens ?? u.completion_tokens ?? u.outputTokens ?? 0) || 0);
    // cachedTokens sums cache_read_input_tokens + cache_creation_input_tokens + cached_input_tokens + cachedContentTokenCount
    const cachedTok =
      (Number(u.cache_read_input_tokens ?? 0) || 0) +
      (Number(u.cache_creation_input_tokens ?? 0) || 0) +
      (Number(u.cached_input_tokens ?? 0) || 0) +
      (Number(u.cachedContentTokenCount ?? 0) || 0) +
      (Number(u.cachedTokens ?? 0) || 0);

    if (inTok > 0 || outTok > 0 || cachedTok > 0) {
      calls += 1;
      totalInputTokens += inTok;
      totalOutputTokens += outTok;
      totalCachedTokens += cachedTok;

      if (snap.provider && typeof snap.provider === 'string' && snap.provider !== 'unknown') {
        detectedProvider = snap.provider;
      } else if (detectedProvider === 'unknown') {
        if (u.promptTokenCount !== undefined || u.candidatesTokenCount !== undefined) {
          detectedProvider = 'gemini';
        } else if (u.cache_read_input_tokens !== undefined || u.cache_creation_input_tokens !== undefined) {
          detectedProvider = 'claude';
        } else if (u.prompt_tokens !== undefined || u.completion_tokens !== undefined) {
          detectedProvider = 'openai';
        }
      }

      if (snap.model && typeof snap.model === 'string' && snap.model !== 'unknown') {
        detectedModel = snap.model;
      }
    }
  }

  if (calls === 0) return null;

  return {
    transcriptSha256,
    calls,
    provider: detectedProvider,
    usage: {
      provider: detectedProvider,
      model: detectedModel,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cachedTokens: totalCachedTokens,
    },
  };
}

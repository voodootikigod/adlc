// Shared helpers for WorkerAdapters (spec §4). Every adapter is a pure I/O shim:
// it spawns its harness in headless mode on the MODEL plane and maps the result
// to the scheduler's standard shape. The result mapping and the default exec are
// identical across harnesses, so they live here.

import { spawnAsync } from '../spawn-async.mjs';

/**
 * The registry sentinel meaning "let the harness resolve its own default"
 * (operating-stack §4b). It is the one `model` value that is NOT forced onto the
 * command line: passing the literal string `default` to a CLI would name a model
 * that does not exist.
 */
export const HARNESS_DEFAULT_ALIAS = 'default';

/**
 * Render the §4c FORCE half: the dispatcher's chosen model, explicitly, rather
 * than the harness's ambient default. Returns the flag pair or nothing.
 */
export function modelArgs(flag, model) {
  if (typeof model !== 'string' || model.length === 0) return [];
  if (model === HARNESS_DEFAULT_ALIAS) return [];
  return [flag, model];
}

export function defaultExec(cmd, args, opts) {
  return spawnAsync(cmd, args, { ...opts, encoding: 'utf8' });
}

/** Map a spawn result to the adapter contract: { exitCode, output, timedOut }. */
export function mapResult(res) {
  const timedOut = res.signal === 'SIGTERM' || res.killed === true || res.timedOut === true;
  const status = typeof res.status === 'number' ? res.status : (timedOut ? 124 : 1);
  return {
    // Output cut at the byte cap is NOT a verdict: the completion marker or result document
    // may be in the part that was dropped, so a truncated result is a failed strike (codex r24 #4).
    exitCode: res.truncated === true && status === 0 ? 1 : status,
    output: `${res.truncated === true ? TRUNCATED_NOTE : ''}${res.stdout ?? ''}${res.stderr ?? ''}`,
    timedOut,
    ...(res.truncated === true ? { truncated: true } : {}),
  };
}

/** Prefixed to a truncated worker's output so the transcript says why the strike failed. */
export const TRUNCATED_NOTE = '[fleet] worker output exceeded the byte cap and was truncated; the result is not trusted\n';

/**
 * Serialize a strike's output and optional structured tool events into
 * normalized JSONL records consumable by `@adlc/flail-detector`'s `parseLog`.
 *
 * @param {object} opts
 * @param {string} opts.ticketId
 * @param {number} opts.strike
 * @param {string} [opts.adapter]
 * @param {string} [opts.output]
 * @param {number | null} [opts.exitCode]
 * @param {boolean} [opts.timedOut]
 * @param {Array<object>} [opts.toolEvents]
 * @returns {string}
 */
export function serializeStrikeTranscriptJsonl({
  ticketId,
  strike,
  adapter = 'unknown',
  output = '',
  exitCode = null,
  timedOut = false,
  toolEvents = [],
} = {}) {
  const records = [
    JSON.stringify({
      type: 'strike_meta',
      ticketId: String(ticketId ?? ''),
      strike: Number(strike) || 1,
      adapter: String(adapter ?? 'unknown'),
      exitCode,
      timedOut: Boolean(timedOut),
    }),
  ];

  if (Array.isArray(toolEvents)) {
    for (const ev of toolEvents) {
      if (!ev || typeof ev !== 'object') continue;
      records.push(JSON.stringify({
        type: ev.type ?? 'tool_use',
        ticketId: String(ticketId ?? ''),
        strike: Number(strike) || 1,
        ...ev,
      }));
    }
  }

  for (const line of String(output ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    records.push(JSON.stringify({
      type: 'output',
      ticketId: String(ticketId ?? ''),
      strike: Number(strike) || 1,
      text: line,
    }));
  }

  return `${records.join('\n')}\n`;
}

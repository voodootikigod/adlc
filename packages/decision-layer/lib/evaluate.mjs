// One shadow evaluation: load the pack, collect and sanitize inputs, ask the
// provider, reduce, and record. The answers never change the exit code: 0 when
// the run was recorded, 1 when it failed before dispatch or was not recorded.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError, GitOutputError, RecordError } from './errors.mjs';
import { diffStats, mainCheckoutRoot, projectRoot, resolveRevision, ticketFacts } from './inputs.mjs';
import { createMockProvider } from './mock-provider.mjs';
import { PackError, loadPack } from './pack.mjs';
import { evaluateDecision } from './provider.mjs';
import { RECORD_SCHEMA_VERSION, appendRecord, recordPath } from './record.mjs';
import { reduce } from './reducer.mjs';
import { SanitizationError, sanitize } from './sanitizer.mjs';

const EXPECTED_FAILURES = [ConfigError, GitOutputError, PackError, SanitizationError, RecordError];

function readMockResponse(cwd, file) {
  if (file === null) return undefined;
  try {
    return readFileSync(resolve(cwd, file), 'utf8');
  } catch (error) {
    throw new ConfigError(`cannot read --mock-response ${file}: ${error.message}`);
  }
}

async function shadowRun(config, { cwd, retryDelayMs, now }) {
  const root = projectRoot(cwd);
  const mainRoot = mainCheckoutRoot(cwd);
  const ticket = ticketFacts(root, config.ticket);
  const responseText = readMockResponse(cwd, config.mockResponse);
  const pack = loadPack(config.pack, { projectRoot: root });
  const revision = resolveRevision(root, config.revision);
  const { sanitizedInput, inputHash } = sanitize({ ...diffStats(root, revision), ...ticket }, pack);

  const result = await evaluateDecision({
    provider: createMockProvider({ responseText }),
    model: config.model,
    pack,
    sanitizedInput,
    revision,
    retryDelayMs,
  });
  const { outcome, wouldAct } = reduce({ status: result.status, answers: result.answers, pack });
  const record = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    recordedAt: now().toISOString(),
    revision,
    provider: config.provider,
    requestedModel: result.requestedModel,
    resolvedModel: result.resolvedModel,
    packId: pack.id,
    packHash: result.packHash,
    inputHash,
    ticketId: config.ticket,
    prNumber: config.pr,
    answers: result.answers,
    outcome,
    wouldAct,
    status: result.status,
    errorClass: result.errorClass,
    attemptCount: result.attemptCount,
    latencyMs: result.latencyMs,
    usage: result.usage,
  };
  appendRecord(mainRoot, record);
  return { exitCode: 0, record, path: recordPath(mainRoot) };
}

/**
 * @param {{ mode: string } & Record<string, unknown>} config output of validateConfig
 * @param {{ cwd: string, retryDelayMs?: number, now?: () => Date }} context
 * @returns {Promise<{ exitCode: 0|1, record?: object, path?: string, error?: Error }>}
 */
export async function runEvaluate(config, { cwd, retryDelayMs, now = () => new Date() }) {
  if (config.mode === 'off') return { exitCode: 0 };
  try {
    return await shadowRun(config, { cwd, retryDelayMs, now });
  } catch (error) {
    if (EXPECTED_FAILURES.some((type) => error instanceof type)) return { exitCode: 1, error };
    throw error;
  }
}

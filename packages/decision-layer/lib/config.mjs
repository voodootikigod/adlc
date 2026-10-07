// Command-line parsing and configuration checks. Everything here runs before
// any repository state is read or anything is sent.
import { parseArgs } from 'node:util';
import { ConfigError } from './errors.mjs';
import { PACK_ID_PATTERN } from './pack.mjs';

export const MODES = Object.freeze(['off', 'shadow']);
export const PROVIDERS = Object.freeze(['mock', 'jev']);
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const TICKET_ID_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
export const JEV_FIXTURE_PATH = 'packages/decision-layer/test/fixtures/jev-live-<date>.json';

const OPTIONS = {
  mode: { type: 'string' },
  provider: { type: 'string' },
  model: { type: 'string' },
  pack: { type: 'string' },
  revision: { type: 'string' },
  ticket: { type: 'string' },
  pr: { type: 'string' },
  'mock-response': { type: 'string' },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
};

/** @param {string[]} argv @returns {{ command: string|undefined, options: Record<string, string|boolean|undefined> }} */
export function parseCommand(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new ConfigError(error.message);
  }
  const [command, ...extra] = parsed.positionals;
  if (extra.length > 0) throw new ConfigError(`unexpected argument "${extra[0]}"`);
  return { command, options: parsed.values };
}

function required(options, name, pattern) {
  const value = options[name];
  if (value === undefined) throw new ConfigError(`--mode shadow needs --${name}`);
  if (!pattern.test(value)) throw new ConfigError(`--${name} ${JSON.stringify(value)} must match ${pattern}`);
  return value;
}

function prNumber(value) {
  if (value === undefined) return null;
  const number = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(number)) throw new ConfigError(`--pr ${JSON.stringify(value)} must be a positive integer`);
  return number;
}

/**
 * Check the flags and the credential environment. A missing API key is a
 * configuration error, never a recorded `unknown`.
 * @param {Record<string, string|boolean|undefined>} options
 * @param {Record<string, string|undefined>} env
 */
export function validateConfig(options, env) {
  const mode = options.mode ?? 'off';
  if (!MODES.includes(mode)) {
    throw new ConfigError(`unknown --mode ${JSON.stringify(mode)}: only "off" and "shadow" exist (enforce mode is not part of this version)`);
  }
  if (options.provider !== undefined && mode !== 'shadow') throw new ConfigError('--provider needs --mode shadow');
  if (options['mock-response'] !== undefined && options.provider !== 'mock') throw new ConfigError('--mock-response is valid only with --provider mock');
  if (mode === 'off') return { mode };

  const provider = options.provider;
  if (provider === undefined) throw new ConfigError('--mode shadow needs --provider');
  if (!PROVIDERS.includes(provider)) throw new ConfigError(`unknown --provider ${JSON.stringify(provider)}: expected ${PROVIDERS.join(' or ')}`);
  const model = required(options, 'model', MODEL_PATTERN);
  const pack = required(options, 'pack', PACK_ID_PATTERN);
  const ticket = options.ticket ?? null;
  if (ticket !== null && !TICKET_ID_PATTERN.test(ticket)) throw new ConfigError(`--ticket ${JSON.stringify(ticket)} is not a ticket ID`);
  const pr = prNumber(options.pr);
  if (provider === 'jev') {
    if (!env.TYPESAFE_API_KEY && !env.JEV_API_KEY) throw new ConfigError('--provider jev needs TYPESAFE_API_KEY or JEV_API_KEY in the environment');
    throw new ConfigError(`--provider jev is not available until its live contract fixture is captured at ${JEV_FIXTURE_PATH}; use --provider mock`);
  }
  return {
    mode,
    provider,
    model,
    pack,
    revision: options.revision ?? 'HEAD',
    ticket,
    pr,
    mockResponse: options['mock-response'] ?? null,
  };
}

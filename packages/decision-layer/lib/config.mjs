// Command-line parsing and configuration checks. Everything here runs before
// any repository state is read or anything is sent.
import { parseArgs } from 'node:util';
import { ConfigError } from './errors.mjs';
import { PACK_ID_PATTERN } from './pack.mjs';
import { API_KEY_PATTERN, DEFAULT_API_URL, assertSafeApiUrl } from './adapters/jev.mjs';

export const MODES = Object.freeze(['off', 'shadow']);
export const PROVIDERS = Object.freeze(['mock', 'jev']);
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const TICKET_ID_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

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

/** TYPESAFE_API_URL, when set, must be an https URL without credentials in it. */
function apiUrl(value) {
  if (value === undefined || value === '') return DEFAULT_API_URL;
  try {
    return assertSafeApiUrl(value);
  } catch (error) {
    if (!(error instanceof TypeError) || error.code === 'ERR_INVALID_URL') throw new ConfigError('TYPESAFE_API_URL is not a URL');
    throw new ConfigError(error.message.replace('the Jev API URL', 'TYPESAFE_API_URL'));
  }
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
    const key = env.TYPESAFE_API_KEY || env.JEV_API_KEY;
    if (!key) throw new ConfigError('--provider jev needs TYPESAFE_API_KEY or JEV_API_KEY in the environment');
    if (!API_KEY_PATTERN.test(key)) throw new ConfigError('the Jev API key holds whitespace or other characters a header cannot carry');
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
    apiUrl: provider === 'jev' ? apiUrl(env.TYPESAFE_API_URL) : null,
  };
}

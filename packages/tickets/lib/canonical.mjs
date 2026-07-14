import { createHash } from 'node:crypto';
import { invalid } from './errors.mjs';
import { STORE_HASH_DOMAIN, TICKET_HASH_DOMAIN } from './constants.mjs';

export function compareTicketIds(left, right) {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return Buffer.compare(a, b);
}

function normalize(value, path = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid('NON_JSON_VALUE', `${path} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => normalize(item, `${path}[${index}]`));
  if (typeof value !== 'object') throw invalid('NON_JSON_VALUE', `${path} contains ${typeof value}`);
  const output = {};
  for (const key of Object.keys(value).sort(compareTicketIds)) {
    const item = value[key];
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
      throw invalid('NON_JSON_VALUE', `${path}.${key} is not JSON`);
    }
    output[key] = normalize(item, `${path}.${key}`);
  }
  return output;
}

export const canonicalValue = (value) => normalize(value);
export const canonicalJson = (value) => JSON.stringify(normalize(value));
export const prettyCanonicalJson = (value) => `${JSON.stringify(normalize(value), null, 2)}\n`;
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const ticketHash = (ticket) => sha256(TICKET_HASH_DOMAIN + canonicalJson(ticket));

export function storeHash(tickets) {
  const pairs = tickets
    .map((ticket) => [ticket.id, ticketHash(ticket)])
    .sort(([left], [right]) => compareTicketIds(left, right));
  return sha256(STORE_HASH_DOMAIN + canonicalJson(pairs));
}

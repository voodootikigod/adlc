import { compareTicketIds, storeHash, ticketHash } from './canonical.mjs';

/**
 * Structural clone via JSON.
 *
 * Fails closed on non-finite numbers instead of silently producing null.
 * index.d.ts declares this `<T extends JsonValue>(value: T): T`, and JSON turns
 * NaN and the infinities into null — so a consumer cloning numeric data kept
 * the `number` type, compiled a following `.toFixed()`, and threw. A value the
 * clone cannot round-trip is a defect at the boundary, not a null to discover
 * three call frames later. Everything that returns now matches the declaration.
 */
export function deepClone(value) {
  // Serialized to a named binding rather than nested inside the JSON.parse call:
  // `return JSON.parse(JSON.stringify(value, function (…) { … }))` spreads one
  // return statement over thirty lines, which reads badly and is also opaque to
  // any line-scoped analysis — a mutation operator rewriting that first line to
  // `return null;` produced a file that did not parse, so nothing was prosecuted
  // here at all. One statement per line, and both are ordinary again.
  const serialized = JSON.stringify(value, function reject(key, item) {
    if (typeof item === 'number' && !Number.isFinite(item)) {
      throw new TypeError(`deepClone cannot round-trip the non-finite number ${item}`);
    }
    // Inside an ARRAY, JSON turns a hole, undefined, a function or a symbol into
    // null — so `number[]` came back holding null while still typed number[],
    // and the first numeric method on it threw. Object properties are different:
    // JSON drops an undefined property, and dropping an OPTIONAL property is
    // type-compatible, so those stay legal.
    if (Array.isArray(this) && (item === undefined || typeof item === 'function' || typeof item === 'symbol')) {
      throw new TypeError(`deepClone cannot round-trip ${String(item)} at array index ${key}`);
    }
    // JSON serializes only an array's INDEX properties, so a value like
    // Object.assign([1, 2], { meta: 'x' }) silently loses `meta` while keeping
    // its declared type — the clone type-checks and the property is gone.
    if (Array.isArray(item)) {
      // Reflect.ownKeys, not Object.keys: the latter omits symbol keys, which
      // JSON also drops. And a CANONICAL index is an unsigned integer string
      // with no leading zeros below 2^32-1 — "01" and "4294967295" look numeric,
      // pass a /^\d+$/ test, and are silently dropped by JSON.stringify.
      // ENUMERABLE own keys only: `length` is an own property of every array and
      // is non-enumerable, so JSON never serializes it and flagging it would
      // reject every array in existence.
      const extra = Reflect.ownKeys(item)
        .filter((key) => Object.getOwnPropertyDescriptor(item, key)?.enumerable)
        .filter((key) => typeof key === 'symbol'
          || !(/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 4294967295));
      if (extra.length) {
        throw new TypeError(`deepClone cannot round-trip non-index array key(s): ${extra.map(String).join(', ')}`);
      }
    }
    return item;
  });
  return JSON.parse(serialized);
}

export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export class TicketSnapshot {
  #byId;

  constructor({ backend, formatVersion, tickets }) {
    this.backend = backend;
    this.formatVersion = formatVersion;
    this.tickets = deepFreeze(deepClone(tickets).sort((left, right) => compareTicketIds(left.id, right.id)));
    this.hash = storeHash(this.tickets);
    this.ticketHashes = deepFreeze(Object.fromEntries(this.tickets.map((ticket) => [ticket.id, ticketHash(ticket)])));
    this.#byId = new Map(this.tickets.map((ticket) => [ticket.id, ticket]));
    Object.freeze(this);
  }

  get(id) {
    return this.#byId.get(id);
  }

  mutableTickets() {
    return deepClone(this.tickets);
  }
}

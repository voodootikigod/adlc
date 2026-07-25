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
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) {
      throw new TypeError(`deepClone cannot round-trip the non-finite number ${item}`);
    }
    return item;
  }));
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

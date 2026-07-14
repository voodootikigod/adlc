import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, sha256, storeHash, ticketHash } from './canonical.mjs';
import { ARCHIVE_DIRECTORY, LEGACY_ARCHIVE_FILE } from './constants.mjs';
import { conflict, invalid, policy } from './errors.mjs';
import { ticketFilename } from './filename.mjs';
import { generateTicketId } from './ids.mjs';
import { deepClone } from './snapshot.mjs';
import { DirectoryTicketStore } from './stores/directory.mjs';
import { LegacyTicketStore } from './stores/legacy.mjs';
import { applyDirectoryTransaction, applyLegacyTransaction } from './transaction.mjs';
import { validateTickets } from './schema.mjs';

const publicPlan = (plan) => Object.fromEntries(Object.entries(plan).filter(([key]) => !key.startsWith('_')));
const planContent = (plan) => Object.fromEntries(Object.entries(publicPlan(plan)).filter(([key]) => key !== 'planHash'));
const comparable = (value) => value === undefined ? '__ADLC_ABSENT__' : canonicalJson(value);
const changedFields = (before, after) => [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
  .filter((key) => comparable(before?.[key]) !== comparable(after?.[key])).sort();

export class TicketService {
  constructor(store, { root = '.', protectedIds = [] } = {}) {
    this.store = store;
    this.root = root;
    this.protectedIds = new Set(protectedIds);
  }

  snapshot() {
    return this.store.load();
  }

  #plan(operation, mutate, { sensitive = [], evidenceRequired = false, expectedSnapshotHash = null } = {}) {
    const before = this.snapshot();
    if (expectedSnapshotHash && before.hash !== expectedSnapshotHash) {
      throw conflict('STALE_SNAPSHOT', `expected ${expectedSnapshotHash}, found ${before.hash}`);
    }
    const tickets = before.mutableTickets();
    const detail = mutate(tickets, before) ?? {};
    validateTickets(tickets);
    const hashes = Object.fromEntries(tickets.map((ticket) => [ticket.id, ticketHash(ticket)]));
    const afterHash = (awaitSnapshotHash(tickets));
    const plan = {
      version: 1,
      operation,
      expectedSnapshotHash: before.hash,
      afterHash,
      ticketId: detail.ticketId ?? null,
      beforeTicketId: detail.beforeTicketId ?? detail.ticketId ?? null,
      changedFields: detail.changedFields ?? [],
      fileOperations: detail.fileOperations ?? [],
      graphEffects: detail.graphEffects ?? [],
      sensitive: detail.sensitive ?? sensitive,
      evidenceRequired: detail.evidenceRequired ?? evidenceRequired,
      validation: 'valid',
      ticketHashes: hashes,
      _tickets: tickets,
    };
    plan.planHash = sha256(`adlc:ticket-plan:v1\0${canonicalJson(planContent(plan))}`);
    return Object.freeze(plan);
  }

  #assertIdNotArchived(id) {
    if (existsSync(join(this.root, ARCHIVE_DIRECTORY, ticketFilename(id)))) {
      throw conflict('ARCHIVE_COLLISION', `archive already contains ${id}`);
    }
    const legacyArchive = join(this.root, LEGACY_ARCHIVE_FILE);
    if (!existsSync(legacyArchive)) return;
    let parsed;
    try { parsed = JSON.parse(readFileSync(legacyArchive, 'utf8')); }
    catch (error) { throw invalid('INVALID_LEGACY_ARCHIVE', `cannot parse ${LEGACY_ARCHIVE_FILE}: ${error.message}`); }
    if (!parsed || !Array.isArray(parsed.tickets)) throw invalid('INVALID_LEGACY_ARCHIVE', `${LEGACY_ARCHIVE_FILE} must contain a tickets array`);
    if (parsed.tickets.some((ticket) => ticket?.id === id)) throw conflict('ARCHIVE_COLLISION', `archive already contains ${id}`);
  }

  planCreate(input = {}) {
    const ticket = deepClone(input);
    if (!ticket.id) ticket.id = generateTicketId();
    this.#assertIdNotArchived(ticket.id);
    return this.#plan('create', (tickets) => {
      if (tickets.some((item) => item.id === ticket.id)) throw conflict('TICKET_EXISTS', `ticket already exists: ${ticket.id}`);
      tickets.push(ticket);
      return { ticketId: ticket.id, changedFields: Object.keys(ticket).sort(), fileOperations: [{ action: 'create', id: ticket.id }] };
    });
  }

  planUpdate(id, input, { expect, authorized = false } = {}) {
    return this.#plan('update', (tickets, snapshot) => {
      const index = tickets.findIndex((ticket) => ticket.id === id);
      if (index < 0) throw invalid('TICKET_NOT_FOUND', `ticket not found: ${id}`);
      if (input.id !== id) throw policy('IDENTITY_CHANGE_REQUIRES_REASSIGN', 'update input id must match; use reassign for identity changes');
      if (expect && snapshot.ticketHashes[id] !== expect) throw conflict('STALE_TICKET', `ticket ${id} hash changed`);
      const before = tickets[index];
      const sensitive = [];
      if ((before.rails ?? []).some((rail) => !(input.rails ?? []).includes(rail))) sensitive.push('rail-narrowing');
      if ((input.scope ?? []).some((scope) => !(before.scope ?? []).includes(scope))) sensitive.push('scope-widening');
      if (sensitive.length && !authorized) throw policy('AUTHORIZATION_REQUIRED', `update requires authorization: ${sensitive.join(', ')}`);
      tickets[index] = deepClone(input);
      return {
        ticketId: id,
        changedFields: changedFields(before, input),
        fileOperations: [{ action: 'update', id }],
        sensitive,
        evidenceRequired: sensitive.length > 0,
      };
    }, { evidenceRequired: authorized });
  }

  planDiscard(id) {
    return this.#plan('discard', (tickets) => {
      if (this.protectedIds.has(id)) throw policy('PROTECTED_TICKET', `cannot discard protected ticket ${id}`);
      if (tickets.some((ticket) => (ticket.edges ?? []).some((edge) => edge.to === id))) throw policy('TICKET_REFERENCED', `cannot discard referenced ticket ${id}`);
      const index = tickets.findIndex((ticket) => ticket.id === id);
      if (index < 0) throw invalid('TICKET_NOT_FOUND', `ticket not found: ${id}`);
      tickets.splice(index, 1);
      return { ticketId: id, fileOperations: [{ action: 'delete', id }] };
    });
  }

  planComplete(id, { authorized = false } = {}) {
    return this.#plan('complete', (tickets) => {
      const ticket = tickets.find((item) => item.id === id);
      if (!ticket) throw invalid('TICKET_NOT_FOUND', `ticket not found: ${id}`);
      if (this.protectedIds.has(id) && !authorized) throw policy('AUTHORIZATION_REQUIRED', `protected completion requires authorization for ${id}`);
      const before = deepClone(ticket);
      ticket.completed = true;
      return { ticketId: id, changedFields: changedFields(before, ticket), fileOperations: [{ action: 'update', id }] };
    }, { sensitive: ['lifecycle-change'], evidenceRequired: true });
  }

  planReassign(id, nextId, { authorized = false } = {}) {
    if (!authorized) throw policy('AUTHORIZATION_REQUIRED', 'identity reassignment requires authorization');
    this.#assertIdNotArchived(nextId);
    return this.#plan('reassign', (tickets) => {
      if (tickets.some((ticket) => ticket.id === nextId)) throw conflict('TICKET_EXISTS', `ticket already exists: ${nextId}`);
      const ticket = tickets.find((item) => item.id === id);
      if (!ticket) throw invalid('TICKET_NOT_FOUND', `ticket not found: ${id}`);
      ticket.id = nextId;
      let rewritten = 0;
      for (const item of tickets) for (const edge of item.edges ?? []) if (edge.to === id) { edge.to = nextId; rewritten += 1; }
      return { ticketId: nextId, beforeTicketId: id, changedFields: ['id'], fileOperations: [{ action: 'rename', from: id, to: nextId }], graphEffects: [{ rewrittenEdges: rewritten }] };
    }, { sensitive: ['identity-change'], evidenceRequired: true });
  }

  planReconciliation(nextTickets, { authorized = false, expectedSnapshotHash = null } = {}) {
    if (!authorized) throw policy('AUTHORIZATION_REQUIRED', 'remote reconciliation requires authorization');
    const desired = deepClone(nextTickets);
    for (const ticket of desired) this.#assertIdNotArchived(ticket.id);
    return this.#plan('remote-reconciliation', (tickets) => {
      const beforeById = new Map(tickets.map((ticket) => [ticket.id, ticket]));
      const beforeIds = new Set(beforeById.keys());
      const afterIds = new Set(desired.map((ticket) => ticket.id));
      // Mandatory manifest evidence is reserved for the PRIVILEGED case: a
      // reconciliation that MUTATES an existing (same-id) ticket in place — the
      // sensitive change that could, e.g., narrow rails. A routine sync that only
      // ADDS tickets, or RENAMES a local ticket to its remote id (a delete+add of
      // distinct ids, as `push` does after reassignId), touches no existing ticket
      // in place and grants no privilege: rails-guard-ci already accepts a purely
      // additive tickets diff and independently denies removal/contract-change of a
      // committed base ticket, and reassignment re-attests its own evidence via
      // migrateManifestEvidence (a no-op when the ticket carried none). This mirrors
      // planUpdate's "evidence only when sensitive" contract and honours the T40
      // invariant that an evidence-less sync must not emit an .adlc/manifest.jsonl
      // entry (which rails-guard-ci rejects outside a migration/ceremony).
      const mutatesExisting = desired.some((ticket) => {
        const before = beforeById.get(ticket.id);
        return before && ticketHash(before) !== ticketHash(ticket);
      });
      tickets.splice(0, tickets.length, ...desired);
      return {
        fileOperations: [
          ...[...afterIds].filter((id) => !beforeIds.has(id)).map((id) => ({ action: 'create', id })),
          ...[...beforeIds].filter((id) => !afterIds.has(id)).map((id) => ({ action: 'delete', id })),
        ],
        graphEffects: [{ reconciledTickets: desired.length }],
        evidenceRequired: mutatesExisting,
      };
    }, { sensitive: ['remote-reconciliation'], expectedSnapshotHash });
  }

  apply(plan, { lock = null } = {}) {
    const expectedPlanHash = sha256(`adlc:ticket-plan:v1\0${canonicalJson(planContent(plan))}`);
    if (expectedPlanHash !== plan.planHash) throw conflict('STALE_PLAN', 'mutation plan hash does not match its contents');
    if (storeHash(plan._tickets) !== plan.afterHash) throw conflict('STALE_PLAN', 'mutation plan payload does not match its after hash');
    if (this.store instanceof DirectoryTicketStore) {
      return applyDirectoryTransaction(this.store, plan._tickets, { expectedSnapshotHash: plan.expectedSnapshotHash, operation: plan.operation, evidenceRequired: plan.evidenceRequired, ticketId: plan.ticketId, beforeTicketId: plan.beforeTicketId, root: this.root, lock });
    }
    if (this.store instanceof LegacyTicketStore) {
      return applyLegacyTransaction(this.store, plan._tickets, { expectedSnapshotHash: plan.expectedSnapshotHash, operation: plan.operation, evidenceRequired: plan.evidenceRequired, ticketId: plan.ticketId, beforeTicketId: plan.beforeTicketId, root: this.root, lock });
    }
    throw policy('READ_ONLY_STORE', 'this ticket store is read-only');
  }
}

function awaitSnapshotHash(tickets) {
  // Kept local so plans depend only on logical content, never a backend path.
  return storeHash(tickets);
}

export const serializePlan = (plan) => publicPlan(plan);

import { invalid } from './errors.mjs';
import { compareTicketIds } from './canonical.mjs';

export function validateTicket(ticket, { archive = false } = {}) {
  const errors = [];
  if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)) return ['ticket is not an object'];
  if (typeof ticket.id !== 'string' || ticket.id.length === 0) errors.push('missing string id');
  if (typeof ticket.title !== 'string' || ticket.title.length === 0) errors.push(`${ticket.id ?? '?'}: missing string title`);
  for (const field of ['scope', 'rails']) {
    if (ticket[field] !== undefined && (!Array.isArray(ticket[field]) || ticket[field].some((item) => typeof item !== 'string'))) {
      errors.push(`${ticket.id ?? '?'}: ${field} must be an array of strings`);
    }
  }
  if (ticket.edges !== undefined) {
    if (!Array.isArray(ticket.edges)) errors.push(`${ticket.id ?? '?'}: edges must be an array`);
    else for (const edge of ticket.edges) {
      if (!edge || typeof edge !== 'object' || Array.isArray(edge) || typeof edge.to !== 'string' || edge.to.length === 0) {
        errors.push(`${ticket.id ?? '?'}: edge missing string "to"`);
      }
    }
  }
  if (ticket.duration !== undefined && (typeof ticket.duration !== 'number' || !Number.isFinite(ticket.duration) || ticket.duration <= 0)) {
    errors.push(`${ticket.id ?? '?'}: duration must be a positive number`);
  }
  if (!archive && Object.hasOwn(ticket, '_adlcArchive')) errors.push(`${ticket.id ?? '?'}: _adlcArchive is reserved for archived tickets`);
  if (archive && ticket._adlcArchive !== undefined) {
    const metadata = ticket._adlcArchive;
    if (!metadata || typeof metadata !== 'object' || metadata.version !== 1 || typeof metadata.ticketHash !== 'string') {
      errors.push(`${ticket.id ?? '?'}: invalid _adlcArchive metadata`);
    }
  }
  return errors;
}

export function validateTickets(tickets, { archive = false, validateGraph = !archive } = {}) {
  if (!Array.isArray(tickets)) throw invalid('INVALID_ENVELOPE', 'tickets must be an array');
  const errors = [];
  const byId = new Map();
  for (const ticket of tickets) {
    errors.push(...validateTicket(ticket, { archive }));
    if (typeof ticket?.id === 'string') {
      if (byId.has(ticket.id)) errors.push(`duplicate ticket id: ${ticket.id}`);
      byId.set(ticket.id, ticket);
    }
  }
  if (validateGraph) {
    for (const ticket of tickets) {
      for (const edge of Array.isArray(ticket?.edges) ? ticket.edges : []) {
        if (typeof edge?.to === 'string' && !byId.has(edge.to)) errors.push(`${ticket.id}: edge to unknown ticket ${edge.to}`);
      }
    }
    const color = new Map();
    const visit = (id, stack) => {
      if (color.get(id) === 1) {
        errors.push(`cycle in ticket DAG: ${[...stack, id].join(' -> ')}`);
        return;
      }
      if (color.get(id) === 2) return;
      color.set(id, 1);
      const ticket = byId.get(id);
      for (const edge of Array.isArray(ticket?.edges) ? ticket.edges : []) if (byId.has(edge.to)) visit(edge.to, [...stack, id]);
      color.set(id, 2);
    };
    for (const id of [...byId.keys()].sort(compareTicketIds)) visit(id, []);
  }
  if (errors.length) throw invalid('INVALID_TICKET_STORE', `ticket store validation failed (${errors.length} error(s))`, errors);
  return tickets;
}

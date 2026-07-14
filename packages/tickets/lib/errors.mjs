export class TicketStoreError extends Error {
  constructor(kind, code, message, details) {
    super(message);
    this.name = 'TicketStoreError';
    this.kind = kind;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const invalid = (code, message, details) => new TicketStoreError('invalid', code, message, details);
export const conflict = (code, message, details) => new TicketStoreError('conflict', code, message, details);
export const policy = (code, message, details) => new TicketStoreError('policy', code, message, details);
export const operational = (code, message, details) => new TicketStoreError('operational', code, message, details);

export function asTicketResult(fn) {
  try {
    return { ok: true, value: fn(), warnings: [] };
  } catch (error) {
    if (error instanceof TicketStoreError) {
      return { ok: false, kind: error.kind, code: error.code, message: error.message, details: error.details };
    }
    return { ok: false, kind: 'operational', code: 'UNEXPECTED', message: error?.message ?? String(error) };
  }
}

export function exitCodeFor(error) {
  return error?.kind === 'operational' ? 1 : 2;
}

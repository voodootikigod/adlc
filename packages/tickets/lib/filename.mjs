import { sha256 } from './canonical.mjs';

export function ticketSlug(id) {
  const slug = id
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'ticket';
}

export const ticketFilename = (id) => `${ticketSlug(id)}--${sha256(Buffer.from(id, 'utf8'))}.json`;

import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encode(value, width) {
  let remaining = BigInt(value);
  let output = '';
  for (let index = 0; index < width; index += 1) {
    output = ALPHABET[Number(remaining & 31n)] + output;
    remaining >>= 5n;
  }
  return output;
}

export function generateTicketId(now = Date.now(), entropy = randomBytes(10)) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) throw new RangeError('ULID timestamp out of range');
  if (!Buffer.isBuffer(entropy) || entropy.length !== 10) throw new TypeError('ULID entropy must be 10 bytes');
  const random = BigInt(`0x${entropy.toString('hex')}`);
  return `T-${encode(BigInt(now), 10)}${encode(random, 16)}`;
}

export const isGeneratedTicketId = (id) => /^T-[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(id);

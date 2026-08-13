/**
 * Byte-capped text with a visible truncation marker.
 *
 * Handoff artifacts are size-capped so a runaway transcript cannot become the
 * repo's largest file. Truncation is never silent: a reader who cannot tell a
 * complete capture from a clipped one will trust a partial narrative as the
 * whole story.
 */

/**
 * Longest UTF-8 prefix of `text` that fits in `maxBytes` without splitting a
 * multi-byte sequence.
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
export function sliceUtf8(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  // buf[end] is the first byte we are dropping. A continuation byte (10xxxxxx)
  // there means the cut lands mid-character, so walk back to its lead byte.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Cap `text` at `maxBytes` INCLUDING the marker, so the stored artifact never
 * exceeds the cap the caller declared.
 * @param {string} text
 * @param {{ maxBytes: number, marker: string }} opts
 * @returns {{ text: string, truncated: boolean }}
 */
export function truncateUtf8(text, { maxBytes, marker }) {
  const body = typeof text === 'string' ? text : '';
  if (Buffer.byteLength(body, 'utf8') <= maxBytes) return { text: body, truncated: false };
  const room = maxBytes - Buffer.byteLength(marker, 'utf8');
  // A cap smaller than its own marker cannot say it truncated; refuse to
  // pretend otherwise and emit the marker alone.
  if (room <= 0) return { text: marker, truncated: true };
  return { text: `${sliceUtf8(body, room)}${marker}`, truncated: true };
}

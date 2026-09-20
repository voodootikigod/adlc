/**
 * An operational error that terminates the command with an explanation.
 *
 * @param {string} message
 * @returns {Error & {isOpError: true}}
 */
export function opError(message) {
  return Object.assign(new Error(message), { isOpError: true });
}

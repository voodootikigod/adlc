// hollow-test/lib/exit.mjs

/**
 * Write `text` to `stream`, wait until the stream has handed it to the OS, then
 * exit with `code`. `process.exit()` does not wait for queued writes, so a large
 * diagnostic followed by an immediate exit loses its tail on a pipe.
 *
 * @param {{ write(text: string, cb: (err?: Error) => void): boolean }} stream
 * @param {string} text
 * @param {number} code
 * @param {(code: number) => void} [exit]
 * @returns {Promise<void>}
 */
export async function writeThenExit(stream, text, code, exit = process.exit) {
  await new Promise((resolve) => { stream.write(text, () => resolve()); });
  exit(code);
}

/**
 * The GitHub writer — every mutation the tool performs, in one place.
 *
 * IN LIB, NOT THE BINARY, for the third time in this package and the same
 * reason each time: a branch left in the bin is reachable only by spawning the
 * process against a real `gh`, so it goes untested and a flipped guard survives
 * every suite. Here that guard decides whether a failed write is noticed at all.
 *
 * Exactly three operations. A writer with one entry point per action is a writer
 * you can audit by reading it, and `apply` refuses an action it has no wiring
 * for rather than silently doing nothing — a no-op that reports success would
 * mark an issue actioned when nothing happened to it.
 */

/**
 * @param {{spawn: Function}} io
 */
export function makeGhWriter({ spawn } = {}) {
  const gh = (args, input) => {
    const res = spawn('gh', args, { encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024 });
    // A non-zero status AND a spawn error are both failures. `||` rather than
    // `&&`: requiring both would let a `gh` that exited 1 without an Error
    // object — the ordinary failure shape — read as success.
    if (res?.error || res?.status !== 0) {
      throw new Error(res?.stderr?.trim() || res?.error?.message || `gh ${args[0]} failed`);
    }
    return res.stdout;
  };

  return {
    comments: (number) => {
      const raw = gh(['issue', 'view', String(number), '--json', 'comments']);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        // Unparseable output is not "no comments". Returning [] would make the
        // idempotence check believe nothing had been written and re-comment.
        throw new Error(`could not parse gh output for issue ${number}: ${err.message}`);
      }
      // `?? []` only for a genuinely absent key — an issue with no comments.
      return (parsed.comments ?? []).map((c) => c.body ?? '');
    },
    comment: (number, body) => gh(['issue', 'comment', String(number), '--body-file', '-'], body),
    apply: (number, action) => {
      if (action === 'close') return gh(['issue', 'close', String(number)]);
      throw new Error(`no writer wired for action ${action} — refusing rather than reporting a write that did not happen`);
    },
  };
}

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
/**
 * A safe issue selector.
 *
 * The number reaches this from a JSON file on disk and goes straight into gh's
 * argv. `--repo other/owner` is a perfectly good string, so an unvalidated
 * selector lets a crafted set point every call at a repository the operator
 * never named — and then comment on and close issues there.
 */
export function issueSelector(number) {
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`backlog-groom: issue selector must be a positive integer, got ${JSON.stringify(number)}`);
  }
  return String(number);
}

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
    /** The issue as it is NOW — body and labels included, for re-validation. */
    issue: (number) => {
      const raw = gh(['issue', 'view', issueSelector(number), '--json', 'number,title,body,labels,updatedAt']);
      const parsed = JSON.parse(raw);
      return { ...parsed, labels: (parsed.labels ?? []).map((l) => l.name ?? l) };
    },
    /** The authenticated login, so a comment can be attributed. */
    login: () => JSON.parse(gh(['api', 'user'])).login,
    comments: (number) => {
      const raw = gh(['issue', 'view', issueSelector(number), '--json', 'comments']);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        // Unparseable output is not "no comments". Returning [] would make the
        // idempotence check believe nothing had been written and re-comment.
        throw new Error(`could not parse gh output for issue ${number}: ${err.message}`);
      }
      // `?? []` only for a genuinely absent key — an issue with no comments.
      // Author AND body: the marker is derived from public facts (issue number
      // and a content hash anyone can compute), so anyone able to comment can
      // forge one. A forged marker would make the tool skip its own evidence
      // comment and act silently — the trail suppressed by the very person the
      // trail exists to inform.
      return (parsed.comments ?? []).map((c) => ({ body: c.body ?? '', author: c.author?.login ?? c.author ?? null }));
    },
    comment: (number, body) => gh(['issue', 'comment', issueSelector(number), '--body-file', '-'], body),
    apply: (number, action, detail = {}) => {
      if (action === 'close') return gh(['issue', 'close', issueSelector(number)]);
      if (action === 'relabel') {
        // Remove then add, both in one gh call: two calls could leave the issue
        // with neither label if the second failed, and the comment has already
        // claimed the change.
        const args = ['issue', 'edit', issueSelector(number)];
        if (detail.from) args.push('--remove-label', detail.from);
        if (detail.to) args.push('--add-label', detail.to);
        if (args.length === 3) throw new Error(`relabel for issue ${number} names neither a from nor a to label`);
        return gh(args);
      }
      throw new Error(`no writer wired for action ${action} — refusing rather than reporting a write that did not happen`);
    },
  };
}

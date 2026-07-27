// The two terminal outcomes of a CI gate step, as thrown values (#140).
//
// The gate previously lived twice — once as scripts/rails-guard-ci.mjs, once as a
// hand-mirrored `node -e` copy inside docs/ci/rails-guard.yml — and both spelled a
// verdict as a bare `process.exit()` from deep inside a helper. That works only
// because exit never returns: a helper like `parseJson`'s catch calls `fail(...)`
// and then falls off the end, which would return `undefined` into the caller if the
// exit were ever removed or stubbed. Throwing makes the non-return structural, so a
// verdict cannot be silently fallen through, and it makes both steps callable as
// library functions (the whole point of #140 — one implementation, two entry points).
//
// Exit-code contract, unchanged from the scripts this replaces:
//   GateDeny -> 2  a frozen rail / trust root / contract was violated (a real verdict)
//   GateFail -> 1  operational error or unverifiable input (fail CLOSED, never open)

export class GateDeny extends Error {
  constructor(message) {
    super(message);
    this.name = 'GateDeny';
    this.exitCode = 2;
  }
}

export class GateFail extends Error {
  constructor(message) {
    super(message);
    this.name = 'GateFail';
    this.exitCode = 1;
  }
}

/** Deny: the change violated a rule the gate enforces. Exit 2. */
export function deny(message) {
  throw new GateDeny(message);
}

/**
 * Fail: the gate could not verify the change. Exit 1 — never 0. An unverifiable
 * input must never read as "nothing was frozen"; that is the fail-OPEN this whole
 * gate exists to avoid.
 */
export function fail(message) {
  throw new GateFail(message);
}

/** True for the two verdict types, so a bin can distinguish them from a crash. */
export function isGateError(error) {
  return error instanceof GateDeny || error instanceof GateFail;
}

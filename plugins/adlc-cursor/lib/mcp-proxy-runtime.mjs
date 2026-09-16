// mcp-proxy-runtime.mjs — client request bookkeeping + bounded child retirement (T65).

/**
 * Queued and in-flight client requests, so no caller is left hanging when the
 * proxy refuses to bind, rebinds, or loses its child.
 */
export class ClientRequests {
  #fail;
  #inFlight = new Map();
  #pending = [];

  constructor(fail) {
    this.#fail = fail;
  }

  queue(message) {
    this.#pending.push(message);
  }

  track(message) {
    if (
      typeof message.method === "string" &&
      message.id !== undefined &&
      message.id !== null
    ) {
      this.#inFlight.set(this.#key(message.id), message);
    }
  }

  complete(id) {
    const key = this.#key(id);
    if (!this.#inFlight.has(key)) {
      return false;
    }
    this.#inFlight.delete(key);
    return true;
  }

  flush(forward) {
    const pending = this.#pending;
    this.#pending = [];
    for (const message of pending) {
      this.track(message);
      forward(message);
    }
  }

  failPending(message, code = -32000) {
    const pending = this.#pending;
    this.#pending = [];
    this.#failAll(pending, message, code);
  }

  failInFlight(message, code = -32000) {
    const inFlight = [...this.#inFlight.values()];
    this.#inFlight.clear();
    this.#failAll(inFlight, message, code);
  }

  #failAll(requests, message, code) {
    for (const request of requests) {
      this.#fail(request.id, message, code);
    }
  }

  // JSON-RPC ids may be number or string; 1 and '1' are distinct requests.
  #key(id) {
    return `${typeof id}:${JSON.stringify(id)}`;
  }
}

/**
 * SIGTERM the child and resolve once it is gone, escalating to SIGKILL after
 * timeoutMs. The fallback timer is deliberately not unref'd: shutdown must keep
 * this process alive long enough to reap a child that ignores SIGTERM, so Cursor
 * closing stdio cannot orphan `adlc mcp-server`.
 *
 * After SIGKILL the retirement waits for the real exit, but only for
 * killTimeoutMs: a child stuck in uninterruptible I/O reports no exit until the
 * kernel releases it, and rebind/shutdown must not hang on it. Continuing is
 * safe because a SIGKILLed process never runs user code again.
 */
export function retireChildProcess(
  child,
  childReadline,
  timers,
  timeoutMs = 500,
  killTimeoutMs = 2_000,
) {
  if (childReadline) {
    try {
      childReadline.close();
    } catch {
      /* already closed */
    }
  }
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const ownTimers = new Set();
    const finish = () => {
      if (settled) return;
      settled = true;
      child.removeListener("exit", finish);
      child.removeListener("error", finish);
      for (const timer of ownTimers) {
        clearTimeout(timer);
        timers.delete(timer);
      }
      ownTimers.clear();
      resolve();
    };
    const schedule = (callback, delayMs) => {
      const timer = setTimeout(() => {
        ownTimers.delete(timer);
        timers.delete(timer);
        callback();
      }, delayMs);
      ownTimers.add(timer);
      timers.add(timer);
    };
    child.once("exit", finish);
    child.once("error", finish);
    try {
      child.kill("SIGTERM");
    } catch {
      finish();
      return;
    }
    schedule(() => {
      try {
        const signaled = child.kill("SIGKILL");
        // SIGKILL delivery is asynchronous. A replacement child must wait for
        // the actual exit/error event, otherwise both MCP children can run at
        // once during a rebind.
        if (!signaled) {
          finish();
          return;
        }
      } catch {
        finish();
        return;
      }
      schedule(() => {
        process.stderr.write(
          `adlc-mcp-wrapper: child ${child.pid ?? "?"} did not exit ${killTimeoutMs}ms after SIGKILL; continuing\n`,
        );
        finish();
      }, killTimeoutMs);
    }, timeoutMs);
  });
}

// mcp-roots-proxy.mjs — lifecycle-aware MCP Roots proxy (T65).
// Speaks JSON-RPC stdio with the Cursor client, requests roots/list once the
// client reports initialized, resolves the consumer workspace via T64
// algorithm, then spawns `adlc mcp-server` with that cwd and forwards traffic.
//
// Never falls back to process.cwd() / plugin cache. Clients without roots
// capability fail closed. Multi-active roots fail closed (ambiguity).

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { MCP_BUILD_METADATA } from "./mcp-build-metadata.mjs";
import { decodeRootsListResult } from "./mcp-file-uri.mjs";
import { resolveHostEnvRoot } from "./mcp-hostenv.mjs";
import {
  isJsonRpcMethodMessage,
  isJsonRpcResponse,
  JsonRpcIdBridge,
} from "./mcp-json-rpc-bridge.mjs";
import { ClientRequests, retireChildProcess } from "./mcp-proxy-runtime.mjs";
import { resolveAdlcMcpSpawn } from "./mcp-spawn.mjs";
import { resolveConsumerWorkspace } from "./workspace-resolve.mjs";

const VERSION = MCP_BUILD_METADATA.pluginVersion;

const ROOTS_REQ_PREFIX = "__adlc_roots_list_";
export const ROOTS_RESPONSE_TIMEOUT_MS = 10_000;
export const PRE_INITIALIZED_TIMEOUT_MS = 10_000;
export const CHILD_HANDSHAKE_TIMEOUT_MS = 10_000;
export const CHILD_HANDSHAKE_TIMEOUT_CODE = -32001;

export { resolveAdlcMcpSpawn } from "./mcp-spawn.mjs";

function send(stream, message) {
  stream.write(`${JSON.stringify(message)}\n`);
}

function failClosed(output, id, message, code = -32000) {
  if (id !== undefined && id !== null) {
    send(output, { jsonrpc: "2.0", id, error: { code, message } });
  }
}

/**
 * Pick a concrete cwd from workspace resolution for MCP (fail closed on ambiguity).
 */
export function mcpRootFromWorkspace(workspace) {
  if (!workspace)
    return {
      ok: false,
      code: "UNRESOLVED",
      message: "no workspace resolution",
    };
  if (workspace.outcome === "active" || workspace.outcome === "inactive") {
    if (!workspace.root)
      return {
        ok: false,
        code: "UNRESOLVED",
        message: "resolved outcome without root",
      };
    return {
      ok: true,
      root: workspace.root,
      outcome: workspace.outcome,
      ticketId: workspace.ticketId ?? null,
    };
  }
  return {
    ok: false,
    code: workspace.outcome?.toUpperCase?.() || "UNRESOLVED",
    message:
      workspace.message || `MCP refuses to launch (${workspace.outcome})`,
  };
}

/**
 * Run the lifecycle proxy on the given streams.
 * @param {{ allowHostEnvFallback?: boolean, platform?: string, signalSource?: object | null,
 *   rootsResponseTimeoutMs?: number, preInitializedTimeoutMs?: number,
 *   childHandshakeTimeoutMs?: number, childRetirementTimeoutMs?: number }} [opts]
 *   allowHostEnvFallback — ONLY for unit tests of host-env path; production entry leaves this false.
 *   signalSource — process-like signal emitter; defaults to process only when reading real stdin.
 */
export async function runRootsProxy({
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  spawnImpl = spawn,
  allowHostEnvFallback = false,
  platform = process.platform,
  signalSource,
  rootsResponseTimeoutMs = ROOTS_RESPONSE_TIMEOUT_MS,
  preInitializedTimeoutMs = PRE_INITIALIZED_TIMEOUT_MS,
  childHandshakeTimeoutMs = CHILD_HANDSHAKE_TIMEOUT_MS,
  childRetirementTimeoutMs = 500,
} = {}) {
  let child = null;
  let childRl = null;
  let childAcceptingRequests = false;
  let boundRoot = null;
  let generation = 1;
  let rootsRequestSequence = 0;
  let activeRootsRequest = null;
  const idBridge = new JsonRpcIdBridge();
  let initializeReceived = false;
  let initializedReceived = false;
  let initializationExpired = false;
  let clientHasRoots = false;
  let binding = false;
  let shuttingDown = false;
  let rebindTail = Promise.resolve();
  const retirementTimers = new Set();
  const retirementPromises = new Set();
  let preInitializedTimer = null;
  let childHandshakeWait = null;
  const requests = new ClientRequests((id, message, code) =>
    failClosed(output, id, message, code),
  );

  const clearChildHandshakeWait = (childProcess) => {
    if (
      !childHandshakeWait ||
      (childProcess && childHandshakeWait.child !== childProcess)
    ) {
      return;
    }
    clearTimeout(childHandshakeWait.timer);
    childHandshakeWait = null;
  };

  const waitForRetirements = async () => {
    await Promise.all([...retirementPromises]);
  };

  const retireSpecificChild = (retiringChild, retiringRl) => {
    clearChildHandshakeWait(retiringChild);
    idBridge.clear(retiringChild);
    const retirement = retireChildProcess(
      retiringChild,
      retiringRl,
      retirementTimers,
      childRetirementTimeoutMs,
    );
    retirementPromises.add(retirement);
    void retirement.finally(() => retirementPromises.delete(retirement));
    return retirement;
  };

  const retireChild = () => {
    const retiringChild = child;
    const retiringRl = childRl;
    child = null;
    childRl = null;
    childAcceptingRequests = false;
    return retireSpecificChild(retiringChild, retiringRl);
  };

  const bindChild = (root) => {
    const myGen = generation;
    const target = resolveAdlcMcpSpawn(env, platform);
    if (!target.command) {
      const message = target.diagnostic;
      requests.failPending(message);
      requests.failInFlight(message);
      return { ok: false, message };
    }
    try {
      child = spawnImpl(target.command, target.args, {
        cwd: root,
        env: { ...env, ADLC_CURSOR_MCP_BOUND_ROOT: root },
        stdio: ["pipe", "pipe", "inherit"],
      });
    } catch (err) {
      const message = `ADLC MCP child failed to spawn: ${err.message}`;
      child = null;
      childRl = null;
      boundRoot = null;
      requests.failPending(message);
      requests.failInFlight(message);
      return { ok: false, message };
    }
    boundRoot = root;
    childAcceptingRequests = false;
    binding = true;
    const childHandshakeId = `__adlc_child_init_${myGen}`;
    const childProcess = child;
    const readline = createInterface({
      input: childProcess.stdout,
      crlfDelay: Infinity,
    });
    childRl = readline;
    const state = {
      error: null,
      exited: false,
      processClosed: false,
      readlineClosed: false,
      terminal: false,
      handshakeComplete: false,
      retired: false,
    };
    const clearBoundChild = () => {
      if (child !== childProcess) return;
      idBridge.clear(childProcess);
      child = null;
      childRl = null;
      childAcceptingRequests = false;
      boundRoot = null;
      binding = false;
    };
    const stopAcceptingRequests = () => {
      if (child !== childProcess) return;
      childAcceptingRequests = false;
      boundRoot = null;
      binding = false;
    };
    const failAfterOutputDrains = () => {
      if (state.retired || myGen !== generation) return;
      if (
        state.terminal ||
        !state.readlineClosed ||
        (!state.exited && !state.processClosed && !state.error)
      )
        return;
      state.terminal = true;
      clearChildHandshakeWait(childProcess);
      clearBoundChild();
      const message = state.error
        ? `ADLC MCP child failed${target.diagnostic ? ` (${target.diagnostic})` : ""}: ${state.error.message}`
        : "ADLC MCP child exited before replying";
      requests.failPending(message);
      requests.failInFlight(message);
    };
    const closeReadlineAfterOutput = () => {
      try {
        readline.close();
      } catch {
        /* readline closes itself when stdout ends */
      }
    };
    readline.on("close", () => {
      state.readlineClosed = true;
      failAfterOutputDrains();
    });
    childProcess.stdout.on("end", closeReadlineAfterOutput);
    childProcess.stdout.on("close", closeReadlineAfterOutput);
    childProcess.stdin.on("error", (err) => {
      if (myGen !== generation || state.retired) return;
      state.error = err;
      // A child may emit exit before its stdin error reaches us. In that case
      // stdout can still carry an already-produced response, so keep its ID
      // bridge until the stream drains and fail only requests left unresolved.
      if (state.exited || state.processClosed) {
        failAfterOutputDrains();
        return;
      }
      state.retired = true;
      clearChildHandshakeWait(childProcess);
      clearBoundChild();
      const message = `ADLC MCP child stdin failed: ${err.message}`;
      requests.failPending(message);
      requests.failInFlight(message);
      void retireSpecificChild(childProcess, readline);
    });
    readline.on("line", (line) => {
      if (myGen !== generation || state.retired) return;
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line);
        const isResponse = isJsonRpcResponse(parsed);
        if (
          !state.handshakeComplete &&
          parsed.id === childHandshakeId &&
          isResponse
        ) {
          state.handshakeComplete = true;
          clearChildHandshakeWait(childProcess);
          if (parsed.error) {
            const message = `ADLC MCP child initialization failed: ${parsed.error.message || "error"}`;
            state.retired = true;
            clearBoundChild();
            requests.failPending(
              message,
              Number.isInteger(parsed.error.code) ? parsed.error.code : -32000,
            );
            requests.failInFlight(
              message,
              Number.isInteger(parsed.error.code) ? parsed.error.code : -32000,
            );
            process.stderr.write(`adlc-mcp-wrapper: ${message}\n`);
            void retireSpecificChild(childProcess, readline);
            return;
          }
          if (
            !state.exited &&
            !state.processClosed &&
            !state.error &&
            child === childProcess
          ) {
            send(childProcess.stdin, {
              jsonrpc: "2.0",
              method: "notifications/initialized",
              params: {},
            });
            childAcceptingRequests = true;
            binding = false;
            flushPending();
          }
          return;
        }
        // User messages are not forwarded until the private initialization has
        // completed, so a legal client id can never collide with this handshake.
        if (!state.handshakeComplete) return;
        if (isResponse) {
          const mapping = idBridge.takeClientResponse(
            parsed.id,
            childProcess,
            myGen,
          );
          if (!mapping || !requests.complete(mapping.originalId)) {
            return;
          }
          send(output, { ...parsed, id: mapping.originalId });
          return;
        }
        if (isJsonRpcMethodMessage(parsed)) {
          send(
            output,
            idBridge.forwardChildRequest(parsed, childProcess, myGen),
          );
          return;
        }
      } catch {
        /* forward raw */
      }
      output.write(`${line}\n`);
    });
    childProcess.on("exit", () => {
      clearChildHandshakeWait(childProcess);
      if (myGen !== generation) return;
      state.exited = true;
      // The child can emit exit before stdout closes. Preserve buffered stdout
      // for in-flight responses, but stop new client traffic immediately:
      // writing to a closed stdin emits an unhandled ERR_STREAM_WRITE_AFTER_END.
      stopAcceptingRequests();
      // Node emits exit before stdio has necessarily flushed. Wait until the
      // readline closes, otherwise an already-buffered response can be forwarded
      // after its in-flight request has been failed.
      failAfterOutputDrains();
    });
    childProcess.on("close", () => {
      clearChildHandshakeWait(childProcess);
      if (myGen !== generation) return;
      state.processClosed = true;
      stopAcceptingRequests();
      closeReadlineAfterOutput();
      failAfterOutputDrains();
    });
    childProcess.on("error", (err) => {
      clearChildHandshakeWait(childProcess);
      if (myGen !== generation) return;
      state.error = err;
      stopAcceptingRequests();
      if (childProcess.stdout.readableEnded || childProcess.stdout.destroyed)
        closeReadlineAfterOutput();
      failAfterOutputDrains();
    });

    // Prime child with initialize before forwarding any client traffic, so even
    // an identical legal client id cannot be mistaken for this private response.
    childHandshakeWait = {
      child: childProcess,
      timer: setTimeout(() => {
        if (childHandshakeWait?.child !== childProcess) {
          return;
        }
        childHandshakeWait = null;
        if (
          shuttingDown ||
          myGen !== generation ||
          state.handshakeComplete ||
          state.retired ||
          child !== childProcess
        ) {
          return;
        }
        state.retired = true;
        clearBoundChild();
        const message = `ADLC MCP child initialization timed out after ${childHandshakeTimeoutMs}ms`;
        requests.failPending(message, CHILD_HANDSHAKE_TIMEOUT_CODE);
        requests.failInFlight(message, CHILD_HANDSHAKE_TIMEOUT_CODE);
        process.stderr.write(`adlc-mcp-wrapper: ${message}\n`);
        void retireSpecificChild(childProcess, readline);
      }, childHandshakeTimeoutMs),
    };
    send(childProcess.stdin, {
      jsonrpc: "2.0",
      id: childHandshakeId,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "adlc-cursor-proxy", version: VERSION },
      },
    });
    return { ok: true };
  };

  const flushPending = () => {
    if (!child?.stdin || !childAcceptingRequests) return;
    requests.flush((msg) =>
      send(child.stdin, idBridge.forwardClientRequest(msg, child, generation)),
    );
  };

  const resolveAndBindFromPaths = (paths) => {
    // Roots are the exclusive production channel: an ambient CURSOR_PROJECT_DIR
    // must neither rescue an unusable Roots result nor manufacture ambiguity.
    const rootsOnlyEnv = { ...env };
    delete rootsOnlyEnv.CURSOR_PROJECT_DIR;
    const workspace = resolveConsumerWorkspace(
      { workspace_roots: paths },
      rootsOnlyEnv,
    );
    const picked = mcpRootFromWorkspace(workspace);
    if (!picked.ok) {
      return picked;
    }
    const bound = bindChild(picked.root);
    if (!bound.ok)
      return { ok: false, code: "SPAWN_FAILED", message: bound.message };
    return picked;
  };

  const tryHostEnvBind = () => {
    if (!allowHostEnvFallback) return null;
    const host = resolveHostEnvRoot(env);
    if (!host.ok) return host;
    const bound = bindChild(host.root);
    if (!bound.ok)
      return { ok: false, code: "SPAWN_FAILED", message: bound.message };
    return { ok: true, root: host.root, via: "host-env" };
  };

  const retireActiveRootsRequest = () => {
    if (!activeRootsRequest) {
      return;
    }
    if (activeRootsRequest.timer) clearTimeout(activeRootsRequest.timer);
    activeRootsRequest = null;
  };

  const clearPreInitializedWait = () => {
    if (preInitializedTimer) {
      clearTimeout(preInitializedTimer);
    }
    preInitializedTimer = null;
  };

  const startPreInitializedWait = () => {
    clearPreInitializedWait();
    preInitializedTimer = setTimeout(() => {
      preInitializedTimer = null;
      if (initializedReceived || shuttingDown) {
        return;
      }
      initializationExpired = true;
      const message = `client did not send notifications/initialized within ${preInitializedTimeoutMs}ms`;
      requests.failPending(message);
      process.stderr.write(`adlc-mcp-wrapper: ${message}\n`);
    }, preInitializedTimeoutMs);
  };

  const requestRoots = () => {
    if (shuttingDown) {
      return;
    }
    const id = `${ROOTS_REQ_PREFIX}${generation}_${++rootsRequestSequence}`;
    activeRootsRequest = { id, generation, timer: null };
    send(output, { jsonrpc: "2.0", id, method: "roots/list", params: {} });
    activeRootsRequest.timer = setTimeout(() => {
      if (activeRootsRequest?.id !== id) return;
      retireActiveRootsRequest();
      binding = false;
      const message = `roots/list timed out after ${rootsResponseTimeoutMs}ms`;
      requests.failPending(message);
      process.stderr.write(`adlc-mcp-wrapper: ${message}\n`);
    }, rootsResponseTimeoutMs);
  };

  return new Promise((resolvePromise) => {
    const lines = createInterface({ input, crlfDelay: Infinity });
    // Only own process signals when driving real stdio; unit tests pass their
    // own streams and must not accumulate global listeners.
    const signals =
      signalSource === undefined
        ? input === process.stdin
          ? process
          : null
        : signalSource;
    let shutdownPromise = null;

    const shutdown = () => {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        shuttingDown = true;
        generation += 1;
        retireActiveRootsRequest();
        idBridge.clear();
        clearPreInitializedWait();
        requests.failPending("ADLC MCP proxy is shutting down");
        requests.failInFlight("ADLC MCP proxy is shutting down");
        await rebindTail;
        await retireChild();
        await waitForRetirements();
        for (const timer of retirementTimers) clearTimeout(timer);
        retirementTimers.clear();
        signals?.removeListener("SIGTERM", onSignal);
        signals?.removeListener("SIGINT", onSignal);
        resolvePromise();
      })();
      return shutdownPromise;
    };

    const onSignal = () => {
      lines.close();
      input.destroy?.();
      void shutdown();
    };
    signals?.on("SIGTERM", onSignal);
    signals?.on("SIGINT", onSignal);

    lines.on("line", async (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const isResponse = isJsonRpcResponse(msg);

      // Client response to our roots/list
      if (
        activeRootsRequest &&
        msg.id === activeRootsRequest.id &&
        activeRootsRequest.generation === generation &&
        isResponse
      ) {
        retireActiveRootsRequest();
        binding = false;
        if (msg.error) {
          // Fail closed any queued tool traffic — do not leave callers hanging.
          requests.failPending(
            `roots/list failed: ${msg.error.message || "error"}`,
            Number.isInteger(msg.error.code) ? msg.error.code : -32000,
          );
          process.stderr.write(
            `adlc-mcp-wrapper: roots/list error — ${msg.error.message}\n`,
          );
          return;
        }
        const decoded = decodeRootsListResult(msg.result);
        if (!decoded.ok) {
          process.stderr.write(
            `adlc-mcp-wrapper: INVALID_ROOTS: ${decoded.message}\n`,
          );
          requests.failPending(`INVALID_ROOTS: ${decoded.message}`);
          return;
        }
        const picked = resolveAndBindFromPaths(decoded.paths);
        if (!picked.ok) {
          process.stderr.write(
            `adlc-mcp-wrapper: ${picked.code}: ${picked.message}\n`,
          );
          requests.failPending(`${picked.code}: ${picked.message}`);
        }
        return;
      }

      if (isResponse) {
        const mapping = idBridge.takeChildResponse(msg.id, child, generation);
        if (
          mapping &&
          child?.stdin &&
          childAcceptingRequests &&
          boundRoot &&
          !binding
        ) {
          send(child.stdin, { ...msg, id: mapping.originalId });
        }
        return;
      }

      if (msg.method === "initialize") {
        const caps = msg.params?.capabilities ?? {};
        clientHasRoots = Boolean(caps.roots);
        send(output, {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "adlc-cursor", version: VERSION },
          },
        });
        initializeReceived = true;
        if (!initializedReceived) {
          startPreInitializedWait();
        }
        return;
      }

      // MCP forbids server-initiated requests before the client reports
      // initialized, so roots/list waits for this notification.
      if (msg.method === "notifications/initialized") {
        if (!initializeReceived || initializedReceived) return;
        clearPreInitializedWait();
        initializedReceived = true;
        initializationExpired = false;
        if (clientHasRoots) {
          binding = true;
          requestRoots();
          return;
        }
        // Fail closed for production path — optional host-env only when explicitly allowed.
        const host = tryHostEnvBind();
        if (!host || !host.ok) {
          requests.failPending(
            host?.message ||
              "client lacks roots capability; refusing to guess cwd",
          );
          process.stderr.write(
            "adlc-mcp-wrapper: client lacks roots capability; refusing to guess cwd. " +
              "Install @adlc/cli and use a Roots-capable Cursor build.\n",
          );
        }
        return;
      }

      if (msg.method === "notifications/roots/list_changed") {
        if (shuttingDown) {
          return;
        }
        if (!clientHasRoots) {
          process.stderr.write(
            "adlc-mcp-wrapper: ignoring roots/list_changed from a client without Roots capability\n",
          );
          return;
        }
        // Rebind: stop accepting new tool calls into the old child, and answer
        // everything already outstanding instead of dropping it.
        const reason = "ADLC MCP roots changed; request failed during rebind";
        requests.failPending(reason);
        requests.failInFlight(reason);
        idBridge.clear();
        generation += 1;
        const rebindGeneration = generation;
        retireActiveRootsRequest();
        boundRoot = null;
        binding = true;
        // Serialize rebinds so a second notification cannot spawn before the
        // previous child has retired, even when it ignores SIGTERM.
        rebindTail = rebindTail.then(async () => {
          await retireChild();
          await waitForRetirements();
          if (
            !shuttingDown &&
            rebindGeneration === generation &&
            initializedReceived &&
            clientHasRoots
          ) {
            requestRoots();
          }
        });
        return;
      }

      // Forward or queue
      if (
        child?.stdin &&
        childAcceptingRequests &&
        boundRoot &&
        !binding
      ) {
        requests.track(msg);
        send(
          child.stdin,
          idBridge.forwardClientRequest(msg, child, generation),
        );
        return;
      }

      // Not bound yet — queue while roots bind is in flight; else fail closed.
      if (msg.method === "tools/call" || msg.method === "tools/list") {
        if (!initializeReceived) {
          failClosed(output, msg.id, "ADLC MCP proxy not initialized");
          return;
        }
        if (!initializedReceived || binding) {
          if (!initializedReceived && initializationExpired) {
            failClosed(
              output,
              msg.id,
              `client did not send notifications/initialized within ${preInitializedTimeoutMs}ms`,
            );
            return;
          }
          requests.queue(msg);
          return;
        }
        if (!boundRoot) {
          const host = tryHostEnvBind();
          if (host?.ok) {
            // bound via host-env; flush includes this call if we queue first
            requests.queue(msg);
            flushPending();
            return;
          }
          failClosed(
            output,
            msg.id,
            host?.message ||
              "ADLC MCP proxy not bound to a consumer root (Roots unresolved or refused)",
          );
          return;
        }
      }

      if (msg.method?.startsWith("notifications/")) return;

      if (msg.id !== undefined) {
        failClosed(
          output,
          msg.id,
          `ADLC MCP proxy not bound to a consumer root yet (${msg.method})`,
        );
      }
    });

    lines.on("close", () => {
      void shutdown();
    });
  });
}

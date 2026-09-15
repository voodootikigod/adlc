// mcp-json-rpc-bridge.mjs — owns IDs at the proxy boundary.

export function isJsonRpcResponse(message) {
  return (
    message &&
    typeof message === "object" &&
    !Object.hasOwn(message, "method") &&
    (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))
  );
}

export function isJsonRpcMethodMessage(message) {
  return (
    message && typeof message === "object" && typeof message.method === "string"
  );
}

export function hasJsonRpcRequestId(message) {
  return (
    isJsonRpcMethodMessage(message) &&
    message.id !== undefined &&
    message.id !== null
  );
}

function key(id) {
  return `${typeof id}:${JSON.stringify(id)}`;
}

/**
 * Rewrites request ids in both directions. Ownership comes from the maps:
 * prefixes distinguish diagnostics, but never decide how a peer message routes.
 */
export class JsonRpcIdBridge {
  #clientToChildSequence = 0;
  #childToClientSequence = 0;
  #clientToChild = new Map();
  #childToClient = new Map();

  forwardClientRequest(message, child, generation) {
    if (!hasJsonRpcRequestId(message)) {
      return message;
    }
    const id = `__adlc_proxy_to_child_${++this.#clientToChildSequence}`;
    this.#clientToChild.set(key(id), {
      child,
      generation,
      originalId: message.id,
    });
    return { ...message, id };
  }

  forwardChildRequest(message, child, generation) {
    if (!hasJsonRpcRequestId(message)) {
      return message;
    }
    const id = `__adlc_proxy_to_client_${++this.#childToClientSequence}`;
    this.#childToClient.set(key(id), {
      child,
      generation,
      originalId: message.id,
    });
    return { ...message, id };
  }

  takeClientResponse(id, child, generation) {
    return this.#take(this.#clientToChild, id, child, generation);
  }

  takeChildResponse(id, child, generation) {
    return this.#take(this.#childToClient, id, child, generation);
  }

  clear(child = null) {
    this.#clear(this.#clientToChild, child);
    this.#clear(this.#childToClient, child);
  }

  #take(mappings, id, child, generation) {
    const mapping = mappings.get(key(id));
    if (!mapping) {
      return null;
    }
    mappings.delete(key(id));
    if (mapping.child !== child || mapping.generation !== generation) {
      return null;
    }
    return mapping;
  }

  #clear(mappings, child) {
    for (const [id, mapping] of mappings) {
      if (!child || mapping.child === child) {
        mappings.delete(id);
      }
    }
  }
}

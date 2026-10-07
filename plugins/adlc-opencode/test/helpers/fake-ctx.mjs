// fake-ctx.mjs — an OpenCode v2 plugin context for unit tests.
//
// It records every hook, transform and event-subscribe registration made by
// `plugin.setup(ctx)`, and drives them the way the host does. Event payloads are
// built by the factories below in the shapes of `@opencode/client`'s generated
// types (`type`, `data.sessionID`, `data.file`, optional `location`), never by
// hand in a test.

import plugin from '../../index.mjs';

let seq = 0;
const nextId = (prefix) => `${prefix}_${++seq}`;

/** `session.compaction.ended` (SessionCompactionEnded). */
export function compactionEnded(sessionID, { directory } = {}) {
  return {
    id: nextId('evt'), created: Date.now(), type: 'session.compaction.ended',
    durable: { aggregateID: sessionID, seq: 1, version: 1 },
    ...(directory ? { location: { directory } } : {}),
    data: { sessionID },
  };
}

/** `filesystem.changed` (FilesystemChanged). */
export function filesystemChanged(file, { event = 'change', directory } = {}) {
  return {
    id: nextId('evt'), created: Date.now(), type: 'filesystem.changed',
    ...(directory ? { location: { directory } } : {}),
    data: { file, event },
  };
}

/** `session.created` (SessionCreated). */
export function sessionCreated(sessionID, { directory } = {}) {
  return {
    id: nextId('evt'), created: Date.now(), type: 'session.created',
    durable: { aggregateID: sessionID, seq: 0, version: 1 },
    ...(directory ? { location: { directory } } : {}),
    data: { sessionID },
  };
}

/** `session.idle` (SessionIdle). */
export function sessionIdle(sessionID, { directory } = {}) {
  return {
    id: nextId('evt'), created: Date.now(), type: 'session.idle',
    ...(directory ? { location: { directory } } : {}),
    data: { sessionID },
  };
}

/**
 * An event stream the plugin can subscribe to. `emit(ev)` resolves once the
 * plugin has finished handling `ev` (the subscriber pulled the next item).
 * `end()` completes the current subscription, as a host reconnect would.
 */
function createEventBus() {
  const subscriptions = [];
  let current = null;
  const bus = {
    subscriptions,
    subscribe({ signal } = {}) {
      const queue = [];
      let wake = null;
      let ended = false;
      let pending = null;
      const sub = {
        signal,
        push(item) { queue.push(item); wake?.(); },
        end() { ended = true; wake?.(); },
      };
      subscriptions.push(sub);
      current = sub;
      signal?.addEventListener('abort', () => sub.end(), { once: true });
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              pending?.done();
              pending = null;
              while (!queue.length && !ended) await new Promise((r) => { wake = r; });
              wake = null;
              if (!queue.length) return { done: true, value: undefined };
              pending = queue.shift();
              return { done: false, value: pending.ev };
            },
            async return() { pending?.done(); pending = null; ended = true; return { done: true, value: undefined }; },
          };
        },
      };
    },
    async waitForSubscription(count = 1) {
      for (let i = 0; i < 400 && subscriptions.length < count; i++) await new Promise((r) => setTimeout(r, 5));
      if (subscriptions.length < count) throw new Error(`expected ${count} event subscriptions, saw ${subscriptions.length}`);
      return subscriptions[count - 1];
    },
    async emit(ev, { timeoutMs = 2000 } = {}) {
      if (!current) await bus.waitForSubscription(1);
      let timer;
      const handled = new Promise((done) => current.push({ ev, done }));
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`event ${ev?.type ?? '?'} was not handled within ${timeoutMs}ms`)), timeoutMs);
      });
      return Promise.race([handled, timeout]).finally(() => clearTimeout(timer));
    },
    end() { current?.end(); },
  };
  return bus;
}

/**
 * Build a fake v2 plugin context.
 *
 * @param {object} [opts]
 * @param {string} [opts.root]  `ctx.location.directory`
 * @param {object} [opts.options]  `ctx.options`
 * @param {object} [opts.session]  extra `ctx.session` methods (create/prompt/…)
 * @param {object} [opts.generate]  `ctx.generate`
 * @param {object} [opts.agent]  `ctx.agent` (list/get)
 * @param {number | ((kind: string, name: string) => number)} [opts.ackDelayMs]
 *   delay before each registration resolves (per registration when a function)
 * @param {(kind: string, name: string) => void} [opts.onRegister]  called as each
 *   registration is ACKNOWLEDGED; may throw to fail that registration
 */
export function createFakeCtx({ root = process.cwd(), options = {}, session = {}, generate, agent, ackDelayMs = 0, onRegister } = {}) {
  const registrations = { tool: new Map(), session: new Map(), permission: new Map(), transforms: [] };
  const log = [];
  const ack = async (kind, name) => {
    const delay = typeof ackDelayMs === 'function' ? ackDelayMs(kind, name) : ackDelayMs;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    onRegister?.(kind, name);
    log.push(`${kind}:${name}`);
    return { dispose: async () => {} };
  };
  const hookOn = (kind) => (name, callback) => {
    registrations[kind].set(name, callback);
    return ack(kind, name);
  };
  const events = createEventBus();
  const ctx = {
    app: { name: 'opencode', version: '2.0.21', channel: 'test' },
    location: { directory: root, project: { id: 'prj_test', directory: root, canonical: root } },
    options,
    event: { subscribe: (o) => events.subscribe(o) },
    permission: { hook: hookOn('permission') },
    session: { hook: hookOn('session'), ...session },
    ...(generate ? { generate } : {}),
    ...(agent ? { agent } : {}),
    tool: {
      hook: hookOn('tool'),
      transform: (callback) => { registrations.transforms.push(callback); return ack('tool', 'transform'); },
    },
  };
  return { ctx, registrations, events, log };
}

/** Apply every registered tool transform to an editor seeded with `builtins`. */
export function runToolTransforms(registrations, builtins = {}) {
  const tools = new Map(Object.entries(builtins).map(([id, t]) => [id, { ...t }]));
  const editor = {
    list: () => [...tools.entries()].map(([id, t]) => ({ ...t, id })),
    get: (id) => (tools.has(id) ? { ...tools.get(id), id } : undefined),
    namespace() {},
    add: (t) => { tools.set(t.name, t); },
    update: (id, fn) => { if (tools.has(id)) fn(tools.get(id)); },
    remove: (id) => { tools.delete(id); },
  };
  for (const transform of registrations.transforms) transform(editor);
  return tools;
}

/**
 * Load the plugin against a fake ctx and return drivers for its registrations.
 * Each driver fires the hook the plugin registered, with an event in the v2
 * host shape.
 */
export async function loadPlugin(opts = {}) {
  const fake = createFakeCtx(opts);
  const cleanup = await plugin.setup(fake.ctx);
  const { registrations, events } = fake;
  const hook = (kind, name) => {
    const cb = registrations[kind].get(name);
    if (!cb) throw new Error(`plugin registered no ${kind} hook "${name}"`);
    return cb;
  };
  let call = 0;
  const toolEvent = (tool, input, sessionID) => ({
    tool, sessionID, agent: 'build', messageID: 'msg_1', id: `call_${++call}`, input,
  });
  const drivers = {
    ...fake,
    cleanup,
    /** `execute.before` for `tool` with v2 `input`; resolves the (mutated) event. */
    async before(tool, input = {}, opts = {}) {
      const sessionID = 'sessionID' in opts ? opts.sessionID : 's';
      const e = toolEvent(tool, input, sessionID);
      await hook('tool', 'execute.before')(e);
      return e;
    },
    /** `execute.after` (completed) for `tool` with v2 `input`. */
    async after(tool, input = {}, opts = {}) {
      const sessionID = 'sessionID' in opts ? opts.sessionID : 's';
      const e = { ...toolEvent(tool, input, sessionID), status: 'completed', result: { content: '' } };
      await hook('tool', 'execute.after')(e);
      return e;
    },
    /** `permission.evaluate`; resolves the event so tests can read `effect`/`message`. */
    async permission({ action, resources = [], sessionID = 's', effect = 'ask' } = {}) {
      const e = { sessionID, agent: 'build', action, resources, effect };
      await hook('permission', 'evaluate')(e);
      return e;
    },
    /** The `context` session hook; resolves the system parts it produced. */
    async context({ sessionID = 's', system = [] } = {}) {
      const e = { sessionID, agent: 'build', model: { id: 'm', providerID: 'p' }, system, messages: [], options: {}, tools: {} };
      await hook('session', 'context')(e);
      return e.system;
    },
    /** The `compaction` session hook; resolves the system parts it produced. */
    async compaction({ sessionID = 's', system = [] } = {}) {
      const e = { sessionID, agent: 'build', model: { id: 'm', providerID: 'p' }, system, messages: [], options: {}, tools: {} };
      await hook('session', 'compaction')(e);
      return e.system;
    },
    /** The `prompt` session hook for prompt `text`; resolves the event. */
    async prompt(text, { sessionID = 's' } = {}) {
      const e = { sessionID, messageID: 'msg_1', prompt: { text }, delivery: 'immediate' };
      await hook('session', 'prompt')(e);
      return e;
    },
    /** Deliver a host event and resolve once the plugin has handled it. */
    emit: (ev) => events.emit(ev),
    /** The tool table after every registered transform, from `builtins`. */
    tools: (builtins) => runToolTransforms(registrations, builtins),
  };
  return drivers;
}

/**
 * Capture `console.error` lines for the duration of `fn` (the plugin's only
 * operator channel). Resolves `{ result, lines }`; rethrows fn's error with
 * `lines` attached.
 */
export async function captureStderr(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    const result = await fn();
    return { result, lines };
  } catch (err) {
    err.stderr = lines;
    throw err;
  } finally {
    console.error = original;
  }
}

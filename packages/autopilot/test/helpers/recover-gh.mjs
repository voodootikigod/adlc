// A stateful `gh` fake for the recovery / reset / creation suites, keyed by
// the fake gh path in `fake-children.mjs` handlers. It models exactly what
// those modules read and write: PR lists by head, issue labels (view/edit),
// the issue timeline, collaborator permissions, comments.

/**
 * @param state.prs          [{ number, head, state: 'OPEN'|'CLOSED'|'MERGED' }]
 * @param state.labels       { [issue]: [name, …] }
 * @param state.timeline     { [issue]: [event, …] }   (GitHub timeline event objects)
 * @param state.permissions  { [login]: 'admin'|'maintain'|'write'|'read' }
 */
export function fakeGithub(state = {}) {
  const gh = {
    prs: state.prs ?? [],
    labels: state.labels ?? {},
    timeline: state.timeline ?? {},
    permissions: state.permissions ?? {},
    comments: state.comments ?? {},
    calls: [],
    /** optional hook run before every call: (args) => void — tests use it to make a PR "appear". */
    onCall: null,
  };
  const flag = (args, name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
  gh.handler = (args) => {
    gh.calls.push([...args]);
    gh.onCall?.(args);
    const [sub, verb] = args;
    if (sub === 'api' && /^repos\/[^/]+\/[^/]+\/pulls\?state=open/.test(String(args[1] ?? ''))) {
      const page = Number(/[?&]page=(\d+)/.exec(String(args[1]))?.[1] ?? 1);
      const rows = page === 1 ? gh.prs.filter((p) => p.state === 'OPEN') : [];
      return { stdout: JSON.stringify(rows.map((p) => ({ number: p.number, head: { ref: p.head }, body: p.body ?? '' }))) };
    }
    if (sub === 'pr' && verb === 'list') {
      const head = flag(args, '--head'); const st = flag(args, '--state') ?? 'open';
      const rows = gh.prs.filter((p) => p.head === head && (st === 'all' || p.state === st.toUpperCase()));
      return { stdout: JSON.stringify(rows.map((p) => ({ number: p.number, headRefName: p.head, state: p.state }))) };
    }
    if (sub === 'issue' && verb === 'view') {
      const n = args[2];
      return { stdout: JSON.stringify({ number: Number(n), labels: (gh.labels[n] ?? []).map((name) => ({ name })), state: 'OPEN' }) };
    }
    if (sub === 'issue' && verb === 'edit') {
      const n = args[2];
      const cur = new Set(gh.labels[n] ?? []);
      const add = flag(args, '--add-label'); const rm = flag(args, '--remove-label');
      if (add) cur.add(add); if (rm) cur.delete(rm);
      gh.labels[n] = [...cur];
      return { stdout: '{}' };
    }
    if (sub === 'issue' && verb === 'comment') return { stdout: '{}' };
    if (sub === 'api') {
      const path = args[1] ?? '';
      let m;
      if ((m = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/timeline/.exec(path))) return { stdout: JSON.stringify(gh.timeline[m[1]] ?? []) };
      if ((m = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments/.exec(path))) return { stdout: JSON.stringify(gh.comments[m[1]] ?? []) };
      if ((m = /^repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)\/permission/.exec(path))) {
        const perm = gh.permissions[decodeURIComponent(m[1])];
        return perm ? { stdout: JSON.stringify({ permission: perm }) } : { status: 1, stderr: 'HTTP 404' };
      }
      return { stdout: '{}' };
    }
    return { stdout: '{}' };
  };
  /** Number of mutating calls (label edits, comments). */
  gh.mutations = () => gh.calls.filter((c) => (c[0] === 'issue' && (c[1] === 'edit' || c[1] === 'comment')) || (c[0] === 'pr' && c[1] !== 'list' && c[1] !== 'view'));
  return gh;
}

/** A timeline `unlabeled` event. */
export function unlabeledEvent({ id, label, actor, at }) {
  return { id, event: 'unlabeled', label: { name: label }, actor: { login: actor }, created_at: at };
}

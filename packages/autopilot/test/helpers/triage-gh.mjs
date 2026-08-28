// A stateful fake GitHub behind the pinned `gh` executable, for the triage and
// terminal-effects suites. Issues and PRs carry labels and comments; every gh
// argv is recorded, every MUTATING call is recorded separately, and a failure
// can be injected for calls matching a predicate (e.g. "fail the label call").

import { json } from './fake-children.mjs';

const isMutation = (args) => args[1] === 'comment' || args[1] === 'edit';

export function fakeGithub({ issues = [], prs = [] } = {}) {
  const state = { issues: new Map(), prs: new Map() };
  const add = (map, kind) => (doc) => map.set(doc.number, { kind, labels: [], comments: [], title: '', body: '', url: `https://github.com/o/r/${kind === 'issue' ? 'issues' : 'pull'}/${doc.number}`, ...doc });
  issues.forEach(add(state.issues, 'issue'));
  prs.forEach(add(state.prs, 'pr'));
  const calls = [];
  const mutations = [];
  let fail = null;
  const target = (kind, n) => (kind === 'pr' ? state.prs : state.issues).get(Number(n)) ?? null;
  const view = (t, fields) => Object.fromEntries(fields.map((f) => [f, f === 'labels' ? t.labels.map((name) => ({ name })) : f === 'comments' ? t.comments.map((c) => ({ body: c.body })) : t[f] ?? null]));

  function handler(args, { stdin }) {
    calls.push([...args]);
    if (fail && fail.remaining > 0 && fail.test(args)) { fail.remaining--; fail.hits++; return { status: fail.status, stderr: fail.stderr }; }
    const [sub, verb] = args;
    if (sub === 'api') {
      const m = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments/.exec(args[1] ?? '');
      if (m) { const t = target('issue', m[1]) ?? target('pr', m[1]); return t ? json(t.comments)() : { status: 1, stderr: 'HTTP 404' }; }
      return { status: 1, stderr: `unhandled api ${args[1]}` };
    }
    if (sub !== 'issue' && sub !== 'pr') return { status: 1, stderr: `unhandled gh ${args.join(' ')}` };
    const t = target(sub, args[2]);
    if (!t) return { status: 1, stderr: `HTTP 404: ${sub} ${args[2]} not found` };
    if (verb === 'view') return json(view(t, (args[args.indexOf('--json') + 1] ?? '').split(',')))();
    if (verb === 'comment') { mutations.push([...args]); t.comments.push({ body: stdin, id: t.comments.length + 1 }); return json({})(); }
    if (verb === 'edit') {
      mutations.push([...args]);
      const add = args.indexOf('--add-label'); const rm = args.indexOf('--remove-label');
      if (add >= 0 && !t.labels.includes(args[add + 1])) t.labels.push(args[add + 1]);
      if (rm >= 0) t.labels = t.labels.filter((l) => l !== args[rm + 1]);
      return json({})();
    }
    return { status: 1, stderr: `unhandled gh ${args.join(' ')}` };
  }
  return {
    state, calls, mutations, handler,
    issue: (n) => target('issue', n), pr: (n) => target('pr', n),
    /** Fail every matching call `times` times (default: until cleared). */
    failWhen(test, { times = Infinity, status = 1, stderr = 'HTTP 500: boom' } = {}) { fail = { test, remaining: times, status, stderr, hits: 0 }; return fail; },
    clearFail() { fail = null; },
    mutationsMatching: (re) => mutations.filter((a) => re.test(a.join(' '))),
    callsMatching: (re) => calls.filter((a) => re.test(a.join(' '))),
    resetCounters() { calls.length = 0; mutations.length = 0; },
    isMutation,
  };
}

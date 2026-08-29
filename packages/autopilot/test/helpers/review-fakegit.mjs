// A fake git for the push / pr suites: answers rev-parse, status, push and
// ls-remote from a mutable state so a test can move HEAD, dirty the tree,
// fail the lease or move the remote between calls.

import { OID } from './review-ctx.mjs';

export const BRANCH_7 = 'adlc/autopilot/issue-7';

export function fakeGit({ head = OID.b, clean = true, pushStatus = 0, remote = OID.b } = {}) {
  const st = { head, clean, pushStatus, remote, lsCalls: 0, pushes: [] };
  const handler = (args) => {
    const verb = args.find((a) => !a.startsWith('-'));
    switch (verb) {
      case 'rev-parse': return { stdout: `${st.head}\n` };
      case 'status': return { stdout: st.clean ? '' : ' M x.js\n' };
      case 'push': st.pushes.push(args); return st.pushStatus ? { status: st.pushStatus, stderr: st.pushStderr ?? `! [rejected] ${BRANCH_7} -> ${BRANCH_7} (stale info)\n` } : { stdout: '' };
      case 'ls-remote': { st.lsCalls++; const oid = typeof st.remote === 'function' ? st.remote(st.lsCalls) : st.remote; return { stdout: oid ? `${oid}\trefs/heads/${BRANCH_7}\n` : '' }; }
      default: return { stdout: '' };
    }
  };
  return { st, handler };
}

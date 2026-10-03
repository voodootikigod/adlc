// plain-workspace-env.mjs — the hook environment for a plain workspace driven
// by an external ticket store. The host's workspace variable binds the root,
// so no `.adlc` in a parent directory can be adopted in its place, and the
// home is a fixture so no real key store is read or written.

const HOME_VAR = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';

export function plainWorkspaceEnv({ workspace, store, home, ticket = 'T1' }) {
  return {
    ADLC_P4_ENFORCEMENT: '1',
    ADLC_TICKET_STORE: store,
    ADLC_TICKET: ticket,
    ANTIGRAVITY_WORKSPACE: workspace,
    [HOME_VAR]: home,
  };
}

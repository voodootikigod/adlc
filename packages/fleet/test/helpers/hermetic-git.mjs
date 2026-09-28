// Environment for git fixtures in this suite: fixed identity, and no user or
// system config (a global hooksPath or gpgsign must not leak into the run).
//
// gc.auto=0 / gc.autoDetach=false travel as GIT_CONFIG_* entries, so they reach
// every git spawned with this env, including call sites that pass no -c flags.
// A detached auto-maintenance child outlives the command that spawned it and can
// create files under .git while a fixture's teardown is removing it (ENOTEMPTY).
// Environment config is never persisted, so `git config --list --local` does not
// report it.
export const hermeticGitEnv = Object.freeze({
  ...process.env,
  GIT_AUTHOR_NAME: 'fleet-test', GIT_AUTHOR_EMAIL: 'fleet@test.invalid',
  GIT_COMMITTER_NAME: 'fleet-test', GIT_COMMITTER_EMAIL: 'fleet@test.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'gc.auto', GIT_CONFIG_VALUE_0: '0',
  GIT_CONFIG_KEY_1: 'gc.autoDetach', GIT_CONFIG_VALUE_1: 'false',
});

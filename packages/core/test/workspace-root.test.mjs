import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '../lib/test-kit.mjs';
import {
  SHELL_WORKDIR_KEYS,
  extractToolWorkdir,
  canonicalizePath,
  isPathInside,
  inspectGitCheckout,
  hasTicketStoreAt,
  findInnermostCheckoutRoot,
  preferInnermostCheckout,
} from '../index.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

function initAdlcGitRepo(t, { sharded = false } = {}) {
  const repo = tmp(t, 'ws-root-repo-');
  git(repo, 'init', '-b', 'main');
  if (sharded) {
    mkdirSync(join(repo, '.adlc', 'tickets'), { recursive: true });
    writeFileSync(join(repo, '.adlc', 'tickets', '.store.json'), '{"version":1}\n');
  } else {
    mkdirSync(join(repo, '.adlc'), { recursive: true });
    writeFileSync(join(repo, '.adlc', 'tickets.json'), '{"tickets":[]}\n');
  }
  writeFileSync(join(repo, 'README.md'), '# test\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'init');
  return repo;
}

test('SHELL_WORKDIR_KEYS is frozen and extractToolWorkdir extracts across harness schemas', () => {
  assert.equal(Object.isFrozen(SHELL_WORKDIR_KEYS), true);
  assert.equal(extractToolWorkdir(null), null);
  assert.equal(extractToolWorkdir(undefined), null);
  assert.equal(extractToolWorkdir('cwd'), null);
  assert.equal(extractToolWorkdir(['/tmp']), null);
  assert.equal(extractToolWorkdir({}), null);
  assert.equal(extractToolWorkdir({ Cwd: '   ', cwd: '' }), null);

  for (const key of SHELL_WORKDIR_KEYS) {
    assert.equal(extractToolWorkdir({ [key]: '  /srv/work  ' }), '/srv/work', key);
  }

  // Top-level takes precedence over nested containers, and Cwd beats cwd.
  assert.equal(
    extractToolWorkdir({ Cwd: '/top/pascal', cwd: '/top/lower', options: { Cwd: '/nested' } }),
    '/top/pascal'
  );
  assert.equal(
    extractToolWorkdir({ options: 'not-an-object', params: ['/arr'], payload: { dir_path: ' /nested/gemini ' } }),
    '/nested/gemini'
  );
  assert.equal(extractToolWorkdir({ input: { workdir: '/nested/opencode' } }), '/nested/opencode');
  assert.equal(extractToolWorkdir({ tool_input: { working_directory: '/nested/cursor' } }), '/nested/cursor');
  assert.equal(extractToolWorkdir({ toolInput: { workingDir: '/nested/camel' } }), '/nested/camel');
});

test('canonicalizePath and isPathInside resolve symlinks and non-existent children safely', (t) => {
  const base = tmp(t, 'ws-canon-');
  const realDir = join(base, 'real-repo');
  const aliasDir = join(base, 'alias-repo');
  const siblingDir = join(base, 'real-repo-sibling');
  mkdirSync(join(realDir, 'src'), { recursive: true });
  mkdirSync(siblingDir, { recursive: true });
  symlinkSync(realDir, aliasDir);

  const expectedReal = realpathSync(realDir);
  assert.equal(canonicalizePath(aliasDir), expectedReal);
  assert.equal(
    canonicalizePath(join(aliasDir, 'src', 'not-created-yet', 'file.mjs')),
    join(expectedReal, 'src', 'not-created-yet', 'file.mjs')
  );

  assert.equal(isPathInside(aliasDir, realDir), true);
  assert.equal(isPathInside(join(aliasDir, 'src', 'new.mjs'), realDir), true);
  assert.equal(isPathInside(siblingDir, realDir), false);
  assert.equal(isPathInside('', realDir), false);
  assert.equal(isPathInside(realDir, '   '), false);
});

test('inspectGitCheckout distinguishes real repos, verified worktrees, syntactic gitfiles, and forgeries', (t) => {
  assert.equal(inspectGitCheckout(''), null);
  const plain = tmp(t, 'ws-plain-');
  assert.equal(inspectGitCheckout(plain), null);

  // Bare .git directory without HEAD is rejected
  const fakeDir = tmp(t, 'ws-fakedir-');
  mkdirSync(join(fakeDir, '.git'));
  assert.equal(inspectGitCheckout(fakeDir), null);

  // Symlink .git is rejected
  const symDir = tmp(t, 'ws-symdir-');
  const targetGit = tmp(t, 'ws-targetgit-');
  writeFileSync(join(targetGit, 'HEAD'), 'ref: refs/heads/main\n');
  symlinkSync(targetGit, join(symDir, '.git'));
  assert.equal(inspectGitCheckout(symDir), null);

  // Oversized and invalid .git files are rejected
  const invalidFileDir = tmp(t, 'ws-invalid-gitfile-');
  writeFileSync(join(invalidFileDir, '.git'), 'not a gitdir pointer\n');
  assert.equal(inspectGitCheckout(invalidFileDir), null);
  writeFileSync(join(invalidFileDir, '.git'), 'gitdir:   \n');
  assert.equal(inspectGitCheckout(invalidFileDir), null);
  writeFileSync(join(invalidFileDir, '.git'), `gitdir: ${'a'.repeat(5000)}\n`);
  assert.equal(inspectGitCheckout(invalidFileDir), null);

  // Syntactic gitdir without valid worktree backlink classifies as gitfile (not verified worktree)
  writeFileSync(join(invalidFileDir, '.git'), 'gitdir: ../.git/modules/sub\n');
  const gitfileInfo = inspectGitCheckout(invalidFileDir);
  assert.equal(gitfileInfo?.kind, 'gitfile');
  assert.equal(gitfileInfo?.commonGitDir, null);

  // Real git repo + real linked worktrees (1-level and 2-level nested)
  const repo = initAdlcGitRepo(t, { sharded: true });
  const repoInfo = inspectGitCheckout(repo);
  assert.equal(repoInfo?.kind, 'repo');
  assert.equal(repoInfo?.commonGitDir, realpathSync(join(repo, '.git')));

  const laneA = join(repo, '.worktrees', 'lane-a');
  git(repo, 'worktree', 'add', '-b', 'lane-a', laneA);
  const laneAInfo = inspectGitCheckout(laneA);
  assert.equal(laneAInfo?.kind, 'worktree');
  assert.equal(laneAInfo?.commonGitDir, realpathSync(join(repo, '.git')));

  const laneB = join(laneA, '.worktrees', 'lane-b');
  git(laneA, 'worktree', 'add', '-b', 'lane-b', laneB);
  const laneBInfo = inspectGitCheckout(laneB);
  assert.equal(laneBInfo?.kind, 'worktree');
  assert.equal(laneBInfo?.commonGitDir, realpathSync(join(repo, '.git')));

  // Copying lane-a's .git file into another directory fails back-pointer verification
  const stolen = join(repo, 'stolen');
  mkdirSync(stolen, { recursive: true });
  writeFileSync(join(stolen, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'lane-a')}\n`);
  assert.equal(inspectGitCheckout(stolen)?.kind, 'gitfile');
});

test('hasTicketStoreAt recognizes sharded, legacy, and relative override stores, never bare .adlc', (t) => {
  const dir = tmp(t, 'ws-store-');
  assert.equal(hasTicketStoreAt(''), false);
  assert.equal(hasTicketStoreAt(dir), false);

  mkdirSync(join(dir, '.adlc'), { recursive: true });
  assert.equal(hasTicketStoreAt(dir), false, 'bare .adlc directory is not a ticket store');

  writeFileSync(join(dir, 'custom-tickets.json'), '{"tickets":[]}\n');
  assert.equal(hasTicketStoreAt(dir, 'custom-tickets.json'), true);
  assert.equal(hasTicketStoreAt(dir, 'missing-tickets.json'), false);
  assert.equal(hasTicketStoreAt(dir, join(dir, 'custom-tickets.json')), false);

  writeFileSync(join(dir, '.adlc', 'tickets.json'), '{"tickets":[]}\n');
  assert.equal(hasTicketStoreAt(dir), true);

  const sharded = tmp(t, 'ws-sharded-');
  mkdirSync(join(sharded, '.adlc', 'tickets'), { recursive: true });
  writeFileSync(join(sharded, '.adlc', 'tickets', '.store.json'), '{"version":1}\n');
  assert.equal(hasTicketStoreAt(sharded), true);
});

test('findInnermostCheckoutRoot resolves nested worktrees while defeating forged .git decoys', (t) => {
  assert.equal(findInnermostCheckoutRoot(''), null);

  const repo = initAdlcGitRepo(t, { sharded: true });
  const repoReal = realpathSync(repo);

  // Plugin directory rejection
  const pluginDir = tmp(t, 'ws-plugin-');
  mkdirSync(join(pluginDir, 'hooks'), { recursive: true });
  assert.equal(
    findInnermostCheckoutRoot(join(pluginDir, 'hooks'), { pluginDir }),
    null
  );

  // allowFileStart works for both existing and non-existent files
  assert.equal(
    findInnermostCheckoutRoot(join(repo, 'README.md'), { allowFileStart: true }),
    repoReal
  );
  assert.equal(
    findInnermostCheckoutRoot(join(repo, 'src', 'new-file.mjs'), { allowFileStart: true }),
    repoReal
  );

  // Forged subdirectory .git/HEAD + forged ticket store inside repo do NOT release enclosing repo
  const forgedSub = join(repo, 'packages', 'forged');
  mkdirSync(join(forgedSub, '.git'), { recursive: true });
  writeFileSync(join(forgedSub, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(join(forgedSub, '.adlc'), { recursive: true });
  writeFileSync(join(forgedSub, '.adlc', 'tickets.json'), '{"tickets":[]}\n');
  assert.equal(findInnermostCheckoutRoot(forgedSub), repoReal);

  // Forged external gitdir worktree pointing to an unrelated repo's .git/worktrees does NOT release enclosing repo
  const attackerRepo = initAdlcGitRepo(t);
  const forgedExternalWt = join(repo, 'packages', 'attacker-wt');
  git(attackerRepo, 'worktree', 'add', '-b', 'evil', forgedExternalWt);
  assert.equal(
    findInnermostCheckoutRoot(forgedExternalWt),
    repoReal,
    'worktree belonging to a different commonGitDir cannot escape enclosing ADLC repo'
  );

  // Real nested worktrees (1-level and 2-level) DO resolve to their own worktree root,
  // even when the outer primary repo is in rememberedRoots!
  const laneA = join(repo, '.worktrees', 'lane-a');
  git(repo, 'worktree', 'add', '-b', 'lane-a', laneA);
  mkdirSync(join(laneA, 'packages', 'a'), { recursive: true });

  const laneB = join(laneA, '.worktrees', 'lane-b');
  git(laneA, 'worktree', 'add', '-b', 'lane-b', laneB);
  mkdirSync(join(laneB, 'packages', 'b'), { recursive: true });

  const remembered = new Set([repoReal, realpathSync(laneA)]);
  assert.equal(
    findInnermostCheckoutRoot(join(laneA, 'packages', 'a'), { rememberedRoots: remembered }),
    realpathSync(laneA)
  );
  assert.equal(
    findInnermostCheckoutRoot(join(laneB, 'packages', 'b'), { rememberedRoots: remembered }),
    realpathSync(laneB)
  );
});

test('findInnermostCheckoutRoot enforces $HOME boundary, external stores, requireStore, and preserveSpelling', (t) => {
  const fakeHome = tmp(t, 'ws-home-');
  mkdirSync(join(fakeHome, '.adlc'), { recursive: true });
  writeFileSync(join(fakeHome, '.adlc', 'tickets.json'), '{"tickets":[]}\n');

  // Unrelated non-ADLC repo beneath $HOME is NOT captured by stray $HOME/.adlc/tickets.json
  const childRepo = join(fakeHome, 'projects', 'app');
  mkdirSync(childRepo, { recursive: true });
  git(childRepo, 'init', '-b', 'main');
  assert.equal(findInnermostCheckoutRoot(childRepo, { homeDir: fakeHome }), null);
  assert.equal(
    findInnermostCheckoutRoot(childRepo, { homeDir: fakeHome, requireStore: false }),
    realpathSync(childRepo)
  );

  // Starting directly in $HOME honors $HOME's store
  assert.equal(findInnermostCheckoutRoot(fakeHome, { homeDir: fakeHome }), realpathSync(fakeHome));

  // If $HOME itself is a real git repo (dotfiles), subdirectories without their own git boundary resolve to $HOME
  git(fakeHome, 'init', '-b', 'main');
  const dotConfig = join(fakeHome, '.config', 'nvim');
  mkdirSync(dotConfig, { recursive: true });
  assert.equal(findInnermostCheckoutRoot(dotConfig, { homeDir: fakeHome }), realpathSync(fakeHome));

  // External absolute storeOverride resolves to checkoutRoot, or startDir if no git checkout exists
  const extStoreDir = tmp(t, 'ws-ext-store-');
  const extStore = join(extStoreDir, 'tickets.json');
  writeFileSync(extStore, '{"tickets":[]}\n');
  assert.equal(
    findInnermostCheckoutRoot(childRepo, { homeDir: fakeHome, storeOverride: extStore }),
    realpathSync(childRepo)
  );
  const plainDir = tmp(t, 'ws-plain-ext-');
  assert.equal(
    findInnermostCheckoutRoot(plainDir, { storeOverride: extStore }),
    realpathSync(plainDir)
  );

  // preserveSpelling keeps symlinked path spelling when requested
  const symlinkParent = tmp(t, 'ws-spell-');
  const aliasRepo = join(symlinkParent, 'alias-child');
  symlinkSync(childRepo, aliasRepo);
  assert.equal(
    findInnermostCheckoutRoot(aliasRepo, { homeDir: fakeHome, requireStore: false, preserveSpelling: true }),
    aliasRepo
  );
});

test('preferInnermostCheckout upgrades outerRoot only for verified nested worktrees inside outerRoot', (t) => {
  const repo = initAdlcGitRepo(t, { sharded: true });
  const otherRepo = initAdlcGitRepo(t, { sharded: true });
  const laneA = join(repo, '.worktrees', 'lane-a');
  git(repo, 'worktree', 'add', '-b', 'lane-a', laneA);
  const subDir = join(repo, 'src');
  mkdirSync(subDir, { recursive: true });

  // No outerRoot -> resolves from dynamicCandidates
  assert.equal(preferInnermostCheckout('', [join(laneA, 'README.md')], { allowFileStart: true }), realpathSync(laneA));
  assert.equal(preferInnermostCheckout(null, ['']), null);

  // Dynamic candidate outside outerRoot -> keeps outerRoot (including non-existent outerRoot with preserveSpelling)
  assert.equal(
    preferInnermostCheckout('/definitely/does/not/exist/nope', [otherRepo], { preserveSpelling: true }),
    '/definitely/does/not/exist/nope'
  );
  assert.equal(preferInnermostCheckout(repo, [otherRepo]), realpathSync(repo));

  // Dynamic candidate in normal subdirectory of outerRoot -> keeps outerRoot
  assert.equal(preferInnermostCheckout(repo, [subDir]), realpathSync(repo));

  // Dynamic candidate inside nested worktree of outerRoot -> upgrades to nested worktree!
  assert.equal(preferInnermostCheckout(repo, [laneA]), realpathSync(laneA));
  mkdirSync(join(laneA, 'packages', 'sub'), { recursive: true });
  assert.equal(preferInnermostCheckout(repo, [join(laneA, 'packages', 'sub')]), realpathSync(laneA));
});

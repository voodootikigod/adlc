// Declarations for @adlc/core/test-kit (lib/test-kit.mjs).

import type { SpawnSyncReturns } from 'node:child_process';

/** The part of a node:test TestContext the kit relies on: a hook run when the test ends. */
export type TestContext = {
  after: (fn: () => unknown) => void;
};

export type GitRepoOptions = {
  prefix?: string;
  branch?: string;
  userEmail?: string;
  userName?: string;
  email?: string;
  name?: string;
};

export type GitRepoResult = {
  dir: string;
  git: (...args: unknown[]) => string;
  g: (...args: unknown[]) => string;
};

export type RunBinOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  allowEnv?: string[];
  allowKeys?: string[];
  allowKey?: boolean;
  encoding?: string;
  timeout?: number;
  platform?: string;
  [key: string]: unknown;
};

export declare const DEFAULT_SCRUBBED_ENV: readonly string[];
export declare const GIT_SCRUBBED_ENV: readonly string[];
export declare const FIXTURE_RM_OPTIONS: Readonly<{ recursive: true; force: true; maxRetries: number; retryDelay: number }>;

/** Throws a TypeError, creating nothing, when `t` has no callable `.after`. */
export declare function tmp(t: TestContext, prefix?: string): string;
/** Throws a TypeError, creating nothing, when `t` has no callable `.after`. */
export declare function gitRepo(t: TestContext, options?: GitRepoOptions | string): GitRepoResult;
export declare function withScopedContext<T>(fn: (ctx: TestContext) => T | Promise<T>): Promise<T>;
export declare function runBin(binPath: string, args?: string[] | RunBinOptions, options?: RunBinOptions): SpawnSyncReturns<string>;
export type Scope = Readonly<TestContext & { dispose: () => Promise<void> }>;
export declare function createScope(): Scope;

import type { ParseArgsConfig } from 'node:util';

export const ADLC_DIR: string;
export const TICKETS_PATH: string;
export const TICKET_TRUST_ROOT_RAILS: readonly string[];

export type ParsedArgs = {
  readonly values: Record<string, string | boolean | string[] | boolean[] | undefined>;
  readonly positionals: string[];
};
export function parseArgs(config?: ParseArgsConfig & { usage?: string | (() => void) }): ParsedArgs;
export function pass(message?: string): never;
export function gateFail(message?: string, details?: unknown): never;
export function opError(message?: string): never;
export function printJson(value: unknown): void;
export function readStdin(): Promise<string>;
export function promptOnly(prompts: string | readonly string[]): never;

export type ModelTier = 'cheap' | 'mid' | 'frontier';
export type Provider = {
  readonly name: string;
  readonly apiKey?: string;
  readonly models: Record<string, string>;
  readonly send?: (options: CompletionRequest) => Promise<string>;
};
export type Usage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly provider: string;
  readonly model: string;
  readonly tier?: ModelTier | string;
};
export type CompletionOptions = {
  readonly tier?: ModelTier | string;
  readonly model?: string;
  readonly system?: string;
  readonly prompt: string;
  readonly maxTokens?: number;
  /**
   * Per-invocation provider override (e.g. a CLI `--provider` flag), mirroring
   * ADLC_PROVIDER but scoped to this one call; takes precedence over
   * ADLC_PROVIDER. Omit it and single-provider auto-detect remains the
   * default (cost/latency per ADR-0007).
   */
  readonly provider?: string;
  /**
   * Optional side-channel fired synchronously right before `complete`
   * returns, with the normalized usage the provider reported (agy never
   * calls it — there is no metered usage to report there). Additive: omit
   * it and behavior is unchanged.
   */
  readonly onUsage?: (usage: Usage) => void;
  /**
   * Marks the system/prompt as a prompt-cache candidate on providers that
   * support explicit cache breakpoints (currently anthropic only). Only set
   * this when the SAME {system, prompt} pair will genuinely be sent again —
   * a cache write costs more than a plain input token and only pays off on
   * a later read. `complete()` defaults this to `false`; `fan()` defaults
   * it to `true` (it exists specifically to resend one prompt N times).
   */
  readonly cacheable?: boolean;
};
export type CompletionRequest = CompletionOptions & {
  readonly apiKey: string;
  readonly model: string;
};
export type FanResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: string };
export type FanProvidersResult =
  | { readonly ok: true; readonly value: string; readonly provider: string }
  | { readonly ok: false; readonly error: string; readonly provider: string };

/** Names of all known providers, in auto-detect priority order. */
export const PROVIDER_NAMES: readonly string[];

export function isAgyTimeout(output: string): boolean;
export function complete(options: CompletionOptions, env?: Record<string, string | undefined>): Promise<string>;
export function fan(options: CompletionOptions, count: number, env?: Record<string, string | undefined>): Promise<FanResult[]>;
export function fanProviders(
  options: CompletionOptions,
  providerNames: readonly string[],
  env?: Record<string, string | undefined>
): Promise<FanProvidersResult[]>;
export function extractJson(text: string): unknown;
export function detectProvider(env?: Record<string, string | undefined>, forceProvider?: string): Provider | null;
export function resolveModel(
  provider: Pick<Provider, 'models'>,
  options?: { readonly tier?: ModelTier | string; readonly model?: string },
  env?: Record<string, string | undefined>
): string;

export const GIT_MAX_BUFFER: number;
export function git(args: readonly string[], opts?: {
  cwd?: string;
  stdio?: unknown;
  encoding?: string;
  maxBuffer?: number;
  [key: string]: unknown;
}): string;
export function gitDiff(base?: string, cwd?: string): string;
export function changedFiles(base?: string, cwd?: string): string[];
/**
 * Split raw NUL-delimited `git ... -z` output into path strings, failing closed
 * on any path that does not round-trip UTF-8 (#249). Pass the Buffer, not a
 * decoded string, so lossy-decode aliasing is detectable.
 */
export function splitNulPaths(raw: Buffer | string): string[];
export function isDirty(cwd?: string): boolean;
export function isGitRepo(cwd?: string): boolean;
export function repoRoot(cwd?: string): string;
export function refExists(ref: string, cwd?: string): boolean;
export function resolveBase(cwd?: string, candidates?: string[]): string | null;
export function coChange(limit?: number, cwd?: string): {
  pairCounts: Record<string, number>;
  fileCounts: Record<string, number>;
};
export function churn(limit?: number, cwd?: string): Record<string, number>;

export function appendEntry<T = unknown>(name: string, entry: T, dir?: string): T;
export function appendEntries<T = unknown>(
  name: string,
  entriesOrFactory: T[] | ((state: { entries: unknown[]; skipped: Array<{ line: number; error: string }>; rawLines: string[]; lastRawLine: string | null }) => T[]),
  dir?: string
): T[];
export function withLedgerLock<T>(target: string, fn: () => T, options?: { retries?: number; delayMs?: number }): T;
export function readEntries<T = unknown>(
  name: string,
  dir?: string
): { entries: T[]; skipped: Array<{ line: number; error: string }> };
export function ledgerPath(name: string, dir?: string): string;
export function sha256(input: string | Uint8Array): string;
export function canonicalJson(value: unknown): string;
export function hashFiles(
  files: readonly string[],
  readFile?: (path: string) => string | Uint8Array
): Record<string, string | null>;

export function validateTicket(ticket: unknown): string[];
export function loadTickets(path?: string): { tickets: unknown[]; errors: string[] };
export function ticketStoreExists(root?: string, override?: string | null): boolean;
export function topoSort(tickets: Array<{ id: string; edges?: Array<{ to: string }> }>): {
  order: string[];
  cycle: string[] | null;
};
export function computeFloat(tickets: Array<{ id: string; duration?: number; edges?: Array<{ to: string }> }>): unknown;
export function globMatch(pattern: string, path: string): boolean;
export function scopesOverlap(left: unknown, right: unknown): boolean;
export function inScope(ticket: unknown, path: string): boolean;
export function pairKey(left: string, right: string): string;

export function resolveRevision(options?: {
  cwd?: string;
  revision?: string | null;
  ignorePaths?: string[];
}): string | null;

export const RISK_TIER_PATTERNS: Readonly<Record<string, readonly string[]>>;
export function matchRiskTier(path: string): { tier: string; pattern: string } | null;
export function classifyRiskTier(paths?: readonly string[]): {
  gated: boolean;
  matches: Array<{ path: string; tier: string; pattern: string }>;
};
export function decideAdversarialReviewNotice(options?: {
  changedPaths?: readonly string[];
  manifestEntries?: readonly unknown[];
  ticketId?: string | null;
}): {
  needed: boolean;
  matches: Array<{ path: string; tier: string; pattern: string }>;
};

export type ProsecutionLens = {
  readonly key: string;
  readonly agent: string;
  readonly focus: string;
};
export type ProsecutionFinding = {
  readonly severity?: 'critical' | 'high' | 'medium' | 'low' | string;
  readonly file?: string;
  readonly line_start?: number;
  readonly line_end?: number;
  readonly title?: string;
  readonly [key: string]: unknown;
};
export type VerifierVote = { readonly real?: boolean };
export const LENSES: readonly ProsecutionLens[];
export const VERIFIER: ProsecutionLens;
export const ALL_AGENTS: readonly string[];
export function findingKey(finding: ProsecutionFinding): string;
export function dedupeFindings(
  findings?: readonly ProsecutionFinding[] | null
): ProsecutionFinding[];
export function survivesVerification(
  votes?: ReadonlyArray<VerifierVote | null | undefined> | null,
  options?: { threshold?: number }
): boolean;
export function shouldContinue(state: {
  freshThisRound: number;
  dryStreak: number;
  maxDry?: number;
}): { continue: boolean; dryStreak: number };

export type RecordableFinding = {
  readonly file: string;
  readonly desc: string;
  readonly category?: string;
  readonly severity?: string;
  readonly line?: number;
  readonly verdict?: string;
};
export type LedgerFinding = {
  ts: string;
  tool: string;
  file: string;
  line: number;
  category: string;
  severity: string;
  desc: string;
  verdict: string;
};
export function recordFinding(finding: RecordableFinding, dir?: string): LedgerFinding;

export function matchFenceOpen(line: string): { char: string; len: number } | null;
export function isFenceClose(line: string, char: string, len: number): boolean;
export function computeFencedLines(content: string, opts?: { unclosedToEof?: boolean }): Set<number>;

export function ensureGitignore(root: string): { path: string; added: string[]; changed: boolean };
export function ensureTicketStore(root: string): {
  backend: 'legacy' | 'directory';
  created: boolean;
  legacyMigrationAvailable: boolean;
  activeCreated?: boolean;
  archiveCreated?: boolean;
};
export function ensureFormatterIgnores(root: string): {
  biome: { path: string | null; detected: boolean; changed: boolean; skipped?: string };
  prettier: { path: string; detected: boolean; changed: boolean };
  eslint: {
    path: string | (string | null)[] | null;
    detected: boolean;
    changed: boolean;
    skipped?: string;
    sources?: { eslintrc: unknown; eslintignore: unknown };
  };
};

export namespace mutate {
  export const OPERATORS: ReadonlyArray<{
    readonly name: string;
    readonly apply: (line: string) => string | null;
  }>;
  export function generateMutants(...args: unknown[]): unknown;
  export function applyMutant(...args: unknown[]): unknown;
  export function changedLinesFromDiff(...args: unknown[]): unknown;
}

// lib/shell.mjs — shell-command classification for in-session rail gating
export function collectPatchPaths(text: string, out: Set<string>): void;
export function shellTokens(text: string): string[];
export function looksPathLike(value: string): boolean;
export function looksBarePathLike(value: string): boolean;
export function keyValuePath(value: string): string | null;
export function shellHasMutation(text: string): boolean;
export function shellHasOpaqueMutation(text: string): boolean;
export function shellIsPositivelyReadOnly(text: string): boolean;
export function shellHasWriteOption(text: string): boolean;
export function shellChangesCwd(text: string): boolean;
export function shellHasExpansion(text: string): boolean;
export function collectShellPaths(text: string, out: Set<string>): void;
export function classifyShellCommand(text: string): {
  readOnly: boolean;
  mutating: boolean;
  opaque: boolean;
  changesCwd: boolean;
  expands: boolean;
  writeOption: boolean;
  paths: string[];
};

// lib/railpath.mjs
export function resolveRailPath(filePath: string, root: string): string;

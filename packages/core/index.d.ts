import type { ParseArgsConfig } from 'node:util';

export const ADLC_DIR: string;
export const TICKETS_PATH: string;

export type ParsedArgs = {
  readonly values: Record<string, string | boolean | string[] | boolean[] | undefined>;
  readonly positionals: string[];
};
export function parseArgs(config?: ParseArgsConfig): ParsedArgs;
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
export type CompletionOptions = {
  readonly tier?: ModelTier | string;
  readonly model?: string;
  readonly system?: string;
  readonly prompt: string;
  readonly maxTokens?: number;
};
export type CompletionRequest = CompletionOptions & {
  readonly apiKey: string;
  readonly model: string;
};
export type FanResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: string };

export function isAgyTimeout(output: string): boolean;
export function complete(options: CompletionOptions): Promise<string>;
export function fan(options: CompletionOptions, count: number): Promise<FanResult[]>;
export function extractJson(text: string): unknown;
export function detectProvider(env?: Record<string, string | undefined>): Provider | null;
export function resolveModel(
  provider: Pick<Provider, 'models'>,
  options?: { readonly tier?: ModelTier | string; readonly model?: string },
  env?: Record<string, string | undefined>
): string;

export function git(args: readonly string[], opts?: {
  cwd?: string;
  stdio?: unknown;
  encoding?: string;
  maxBuffer?: number;
  [key: string]: unknown;
}): string;
export function gitDiff(base?: string, cwd?: string): string;
export function changedFiles(base?: string, cwd?: string): string[];
export function isDirty(cwd?: string): boolean;
export function isGitRepo(cwd?: string): boolean;
export function refExists(ref: string, cwd?: string): boolean;
export function resolveBase(cwd?: string, candidates?: string[]): string | null;
export function coChange(limit?: number, cwd?: string): {
  pairCounts: Record<string, number>;
  fileCounts: Record<string, number>;
};
export function churn(limit?: number, cwd?: string): Record<string, number>;

export function appendEntry<T = unknown>(name: string, entry: T, dir?: string): T;
export function withLedgerLock<T>(target: string, fn: () => T): T;
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

export namespace mutate {
  export const OPERATORS: ReadonlyArray<{
    readonly name: string;
    readonly apply: (line: string) => string | null;
  }>;
  export function generateMutants(...args: unknown[]): unknown;
  export function applyMutant(...args: unknown[]): unknown;
  export function changedLinesFromDiff(...args: unknown[]): unknown;
}

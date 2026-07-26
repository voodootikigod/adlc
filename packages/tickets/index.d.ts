// No `/// <reference types="node" />`. An earlier revision had one, which made
// @types/node a hard requirement of merely importing this package: a project
// with only typescript and @adlc/tickets installed failed to resolve the
// reference before it type-checked a single line of its own code. A published
// .d.ts must stand on its own.
//
// generateTicketId still needs a real Node Buffer at runtime (it calls
// Buffer.isBuffer), so `NodeBuffer` below describes one structurally instead of
// naming the global.
export type Ticket = { id: string; title: string; scope?: string[]; rails?: string[]; edges?: Array<{ to: string; [key: string]: unknown }>; [key: string]: unknown };
export type TicketErrorKind = 'operational' | 'invalid' | 'conflict' | 'policy';
export class TicketStoreError extends Error {
  constructor(kind: TicketErrorKind, code: string, message: string, details?: unknown);
  kind: TicketErrorKind;
  code: string;
  details?: unknown;
}
/** Error factories, one per kind. Exported at runtime and used by every tool
 *  that raises a store error, so they belong in the published surface. */
export type TicketErrorFactory = (code: string, message: string, details?: unknown) => TicketStoreError;
export const invalid: TicketErrorFactory;
export const conflict: TicketErrorFactory;
export const policy: TicketErrorFactory;
export const operational: TicketErrorFactory;
export class TicketSnapshot {
  readonly backend: 'legacy' | 'directory' | 'git-revision';
  readonly formatVersion: number;
  readonly hash: string;
  readonly tickets: readonly Readonly<Ticket>[];
  readonly ticketHashes: Readonly<Record<string, string>>;
  get(id: string): Readonly<Ticket> | undefined;
  mutableTickets(): Ticket[];
}
export class LegacyTicketStore { constructor(path?: string); path: string; exists(): boolean; load(): TicketSnapshot; write(tickets: Ticket[]): TicketSnapshot }
export class DirectoryTicketStore { constructor(path?: string, options?: { archive?: boolean }); path: string; archive: boolean; exists(): boolean; load(): TicketSnapshot }
export class GitTreeTicketStore { constructor(options: { cwd?: string; revision: string; storePath?: string }); load(): TicketSnapshot }
export class TicketService {
  constructor(store: LegacyTicketStore | DirectoryTicketStore, options?: { root?: string; protectedIds?: string[] });
  snapshot(): TicketSnapshot;
  planCreate(input?: Partial<Ticket>): TicketPlan;
  planUpdate(id: string, input: Ticket, options?: { expect?: string; authorized?: boolean }): TicketPlan;
  planDiscard(id: string): TicketPlan;
  planComplete(id: string, options?: { authorized?: boolean }): TicketPlan;
  planReassign(id: string, nextId: string, options?: { authorized?: boolean }): TicketPlan;
  planReconciliation(tickets: Ticket[], options?: { authorized?: boolean; expectedSnapshotHash?: string | null }): TicketPlan;
  apply(plan: TicketPlan, options?: { lock?: unknown }): TicketSnapshot;
}
export type TicketPlan = Readonly<{ version: 1; operation: string; expectedSnapshotHash: string; afterHash: string; planHash: string; ticketId: string | null; beforeTicketId: string | null; [key: string]: unknown }>;
export function canonicalJson(value: unknown): string;
export function prettyCanonicalJson(value: unknown): string;
export function ticketHash(ticket: Ticket): string;
export function storeHash(tickets: Ticket[]): string;
export function ticketFilename(id: string): string;
/**
 * A Node Buffer, described structurally so these declarations need no
 * @types/node. readUInt8 is the discriminator: Buffer has it, a plain
 * Uint8Array does not — and generateTicketId rejects anything that is not a
 * real Buffer, so accepting Uint8Array here would declare a call that throws.
 */
export type NodeBuffer = Uint8Array & { readUInt8(offset?: number): number };
export function generateTicketId(now?: number, entropy?: NodeBuffer): string;
export function isGeneratedTicketId(id: string): boolean;
export function validateTicket(ticket: unknown, options?: { archive?: boolean }): string[];
export function validateTickets(tickets: unknown[], options?: { archive?: boolean; validateGraph?: boolean }): unknown[];
export type TicketField = Readonly<{ name: string; type: string; required: boolean; summary: string; schema: Record<string, unknown> }>;
export const TICKET_FIELDS: readonly TicketField[];
export const SCHEMA_ID: string;
/** Categories @adlc/ticket-sync round-trips; the published schema stays
 *  permissive, so this is an authoring-time check, not a stored constraint. */
export const SYNC_CATEGORIES: readonly string[];
/** A warning for a category ticket-sync would reject, or null when it is fine. */
export function categoryWarning(category: unknown): string | null;
export function renderCommandHelp(command: string | undefined): string | null;
export function renderUsage(): string;
export function ticketJsonSchema(): Record<string, unknown>;
export function serializeTicketJsonSchema(): string;
// ---- store layout and hash domains ----
export type TicketManifest = Readonly<{ format: string; version: number }>;
export const ACTIVE_MANIFEST: TicketManifest;
export const ARCHIVE_MANIFEST: TicketManifest;
export const ACTIVE_DIRECTORY: string;
export const ARCHIVE_DIRECTORY: string;
export const LEGACY_FILE: string;
export const LEGACY_ARCHIVE_FILE: string;
export const LOCK_DIRECTORY: string;
export const TRANSACTION_DIRECTORY: string;
export const TICKET_HASH_DOMAIN: string;
export const STORE_HASH_DOMAIN: string;

// ---- canonicalization ----
/** Sort order for ticket ids; negative, zero, or positive like any comparator. */
export function compareTicketIds(left: string, right: string): number;
/** The canonical (key-sorted, normalized) form of a value, before serialization. */
export function canonicalValue(value: unknown): unknown;
export function sha256(value: string | Uint8Array): string;
export function ticketSlug(id: string): string;
/** JSON-representable values — the only domain deepClone round-trips faithfully. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
/**
 * Structural clone via JSON.
 *
 * Returns `JsonValue`, NOT the input type. Four consecutive review rounds found
 * a different way `<T>(value: T): T` was false — Date became an ISO string, NaN
 * and the infinities became null, sparse arrays and undefined elements became
 * null, and non-canonical index keys like "01" or 4294967295 were dropped
 * silently. Each round added a guard; each round JSON found another gap,
 * because the promise itself is the defect: JSON round-tripping does not
 * preserve types, and no amount of input validation makes it.
 *
 * Callers that know their shape can assert it. That is one visible cast at the
 * call site instead of a compiler-blessed lie at every one.
 */
export function deepClone(value: JsonValue): JsonValue;
export function deepFreeze<T>(value: T): Readonly<T>;

// ---- store constructors ----
export function activeDirectoryStore(root?: string): DirectoryTicketStore;
export function archiveDirectoryStore(root?: string): DirectoryTicketStore;

// ---- lock ----
export type TicketLockMetadata = {
  version: number;
  pid: number;
  hostname: string;
  startedAt: string;
  command: string;
  transactionId: string | null;
};
/** The current lock holder's metadata, or null when unlocked or unreadable. */
export function readTicketLock(root?: string): TicketLockMetadata | null;

// ---- active-ticket pointer ----
export const CURRENT_TICKET_FILE: string;
/** The one id key a pointer should use; the aliases below are 1.x-only. */
export const CANONICAL_ID_KEY: 'id';
/** Accepted but deprecated pointer id keys, removed in 2.0. */
export const DEPRECATED_ID_KEYS: readonly string[];
/** Every pointer read returns this discriminated union; `ok: false` is fail-closed. */
export type TicketOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; kind: TicketErrorKind; code: string; message: string };
export type ActiveTicketPointer = {
  present: boolean;
  id?: string;
  ticketHash?: string | null;
  legacyString?: boolean;
  deprecatedAlias?: string;
};
export type ActiveTicketSelection = {
  id: string;
  pointerPresent: boolean;
  ticketHash: string | null;
  legacyString: boolean;
  deprecatedAlias?: string;
};
export type ActiveTicketResolution = {
  id: string;
  ticket: Readonly<Ticket>;
  ticketHash: string;
  storeHash: string;
  warnings: string[];
  deprecatedAlias?: string;
};
export function readActiveTicketPointer(root?: string): TicketOutcome<ActiveTicketPointer>;
/** Identity only — no store is consulted, so staleness is not decidable here.
 *  `value: null` means "no active ticket", the only allow-with-no-ticket outcome. */
export function resolveActiveTicketId(options?: { root?: string; env?: Record<string, string | undefined> }): TicketOutcome<ActiveTicketSelection | null>;
/** Resolves against a loaded snapshot and verifies the pinned hash.
 *  `allowLegacyPointer` is the documented 1.x bridge for a hash-less pointer;
 *  a hash that IS present is always verified. */
export function resolveActiveTicketAgainst(
  snapshot: TicketSnapshot,
  options?: { root?: string; env?: Record<string, string | undefined>; allowLegacyPointer?: boolean },
): TicketOutcome<ActiveTicketResolution | null>;
/** Writes the canonical `{id, ticketHash}` pointer atomically; returns its path. */
export function writeActiveTicket(root: string, pointer: { id: string; ticketHash: string }): string;

export type EditorRunner = (editor: string, path: string) => void;
export const spawnEditor: EditorRunner;
export type EditSession = { plan: TicketPlan; draftPath: string };
/** The draft at `draftPath` outlives this call: a dry run must not destroy the
 *  work it is previewing. Delete it once the plan is applied. */
export function planEditSession(service: TicketService, id: string, options?: { authorized?: boolean; editor?: string; runEditor?: EditorRunner; onEdited?: (edited: Ticket) => void }): EditSession;
export function detectTicketStore(options?: Record<string, unknown>): LegacyTicketStore | DirectoryTicketStore;
export function loadTicketSnapshot(options?: Record<string, unknown>): TicketSnapshot;
export function pendingTransactions(root?: string): string[];
export function resolveStoreOverride(options?: Record<string, unknown>): string | null;
export function acquireTicketLock(root?: string, options?: Record<string, unknown>): { path: string; metadata: Record<string, unknown> };
/** The outcome of a release. NEVER throws: release runs from `finally` blocks,
 *  where a throw would replace the real result of an operation that may already
 *  have committed. `released: false` with code LOCK_STRANDED means the lock
 *  directory is still on disk and a human has to remove it. */
export type LockReleaseOutcome =
  | { released: true }
  | { released: false; reason: 'no-lock' | 'not-ours' }
  | { released: false; reason: 'unverifiable' | 'remove-failed'; code: 'LOCK_STRANDED'; path: string; cause?: unknown };
export function releaseTicketLock(lock: unknown, options?: { removeLock?: (path: string, options?: unknown) => void }): LockReleaseOutcome;
export function applyDirectoryTransaction(store: DirectoryTicketStore, tickets: Ticket[], options?: Record<string, unknown>): TicketSnapshot;
export function applyLegacyTransaction(store: LegacyTicketStore, tickets: Ticket[], options?: Record<string, unknown>): TicketSnapshot;
export function recoverDirectoryTransaction(store: LegacyTicketStore | DirectoryTicketStore, transactionId: string, options: { root?: string; direction: 'complete' | 'rollback' }): TicketSnapshot;
export function initializeDirectoryStore(path: string): void;
export function initializeTicketStores(root?: string): Record<string, unknown>;
export function archiveTicket(store: DirectoryTicketStore, archivePath: string, id: string, options?: Record<string, unknown>): { active: TicketSnapshot; archived: Ticket };
export function restoreTicket(store: DirectoryTicketStore, archivePath: string, id: string, options?: Record<string, unknown>): { active: TicketSnapshot; ticket: Ticket };
export function migrationPlan(root?: string): Record<string, unknown>;
export function migrateLegacyStore(root?: string, options?: { write?: boolean; yes?: boolean; requireClean?: boolean; faultInjector?: (step: string, context: unknown) => void }): Record<string, unknown>;
export function recoverMigration(root: string, id: string, options: { direction: 'complete' | 'rollback' }): TicketSnapshot;
export function exportLegacyStore(store: LegacyTicketStore | DirectoryTicketStore, outputPath: string): TicketSnapshot;
export function doctorTicketStore(store: LegacyTicketStore | DirectoryTicketStore, options?: { root?: string; archive?: boolean }): Record<string, unknown>;
export function recordTicketEvidence(root: string, options: Record<string, unknown>): Record<string, unknown>;
export function withManifestLock<T>(path: string, fn: () => T, options?: { retries?: number; delayMs?: number }): T;
export function fsyncFile(path: string): void;
export function fsyncDirectory(path: string): boolean;
export function durableMkdir(path: string): void;
export function durableWrite(path: string, content: string | Uint8Array): void;
export function durableCopy(source: string, target: string): void;
export function durableRename(source: string, target: string): void;
export function durableRemove(path: string, options?: Record<string, unknown>): void;
export function resolveActiveTicket(snapshot: TicketSnapshot, options?: Record<string, unknown>): { id: string; ticket: Readonly<Ticket>; ticketHash: string; storeHash: string } | null;
export function verifyEvidenceBinding(evidence: Record<string, unknown>, snapshot: TicketSnapshot): true;
export function serializePlan(plan: TicketPlan): Record<string, unknown>;
export function asTicketResult<T>(fn: () => T): { ok: true; value: T; warnings: unknown[] } | { ok: false; kind: TicketErrorKind; code: string; message: string; details?: unknown };
export function exitCodeFor(error: { kind?: TicketErrorKind }): 1 | 2;
export function shouldOfferLegacyMigration(store: unknown, flags?: Record<string, unknown>, io?: { input?: { isTTY?: boolean }; output?: { isTTY?: boolean } }): boolean;
export function offerLegacyMigration(store: LegacyTicketStore, root: string, flags?: Record<string, unknown>, dependencies?: Record<string, unknown>): Promise<LegacyTicketStore | DirectoryTicketStore>;

// #235 — manifest-rail hygiene
export const MANIFEST_BASENAMES: readonly string[];
export function discoverManifests(root?: string): string[];
export function coversManifest(glob: unknown, manifestPaths: readonly string[]): boolean;
export function manifestCoveringRails(rails: unknown, manifestPaths: readonly string[]): string[];

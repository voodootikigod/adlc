export type Ticket = { id: string; title: string; scope?: string[]; rails?: string[]; edges?: Array<{ to: string; [key: string]: unknown }>; [key: string]: unknown };
export type TicketErrorKind = 'operational' | 'invalid' | 'conflict' | 'policy';
export class TicketStoreError extends Error { kind: TicketErrorKind; code: string; details?: unknown }
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
export function generateTicketId(now?: number, entropy?: Buffer): string;
export function isGeneratedTicketId(id: string): boolean;
export function validateTicket(ticket: unknown, options?: { archive?: boolean }): string[];
export function validateTickets(tickets: unknown[], options?: { archive?: boolean; validateGraph?: boolean }): unknown[];
export function detectTicketStore(options?: Record<string, unknown>): LegacyTicketStore | DirectoryTicketStore;
export function loadTicketSnapshot(options?: Record<string, unknown>): TicketSnapshot;
export function pendingTransactions(root?: string): string[];
export function resolveStoreOverride(options?: Record<string, unknown>): string | null;
export function acquireTicketLock(root?: string, options?: Record<string, unknown>): { path: string; metadata: Record<string, unknown> };
export function releaseTicketLock(lock: unknown): void;
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
export function durableWrite(path: string, content: string | Buffer): void;
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

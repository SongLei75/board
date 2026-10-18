/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import { setIdentity } from './identity.js';
import { BoardSession, sessionActivity } from './session.js';
import { BoardAddError, createProviders, type AvailableBoard, type BoardLease, type BoardProvider, type ProviderInfo } from './provider.js';
import type { OpenOptions } from './types.js';

/** Public metadata never includes SSH credentials or a provider's private handle. */
export interface ManagedBoard {
	id: string;
	name: string;
	providerId: string;
	lease: BoardLease | null;
}

export interface BoardManagerOptions {
	idleMs?: number;
	renewAheadMs?: number;
}

export interface BoardEvent extends ManagedBoard {
	type: 'added' | 'renewed' | 'renewFailed' | 'released' | 'releaseFailed' | 'expired';
	error?: Error;
}

export interface BoardState extends ManagedBoard {
	remainingMs: number | null;
	sessions: number;
	available: boolean;
	error?: Error;
}

interface BoardEntry {
	board: ManagedBoard;
	provider: BoardProvider;
	handle: unknown;
	connection?: OpenOptions;
	key?: string;
	sessions: Set<BoardSession>;
	opening: Set<Promise<BoardSession>>;
	retiring: boolean;
	pending: Promise<void>;
	lastActivityAt: number;
	activeOperations: number;
	timer?: ReturnType<typeof setTimeout>;
	nextRenewAt: number;
	renewing?: Promise<void>;
	error?: Error;
	terminal?: Promise<void>;
}

/** Owns resource lifetime and independent SSH sessions, never a consumer's current board. */
export class BoardManager {
	private readonly providers = new Map<string, BoardProvider>();
	private readonly boards = new Map<string, BoardEntry>();
	private readonly acquisitions = new Map<string, Promise<ManagedBoard>>();
	private readonly listeners = new Set<(event: BoardEvent) => void>();
	private readonly idleMs: number;
	private readonly renewAheadMs: number;

	constructor(options: BoardManagerOptions = {}) {
		this.idleMs = options.idleMs ?? 600_000;
		this.renewAheadMs = options.renewAheadMs ?? 600_000;
		for (const value of [this.idleMs, this.renewAheadMs]) {
			if (!Number.isFinite(value) || value <= 0) throw new RangeError('Lifecycle timing must be positive and finite');
		}
		for (const provider of createProviders()) {
			if (!provider.id || !provider.displayName || this.providers.has(provider.id)) {
				throw new Error('Providers require a display name and a unique, non-empty ID');
			}
			this.providers.set(provider.id, provider);
		}
	}

	getProviders(): ProviderInfo[] {
		return [...this.providers.values()].map(provider => ({
			id: provider.id, displayName: provider.displayName,
		}));
	}

	private getProvider(id: string): BoardProvider {
		const provider = this.providers.get(id);
		if (!provider) throw new Error(`Unknown board provider: ${id}`);
		return provider;
	}

	/** Synchronous notifications; listener errors cannot interrupt cleanup. */
	onDidChange(listener: (event: BoardEvent) => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	private notify(entry: BoardEntry, type: BoardEvent['type'], error?: Error): void {
		for (const listener of this.listeners) {
			try { listener({ ...structuredClone(entry.board), type, ...(error ? { error } : {}) }); } catch { /* Consumer isolation. */ }
		}
	}

	/** Authentication belongs to the provider; providers without login need no action. */
	async login(providerId: string, input?: unknown): Promise<void> {
		await this.getProvider(providerId).login?.(input);
	}

	/** Queries candidates without logging in; providers without a catalog return []. */
	async listAvailableBoards(providerId: string): Promise<AvailableBoard[]> {
		const provider = this.getProvider(providerId);
		return await provider.listAvailableBoards?.() ?? [];
	}

	/** Override the shared identity for future connections across managers. */
	setIdentity(pem: Buffer | string): Promise<void> {
		return setIdentity(pem);
	}

	/** Routes input unchanged to its provider; never establishes SSH. */
	async addBoard(providerId: string, input: unknown): Promise<ManagedBoard> {
		const provider = this.getProvider(providerId);
		const resourceKey = provider.getBoardKey?.(input);
		const key = resourceKey === undefined ? undefined : JSON.stringify([provider.id, resourceKey]);
		if (key !== undefined) {
			const existing = [...this.boards.values()].find(entry => entry.key === key);
			if (existing) {
				this.requireAvailable(existing);
				return structuredClone(existing.board);
			}
			const pending = this.acquisitions.get(key);
			if (pending) return structuredClone(await pending);
		}
		const adding = this.acquire(provider, input, key);
		if (key !== undefined) this.acquisitions.set(key, adding);
		try {
			return structuredClone(await adding);
		} finally {
			if (key !== undefined) this.acquisitions.delete(key);
		}
	}

	private newEntry(provider: BoardProvider, handle: unknown, key?: string): BoardEntry {
		return {
			board: { id: randomUUID(), name: provider.displayName, providerId: provider.id, lease: null },
			provider, handle, key,
			sessions: new Set(), opening: new Set(), retiring: false, pending: Promise.resolve(),
			lastActivityAt: Date.now(), activeOperations: 0, nextRenewAt: Infinity,
		};
	}

	private async acquire(provider: BoardProvider, input: unknown, key?: string): Promise<ManagedBoard> {
		let entry: BoardEntry;
		try {
			const result = await provider.addBoard(input);
			entry = this.newEntry(provider, result.handle, key);
			try {
				if (typeof result.name !== 'string' || !result.name.trim()) throw new TypeError('Provider returned no board name');
				const lease = result.lease ?? null;
				if (lease !== null && (!Number.isFinite(lease.expiresAt) || lease.expiresAt <= Date.now())) {
					throw new RangeError('Provider returned an invalid lease');
				}
				entry.board.name = result.name;
				entry.board.lease = structuredClone(lease);
				entry.connection = structuredClone(result.connection);
				entry.nextRenewAt = lease === null ? Infinity : lease.expiresAt - this.renewAheadMs;
			} catch (error) {
				await this.compensate(entry, error);
				throw error;
			}
		} catch (error) {
			if (error instanceof BoardAddError) {
				entry = this.newEntry(provider, error.handle, key);
				// The internal transfer error carries a private handle; never expose it.
				const failure = new AggregateError(error.errors, `${error.message}; retry removeBoard('${entry.board.id}')`);
				this.retainCleanup(entry, failure);
				throw failure;
			}
			throw error;
		}
		this.boards.set(entry.board.id, entry);
		this.schedule(entry);
		this.notify(entry, 'added');
		return structuredClone(entry.board);
	}

	private retainCleanup(entry: BoardEntry, error: unknown): void {
		entry.retiring = true;
		entry.error = error instanceof Error ? error : new Error(String(error));
		this.boards.set(entry.board.id, entry);
		this.notify(entry, 'releaseFailed', entry.error);
	}

	private async compensate(entry: BoardEntry, cause: unknown): Promise<void> {
		try {
			await entry.provider.releaseBoard?.(entry.handle);
		} catch (error) {
			const failure = new AggregateError([cause, error], `Board acquisition cleanup failed; retry removeBoard('${entry.board.id}')`);
			this.retainCleanup(entry, failure);
			throw failure;
		}
	}

	getBoard(id: string): ManagedBoard | undefined {
		const board = this.boards.get(id)?.board;
		return board && structuredClone(board);
	}

	private requireBoard(id: string): BoardEntry {
		const entry = this.boards.get(id);
		if (!entry) throw new Error(`Unknown managed board: ${id}`);
		return entry;
	}

	private requireAvailable(entry: BoardEntry): void {
		if (this.boards.get(entry.board.id) !== entry || entry.retiring || !entry.connection ||
			(entry.board.lease !== null && entry.board.lease.expiresAt <= Date.now())) {
			throw new Error(`Managed board is not available: ${entry.board.name}`);
		}
	}

	// Serialize provider operations per board, not SSH opens or unrelated boards.
	private run<T>(entry: BoardEntry, operation: () => Promise<T>): Promise<T> {
		const result = entry.pending.then(operation);
		entry.pending = result.then(() => {}, () => {});
		return result;
	}

	private activity(entry: BoardEntry, event: 'start' | 'end' | 'read'): void {
		if (event === 'end') entry.activeOperations--;
		else if (event === 'start') this.requireAvailable(entry);
		if (this.boards.get(entry.board.id) !== entry || entry.retiring) return;
		if (event === 'start') entry.activeOperations++;
		entry.lastActivityAt = Date.now();
		this.schedule(entry);
	}

	/** Every call creates a separate SSH connection and persistent shell. */
	async openBoard(id: string): Promise<BoardSession> {
		const entry = this.requireBoard(id);
		this.requireAvailable(entry);
		const opening = (async () => {
			const session = await BoardSession.open(entry.connection!);
			try {
				this.requireAvailable(entry);
				if (session.isClosed) throw new Error('BoardSession closed during open');
			} catch (error) {
				await session.close();
				throw error;
			}
			entry.sessions.add(session);
			session[sessionActivity] = event => this.activity(entry, event);
			entry.lastActivityAt = Date.now();
			return session;
		})();
		entry.opening.add(opening);
		this.schedule(entry);
		void opening.finally(() => {
			entry.opening.delete(opening);
			this.schedule(entry);
		}).catch(() => {});
		return opening;
	}

	private async closeAll(entry: BoardEntry): Promise<void> {
		// Close established sessions immediately; a slow SSH handshake must not keep existing shells alive.
		const closing = Promise.allSettled([...entry.sessions].map(session => session.close()));
		await Promise.allSettled([...entry.opening]);
		const outcomes = await closing;
		for (const session of entry.sessions) {
			if (session.isClosed) entry.sessions.delete(session);
		}
		const errors = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
		if (errors.length) throw new AggregateError(errors, 'Failed to close board sessions');
	}

	/** Closes ALL sessions for this board, including handles held by other consumers. */
	removeBoard(id: string): Promise<void> {
		return this.finish(this.requireBoard(id), 'released');
	}

	private finish(entry: BoardEntry, reason: 'released' | 'expired'): Promise<void> {
		if (entry.terminal) return entry.terminal;
		entry.retiring = true;
		clearTimeout(entry.timer);
		const result = (async () => {
			try {
				// Close immediately; provider release waits for any outstanding renewal.
				await this.closeAll(entry);
				await this.run(entry, async () => { await entry.provider.releaseBoard?.(entry.handle); });
				this.boards.delete(entry.board.id);
				this.notify(entry, reason);
			} catch (cause) {
				entry.error = cause instanceof Error ? cause : new Error(String(cause));
				this.notify(entry, 'releaseFailed', entry.error);
				throw entry.error;
			}
		})();
		entry.terminal = result;
		void result.finally(() => { entry.terminal = undefined; this.schedule(entry); }).catch(() => { });
		return result;
	}

	/** Manager chooses when; each provider chooses its supported minimum extension. */
	private renew(entry: BoardEntry): Promise<void> {
		if (entry.renewing) return entry.renewing;
		entry.nextRenewAt = Infinity; // One attempt per lease, never a tight failure retry loop.
		const result = this.run(entry, async () => {
			if (entry.retiring || this.isIdle(entry)) return;
			this.requireAvailable(entry);
			try {
				const expiresAt = await entry.provider.renewBoard!(entry.handle);
				if (!Number.isFinite(expiresAt) || expiresAt <= Math.max(Date.now(), entry.board.lease!.expiresAt)) {
					throw new Error('Renewal must extend the expiration');
				}
				// Provider retains the remote result for cleanup even when this board is retiring.
				this.requireAvailable(entry);
				entry.board.lease = { expiresAt };
				entry.error = undefined;
				entry.nextRenewAt = expiresAt - Math.min(this.renewAheadMs, (expiresAt - Date.now()) / 2);
				this.notify(entry, 'renewed');
			} catch (cause) {
				const error = cause instanceof Error ? cause : new Error(String(cause));
				if (!entry.retiring) {
					entry.error = error;
					this.notify(entry, 'renewFailed', error);
				}
				throw error;
			}
		});
		entry.renewing = result;
		void result.finally(() => { entry.renewing = undefined; this.schedule(entry); }).catch(() => { });
		return result;
	}

	private isIdle(entry: BoardEntry): boolean {
		return !entry.activeOperations && !entry.opening.size && entry.lastActivityAt + this.idleMs <= Date.now();
	}

	private schedule(entry: BoardEntry): void {
		clearTimeout(entry.timer);
		if (entry.retiring || this.boards.get(entry.board.id) !== entry) return;
		let deadline = entry.board.lease?.expiresAt ?? Infinity;
		// Idle reclamation is a provider capability, independent of lease presence.
		if (entry.provider.releaseBoard && !entry.activeOperations && !entry.opening.size) {
			deadline = Math.min(deadline, entry.lastActivityAt + this.idleMs);
		}
		if (entry.board.lease !== null && entry.provider.renewBoard && !this.isIdle(entry)) {
			deadline = Math.min(deadline, entry.nextRenewAt);
		}
		if (deadline === Infinity) return;
		entry.timer = setTimeout(() => this.evaluate(entry), Math.max(1, Math.min(2_147_483_647, deadline - Date.now())));
		entry.timer.unref();
	}

	private evaluate(entry: BoardEntry): void {
		if (entry.retiring || this.boards.get(entry.board.id) !== entry) return;
		if (entry.board.lease !== null && entry.board.lease.expiresAt <= Date.now()) {
			void this.finish(entry, 'expired').catch(() => { });
		} else if (entry.provider.releaseBoard && this.isIdle(entry)) {
			void this.finish(entry, 'released').catch(() => { });
		} else if (entry.board.lease !== null && entry.provider.renewBoard && !this.isIdle(entry) && entry.nextRenewAt <= Date.now()) {
			void this.renew(entry).catch(() => { });
		}
		this.schedule(entry);
	}

	/** Current managed resources; lifecycle scheduling does not depend on polling. */
	listManagedBoards(providerId?: string): BoardState[] {
		const now = Date.now();
		const entries = [...this.boards.values()].filter(entry => providerId === undefined || entry.board.providerId === providerId);
		return entries.map(({ board, sessions, retiring, error }) => {
			for (const session of sessions) {
				if (session.isClosed) sessions.delete(session);
			}
			return {
				...structuredClone(board), remainingMs: board.lease === null ? null : board.lease.expiresAt - now,
				sessions: sessions.size,
				available: !retiring && (board.lease === null || board.lease.expiresAt > now),
				...(error ? { error } : {}),
			};
		});
	}
}

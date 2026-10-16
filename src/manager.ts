/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BoardSession, sessionActivity } from './session.js';
import type { OpenOptions } from './types.js';

export interface ManagedBoard {
	id: string;
	name: string;
	connection: OpenOptions;
	expiresAt: number | null;
}

export interface BoardLifecycle {
	renew?: (minutes: number) => Promise<number>;
	release?: () => Promise<void>;
}

export interface BoardManagerOptions {
	idleMs?: number;
	renewMinutes?: number;
	renewAheadMs?: number;
}

export interface BoardEvent {
	type: 'renewed' | 'renewFailed' | 'released' | 'releaseFailed' | 'expired';
	id: string;
	name: string;
	expiresAt: number | null;
	error?: Error;
}

export interface BoardSnapshot {
	boards: Array<{
		id: string;
		name: string;
		expiresAt: number | null;
		remainingMs: number | null;
		sessions: number;
		available: boolean;
		error?: Error;
	}>;
	removedExpired: Array<{ id: string; name: string }>;
}

interface BoardEntry {
	board: ManagedBoard;
	lifecycle: BoardLifecycle;
	sessions: Set<BoardSession>;
	opening: Set<Promise<BoardSession>>;
	retiring: boolean;
	pending: Promise<void>;
	lastActivityAt: number;
	activeOperations: number;
	timer?: ReturnType<typeof setTimeout>;
	nextRenewAt: number;
	error?: Error;
	terminal?: Promise<void>;
}

/** Manages board resources and their independent SSH sessions, not a host UI's current conversation. */
export class BoardManager {
	private readonly boards = new Map<string, BoardEntry>();
	private readonly owners = new WeakMap<BoardSession, BoardEntry>();
	private readonly listeners = new Set<(event: BoardEvent) => void>();
	private readonly options: Required<BoardManagerOptions>;
	private disposed = false;

	constructor(options: BoardManagerOptions = {}) {
		this.options = { idleMs: 600_000, renewMinutes: 60, renewAheadMs: 300_000, ...options };
		for (const value of Object.values(this.options)) {
			if (!Number.isFinite(value) || value <= 0) throw new RangeError('Lifecycle timing must be positive and finite');
		}
	}

	/** Synchronous notifications; listener errors are isolated from resource cleanup. */
	onDidChange(listener: (event: BoardEvent) => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	private notify(entry: BoardEntry, type: BoardEvent['type'], error?: Error): void {
		const { id, name, expiresAt } = entry.board;
		for (const listener of this.listeners) {
			try { listener({ type, id, name, expiresAt, ...(error ? { error } : {}) }); } catch { /* Host UI must not interrupt cleanup. */ }
		}
	}

	addBoard(board: ManagedBoard, lifecycle: BoardLifecycle = {}): void {
		if (this.disposed) throw new Error('BoardManager is disposed');
		if (!board.id || !board.name || this.boards.has(board.id)) {
			throw new Error('A managed board requires a name and a unique, non-empty ID');
		}
		if (board.expiresAt !== null && !Number.isFinite(board.expiresAt)) {
			throw new RangeError('Board expiration must be an absolute timestamp or null');
		}
		const entry: BoardEntry = {
			board: structuredClone(board),
			lifecycle: { ...lifecycle },
			sessions: new Set(),
			opening: new Set(),
			retiring: false,
			pending: Promise.resolve(),
			lastActivityAt: Date.now(), activeOperations: 0,
			nextRenewAt: board.expiresAt === null ? Infinity : board.expiresAt - this.options.renewAheadMs,
		};
		this.boards.set(board.id, entry);
		this.schedule(entry);
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
		if (this.disposed || this.boards.get(entry.board.id) !== entry || entry.retiring ||
			(entry.board.expiresAt !== null && entry.board.expiresAt <= Date.now())) {
			throw new Error(`Managed board is not available: ${entry.board.name}`);
		}
	}

	// Serialize remote lifecycle calls per board, never SSH opens or unrelated boards.
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

	/** Every call creates a separate SSH connection and persistent shell, even for the same board. */
	async openBoard(id: string): Promise<BoardSession> {
		const entry = this.requireBoard(id);
		this.requireAvailable(entry);
		const opening = (async () => {
			const session = await BoardSession.open(entry.board.connection);
			try {
				this.requireAvailable(entry);
				if (session.isClosed) throw new Error('BoardSession closed during open');
			} catch (error) {
				await session.close();
				throw error;
			}
			entry.sessions.add(session);
			this.owners.set(session, entry);
			session[sessionActivity] = event => this.activity(entry, event);
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

	/** Closes only this session. Other sessions and the board's reservation remain intact. */
	async closeSession(session: BoardSession): Promise<void> {
		const entry = this.owners.get(session);
		if (!entry) throw new Error('Session is not owned by this BoardManager');
		try {
			await session.close();
		} finally {
			entry.sessions.delete(session);
		}
	}

	private async closeAll(entry: BoardEntry): Promise<void> {
		await Promise.allSettled([...entry.opening]);
		const outcomes = await Promise.allSettled([...entry.sessions].map(session => session.close()));
		for (const session of entry.sessions) {
			if (session.isClosed) entry.sessions.delete(session);
		}
		const failed = outcomes.find(outcome => outcome.status === 'rejected');
		if (failed?.status === 'rejected') throw failed.reason;
	}

	/** Releasing a board closes all of its sessions. Failed releases can be retried explicitly. */
	removeBoard(id: string): Promise<void> {
		return this.finish(this.requireBoard(id), true);
	}

	private finish(entry: BoardEntry, release: boolean): Promise<void> {
		if (entry.terminal) return entry.terminal;
		entry.retiring = true;
		clearTimeout(entry.timer);
		const result = (async () => {
			try {
				// Close locally without waiting for an outstanding provider request.
				await this.closeAll(entry);
				if (release) await this.run(entry, async () => { await entry.lifecycle.release?.(); });
				this.boards.delete(entry.board.id);
				this.notify(entry, release ? 'released' : 'expired');
			} catch (cause) {
				entry.error = cause instanceof Error ? cause : new Error(String(cause));
				this.notify(entry, release ? 'releaseFailed' : 'expired', entry.error);
				throw entry.error;
			}
		})();
		entry.terminal = result;
		void result.finally(() => { entry.terminal = undefined; }).catch(() => {});
		return result;
	}

	renewBoard(id: string, minutes: number): Promise<void> {
		const entry = this.requireBoard(id);
		return this.run(entry, async () => {
			this.requireAvailable(entry);
			if (!entry.lifecycle.renew) throw new Error(`Managed board cannot be renewed: ${entry.board.name}`);
			if (!Number.isFinite(minutes) || minutes <= 0) throw new RangeError('Invalid renewal duration');
			entry.nextRenewAt = Infinity;
			this.schedule(entry);
			try {
				const expiresAt = await entry.lifecycle.renew(minutes);
				if (!Number.isFinite(expiresAt) || expiresAt <= Math.max(Date.now(), entry.board.expiresAt ?? 0)) {
					throw new Error('Renewal must extend the expiration');
				}
				// A late network result cannot revive an expired or releasing reservation.
				this.requireAvailable(entry);
				entry.board.expiresAt = expiresAt;
				entry.error = undefined;
				// A short extension is checked halfway through its remaining lifetime.
				entry.nextRenewAt = expiresAt - Math.min(this.options.renewAheadMs, (expiresAt - Date.now()) / 2);
				this.notify(entry, 'renewed');
			} catch (cause) {
				const error = cause instanceof Error ? cause : new Error(String(cause));
				if (!entry.retiring) {
					entry.error = error;
					this.notify(entry, 'renewFailed', error);
				}
				throw error;
			} finally {
				this.schedule(entry);
			}
		});
	}

	private isIdle(entry: BoardEntry): boolean {
		return !entry.activeOperations && !entry.opening.size && entry.lastActivityAt + this.options.idleMs <= Date.now();
	}

	private schedule(entry: BoardEntry): void {
		clearTimeout(entry.timer);
		if (this.disposed || entry.retiring || this.boards.get(entry.board.id) !== entry) return;
		let deadline = entry.board.expiresAt ?? Infinity;
		if (entry.lifecycle.release && !entry.activeOperations && !entry.opening.size) {
			deadline = Math.min(deadline, entry.lastActivityAt + this.options.idleMs);
		}
		if (entry.lifecycle.renew && !this.isIdle(entry)) deadline = Math.min(deadline, entry.nextRenewAt);
		if (deadline === Infinity) return;
		entry.timer = setTimeout(() => this.evaluate(entry), Math.max(1, Math.min(2_147_483_647, deadline - Date.now())));
		entry.timer.unref();
	}

	private evaluate(entry: BoardEntry): void {
		if (this.disposed || entry.retiring || this.boards.get(entry.board.id) !== entry) return;
		if (entry.board.expiresAt !== null && entry.board.expiresAt <= Date.now()) {
			void this.finish(entry, false).catch(() => {});
		} else if (this.isIdle(entry)) {
			if (entry.lifecycle.release) void this.finish(entry, true).catch(() => {});
		} else if (entry.lifecycle.renew && entry.nextRenewAt <= Date.now()) {
			entry.nextRenewAt = Infinity; // One attempt until success schedules the next lease; no automatic failure retry.
			void this.renewBoard(entry.board.id, this.options.renewMinutes).catch(() => {});
		}
		this.schedule(entry);
	}

	/** Current snapshot; removedExpired includes only resources expired by this refresh. */
	async refresh(): Promise<BoardSnapshot> {
		const removedExpired: BoardSnapshot['removedExpired'] = [];
		await Promise.all([...this.boards.values()].map(async entry => {
			if (!entry.retiring && entry.board.expiresAt !== null && entry.board.expiresAt <= Date.now()) {
				await this.finish(entry, false);
				removedExpired.push({ id: entry.board.id, name: entry.board.name });
			}
			for (const session of entry.sessions) {
				if (session.isClosed) entry.sessions.delete(session);
			}
		}));
		const now = Date.now();
		return {
			boards: [...this.boards.values()].map(({ board, sessions, retiring, error }) => ({
				id: board.id, name: board.name, expiresAt: board.expiresAt,
				remainingMs: board.expiresAt === null ? null : board.expiresAt - now,
				sessions: [...sessions].filter(session => !session.isClosed).length,
				available: !retiring && (board.expiresAt === null || board.expiresAt > now),
				...(error ? { error } : {}),
			})),
			removedExpired,
		};
	}

	/** Stops scheduling, closes sessions and releases reservations; failures remain retryable via removeBoard. */
	async dispose(): Promise<void> {
		this.disposed = true;
		const outcomes = await Promise.allSettled([...this.boards.keys()].map(id => this.removeBoard(id)));
		this.listeners.clear();
		const errors = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
		if (errors.length) throw new AggregateError(errors, 'Failed to dispose managed boards');
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OpenOptions } from './types.js';
import { BoardAddError, registerProvider, type AvailableBoard, type BoardProvider, type ProviderBoard } from './provider.js';

const minimumMinutes = 60;

interface BatonBoard {
	b_id: string;
	device_code: string;
	type: number;
	server: { b_id: string; ip_addr: string };
	sub_boards?: { b_id: string; ip_addr: string }[];
	default_reservation_docker_image?: string;
	reservations?: BatonReservation[];
}

interface BatonReservation {
	b_id: string;
	board_b_id: string;
	start_at: string;
	end_at: string;
	/** True once the reservation was released before its scheduled end. */
	early_released?: boolean;
	board?: BatonBoard;
}

interface PortMapping { name: string; port: number }
interface BoardType { val: number; params?: { use_docker_host_network?: boolean } }
interface ApiResponse<T> { code?: number; data?: T; message?: string; msg?: string }

// Keep the Baton request timestamp shape used by the existing BenchOps integration.
function formatApiDate(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	const offset = -date.getTimezoneOffset();
	const sign = offset >= 0 ? '+' : '-';
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

/** HTTP or application error. Failed queries are never represented as empty lists. */
class BatonApiError extends Error {
	constructor(message: string, readonly code: number) {
		super(message);
		this.name = 'BatonApiError';
	}
}

/** Internal BenchOps HTTP client. Credentials live only in this provider instance. */
class BatonClient {
	readonly apiUrl: string;
	readonly authUrl: string;
	private token?: string;

	constructor() {
		let config: { boardops_api_url?: string; baton_auth_url?: string } = {};
		try {
			config = JSON.parse(readFileSync(join(homedir(), '.benchops', 'config.json'), 'utf8'));
		} catch { /* Optional local configuration. */ }
		this.apiUrl = (process.env.BENCHOPS_API_URL || config.boardops_api_url || 'https://board.carizon.work').replace(/\/$/, '');
		this.authUrl = (process.env.BATON_AUTH_URL || config.baton_auth_url || 'https://auth.carizon.work').replace(/\/$/, '');
	}

	private async request<T>(path: string, method = 'GET', body?: object, auth = false): Promise<T | undefined> {
		if (!auth && !this.token) { throw new BatonApiError('Baton authentication required', 401); }
		const response = await fetch(`${auth ? this.authUrl : this.apiUrl}${path}`, {
			method,
			headers: {
				...(!auth ? { Authorization: `Bearer ${this.token}` } : {}),
				...(body ? { 'Content-Type': 'application/json' } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(30_000),
		});
		const text = await response.text();
		let result: ApiResponse<T> = {};
		if (text) {
			try { result = JSON.parse(text) as ApiResponse<T>; }
			catch { throw new BatonApiError(`Baton returned invalid JSON (HTTP ${response.status})`, response.status); }
		}
		if (!response.ok || (result.code !== undefined && result.code !== 0 && result.code !== 200)) {
			const code = !response.ok ? response.status : result.code!;
			throw new BatonApiError(result.message || result.msg || `Baton request failed (${code})`, code);
		}
		return result.data;
	}

	async validateToken(): Promise<boolean> {
		if (!this.token) { return false; }
		try {
			await this.getBoardTypes();
			return true;
		} catch (error) {
			if (error instanceof BatonApiError && (error.code === 401 || error.code === 403)) {
				this.token = undefined;
				return false;
			}
			throw error;
		}
	}

	async login(username: string, password: string): Promise<void> {
		const data = await this.request<{ jwt_token?: string; token?: string }>(
			'/api/system/sso/login', 'POST', { username, password }, true);
		const token = data?.jwt_token || data?.token;
		if (!token) { throw new Error('Baton login returned no token'); }
		this.token = token;
	}

	async listAvailableBoards(): Promise<BatonBoard[]> {
		const data = await this.request<{ items?: BatonBoard[] }>('/api/boardops/v1/board/reservable/me/query', 'POST', { board_status: 1 });
		const now = Date.now();
		// An early-released reservation keeps its original window but no longer occupies the board.
		return (data?.items ?? []).filter(board => !!board.server?.ip_addr && !board.reservations?.some(
			reservation => !reservation.early_released && Date.parse(reservation.start_at) <= now && now < Date.parse(reservation.end_at)));
	}

	/** Board-type sys-dict. The API may return a bare list or wrap it in `{ items }`. */
	private async getBoardTypes(): Promise<BoardType[]> {
		const data = await this.request<BoardType[] | { items?: BoardType[] }>('/api/boardops/v1/sys-dict?type=board_type');
		return Array.isArray(data) ? data : data?.items ?? [];
	}

	private async getDefaultPorts(boardId: string): Promise<PortMapping[]> {
		const data = await this.request<PortMapping[] | { items?: PortMapping[] }>(`/api/boardops/v1/board/${encodeURIComponent(boardId)}/default-host-port`);
		return Array.isArray(data) ? data : data?.items ?? [];
	}

	async reserve(board: BatonBoard): Promise<BatonReservation> {
		const start = new Date();
		const body: {
			board_b_id: string; start_at: string; end_at: string; server_reserved: boolean;
			docker_image?: string;
			container_port_mappings?: { name: string; container_port: string; host_port: string; protocol: string }[];
		} = {
			board_b_id: board.b_id, start_at: formatApiDate(start),
			end_at: formatApiDate(new Date(start.getTime() + minimumMinutes * 60_000)), server_reserved: false,
		};
		if (board.default_reservation_docker_image) { body.docker_image = board.default_reservation_docker_image; }
		const types = await this.getBoardTypes();
		if (!types.find(type => type.val === board.type)?.params?.use_docker_host_network) {
			const ports = await this.getDefaultPorts(board.b_id);
			const defaults: Record<string, number> = { ssh: 22, 'perfetto-web': 1 };
			const mappings = ports.filter(port => Object.hasOwn(defaults, port.name)).map(port => ({
				name: port.name, container_port: String(defaults[port.name]), host_port: String(port.port), protocol: 'tcp',
			}));
			if (mappings.length) { body.container_port_mappings = mappings; }
		}
		const reservation = await this.request<BatonReservation>('/api/boardops/v1/reservation', 'POST', body);
		if (!reservation?.b_id) { throw new Error('Baton returned no reservation ID'); }
		return reservation;
	}

	/** Extend an existing reservation and return its new absolute expiration. */
	async renew(reservationId: string): Promise<number> {
		const end = await this.request<string | { end_at?: string } | undefined>(
			`/api/boardops/v1/reservation/${encodeURIComponent(reservationId)}/extend`, 'PATCH', { extension_minutes: minimumMinutes });
		const raw = typeof end === 'string' ? end : end?.end_at;
		const expiresAt = raw ? Date.parse(raw) : NaN;
		if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) { throw new Error('Baton returned an invalid reservation end time'); }
		return expiresAt;
	}

	/** Release an existing reservation. Natural expiration does not call this API. */
	async release(reservationId: string): Promise<void> {
		await this.request(`/api/boardops/v1/reservation/${encodeURIComponent(reservationId)}/release`, 'POST');
	}

	async resolveConnection(reservation: BatonReservation, selected: BatonBoard): Promise<OpenOptions> {
		if (reservation.board_b_id !== selected.b_id) { throw new Error('Baton reservation board does not match selection'); }
		const board = reservation.board ?? selected;
		const host = board.sub_boards?.[0]?.ip_addr;
		if (!host || !board.server?.ip_addr) {
			throw new Error(`Reservation ${reservation.b_id} exists but has no board/server IP; cannot resolve the X.509 target`);
		}
		const ports = await this.getDefaultPorts(board.b_id);
		const port = ports.find(mapping => mapping.name === 'ssh')?.port ?? 22;
		if (!Number.isInteger(port) || port < 1 || port > 65535) { throw new Error('Baton returned an invalid SSH host port'); }
		return {
			board: { host, username: 'root', port: 22 },
			jumps: [{ host: board.server.ip_addr, port, username: 'root', password: '123456' }],
		};
	}

}

export interface BatonCredentials {
	username: string;
	password: string;
}

export interface BatonBoardInput {
	boardId: string;
}

interface BatonHandle {
	reservationId: string;
	expiresAt: number;
	renewalUncertain?: boolean;
}

/** Adapts Baton operations; only BoardManager decides when to renew or release. */
class BatonProvider implements BoardProvider<BatonBoardInput, BatonHandle, BatonCredentials> {
	readonly id = 'baton';
	readonly displayName = 'Baton';
	private readonly client = new BatonClient();
	private authenticating?: Promise<void>;

	private readonly candidates = new Map<string, BatonBoard>();

	private async authenticate(input?: BatonCredentials): Promise<void> {
		if (!await this.client.validateToken()) {
			this.candidates.clear();
			if (!input || typeof input.username !== 'string' || !input.username.trim() ||
				typeof input.password !== 'string' || !input.password) {
				throw new TypeError('Baton authentication requires a username and password');
			}
			await this.client.login(input.username, input.password);
		}
	}

	async login(input?: BatonCredentials): Promise<void> {
		// Concurrent login calls share one authentication.
		const authentication = this.authenticating ??= this.authenticate(input);
		try {
			await authentication;
		} finally {
			if (this.authenticating === authentication) this.authenticating = undefined;
		}
	}

	async listAvailableBoards(): Promise<AvailableBoard[]> {
		const boards = await this.client.listAvailableBoards();
		this.candidates.clear();
		for (const board of boards) this.candidates.set(board.b_id, board);
		return boards.map(board => ({ id: board.b_id, name: board.device_code }));
	}

	getBoardKey(input: BatonBoardInput): string {
		if (!input || typeof input.boardId !== 'string' || !input.boardId.trim()) {
			throw new TypeError('Select a valid Baton board ID');
		}
		return `${this.client.apiUrl}:${input.boardId}`;
	}

	async addBoard(input: BatonBoardInput): Promise<ProviderBoard<BatonHandle>> {
		this.getBoardKey(input);
		const board = this.candidates.get(input.boardId);
		if (!board || typeof board.device_code !== 'string' || !board.device_code.trim() || !Number.isInteger(board.type)) {
			throw new Error('Select a board from the latest Baton available-board list');
		}
		const reservation = await this.client.reserve(board);
		const handle: BatonHandle = { reservationId: reservation.b_id, expiresAt: Date.parse(reservation.end_at) };
		try {
			const connection = await this.client.resolveConnection(reservation, board);
			if (!Number.isFinite(handle.expiresAt) || handle.expiresAt <= Date.now()) {
				throw new Error('Baton returned an invalid reservation expiration');
			}
			return { name: board.device_code, connection, lease: { expiresAt: handle.expiresAt }, handle };
		} catch (error) {
			try { await this.releaseBoard(handle); }
			catch (releaseError) {
				throw new BoardAddError(handle, [error, releaseError], `Could not resolve or release Baton reservation ${reservation.b_id}`);
			}
			throw error;
		}
	}

	async renewBoard(handle: BatonHandle): Promise<number> {
		// A timeout cannot prove the platform did not extend the reservation.
		handle.renewalUncertain = true;
		const expiresAt = await this.client.renew(handle.reservationId);
		if (!Number.isFinite(expiresAt) || expiresAt <= Math.max(Date.now(), handle.expiresAt)) {
			throw new Error('Baton returned a renewal expiration that does not extend the reservation');
		}
		handle.expiresAt = expiresAt;
		handle.renewalUncertain = false;
		return expiresAt;
	}

	async releaseBoard(handle: BatonHandle): Promise<void> {
		// Skip only confirmed natural expiration, never an uncertain renewal result.
		if (!handle.renewalUncertain && handle.expiresAt <= Date.now()) return;
		await this.client.release(handle.reservationId);
		handle.expiresAt = 0;
		handle.renewalUncertain = false;
	}
}

registerProvider(() => new BatonProvider());

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OpenOptions } from './types.js';

export interface BatonBoard {
	b_id: string;
	device_code: string;
	type: number;
	type_name?: string;
	project_code?: string;
	vehicle_model?: string;
	hardware_platform?: string;
	server: { b_id: string; ip_addr: string };
	sub_boards?: { b_id: string; ip_addr: string }[];
	default_reservation_docker_image?: string;
	reservations?: BatonReservation[];
}

export interface BatonReservation {
	b_id: string;
	board_b_id: string;
	start_at: string;
	end_at: string;
	/** True once the reservation was released before its scheduled end. */
	early_released?: boolean;
	board?: BatonBoard;
}

export interface BatonClientOptions {
	apiUrl?: string;
	authUrl?: string;
	token?: string;
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
export class BatonApiError extends Error {
	constructor(message: string, readonly code: number) {
		super(message);
		this.name = 'BatonApiError';
	}
}

/** UI-independent BenchOps client. The host owns credential persistence and reservation lifetime. */
export class BatonClient {
	readonly apiUrl: string;
	readonly authUrl: string;
	private token?: string;

	constructor(options: BatonClientOptions = {}) {
		let config: { boardops_api_url?: string; baton_auth_url?: string } = {};
		try {
			config = JSON.parse(readFileSync(join(homedir(), '.benchops', 'config.json'), 'utf8'));
		} catch { /* Optional local configuration. */ }
		this.apiUrl = (options.apiUrl || process.env.BENCHOPS_API_URL || config.boardops_api_url || 'https://board.carizon.work').replace(/\/$/, '');
		this.authUrl = (options.authUrl || process.env.BATON_AUTH_URL || config.baton_auth_url || 'https://auth.carizon.work').replace(/\/$/, '');
		this.token = options.token;
	}

	setToken(token: string | undefined): void { this.token = token; }

	listDurations(): readonly { label: string; minutes: number }[] {
		return [1, 2, 4, 8, 24].map(hours => ({ label: `${hours} h`, minutes: hours * 60 }));
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

	async validateToken(token = this.token): Promise<boolean> {
		if (!token) { return false; }
		this.setToken(token);
		try {
			await this.getBoardTypes();
			return true;
		} catch (error) {
			if (error instanceof BatonApiError && (error.code === 401 || error.code === 403)) {
				this.setToken(undefined);
				return false;
			}
			throw error;
		}
	}

	async login(username: string, password: string): Promise<string> {
		const data = await this.request<{ jwt_token?: string; token?: string }>(
			'/api/system/sso/login', 'POST', { username, password }, true);
		const token = data?.jwt_token || data?.token;
		if (!token) { throw new Error('Baton login returned no token'); }
		this.setToken(token);
		return token;
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

	private validateDuration(minutes: number): void {
		if (!this.listDurations().some(duration => duration.minutes === minutes)) {
			throw new RangeError('Select a supported Baton reservation duration');
		}
	}

	async reserve(board: BatonBoard, minutes: number): Promise<BatonReservation> {
		this.validateDuration(minutes);
		const start = new Date();
		const body: {
			board_b_id: string; start_at: string; end_at: string; server_reserved: boolean;
			docker_image?: string;
			container_port_mappings?: { name: string; container_port: string; host_port: string; protocol: string }[];
		} = {
			board_b_id: board.b_id, start_at: formatApiDate(start),
			end_at: formatApiDate(new Date(start.getTime() + minutes * 60_000)), server_reserved: false,
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
	async renew(reservationId: string, minutes: number): Promise<number> {
		this.validateDuration(minutes);
		const end = await this.request<string | { end_at?: string } | undefined>(
			`/api/boardops/v1/reservation/${encodeURIComponent(reservationId)}/extend`, 'PATCH', { extension_minutes: minutes });
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

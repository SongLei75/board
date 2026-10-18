import type { OpenOptions } from './types.js';

export interface BoardLease {
  expiresAt: number;
}

export interface ProviderInfo {
  id: string;
  displayName: string;
}

/** A real candidate returned by a provider, not a managed resource. */
export interface AvailableBoard {
  id: string;
  name: string;
}

export interface ProviderBoard<THandle = unknown> {
  name: string;
  connection: OpenOptions;
  lease?: BoardLease | null;
  handle: THandle;
}

/** Platform operations only. Scheduling and ownership belong to BoardManager. */
export interface BoardProvider<TInput = unknown, THandle = unknown, TLogin = unknown> {
  id: string;
  displayName: string;
  login?(input?: TLogin): Promise<void>;
  listAvailableBoards?(): Promise<AvailableBoard[]>;
  getBoardKey?(input: TInput): string;
  addBoard(input: TInput): Promise<ProviderBoard<THandle>>;
  renewBoard?(handle: THandle): Promise<number>;
  /** Idempotent: an already released or naturally expired resource is considered released. */
  releaseBoard?(handle: THandle): Promise<void>;
}

const providerFactories: Array<() => BoardProvider> = [];

/** Called by provider modules during package initialization. */
export function registerProvider(factory: () => BoardProvider): void {
  providerFactories.push(factory);
}

/** Share registrations, never mutable provider instances, between managers. */
export function createProviders(): BoardProvider[] {
  return providerFactories.map(factory => factory());
}

/** Transfer an unreleased provider handle to BoardManager for cleanup retries. */
export class BoardAddError extends AggregateError {
  constructor(readonly handle: unknown, errors: unknown[], message: string) {
    super(errors, message);
  }
}

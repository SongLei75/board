import { registerProvider } from './provider.js';
import type { BoardProvider, ProviderBoard } from './provider.js';
import type { OpenOptions } from './types.js';

export interface StaticBoardInput extends OpenOptions {
	name?: string;
}

/** Direct and jump-server connections share one provider and the same OpenOptions. */
class StaticProvider implements BoardProvider<StaticBoardInput, undefined> {
	readonly id = 'static';
	readonly displayName = 'Static';

	async addBoard(input: StaticBoardInput): Promise<ProviderBoard<undefined>> {
		if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim())) {
			throw new TypeError('Board name must be non-empty');
		}
		return {
			name: input.name ?? input.board.host,
			connection: structuredClone({ board: input.board, jumps: input.jumps ?? [] }),
			lease: null,
			handle: undefined,
		};
	}
}

registerProvider(() => new StaticProvider());

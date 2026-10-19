// Loading a provider module registers its factory before consumers create a manager.
import './static.js';
import './baton.js';

export { BoardSession } from './session.js';
export type { BoardAddress, JumpAddress, OpenOptions, ExecResult, TerminalOutput } from './types.js';
export type { ProviderInfo, AvailableBoard } from './provider.js';
export { BoardManager } from './manager.js';
export type { ManagedBoard, BoardState, BoardManagerOptions, BoardEvent } from './manager.js';
export type { StaticBoardInput } from './static.js';
export type { BatonCredentials, BatonBoardInput } from './baton.js';

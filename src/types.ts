export interface BoardAddress {
  host: string;
  port?: number;
  username: string;
}

export interface JumpAddress extends BoardAddress {
  privateKeyFile?: string;
  password?: string;
}

export interface OpenOptions {
  board: BoardAddress;
  jumps?: JumpAddress[];
}

export interface TerminalOutput {
  text: string;
}

export interface ExecResult extends TerminalOutput {
  completed: boolean;
  exitCode?: number;
}

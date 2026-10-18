import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { Worker } from 'node:worker_threads';
import { readIdentity, setIdentity } from './identity.js';
import { Transport } from './transport.js';
import type { ExecResult, OpenOptions, TerminalOutput } from './types.js';

// Package-internal hook, attached only after a managed session finishes initialization.
export const sessionActivity = Symbol('sessionActivity');

interface Command {
  token: string;
  started: boolean;
  text: string;
  timer?: ReturnType<typeof setTimeout>;
  resolve?: (result: ExecResult) => void;
  reject?: (error: Error) => void;
}

function validate(options: OpenOptions): void {
  if (!options?.board || (options.jumps !== undefined && !Array.isArray(options.jumps))) {
    throw new TypeError('Expected { board, jumps? }');
  }
  for (const address of [options.board, ...(options.jumps ?? [])]) {
    if (!address || typeof address.host !== 'string' || !address.host.trim() || /[\0\r\n]/.test(address.host) ||
        typeof address.username !== 'string' || !address.username.trim() || /[\0\r\n]/.test(address.username)) {
      throw new TypeError('Every board/jump requires a host and username');
    }
    if (address.port !== undefined && (!Number.isInteger(address.port) || address.port < 1 || address.port > 65535)) {
      throw new RangeError('Port must be an integer from 1 to 65535');
    }
  }
  for (const jump of options.jumps ?? []) {
    if (jump.privateKeyFile !== undefined && (typeof jump.privateKeyFile !== 'string' || !jump.privateKeyFile)) {
      throw new TypeError('Jump privateKeyFile must be a non-empty string');
    }
    if (!jump.privateKeyFile && (typeof jump.password !== 'string' || !jump.password)) {
      throw new TypeError('Each jump requires a password or privateKeyFile');
    }
  }
}

export class BoardSession {
  static setIdentity = setIdentity;
  [sessionActivity]?: (event: 'start' | 'end' | 'read') => void;

  private readonly transport = new Transport(error => this.fail(error));
  private worker?: Worker;
  private closed = false;
  private closing?: Promise<void>;
  private failure?: Error;
  private output = '';
  private fragment = '';
  private readonly decoder = new StringDecoder('utf8');
  private command?: Command;
  private nextWrite = 0;
  private writes = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  private openingReject?: (error: Error) => void;

  private constructor() {}

  static async open(options: OpenOptions): Promise<BoardSession> {
    validate(options);
    const pem = await readIdentity();
    const session = new BoardSession();
    try {
      const endpoint = await session.transport.open(options);
      if (session.closed) throw session.failure ?? new Error('Transport closed during open');
      await session.startWorker(endpoint, options.board.username, pem);
      const ready = await session.exec("stty -echo; PS1=''; PS2=''; unset PROMPT_COMMAND", 30_000);
      if (!ready.completed || ready.exitCode !== 0) throw new Error('Board shell initialization failed');
      session.read(); // Consume login/banner and initialization echo.
      return session;
    } catch (error) {
      await session.close();
      throw error;
    } finally { pem.fill(0); }
  }

  get isClosed(): boolean { return this.closed; }

  private startWorker(endpoint: { host: string; port: number }, username: string, pem: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => this.fail(new Error('Board SSH connection timed out')), 30_000);
      this.openingReject = error => { clearTimeout(timeout); reject(error); };
      const worker = this.worker = new Worker(new URL('./native-worker.js', import.meta.url), {
        workerData: { ...endpoint, username, pem },
        // The VS Code extension host can carry Electron/V8 flags rejected by Node workers.
      execArgv: [],
      });
      worker.on('message', message => {
        if (message.type === 'ready') {
          clearTimeout(timeout);
          this.openingReject = undefined;
          resolve();
        } else if (message.type === 'data') {
          this.accept(this.decoder.write(Buffer.from(message.data)));
        } else if (message.type === 'written') {
          this.writes.get(message.id)?.resolve();
          this.writes.delete(message.id);
        } else if (message.type === 'failure') {
          this.fail(new Error(message.message));
        }
      });
      worker.on('error', error => this.fail(error));
      worker.on('exit', () => {
        this.accept(this.decoder.end());
        this.fail(new Error('Board native session stopped'));
      });
    });
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.failure = error;
    void this.close();
  }

  private ensureOpen(): void {
    if (this.closed) throw this.failure ?? new Error('BoardSession is closed');
  }

  private write(text: string): Promise<void> {
    this.ensureOpen();
    return new Promise((resolve, reject) => {
      const id = ++this.nextWrite;
      this.writes.set(id, { resolve, reject });
      this.worker!.postMessage({ type: 'write', id, data: Buffer.from(text) });
    });
  }

  private appendOutput(text: string): void {
    this.output += text;
    if (this.command?.started) this.command.text += text;
  }

  private consumeCommand(command: Command): string {
    const text = command.text;
    // Command output is the suffix after any older, unread terminal output.
    this.output = this.output.slice(0, this.output.length - text.length);
    command.text = '';
    return text;
  }

  private accept(text: string): void {
    this.fragment += text;
    while (this.fragment) {
      const command = this.command;
      if (!command) {
        this.appendOutput(this.fragment);
        this.fragment = '';
        return;
      }
      const prefix = `\x1e${command.token}:${command.started ? 'END:' : 'BEGIN'}`;
      const index = this.fragment.indexOf(prefix);
      if (index !== -1) {
        const end = this.fragment.indexOf('\x1f', index + prefix.length);
        if (end === -1) {
          this.appendOutput(this.fragment.slice(0, index));
          this.fragment = this.fragment.slice(index);
          return;
        }
        const status = this.fragment.slice(index + prefix.length, end);
        if ((!command.started && status === '') || (command.started && /^\d{1,3}$/.test(status))) {
          this.appendOutput(this.fragment.slice(0, index));
          this.fragment = this.fragment.slice(end + 1);
          if (!command.started) command.started = true;
          else {
            this.command = undefined;
            clearTimeout(command.timer);
            if (command.resolve) command.resolve({
              text: this.consumeCommand(command), completed: true, exitCode: Number(status),
            });
          }
          continue;
        }
      }
      // Keep only the suffix that could be the start of a split marker.
      let keep = Math.min(prefix.length - 1, this.fragment.length);
      while (keep > 0 && !prefix.startsWith(this.fragment.slice(-keep))) keep--;
      this.appendOutput(keep ? this.fragment.slice(0, -keep) : this.fragment);
      this.fragment = keep ? this.fragment.slice(-keep) : '';
      return;
    }
  }

  exec(command: string, timeoutMs = 30_000): Promise<ExecResult> {
    this.ensureOpen();
    if (typeof command !== 'string' || command.includes('\0')) throw new TypeError('Command must be a string without NUL');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new RangeError('Invalid command timeout');
    if (this.command) throw new Error('A command is still running; use read()/send() or close() before another exec()');
    const token = `BS_${randomUUID().replaceAll('-', '')}`;
    const quoted = `'${command.replaceAll("'", "'\\''")}'`;
    this[sessionActivity]?.('start');
    return new Promise<ExecResult>((resolve, reject) => {
      const active: Command = { token, started: false, text: '', resolve, reject };
      this.command = active;
      active.timer = setTimeout(() => {
        active.resolve = undefined;
        active.reject = undefined;
        resolve({ text: this.consumeCommand(active), completed: false });
        // Keep tracking the marker. Timeout does not cancel the remote command.
      }, timeoutMs);
      void this.write(`command printf '\\036${token}:BEGIN\\037'; eval ${quoted}; command printf '\\036${token}:END:%d\\037' "$?"\n`)
        .catch(error => this.fail(error));
    }).finally(() => this[sessionActivity]?.('end'));
  }

  read(): TerminalOutput {
    const text = this.output;
    if (text) this[sessionActivity]?.('read');
    this.output = '';
    if (this.command) this.command.text = '';
    return { text };
  }

  async send(text: string, appendNewline = false): Promise<TerminalOutput> {
    this.ensureOpen();
    if (typeof text !== 'string') throw new TypeError('Input must be a string');
    const input = text + (appendNewline ? '\r' : '');
    if (!input) return this.read();
    this[sessionActivity]?.('start');
    try {
      await this.write(input);
      return this.read();
    } finally {
      this[sessionActivity]?.('end');
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const error = this.failure ?? new Error('BoardSession is closed');
    this.openingReject?.(error);
    this.openingReject = undefined;
    if (this.command) {
      clearTimeout(this.command.timer);
      this.command.reject?.(error);
      this.command = undefined;
    }
    this.output += this.fragment;
    this.fragment = '';
    for (const write of this.writes.values()) write.reject(error);
    this.writes.clear();
    this.closing = (async () => {
      const worker = this.worker;
      const stopped = worker && worker.threadId !== -1 ? new Promise<void>(resolve => {
        const timer = setTimeout(() => { void worker.terminate(); }, 1_000);
        worker.once('exit', () => { clearTimeout(timer); resolve(); });
        worker.postMessage({ type: 'close' });
      }) : Promise.resolve();
      await Promise.all([stopped, this.transport.close()]);
    })();
    return this.closing;
  }
}

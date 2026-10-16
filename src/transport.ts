import { readFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import type { OpenOptions } from './types.js';

const CONNECT_TIMEOUT = 30_000;
// A Baton reservation's forwarded jump port is not instantly connectable (cold
// start ~1s, variable). Probe it for a bounded window before giving up.
const CONNECT_WARMUP_MS = 20_000;
const CONNECT_RETRY_MS = 750;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * True for a connect refusal that can resolve on its own while a forwarded port
 * warms up. Deliberately narrow: a real timeout or unreachable host is a config
 * error, not a warmup symptom, and must surface instead of being retried.
 */
function isTransientConnectError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ECONNREFUSED|Connection refused|ECONNRESET|Connection reset/i.test(message);
}

/**
 * Resources of a single open() attempt. Its identity is checked on every ssh2
 * event: once an attempt is superseded (retry) or discarded (close), its late
 * events are ignored instead of affecting the transport.
 */
interface Attempt {
  readonly channels: ClientChannel[];
  readonly clients: Client[];
  readonly closures: Promise<void>[];
  server?: Server;
  socket?: Socket;
  /** Set once this attempt produced the returned endpoint; failures past it are terminal. */
  live: boolean;
  teardown?: Promise<void>;
}

// Owns only jump SSH connections and the single final loopback bridge.
export class Transport {
  private closed = false;
  private failure?: Error;
  private closing?: Promise<void>;
  private attempt?: Attempt;
  private pending = new Set<(error: Error) => void>();

  constructor(private readonly onFailure: (error: Error) => void) {}

  private fail(error: Error, attempt: Attempt): void {
    if (this.closed || this.failure) return;
    // Only the attempt that is still current may affect the transport. Events from
    // a superseded attempt (retry) or from any attempt after close() are ignored.
    if (attempt !== this.attempt) return;
    // Reject the in-flight wait so open() can retry while the port warms up.
    for (const reject of this.pending) reject(error);
    // A failure after a successful connect is terminal; during open it only fails
    // the current attempt.
    if (!attempt.live) return;
    this.failure = error;
    this.onFailure(error);
    void this.close();
  }

  private wait<T>(start: (resolve: (value: T) => void, reject: (error: Error) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.closed || this.failure) return reject(this.failure ?? new Error('Transport is closed'));
      const fail = (error: Error) => { cleanup(); reject(error); };
      const timer = setTimeout(() => fail(new Error('SSH forwarding timed out')), CONNECT_TIMEOUT);
      const cleanup = () => { clearTimeout(timer); this.pending.delete(fail); };
      this.pending.add(fail);
      try { start(value => { cleanup(); resolve(value); }, fail); }
      catch (error) { fail(error as Error); }
    });
  }

  private async forward(attempt: Attempt, client: Client, host: string, port: number): Promise<ClientChannel> {
    return this.wait((resolve, reject) => {
      client.forwardOut('127.0.0.1', 0, host, port, (error, channel) => {
        if (error) return reject(new Error(`Cannot forward to ${host}:${port}: ${error.message}`));
        if (this.closed) { channel.destroy(); return; }
        attempt.channels.push(channel);
        channel.on('error', (error: Error) => this.fail(error, attempt));
        channel.on('close', () => this.fail(new Error(`Forwarding to ${host}:${port} closed`), attempt));
        resolve(channel);
      });
    });
  }

  async open({ board, jumps = [] }: OpenOptions): Promise<{ host: string; port: number }> {
    const deadline = Date.now() + CONNECT_WARMUP_MS;
    for (; ;) {
      if (this.closed || this.failure) throw this.failure ?? new Error('Transport is closed');
      const attempt: Attempt = { channels: [], clients: [], closures: [], live: false };
      this.attempt = attempt;
      try {
        return await this.connect(attempt, { board, jumps });
      } catch (error) {
        if (this.attempt === attempt) this.attempt = undefined;
        await this.teardown(attempt);
        // A terminal failure (auth, bad config, close) must surface, not be retried.
        if (!isTransientConnectError(error) || this.closed || this.failure) throw error;
        // Enforce the warmup budget before spending another attempt, so the window
        // bounds the total probe time instead of being extended by each retry.
        if (Date.now() + CONNECT_RETRY_MS >= deadline) throw error;
        await delay(CONNECT_RETRY_MS);
      }
    }
  }

  private async connect(attempt: Attempt, { board, jumps = [] }: OpenOptions): Promise<{ host: string; port: number }> {
    let previous: Client | undefined;
    for (const jump of jumps) {
      const privateKey = jump.privateKeyFile ? await readFile(jump.privateKeyFile) : undefined;
      const sock = previous ? await this.forward(attempt, previous, jump.host, jump.port ?? 22) : undefined;
      if (this.closed) throw this.failure ?? new Error('Transport is closed');
      const client = new Client();
      attempt.clients.push(client);
      let connectionClosed!: () => void;
      attempt.closures.push(new Promise(resolve => {
        connectionClosed = resolve;
        client.once('close', resolve);
      }));
      client.on('error', error => this.fail(new Error(`Jump ${jump.host}: ${error.message}`), attempt));
      client.on('close', () => this.fail(new Error(`Jump ${jump.host} closed`), attempt));
      const config: ConnectConfig = {
        host: jump.host, port: jump.port ?? 22, username: jump.username,
        ...(privateKey ? { privateKey } : { password: jump.password }),
        sock, readyTimeout: CONNECT_TIMEOUT, keepaliveInterval: 30_000, keepaliveCountMax: 3,
      };
      await this.wait<void>(resolve => {
        client.once('ready', resolve);
        try { client.connect(config); }
        catch (error) {
          // Invalid key/config can throw before ssh2 creates a socket. In that
          // case destroy() has no socket and will never emit a close event.
          client.destroy();
          connectionClosed();
          throw error;
        }
      });
      previous = client;
    }
    if (!previous) { attempt.live = true; return { host: board.host, port: board.port ?? 22 }; }

    const channel = await this.forward(attempt, previous, board.host, board.port ?? 22);
    const server = attempt.server = createServer(socket => {
      if (attempt.socket || this.closed) { socket.destroy(); return; }
      attempt.socket = socket;
      server.close(); // Stop listening; the accepted socket remains owned until close().
      socket.setNoDelay(true);
      socket.on('error', error => this.fail(error, attempt));
      socket.on('close', () => this.fail(new Error('Board TCP bridge closed'), attempt));
      socket.pipe(channel).pipe(socket);
    });
    server.on('error', error => this.fail(error, attempt));
    await this.wait<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback bridge did not start');
    attempt.live = true;
    return { host: '127.0.0.1', port: address.port };
  }

  /** Release the resources of one attempt (used by retry and close). Idempotent. */
  private teardown(attempt: Attempt): Promise<void> {
    attempt.teardown ??= (async () => {
      attempt.socket?.destroy();
      attempt.socket = undefined;
      const closing: Promise<void>[] = [];
      if (attempt.server?.listening) {
        const server = attempt.server;
        closing.push(new Promise(resolve => server.close(() => resolve())));
      }
      attempt.server = undefined;
      for (const channel of attempt.channels.reverse()) channel.destroy();
      for (const client of attempt.clients.reverse()) client.destroy();
      closing.push(...attempt.closures);
      await Promise.all(closing);
    })();
    return attempt.teardown;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const attempt = this.attempt;
    this.attempt = undefined;
    for (const reject of this.pending) reject(this.failure ?? new Error('Transport closed'));
    this.closing = attempt ? this.teardown(attempt) : Promise.resolve();
    return this.closing;
  }
}

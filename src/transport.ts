import { createServer, type Server, type Socket } from 'node:net';
import { Worker } from 'node:worker_threads';
import type { OpenOptions } from './types.js';

const CONNECT_TIMEOUT = 30_000;
// A Baton reservation's forwarded jump port is not instantly connectable.
const CONNECT_WARMUP_MS = 20_000;
const CONNECT_RETRY_MS = 750;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTransientConnectError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ECONNREFUSED|Connection refused|ECONNRESET|Connection reset/i.test(message);
}

interface Peer {
  worker: Worker;
  stopped: Promise<void>;
  server?: Server;
  socket?: Socket;
  channel?: number;
  buffered?: Buffer;
  ready?: () => void;
  forwarded?: () => void;
  writeId: number;
}

// Events belong to one attempt; late messages cannot affect a retry or close().
interface Attempt {
  readonly peers: Peer[];
  live: boolean;
  error?: Error;
  teardown?: Promise<void>;
}

// Owns jump connections and one loopback TCP bridge per forwarding channel.
export class Transport {
  private closed = false;
  private failure?: Error;
  private closing?: Promise<void>;
  private attempt?: Attempt;
  private pending = new Set<(error: Error) => void>();

  constructor(private readonly onFailure: (error: Error) => void) {}

  private fail(error: Error, attempt: Attempt): void {
    if (this.closed || this.failure || attempt !== this.attempt || attempt.error) return;
    attempt.error = error;
    for (const reject of this.pending) reject(error);
    if (!attempt.live) return;
    this.failure = error;
    this.onFailure(error);
    void this.close();
  }

  private wait<T>(start: (resolve: (value: T) => void, reject: (error: Error) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.closed || this.failure || this.attempt?.error)
        return reject(this.failure ?? this.attempt?.error ?? new Error('Transport is closed'));
      const fail = (error: Error) => { cleanup(); reject(error); };
      const timer = setTimeout(() => fail(new Error('SSH forwarding timed out')), CONNECT_TIMEOUT);
      const cleanup = () => { clearTimeout(timer); this.pending.delete(fail); };
      this.pending.add(fail);
      try { start(value => { cleanup(); resolve(value); }, fail); }
      catch (error) { fail(error as Error); }
    });
  }

  async open({ board, jumps = [] }: OpenOptions): Promise<{ host: string; port: number }> {
    const deadline = Date.now() + CONNECT_WARMUP_MS;
    for (; ;) {
      if (this.closed || this.failure) throw this.failure ?? new Error('Transport is closed');
      const attempt: Attempt = { peers: [], live: false };
      this.attempt = attempt;
      try {
        return await this.connect(attempt, { board, jumps });
      } catch (error) {
        await this.teardown(attempt);
        if (this.attempt === attempt) this.attempt = undefined;
        if (!isTransientConnectError(error) || this.closed || this.failure) throw error;
        if (Date.now() + CONNECT_RETRY_MS >= deadline) throw error;
        await delay(CONNECT_RETRY_MS);
      }
    }
  }

  private async connect(attempt: Attempt, { board, jumps = [] }: OpenOptions): Promise<{ host: string; port: number }> {
    let endpoint = { host: jumps[0]?.host ?? board.host, port: (jumps[0] ?? board).port ?? 22 };
    for (let i = 0; i < jumps.length; i++) {
      const jump = jumps[i];
      const target = jumps[i + 1] ?? board;
      const context = `Jump ${jump.host}:${jump.port ?? 22} forwarding to ${target.host}:${target.port ?? 22}`;
      if (this.closed || attempt.error) throw attempt.error ?? new Error('Transport is closed');
      const worker = new Worker(new URL('./native-worker.js', import.meta.url), {
        workerData: { ...endpoint, username: jump.username,
          auth: { type: 'password', password: jump.password }, terminal: false },
        execArgv: [],
      });
      const peer: Peer = { worker, stopped: new Promise(resolve => worker.once('exit', resolve)), writeId: 0 };
      attempt.peers.push(peer);
      worker.on('error', error => this.fail(new Error(`${context}: ${error.message}`), attempt));
      worker.on('exit', () => this.fail(new Error(`${context}: SSH connection stopped`), attempt));
      worker.on('message', message => {
        if (this.closed || this.attempt !== attempt || attempt.error) return;
        if (message.type === 'ready') peer.ready?.();
        else if (message.type === 'forwarded') {
          peer.channel = message.channel;
          peer.forwarded?.();
        } else if (message.type === 'data') {
          if (message.channel === undefined) worker.postMessage({ type: 'consumed' });
          else if (peer.socket) this.receive(peer, Buffer.from(message.data));
          else peer.buffered = Buffer.from(message.data);
        } else if (message.type === 'written') {
          if (message.id === peer.writeId) peer.socket?.resume();
        } else if (message.type === 'failure') this.fail(new Error(`${context}: ${message.message}`), attempt);
        else if (message.type === 'channelClosed' && message.channel !== undefined)
          this.fail(new Error(`${context}: forwarding channel closed`), attempt);
      });
      await this.wait<void>(resolve => { peer.ready = resolve; });
      await this.wait<void>(resolve => {
        peer.forwarded = resolve;
        worker.postMessage({ type: 'openForward', id: 0, host: target.host, port: target.port ?? 22 });
      });
      endpoint = await this.bridge(attempt, peer);
    }
    if (this.closed || attempt.error) throw attempt.error ?? new Error('Transport is closed');
    attempt.live = true;
    return endpoint;
  }

  private receive(peer: Peer, data: Buffer): void {
    peer.socket!.write(data, () => {
      if (!this.closed && !peer.socket?.destroyed)
        peer.worker.postMessage({ type: 'consumed', channel: peer.channel });
    });
  }

  private async bridge(attempt: Attempt, peer: Peer): Promise<{ host: string; port: number }> {
    const server = peer.server = createServer(socket => {
      if (peer.socket || this.closed || this.attempt !== attempt || attempt.error) { socket.destroy(); return; }
      peer.socket = socket;
      server.close();
      socket.setNoDelay(true);
      socket.on('error', error => this.fail(error, attempt));
      socket.on('close', () => this.fail(new Error('SSH TCP bridge closed'), attempt));
      socket.on('data', data => {
        socket.pause();
        peer.worker.postMessage({ type: 'write', id: ++peer.writeId, channel: peer.channel, data });
      });
      if (peer.buffered) {
        this.receive(peer, peer.buffered);
        peer.buffered = undefined;
      }
    });
    server.on('error', error => this.fail(error, attempt));
    await this.wait<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Cannot create SSH TCP bridge');
    return { host: '127.0.0.1', port: address.port };
  }

  private teardown(attempt: Attempt): Promise<void> {
    if (attempt.teardown) return attempt.teardown;
    attempt.teardown = (async () => {
      for (const peer of [...attempt.peers].reverse()) {
        peer.socket?.destroy();
        const listeningClosed = peer.server && new Promise<void>(resolve => peer.server!.close(() => resolve()));
        const timer = setTimeout(() => { void peer.worker.terminate(); }, 1_000);
        peer.worker.postMessage({ type: 'close' });
        await Promise.all([peer.stopped, listeningClosed]);
        clearTimeout(timer);
      }
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

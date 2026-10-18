import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

interface Native {
  create(config: unknown): unknown;
  handshake(handle: unknown): boolean;
  poll(handle: unknown, receive: boolean): boolean;
  openForward(handle: unknown, host: string, port: number): number;
  forwardReady(handle: unknown, channel: number): boolean;
  read(handle: unknown, ...channel: [] | [number]): Buffer | null;
  write(handle: unknown, data: Buffer, ...channel: [] | [number]): number;
  close(handle: unknown): void;
}

interface Channel {
  opening?: number;
  awaitingRead: boolean;
}

const port = parentPort!;
const require = createRequire(import.meta.url);
let native: Native;
let handle: unknown;
let timer: ReturnType<typeof setInterval>;
let ready = false;
let stopped = false;
const channels = new Map<number | undefined, Channel>([[undefined, { awaitingRead: false }]]);
const pending: { id: number; data: Buffer; channel?: number }[] = [];

function stop(error?: unknown): void {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
  if (handle) native.close(handle);
  if (error) port.postMessage({ type: 'failure', message: (error as Error).message });
  port.close();
}

function pump(): void {
  if (stopped) return;
  try {
    if (!ready) {
      if (!native.handshake(handle)) return;
      ready = true;
      port.postMessage({ type: 'ready' });
    }
    // One unacknowledged read per channel bounds message/socket buffering. Stop
    // receiving protocol packets under backpressure, preserving SSH window limits.
    for (let i = 0; i < 64; i++) {
      const paused = [...channels.values()].some(channel => channel.awaitingRead);
      const progressed = native.poll(handle, !paused);
      if (paused) break;
      for (const [id, channel] of channels) {
        if (channel.opening !== undefined) {
          if (!native.forwardReady(handle, id!)) continue;
          port.postMessage({ type: 'forwarded', id: channel.opening, channel: id });
          channel.opening = undefined;
        }
        const data = native.read(handle, ...(id === undefined ? [] as const : [id] as const));
        if (data === null) {
          channels.delete(id);
          port.postMessage({ type: 'channelClosed', channel: id });
        } else if (data.length) {
          channel.awaitingRead = true;
          port.postMessage({ type: 'data', channel: id, data });
        }
      }
      if (!progressed) break;
    }
    // Bound each tick so close/input messages can always be processed.
    for (let i = 0; i < 64 && pending.length; i++) {
      const item = pending[0];
      const written = native.write(handle, item.data,
        ...(item.channel === undefined ? [] as const : [item.channel] as const));
      if (written === 0) break;
      item.data = item.data.subarray(written);
      if (!item.data.length) {
        pending.shift();
        port.postMessage({ type: 'written', id: item.id, channel: item.channel });
      }
    }
  } catch (error) { stop(error); }
}

port.on('message', message => {
  if (stopped) return;
  try {
    if (message.type === 'close') { stop(); return; }
    if (message.type === 'openForward') {
      const channel = native.openForward(handle, message.host, message.port);
      channels.set(channel, { opening: message.id, awaitingRead: false });
    } else if (message.type === 'consumed') {
      const channel = channels.get(message.channel);
      if (channel) channel.awaitingRead = false;
    } else if (message.type === 'write') {
      const data = Buffer.from(message.data);
      if (!data.length) port.postMessage({ type: 'written', id: message.id, channel: message.channel });
      else pending.push({ id: message.id, data, channel: message.channel });
    }
    pump();
  } catch (error) { stop(error); }
});

try {
  native = require(`../prebuilds/${process.platform}-${process.arch}/board_session.node`) as Native;
  const auth = workerData.auth;
  const secret = Buffer.from(auth.type === 'password' ? auth.password : auth.identity);
  try {
    handle = native.create({ ...workerData, terminal: workerData.terminal ?? false,
      auth: auth.type === 'password' ? { type: 'password', password: secret } : { type: 'x509', identity: secret } });
  } finally {
    secret.fill(0);
    if (auth.type === 'password') auth.password = '';
    else auth.identity.fill(0);
  }
  timer = setInterval(pump, 10);
  pump();
} catch (error) { stop(error); }

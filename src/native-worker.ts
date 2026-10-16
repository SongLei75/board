import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

interface Native {
  create(host: string, port: number, username: string, pem: Buffer): unknown;
  handshake(handle: unknown): boolean;
  read(handle: unknown): Buffer | null;
  write(handle: unknown, data: Buffer): number;
  close(handle: unknown): void;
}

const port = parentPort!;
const require = createRequire(import.meta.url);
let native: Native;
let handle: unknown;
let timer: ReturnType<typeof setInterval>;
let ready = false;
let stopped = false;
const pending: { id: number; data: Buffer }[] = [];

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
    // Bound each tick so close/input messages can always be processed.
    for (let i = 0; i < 64; i++) {
      const data = native.read(handle);
      if (data === null) { stop(new Error('Board SSH channel closed')); return; }
      if (data.length === 0) break;
      port.postMessage({ type: 'data', data });
    }
    for (let i = 0; i < 64 && pending.length; i++) {
      const item = pending[0];
      const written = native.write(handle, item.data);
      if (written === 0) break;
      item.data = item.data.subarray(written);
      if (!item.data.length) {
        pending.shift();
        port.postMessage({ type: 'written', id: item.id });
      }
    }
  } catch (error) { stop(error); }
}

port.on('message', message => {
  if (message.type === 'close') { stop(); return; }
  if (message.type === 'write') {
    const data = Buffer.from(message.data);
    if (!data.length) port.postMessage({ type: 'written', id: message.id });
    else pending.push({ id: message.id, data });
    pump();
  }
});

try {
  native = require(`../prebuilds/${process.platform}-${process.arch}/board_session.node`) as Native;
  const pem = Buffer.from(workerData.pem);
  try { handle = native.create(workerData.host, workerData.port, workerData.username, pem); }
  finally { pem.fill(0); workerData.pem.fill(0); }
  timer = setInterval(pump, 10);
  pump();
} catch (error) { stop(error); }

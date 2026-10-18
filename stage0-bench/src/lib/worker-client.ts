import type { WorkerRequest, WorkerResponse } from './types';

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: number };

/** Tiny RPC over postMessage. A timed-out call restarts the worker. */
export class EngineClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  startError: string | null = null;

  private spawn(): Worker {
    const w = new Worker(new URL('../worker/engine.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const p = this.pending.get(ev.data.id);
      if (!p) return;
      this.pending.delete(ev.data.id);
      clearTimeout(p.timer);
      if (ev.data.ok) p.resolve(ev.data.result);
      else p.reject(new Error(ev.data.error));
    };
    w.onerror = (ev) => {
      ev.preventDefault();
      const msg = ev.message || 'worker error (module worker failed to load?)';
      this.startError = msg;
      this.failAll(msg);
    };
    return w;
  }

  private failAll(msg: string) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(msg));
      this.pending.delete(id);
    }
  }

  restart() {
    this.worker?.terminate();
    this.worker = null;
    this.failAll('worker restarted');
  }

  call<T = any>(cmd: string, args?: any, timeoutMs = 30000, transfer: Transferable[] = []): Promise<T> {
    if (!this.worker) this.worker = this.spawn();
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs} ms`));
        this.restart();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const msg: WorkerRequest = { id, cmd, args };
      this.worker!.postMessage(msg, transfer);
    });
  }
}

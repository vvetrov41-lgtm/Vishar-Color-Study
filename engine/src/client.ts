// Main-thread side of the engine. Owns no pixels: it forwards view states to the
// Worker and coalesces slider input so the Worker never builds a backlog.

import * as Comlink from 'comlink';
import type { ViewState } from './core/view';
import type { PaletteParams } from './core/palette';
import type { Caps, OpenOptions, OpenResult, PaletteResult, ParityReport, PickResult, SvgExport, ViewResult } from './types';
import type { EngineApi } from './worker/engine.worker';

type Resolver = { ok: (r: ViewResult) => void; fail: (e: unknown) => void };

export class EngineClient {
  private inflight = false;
  private pending: { state: ViewState; waiters: Resolver[] } | null = null;
  private bitmapCtx: ImageBitmapRenderingContext | null = null;
  private idleWaiters: Array<() => void> = [];

  private constructor(
    private readonly worker: Worker,
    private readonly api: Comlink.Remote<EngineApi>,
    readonly caps: Caps,
  ) {}

  static async create(canvas: HTMLCanvasElement): Promise<EngineClient> {
    const worker = new Worker(new URL('./worker/engine.worker.ts', import.meta.url), { type: 'module' });
    const api = Comlink.wrap<EngineApi>(worker);
    let caps: Caps;
    let ctx: ImageBitmapRenderingContext | null = null;
    if ('transferControlToOffscreen' in canvas) {
      const off = canvas.transferControlToOffscreen();
      caps = await api.init(Comlink.transfer(off, [off]));
    } else {
      ctx = (canvas as HTMLCanvasElement).getContext('bitmaprenderer');
      caps = await api.init();
    }
    const c = new EngineClient(worker, api, caps);
    c.bitmapCtx = ctx;
    return c;
  }

  open(blob: Blob, opts?: OpenOptions): Promise<OpenResult> {
    return this.api.open(blob, opts);
  }

  async resize(cssW: number, cssH: number, dpr: number, bg?: [number, number, number]): Promise<void> {
    const r = await this.api.resize(cssW, cssH, dpr, bg);
    if (r?.frame) this.bitmapCtx?.transferFromImageBitmap(r.frame);
  }

  /** Latest state wins: while a frame renders, newer states replace the queued one. */
  setView(state: ViewState): Promise<ViewResult> {
    return new Promise((ok, fail) => {
      if (this.inflight) {
        this.pending = { state, waiters: [...(this.pending?.waiters ?? []), { ok, fail }] };
        return;
      }
      void this.run(state, [{ ok, fail }]);
    });
  }

  private async run(state: ViewState, waiters: Resolver[]) {
    this.inflight = true;
    const t0 = performance.now();
    try {
      const r = await this.api.setView(state);
      r.roundTripMs = Math.round((performance.now() - t0) * 10) / 10;
      if (r.frame) this.bitmapCtx?.transferFromImageBitmap(r.frame);
      waiters.forEach((w) => w.ok(r));
    } catch (e) {
      waiters.forEach((w) => w.fail(e));
    } finally {
      this.inflight = false;
      const next = this.pending;
      this.pending = null;
      if (next) void this.run(next.state, next.waiters);
      else {
        const w = this.idleWaiters;
        this.idleWaiters = [];
        w.forEach((f) => f());
      }
    }
  }

  /** Resolves once the frame in flight and any queued state have rendered. */
  private settled(): Promise<void> {
    return this.inflight ? new Promise((ok) => this.idleWaiters.push(ok)) : Promise.resolve();
  }

  pick(x: number, y: number): Promise<number> {
    return this.api.pick(x, y);
  }

  palette(params?: PaletteParams): Promise<PaletteResult> {
    return this.api.palette(params);
  }

  /** Pipette at (u, v), 0..1 of the working copy. */
  pickColor(u: number, v: number, size: number): Promise<PickResult | null> {
    return this.api.pickColor(u, v, size);
  }

  /** Simplify / Graph progress, 0..1, while a long computation runs in the Worker. */
  onProgress(cb: (share: number, stage: string) => void): Promise<void> {
    return this.api.setProgress(Comlink.proxy(cb));
  }

  /** Current Drawing as SVG (the view must be 'drawing'). */
  async exportSvg(): Promise<SvgExport> {
    // Exports read the Worker's current view: let the latest queued state land first.
    await this.settled();
    return this.api.exportSvg();
  }

  /** Current Drawing as a transparent PNG (for Procreate, which has no SVG import). */
  async exportInkPng(): Promise<Blob> {
    await this.settled();
    return this.api.exportInkPng();
  }

  async exportWork(): Promise<Blob> {
    await this.settled();
    return this.api.exportWork();
  }

  selftest(fixtures: Record<string, string>): Promise<ParityReport> {
    return this.api.selftest(fixtures);
  }

  terminate() {
    this.worker.terminate();
  }
}

/// <reference lib="webworker" />
// Engine worker for the Stage 0 bench. Every pixel operation runs here, never
// on the main thread. Each command returns plain data; errors are reported
// per step so one unsupported API does not hide the other measurements.
import { getGl, glParams, makeTexture, renderPass, uploadSubRect } from './gl';
import { kmeans1d, lumaHistogram } from '../lib/values';
import type { PipelineOptions, PipelineResult, WorkerRequest, WorkerResponse } from '../lib/types';

declare const self: DedicatedWorkerGlobalScope;

const now = () => performance.now();
const round = (v: number) => Math.round(v * 10) / 10;
const errMsg = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

function pixelAt(src: ImageBitmap, x: number, y: number): number[] {
  const c = new OffscreenCanvas(src.width, src.height);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(src, 0, 0);
  const d = ctx.getImageData(x, y, 1, 1).data;
  c.width = c.height = 0;
  return [d[0], d[1], d[2], d[3]];
}

function gradientImageData(w: number, h: number): ImageData {
  const d = new ImageData(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      d.data[i] = x * 4;
      d.data[i + 1] = y * 4;
      d.data[i + 2] = 0;
      d.data[i + 3] = 255;
    }
  return d;
}

async function caps() {
  const r: Record<string, any> = {
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    createImageBitmap: typeof createImageBitmap === 'function',
    imageDecoder: typeof (self as any).ImageDecoder !== 'undefined',
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    errors: {} as Record<string, string>,
  };
  try {
    r.ctx2d = !!new OffscreenCanvas(4, 4).getContext('2d');
    r.convertToBlob = typeof OffscreenCanvas.prototype.convertToBlob === 'function';
    r.transferToImageBitmap = typeof OffscreenCanvas.prototype.transferToImageBitmap === 'function';
  } catch (e) {
    r.ctx2d = false;
    r.errors.ctx2d = errMsg(e);
  }
  try {
    const t0 = now();
    const e = getGl();
    r.webgl2 = true;
    r.webgl2InitMs = round(now() - t0);
    r.gl = glParams(e.gl);
  } catch (e) {
    r.webgl2 = false;
    r.errors.webgl2 = errMsg(e);
  }
  if (r.webgl2) {
    // Can a WebGL2 texture be filled from a sub-rectangle of an ImageBitmap?
    // Needed for tiled export without an extra 2D canvas copy per tile.
    try {
      const bmp = await createImageBitmap(gradientImageData(64, 64), {
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      });
      const e = getGl();
      const tex = makeTexture(e.gl);
      uploadSubRect(e.gl, tex, bmp, 16, 8, 8, 8);
      const out = new Uint8Array(8 * 8 * 4);
      renderPass(e, e.copy, tex, 8, 8, () => {}, { x: 0, y: 0, w: 8, h: 8, out });
      e.gl.deleteTexture(tex);
      bmp.close();
      r.unpackSkipImageBitmap = Math.abs(out[0] - 64) <= 2 && Math.abs(out[1] - 32) <= 2;
      r.unpackSkipSample = [out[0], out[1], out[2]];
    } catch (e) {
      r.unpackSkipImageBitmap = false;
      r.errors.unpackSkip = errMsg(e);
    }
  }
  const gpu = (navigator as any).gpu;
  r.webgpu = !!gpu;
  if (gpu) {
    try {
      const a = await gpu.requestAdapter();
      r.webgpuAdapter = a
        ? {
            vendor: a.info?.vendor ?? null,
            architecture: a.info?.architecture ?? null,
            maxTextureDimension2D: a.limits.maxTextureDimension2D,
            maxBufferSize: a.limits.maxBufferSize,
            maxStorageBufferBindingSize: a.limits.maxStorageBufferBindingSize,
          }
        : null;
    } catch (e) {
      r.errors.webgpu = errMsg(e);
    }
  }
  // OPFS synchronous access handle: only available inside workers.
  try {
    const t0 = now();
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle('bench-sync.bin', { create: true });
    const h = await (fh as any).createSyncAccessHandle();
    const buf = new Uint8Array(4 * 1024 * 1024);
    for (let i = 0; i < buf.length; i++) buf[i] = ((i >> 12) + (i & 7) + 1) & 255 || 1;
    h.write(buf, { at: 0 });
    h.flush();
    const back = new Uint8Array(buf.length);
    h.read(back, { at: 0 });
    h.close();
    await root.removeEntry('bench-sync.bin');
    let same = true;
    for (let i = 0; i < buf.length; i += 997) if (back[i] !== buf[i]) { same = false; break; }
    r.opfsSync = same && back[buf.length - 1] === buf[buf.length - 1];
    r.opfsSyncMs4MB = round(now() - t0);
  } catch (e) {
    r.opfsSync = false;
    r.errors.opfsSync = errMsg(e);
  }
  return r;
}

type BitmapTry = { ok: boolean; w?: number; h?: number; b?: ImageBitmap; error?: string };

async function tryBitmap(src: ImageBitmapSource, opts?: ImageBitmapOptions): Promise<BitmapTry> {
  try {
    const b = await createImageBitmap(src, opts as ImageBitmapOptions);
    return { ok: true, w: b.width, h: b.height, b };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

async function bitmapOptions(orient: Blob) {
  const src = gradientImageData(64, 32);
  const r: Record<string, any> = {};
  const dims = async (key: string, s: ImageBitmapSource, o?: ImageBitmapOptions) => {
    const t = await tryBitmap(s, o);
    r[key] = t.ok ? { ok: true, size: `${t.w}x${t.h}` } : { ok: false, error: t.error };
    if (t.ok) t.b!.close();
    return t;
  };
  await dims('resizeWH', src, { resizeWidth: 16, resizeHeight: 8 });
  r.resizeWH.honored = r.resizeWH.size === '16x8';
  await dims('resizeWidthOnly', src, { resizeWidth: 16 });
  r.resizeWidthOnly.honored = r.resizeWidthOnly.size === '16x8';
  for (const q of ['pixelated', 'low', 'medium', 'high'] as ResizeQuality[]) {
    await dims('resizeQuality_' + q, src, { resizeWidth: 16, resizeHeight: 8, resizeQuality: q });
  }
  for (const o of ['none', 'premultiply', 'default'] as PremultiplyAlpha[]) {
    await dims('premultiplyAlpha_' + o, src, { premultiplyAlpha: o });
  }
  for (const o of ['none', 'default'] as ColorSpaceConversion[]) {
    await dims('colorSpaceConversion_' + o, src, { colorSpaceConversion: o });
  }
  // imageOrientation on raw pixels: flipY must move the bottom row (G=124) to the top.
  for (const o of ['flipY', 'from-image', 'none']) {
    const t = await tryBitmap(src, { imageOrientation: o as ImageOrientation });
    if (t.ok) {
      const px = pixelAt(t.b!, 0, 0);
      t.b!.close();
      r['imageOrientation_' + o] = { ok: true, topLeftG: px[1], flipped: px[1] > 100 };
    } else r['imageOrientation_' + o] = { ok: false, error: t.error };
  }
  // EXIF Orientation=6 JPEG (64x32 stored). Applied rotation → 32x64 with red on top.
  for (const [key, o] of [
    ['exif_default', undefined],
    ['exif_from-image', { imageOrientation: 'from-image' }],
    ['exif_none', { imageOrientation: 'none' }],
  ] as [string, ImageBitmapOptions | undefined][]) {
    const t = await tryBitmap(orient, o);
    if (t.ok) {
      const top = pixelAt(t.b!, Math.floor(t.w! / 2), 1);
      t.b!.close();
      r[key] = { ok: true, size: `${t.w}x${t.h}`, rotated: t.w === 32 && t.h === 64 && top[0] > 200 };
    } else r[key] = { ok: false, error: t.error };
  }
  await dims('blobResizeWidth', orient, { resizeWidth: 8, resizeHeight: 16 });
  return r;
}

async function decode(blob: Blob) {
  const t0 = now();
  const b = await createImageBitmap(blob);
  const ms = round(now() - t0);
  const res = { width: b.width, height: b.height, ms, center: pixelAt(b, b.width >> 1, b.height >> 1) };
  b.close();
  return res;
}

async function canvasLimit(sizes: [number, number][]) {
  const out = [];
  for (const [w, h] of sizes) {
    const t0 = now();
    let c: OffscreenCanvas | null = null;
    try {
      c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('getContext returned null');
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(w - 2, h - 2, 2, 2);
      const d = ctx.getImageData(w - 1, h - 1, 1, 1).data;
      out.push({ size: `${w}x${h}`, mp: round((w * h) / 1e6), ok: d[0] === 255 && d[1] === 0, ms: round(now() - t0) });
    } catch (e) {
      out.push({ size: `${w}x${h}`, mp: round((w * h) / 1e6), ok: false, error: errMsg(e) });
    } finally {
      if (c) c.width = c.height = 0;
    }
  }
  return out;
}

function fitLong(w: number, h: number, long: number) {
  const s = Math.min(1, long / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

async function pipeline(blob: Blob, label: string, opts: PipelineOptions): Promise<PipelineResult> {
  const res: PipelineResult = { label, bytes: blob.size, type: blob.type, steps: {}, errors: [] };
  const s = res.steps;
  const step = async <T>(name: string, fn: () => Promise<T> | T): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      res.errors.push(`${name}: ${errMsg(e)}`);
      s[name + 'Error'] = errMsg(e);
      return undefined;
    }
  };

  // 1. Full decode
  let full: ImageBitmap | undefined;
  await step('decodeFull', async () => {
    const t0 = now();
    full = await createImageBitmap(blob);
    s.decodeFullMs = round(now() - t0);
  });
  if (!full) return res;
  const W = full.width;
  const H = full.height;
  res.width = W;
  res.height = H;
  res.megapixels = round((W * H) / 1e6);
  s.fullBitmapMB = round((W * H * 4) / 1048576);
  const [ww, wh] = fitLong(W, H, opts.workLong);
  s.workSize = `${ww}x${wh}`;

  // 2. Working copy: resize an already decoded bitmap
  let work: ImageBitmap | undefined;
  await step('resizeFromBitmap', async () => {
    const t0 = now();
    work = await createImageBitmap(full!, { resizeWidth: ww, resizeHeight: wh, resizeQuality: 'high' });
    s.resizeFromBitmapMs = round(now() - t0);
    s.resizeFromBitmapHonored = work.width === ww && work.height === wh;
  });

  // 3. Full-resolution tiled GPU pass (export simulation), while `full` is alive
  if (opts.fullRes) {
    await step('tiled', () => tiledPass(full!, opts, s));
  }
  full.close();
  full = undefined;

  // 4. Decode straight to working size (second decode of the same blob)
  await step('decodeResize', async () => {
    const t0 = now();
    const b = await createImageBitmap(blob, { resizeWidth: ww, resizeHeight: wh, resizeQuality: 'high' });
    s.decodeResizeMs = round(now() - t0);
    s.decodeResizeHonored = b.width === ww && b.height === wh;
    if (!work) work = b;
    else b.close();
  });
  if (!work) return res;

  // 5. GPU Values pass on the working copy: cold (incl. upload) and warm
  const out = new Uint8Array(ww * wh * 4);
  await step('gpuWork', () => {
    const e = getGl();
    const run = () => {
      const tex = makeTexture(e.gl);
      e.gl.texImage2D(e.gl.TEXTURE_2D, 0, e.gl.RGBA8, e.gl.RGBA, e.gl.UNSIGNED_BYTE, work!);
      renderPass(e, e.values, tex, ww, wh, (gl, p) => gl.uniform1i(gl.getUniformLocation(p, 'uLevels'), opts.levels), {
        x: 0, y: 0, w: ww, h: wh, out,
      });
      e.gl.deleteTexture(tex);
    };
    let t0 = now();
    run();
    s.gpuWorkColdMs = round(now() - t0);
    t0 = now();
    run();
    s.gpuWorkWarmMs = round(now() - t0);
  });

  // 6. CPU structural pass: pixels → luma histogram → 1-D k-means (compatibility mode)
  await step('cpuWork', () => {
    const c = new OffscreenCanvas(ww, wh);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    let t0 = now();
    ctx.drawImage(work!, 0, 0);
    const px = ctx.getImageData(0, 0, ww, wh).data;
    s.cpuGetImageDataMs = round(now() - t0);
    t0 = now();
    const hist = lumaHistogram(px);
    const centers = kmeans1d(hist, opts.levels, false);
    s.cpuHistKmeansMs = round(now() - t0);
    s.kmeansCenters = centers.map((v) => Math.round(v)).join(',');
    c.width = c.height = 0;
  });

  // 7. Preview of the GPU result for the page
  if (opts.preview && s.gpuWorkWarmMs !== undefined) {
    await step('preview', () => {
      const c = new OffscreenCanvas(ww, wh);
      const ctx = c.getContext('2d')!;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(out.buffer), ww, wh), 0, 0);
      res.preview = c.transferToImageBitmap();
    });
  }
  work.close();
  return res;
}

async function tiledPass(full: ImageBitmap, opts: PipelineOptions, s: PipelineResult['steps']) {
  const e = getGl();
  const gl = e.gl;
  const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  const T = Math.min(opts.tile, max - 2 * opts.overlap);
  const ov = opts.overlap;
  const W = full.width;
  const H = full.height;
  const caps = await capsCache();
  const method = caps.unpackSkipImageBitmap ? 'unpack-skip' : 'canvas-crop';
  s.tileMethod = method;
  s.tileSize = T;
  s.tileOverlap = ov;
  let upload = 0;
  let render = 0;
  let tiles = 0;
  let checksum = 0;
  const crop = method === 'canvas-crop' ? new OffscreenCanvas(T + 2 * ov, T + 2 * ov) : null;
  const cropCtx = crop?.getContext('2d') ?? null;
  const out = new Uint8Array(T * T * 4);
  const tex = makeTexture(gl);
  const t00 = now();
  for (let ty = 0; ty < H; ty += T) {
    for (let tx = 0; tx < W; tx += T) {
      // Tile with overlap on each side, clamped to the image. The overlap is
      // there for neighbourhood filters (blur, Sobel); only the inner part is kept.
      const x0 = Math.max(0, tx - ov);
      const y0 = Math.max(0, ty - ov);
      const x1 = Math.min(W, tx + T + ov);
      const y1 = Math.min(H, ty + T + ov);
      const tw = x1 - x0;
      const th = y1 - y0;
      let t0 = now();
      if (method === 'unpack-skip') {
        uploadSubRect(gl, tex, full, x0, y0, tw, th);
      } else {
        crop!.width = tw;
        crop!.height = th;
        cropCtx!.drawImage(full, x0, y0, tw, th, 0, 0, tw, th);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, crop!);
      }
      upload += now() - t0;
      t0 = now();
      const iw = Math.min(T, W - tx);
      const ih = Math.min(T, H - ty);
      renderPass(e, e.values, tex, tw, th, (g, p) => g.uniform1i(g.getUniformLocation(p, 'uLevels'), opts.levels), {
        x: tx - x0, y: ty - y0, w: iw, h: ih, out,
      });
      render += now() - t0;
      checksum = (checksum + out[0] + out[(iw * ih * 4) >> 1]) % 65521;
      tiles++;
    }
  }
  gl.deleteTexture(tex);
  if (crop) crop.width = crop.height = 0;
  s.tiledMs = round(now() - t00);
  s.tiles = tiles;
  s.tileUploadMs = round(upload);
  s.tileRenderReadMs = round(render);
  s.tileChecksum = checksum;
  // Per-tile PNG encode, to estimate the cost of a tiled export file
  const enc = new OffscreenCanvas(Math.min(T, W), Math.min(T, H));
  enc.getContext('2d')!.drawImage(full, 0, 0);
  const t0 = now();
  const png = await enc.convertToBlob({ type: 'image/png' });
  s.tilePngEncodeMs = round(now() - t0);
  s.tilePngKB = Math.round(png.size / 1024);
  enc.width = enc.height = 0;
}

let capsPromise: Promise<any> | null = null;
function capsCache() {
  return (capsPromise ??= caps());
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const { id, cmd, args } = ev.data;
  const reply = (r: WorkerResponse, transfer: Transferable[] = []) => self.postMessage(r, transfer);
  try {
    let result: any;
    switch (cmd) {
      case 'ping':
        result = { pong: true, t: now() };
        break;
      case 'caps':
        capsPromise = caps();
        result = await capsPromise;
        break;
      case 'bitmapOptions':
        result = await bitmapOptions(args.orient);
        break;
      case 'decode':
        result = await decode(args.blob);
        break;
      case 'canvasLimit':
        result = await canvasLimit(args.sizes);
        break;
      case 'pipeline': {
        const r = await pipeline(args.blob, args.label, args.opts);
        reply({ id, ok: true, result: r }, r.preview ? [r.preview] : []);
        return;
      }
      default:
        throw new Error('unknown command ' + cmd);
    }
    reply({ id, ok: true, result });
  } catch (e) {
    reply({ id, ok: false, error: errMsg(e) });
  }
};

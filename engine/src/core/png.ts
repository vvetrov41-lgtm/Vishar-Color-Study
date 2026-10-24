// Streaming PNG writer for full-resolution exports (plan, «Фото 48 МП»): rows go in band by
// band, compressed on the fly, so the 145 MB of raw RGB of a 48 MP frame never sit in one
// buffer. RGB 8-bit, filter Sub on every row, zlib through CompressionStream('deflate').

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC[(c ^ p[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length), v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32([out.subarray(4, 8 + data.length)]));
  return out;
}

export class PngWriter {
  private parts: BlobPart[] = [];
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private pump: Promise<void>;
  private rows = 0;

  constructor(readonly w: number, readonly h: number) {
    const ihdr = new Uint8Array(13), v = new DataView(ihdr.buffer);
    v.setUint32(0, w);
    v.setUint32(4, h);
    ihdr.set([8, 2, 0, 0, 0], 8);
    this.parts.push(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr) as BlobPart);
    const cs = new CompressionStream('deflate');
    this.writer = cs.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
    // Compressed bytes become IDAT chunks as they come; small pieces are gathered first.
    this.pump = (async () => {
      const reader = cs.readable.getReader();
      let buf: Uint8Array[] = [], size = 0;
      const flush = () => {
        if (!size) return;
        const data = new Uint8Array(size);
        let at = 0;
        for (const b of buf) { data.set(b, at); at += b.length; }
        this.parts.push(new Blob([chunk('IDAT', data) as BlobPart]));
        buf = []; size = 0;
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf.push(value);
        size += value.length;
        if (size >= 1 << 20) flush();
      }
      flush();
    })();
  }

  /** Appends whole rows of RGBA pixels (alpha is dropped), top to bottom. */
  async addRows(rgba: Uint8Array, rows: number): Promise<void> {
    const w = this.w, stride = w * 3 + 1, out = new Uint8Array(stride * rows);
    for (let y = 0; y < rows; y++) {
      const o = y * stride, s = y * w * 4;
      out[o] = 1; // Sub: each byte minus the same channel of the pixel to the left
      let pr = 0, pg = 0, pb = 0;
      for (let x = 0; x < w; x++) {
        const r = rgba[s + x * 4], g = rgba[s + x * 4 + 1], b = rgba[s + x * 4 + 2], q = o + 1 + x * 3;
        out[q] = (r - pr) & 255; out[q + 1] = (g - pg) & 255; out[q + 2] = (b - pb) & 255;
        pr = r; pg = g; pb = b;
      }
    }
    this.rows += rows;
    await this.writer.ready;
    await this.writer.write(out);
  }

  async finish(): Promise<Blob> {
    if (this.rows !== this.h) throw new Error(`PNG: ${this.rows} строк из ${this.h}`);
    await this.writer.close();
    await this.pump;
    this.parts.push(chunk('IEND', new Uint8Array(0)) as BlobPart);
    return new Blob(this.parts, { type: 'image/png' });
  }
}

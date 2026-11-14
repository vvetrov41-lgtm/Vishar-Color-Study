import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { PngWriter } from '../src/core/png';
import { loadFixture } from './util';

describe('streaming png', () => {
  it('writes rows band by band into a PNG that decodes to the same pixels', async () => {
    const img = loadFixture('landscape'), w = img.w, h = img.h, band = 100;
    const png = new PngWriter(w, h);
    for (let y = 0; y < h; y += band) {
      const rows = Math.min(band, h - y);
      await png.addRows(img.data.subarray(y * w * 4, (y + rows) * w * 4), rows);
    }
    const out = PNG.sync.read(Buffer.from(await (await png.finish()).arrayBuffer()));
    expect([out.width, out.height]).toEqual([w, h]);
    let diff = 0;
    for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) diff += Math.abs(out.data[i * 4 + c] - img.data[i * 4 + c]);
    expect(diff).toBe(0);
  });

  it('refuses to finish with missing rows', async () => {
    const png = new PngWriter(4, 4);
    await png.addRows(new Uint8Array(4 * 4 * 2), 2);
    await expect(png.finish()).rejects.toThrow();
  });
});

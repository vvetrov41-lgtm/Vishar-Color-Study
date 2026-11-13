import { describe, expect, it } from 'vitest';
import { DEFAULT_GRID, gridGeometry, paintGrid, type GridParams } from '../src/core/grid';

const g = (p: Partial<GridParams>): GridParams => ({ ...DEFAULT_GRID, ...p });

describe('grid', () => {
  it('equal cells: cols-1 vertical and rows-1 horizontal lines', () => {
    const { main, sub } = gridGeometry(g({ cols: 4, rows: 3, square: false }), 800, 600);
    expect(main.filter((s) => s[0] === s[2]).map((s) => s[0])).toEqual([0.25, 0.5, 0.75]);
    expect(main.filter((s) => s[1] === s[3]).length).toBe(2);
    expect(sub.length).toBe(0);
  });

  it('square cells follow the image height', () => {
    const { main } = gridGeometry(g({ cols: 4, square: true }), 800, 600);
    // Cell 200 px: horizontal lines at 200 and 400 px of 600.
    const ys = main.filter((s) => s[1] === s[3]).map((s) => Math.round(s[1] * 600));
    expect(ys).toEqual([200, 400]);
  });

  it('centimetre cells: 10 cm wide, 2 cm cells → 4 inner vertical lines', () => {
    const { main } = gridGeometry(g({ mode: 'cm', cellCm: 2, widthCm: 10 }), 1000, 500);
    expect(main.filter((s) => s[0] === s[2]).length).toBe(4);
    expect(main.filter((s) => s[1] === s[3]).map((s) => Math.round(s[1] * 500))).toEqual([200, 400]);
  });

  it('subdivisions skip the main lines, diagonals stay inside the image', () => {
    const { main, sub } = gridGeometry(g({ cols: 2, rows: 2, square: false, sub: 2, diagonals: true }), 400, 400);
    expect(main.length).toBe(2);
    const subLines = sub.filter((s) => s[0] === s[2] || s[1] === s[3]);
    expect(subLines.length).toBe(4);
    for (const s of sub) for (const v of s) { expect(v).toBeGreaterThanOrEqual(-1e-9); expect(v).toBeLessThanOrEqual(1 + 1e-9); }
    expect(sub.length - subLines.length).toBe(8);
  });

  it('too dense a grid draws nothing', () => {
    expect(gridGeometry(g({ mode: 'cm', cellCm: 0.01, widthCm: 40 }), 1000, 1000).main.length).toBe(0);
  });

  it('paints the same pixels in one pass and band by band', () => {
    const W = 300, H = 200, p = g({ cols: 3, square: true, sub: 2, diagonals: true, color: [255, 0, 0], opacity: 1 });
    const whole = new Uint8Array(W * H * 4).fill(40);
    paintGrid(whole, W, H, 0, H, p);
    const bands = new Uint8Array(W * H * 4).fill(40);
    for (let y0 = 0; y0 < H; y0 += 64) {
      const rows = Math.min(64, H - y0), band = bands.subarray(y0 * W * 4, (y0 + rows) * W * 4);
      paintGrid(band, W, H, y0, rows, p);
    }
    expect(Buffer.compare(whole, bands)).toBe(0);
    // A main vertical line at x = 100 is red, a pixel between lines keeps its value.
    const at = (x: number, y: number) => Array.from(whole.subarray((y * W + x) * 4, (y * W + x) * 4 + 3));
    expect(at(99, 10)[0] === 255 || at(100, 10)[0] === 255).toBe(true);
    expect(at(10, 37)).toEqual([40, 40, 40]);
  });
});

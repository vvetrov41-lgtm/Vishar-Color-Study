// Drawing grid over the image: equal cells, square cells or centimetre cells for a tattoo of a
// given width. One geometry feeds both the on-screen overlay (SVG) and the exported PNG
// (rasterised band by band), so what is seen is what is saved.

export type GridMode = 'cells' | 'cm';

export interface GridParams {
  mode: GridMode;
  /** Columns in «cells» mode. */
  cols: number;
  /** Rows in «cells» mode, ignored when `square`. */
  rows: number;
  /** Square cells: the cell side is width / cols, rows follow the image height. */
  square: boolean;
  /** Cell side in cm in «cm» mode, against `widthCm` of the whole image. */
  cellCm: number;
  widthCm: number;
  /** Subdivisions per cell side (1 = none), drawn thinner. */
  sub: number;
  diagonals: boolean;
  color: [number, number, number];
  /** 0…1. */
  opacity: number;
}

export const DEFAULT_GRID: GridParams = {
  mode: 'cells', cols: 4, rows: 4, square: true, cellCm: 1, widthCm: 10, sub: 1, diagonals: false, color: [255, 255, 255], opacity: 0.8,
};

/** A segment in image coordinates 0…1 (x across the width, y down the height). */
export type Seg = [number, number, number, number];

export interface GridGeometry { main: Seg[]; sub: Seg[] }

const MAX_LINES = 400;

/** Cell size in normalised units along x and y for an image `w`×`h`. */
function cellSize(p: GridParams, w: number, h: number): [number, number] {
  if (p.mode === 'cm') {
    const cx = Math.max(1e-3, p.cellCm / Math.max(1e-3, p.widthCm));
    return [cx, (cx * w) / h];
  }
  const cols = Math.max(1, Math.round(p.cols));
  const cx = 1 / cols;
  return p.square ? [cx, (cx * w) / h] : [cx, 1 / Math.max(1, Math.round(p.rows))];
}

/** Liang–Barsky clip of a segment to the unit square; null when outside. */
function clip([x1, y1, x2, y2]: Seg): Seg | null {
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  for (const [p, q] of [[-dx, x1], [dx, 1 - x1], [-dy, y1], [dy, 1 - y1]] as const) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
}

/** Lines of the grid for an image `w`×`h` px. The outer border is not drawn. */
export function gridGeometry(p: GridParams, w: number, h: number): GridGeometry {
  const [cx, cy] = cellSize(p, w, h), sub = Math.max(1, Math.round(p.sub));
  const main: Seg[] = [], subs: Seg[] = [];
  const eps = 1e-6;
  // Too dense to read (and to draw): no grid at all rather than a grey veil.
  if (1 / cx > MAX_LINES || 1 / cy > MAX_LINES || sub / cx > MAX_LINES * 2 || sub / cy > MAX_LINES * 2) return { main, sub: subs };
  for (let k = 1; k * cx < 1 - eps; k++) main.push([k * cx, 0, k * cx, 1]);
  for (let k = 1; k * cy < 1 - eps; k++) main.push([0, k * cy, 1, k * cy]);
  if (sub > 1) {
    const sx = cx / sub, sy = cy / sub;
    for (let k = 1; k * sx < 1 - eps; k++) if (k % sub) subs.push([k * sx, 0, k * sx, 1]);
    for (let k = 1; k * sy < 1 - eps; k++) if (k % sub) subs.push([0, k * sy, 1, k * sy]);
  }
  if (p.diagonals) {
    for (let i = 0; i * cx < 1 - eps; i++) {
      for (let j = 0; j * cy < 1 - eps; j++) {
        const x0 = i * cx, y0 = j * cy;
        for (const s of [[x0, y0, x0 + cx, y0 + cy], [x0 + cx, y0, x0, y0 + cy]] as Seg[]) {
          const c = clip(s);
          if (c) subs.push(c);
        }
      }
    }
  }
  return { main, sub: subs };
}

/** Line widths in px for an image whose longer side is `long` px: readable at any export size. */
export function lineWidths(long: number): { main: number; sub: number } {
  const main = Math.max(1, Math.round(long / 700));
  return { main, sub: Math.max(1, Math.round(main / 2)) };
}

/**
 * Paints the grid into RGBA rows `y0 … y0 + rows - 1` of a `W`×`H` image held in `px`
 * (row-major, width W, starting at row y0). Sub-lines and diagonals get half the opacity.
 */
export function paintGrid(px: Uint8Array | Uint8ClampedArray, W: number, H: number, y0: number, rows: number, p: GridParams, g = gridGeometry(p, W, H)): void {
  const lw = lineWidths(Math.max(W, H));
  const [r, gg, b] = p.color;
  const blend = (x: number, y: number, a: number) => {
    if (x < 0 || x >= W || y < y0 || y >= y0 + rows || y >= H) return;
    const i = ((y - y0) * W + x) * 4;
    px[i] += (r - px[i]) * a;
    px[i + 1] += (gg - px[i + 1]) * a;
    px[i + 2] += (b - px[i + 2]) * a;
  };
  const draw = (segs: Seg[], width: number, a: number) => {
    if (a <= 0) return;
    const half = (width - 1) / 2;
    for (const [x1, y1, x2, y2] of segs) {
      const X1 = x1 * W, Y1 = y1 * H, X2 = x2 * W, Y2 = y2 * H;
      if (Math.abs(X1 - X2) < 1e-6) {
        // Vertical.
        const xc = Math.round(X1 - half - 0.5);
        const ya = Math.max(y0, Math.floor(Math.min(Y1, Y2))), yb = Math.min(y0 + rows, Math.ceil(Math.max(Y1, Y2)));
        for (let y = ya; y < yb; y++) for (let k = 0; k < width; k++) blend(xc + k, y, a);
      } else if (Math.abs(Y1 - Y2) < 1e-6) {
        // Horizontal.
        const yc = Math.round(Y1 - half - 0.5);
        for (let k = 0; k < width; k++) {
          const y = yc + k;
          if (y < y0 || y >= y0 + rows) continue;
          const xa = Math.max(0, Math.floor(Math.min(X1, X2))), xb = Math.min(W, Math.ceil(Math.max(X1, X2)));
          for (let x = xa; x < xb; x++) blend(x, y, a);
        }
      } else {
        // Diagonal: one run per row, as wide as the line is across.
        const slope = (X2 - X1) / (Y2 - Y1), across = Math.max(1, Math.round(width * Math.hypot(1, slope)));
        const ya = Math.max(y0, Math.floor(Math.min(Y1, Y2))), yb = Math.min(y0 + rows, Math.ceil(Math.max(Y1, Y2)));
        for (let y = ya; y < yb; y++) {
          const xc = Math.round(X1 + (y + 0.5 - Y1) * slope - across / 2);
          for (let k = 0; k < across; k++) blend(xc + k, y, a);
        }
      }
    }
  };
  draw(g.sub, lw.sub, p.opacity * 0.6);
  draw(g.main, lw.main, p.opacity);
}

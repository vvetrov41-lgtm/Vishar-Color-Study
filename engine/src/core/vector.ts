// Vector export of a line drawing: the ink mask becomes closed outlines (even-odd fill),
// traced along pixel edges and straightened with Ramer–Douglas–Peucker. One <path>, plain
// SVG 1.1, so Illustrator, Inkscape, Affinity and browsers open it as editable shapes.

export interface TraceOptions {
  /** RDP tolerance, px: 0.7 turns pixel staircases into straight segments. */
  tolerance?: number;
  /** Outlines enclosing less than this many px² are dropped (single-pixel noise). */
  minArea?: number;
}

export type Loop = Int32Array; // x0, y0, x1, y1, … corner coordinates

// Directions: 0 right, 1 down, 2 left, 3 up (y grows downwards).
const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];

/**
 * Boundary loops of a 0/1 mask. Every ink pixel contributes its edges that face paper,
 * clockwise on screen; at a saddle the walk turns towards the ink, so two pixels that touch
 * only at a corner get separate outlines.
 */
export function traceLoops(mask: ArrayLike<number>, w: number, h: number): Loop[] {
  const W = w + 1, out = new Uint8Array(W * (h + 1));
  const ink = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] > 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    if (!ink(x, y - 1)) out[y * W + x] |= 1;
    if (!ink(x + 1, y)) out[y * W + x + 1] |= 2;
    if (!ink(x, y + 1)) out[(y + 1) * W + x + 1] |= 4;
    if (!ink(x - 1, y)) out[(y + 1) * W + x] |= 8;
  }
  const loops: Loop[] = [], pts: number[] = [];
  for (let v0 = 0; v0 < out.length; v0++) {
    while (out[v0]) {
      let d0 = 0;
      while (!(out[v0] & (1 << d0))) d0++;
      pts.length = 0;
      let v = v0, d = d0, x = v0 % W, y = (v0 / W) | 0;
      pts.push(x, y);
      for (;;) {
        out[v] &= ~(1 << d);
        x += DX[d]; y += DY[d]; v = y * W + x;
        // Right turn first (towards the ink), then straight, then left.
        let next = -1;
        for (const nd of [(d + 1) & 3, d, (d + 3) & 3]) {
          if (v === v0 && nd === d0) break;
          if (out[v] & (1 << nd)) { next = nd; break; }
        }
        if (next < 0) break;
        if (next !== d) pts.push(x, y);
        d = next;
      }
      loops.push(Int32Array.from(pts));
    }
  }
  return loops;
}

/** Signed area (shoelace), px². */
export function loopArea(l: Loop): number {
  let a = 0;
  for (let i = 0, n = l.length; i < n; i += 2) {
    const j = (i + 2) % n;
    a += l[i] * l[j + 1] - l[j] * l[i + 1];
  }
  return a / 2;
}

function rdp(xs: number[], ys: number[], a: number, b: number, tol2: number, keep: Uint8Array) {
  let best = -1, bd = tol2;
  const ax = xs[a], ay = ys[a], dx = xs[b] - ax, dy = ys[b] - ay, len2 = dx * dx + dy * dy;
  for (let i = a + 1; i < b; i++) {
    const px = xs[i] - ax, py = ys[i] - ay;
    const d = len2 ? (px * dy - py * dx) ** 2 / len2 : px * px + py * py;
    if (d > bd) { bd = d; best = i; }
  }
  if (best < 0) return;
  keep[best] = 1;
  rdp(xs, ys, a, best, tol2, keep);
  rdp(xs, ys, best, b, tol2, keep);
}

/** RDP on a closed loop: split at the vertex farthest from the first one. */
export function simplifyLoop(l: Loop, tol: number): Loop {
  const n = l.length >> 1;
  if (n <= 4) return l;
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < n; i++) { xs.push(l[i * 2]); ys.push(l[i * 2 + 1]); }
  xs.push(xs[0]); ys.push(ys[0]);
  let far = 1, fd = -1;
  for (let i = 1; i < n; i++) { const d = (xs[i] - xs[0]) ** 2 + (ys[i] - ys[0]) ** 2; if (d > fd) { fd = d; far = i; } }
  const keep = new Uint8Array(n + 1);
  keep[0] = keep[far] = keep[n] = 1;
  rdp(xs, ys, 0, far, tol * tol, keep);
  rdp(xs, ys, far, n, tol * tol, keep);
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(xs[i], ys[i]);
  return out.length >= 6 ? Int32Array.from(out) : l;
}

export interface SvgResult {
  svg: string;
  loops: number;
  points: number;
}

/** Ink mask → SVG document: black outlines on a transparent sheet, or white on black when inverted. */
export function maskToSvg(mask: ArrayLike<number>, w: number, h: number, invert = false, opts: TraceOptions = {}): SvgResult {
  const tol = opts.tolerance ?? 0.7, minArea = opts.minArea ?? 2;
  const parts: string[] = [];
  let loops = 0, points = 0;
  for (const raw of traceLoops(mask, w, h)) {
    if (Math.abs(loopArea(raw)) < minArea) continue;
    const l = simplifyLoop(raw, tol);
    let s = 'M' + l[0] + ' ' + l[1];
    for (let i = 2; i < l.length; i += 2) s += ' ' + l[i] + ' ' + l[i + 1];
    parts.push(s + 'Z');
    loops++;
    points += l.length >> 1;
  }
  // No background unless inverted: black ink on a transparent sheet drops straight onto a layer.
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n`
    + (invert ? `<rect width="${w}" height="${h}" fill="#000"/>\n` : '')
    + `<path fill="${invert ? '#fff' : '#000'}" fill-rule="evenodd" d="${parts.join('')}"/>\n</svg>\n`;
  return { svg, loops, points };
}

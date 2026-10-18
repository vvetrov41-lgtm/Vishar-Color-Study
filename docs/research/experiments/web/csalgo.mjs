// Vishar Color Study — prototype algorithms for experiments (own implementation, no third-party code).
// Pure functions over typed arrays: runs in Node, a Web Worker, or Safari unchanged.
// Image = { w, h, rgb: Uint8Array (3 bytes per pixel) }.

// ---------- colour space ----------
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
const fLab = t => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const Xn = 0.95047, Zn = 1.08883;

export function toLab(img) {
  const n = img.w * img.h, L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n), p = img.rgb;
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const r = LIN[p[j]], g = LIN[p[j + 1]], b = LIN[p[j + 2]];
    const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / Xn, y = 0.2126 * r + 0.7152 * g + 0.0722 * b, z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / Zn;
    const fx = fLab(x), fy = fLab(y), fz = fLab(z);
    L[i] = 116 * fy - 16; A[i] = 500 * (fx - fy); B[i] = 200 * (fy - fz);
  }
  return { w: img.w, h: img.h, L, A, B };
}

export function labToRgb(L, a, b) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = f => (f ** 3 > 216 / 24389 ? f ** 3 : (116 * f - 16) / (24389 / 27));
  const x = inv(fx) * Xn, y = inv(fy), z = inv(fz) * Zn;
  const r = 3.2406 * x - 1.5372 * y - 0.4986 * z, g = -0.9689 * x + 1.8758 * y + 0.0415 * z, bl = 0.0557 * x - 0.204 * y + 1.057 * z;
  const enc = c => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)));
  return [enc(r), enc(g), enc(bl)];
}

export const deltaE76 = (l1, a1, b1, l2, a2, b2) => Math.hypot(l1 - l2, a1 - a2, b1 - b2);

// ---------- resampling & smoothing ----------
export function downscale(img, maxSide) {
  const s = Math.min(1, maxSide / Math.max(img.w, img.h));
  if (s === 1) return img;
  const w = Math.max(1, Math.round(img.w * s)), h = Math.max(1, Math.round(img.h * s)), out = new Uint8Array(w * h * 3);
  const fx = img.w / w, fy = img.h / h;
  for (let y = 0; y < h; y++) {   // box filter (area average) — no aliasing on large downscale
    const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let r = 0, g = 0, b = 0, c = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0, j = (yy * img.w + x0) * 3; xx < x1; xx++, j += 3) { r += img.rgb[j]; g += img.rgb[j + 1]; b += img.rgb[j + 2]; c++; }
      const o = (y * w + x) * 3; out[o] = r / c; out[o + 1] = g / c; out[o + 2] = b / c;
    }
  }
  return { w, h, rgb: out };
}

export function boxBlur(ch, w, h, r) {   // separable running-sum box blur, O(n) regardless of radius
  if (r < 1) return ch;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), d = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const o = y * w; let s = 0;
    for (let x = -r; x <= r; x++) s += ch[o + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) { tmp[o + x] = s / d; s += ch[o + Math.min(w - 1, x + r + 1)] - ch[o + Math.max(0, x - r)]; }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) { out[y * w + x] = s / d; s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; }
  }
  return out;
}
// 3 box passes ≈ Gaussian. level: 0 none, 1 subtle, 2 strong; radius scales with image size.
export function smooth(ch, w, h, level) {
  if (!level) return ch;
  const r = Math.max(1, Math.round(Math.max(w, h) * (level === 1 ? 0.0015 : 0.004)));
  return boxBlur(boxBlur(boxBlur(ch, w, h, r), w, h, r), w, h, r);
}

// ---------- values ----------
function hist256(L) { const hst = new Float64Array(256); for (let i = 0; i < L.length; i++) hst[Math.min(255, Math.max(0, Math.round(L[i] * 2.55)))]++; return hst; }

export function evenBins(k) { return Array.from({ length: k - 1 }, (_, i) => (100 * (i + 1)) / k); }

// 1-D k-means on the 256-bin L* histogram: cost O(256·k·iter), independent of image size.
export function kmeansBins(L, k, iters = 50) {
  const hst = hist256(L), total = L.length;
  let c = [], acc = 0, q = 1;           // init at quantiles
  for (let v = 0; v < 256 && c.length < k; v++) { acc += hst[v]; while (acc >= (q - 0.5) * total / k && c.length < k) { c.push(v); q++; } }
  while (c.length < k) c.push(255);
  for (let it = 0; it < iters; it++) {
    const s = new Float64Array(k), n = new Float64Array(k);
    for (let v = 0; v < 256; v++) { if (!hst[v]) continue; let bi = 0, bd = 1e9; for (let j = 0; j < k; j++) { const d = Math.abs(v - c[j]); if (d < bd) { bd = d; bi = j; } } s[bi] += v * hst[v]; n[bi] += hst[v]; }
    const nc = c.map((cv, j) => (n[j] ? s[j] / n[j] : cv)).sort((a, b) => a - b);
    if (nc.every((v, j) => Math.abs(v - c[j]) < 0.01)) { c = nc; break; }
    c = nc;
  }
  return c.slice(1).map((v, j) => (c[j] + v) / 2 / 2.55);   // thresholds in L*
}

export function quantize(L, thresholds) {
  const out = new Uint8Array(L.length), t = thresholds;
  for (let i = 0; i < L.length; i++) { let j = 0; while (j < t.length && L[i] >= t[j]) j++; out[i] = j; }
  return out;
}
export function levelMeans(L, labels, k) { const s = new Float64Array(k), n = new Float64Array(k); for (let i = 0; i < L.length; i++) { s[labels[i]] += L[i]; n[labels[i]]++; } return Array.from(s, (v, j) => (n[j] ? v / n[j] : 0)); }
export function quantMSE(L, labels, means) { let e = 0; for (let i = 0; i < L.length; i++) e += (L[i] - means[labels[i]]) ** 2; return e / L.length; }

// connected components (4-neighbour) over a label map; returns {count, sizes, comp}
export function components(labels, w, h) {
  const comp = new Int32Array(w * h).fill(-1), stack = new Int32Array(w * h), sizes = [];
  let count = 0;
  for (let s = 0; s < w * h; s++) {
    if (comp[s] >= 0) continue;
    const lab = labels[s]; let sp = 0, size = 0; stack[sp++] = s; comp[s] = count;
    while (sp) {
      const p = stack[--sp]; size++; const x = p % w, y = (p / w) | 0;
      if (x > 0 && comp[p - 1] < 0 && labels[p - 1] === lab) { comp[p - 1] = count; stack[sp++] = p - 1; }
      if (x < w - 1 && comp[p + 1] < 0 && labels[p + 1] === lab) { comp[p + 1] = count; stack[sp++] = p + 1; }
      if (y > 0 && comp[p - w] < 0 && labels[p - w] === lab) { comp[p - w] = count; stack[sp++] = p - w; }
      if (y < h - 1 && comp[p + w] < 0 && labels[p + w] === lab) { comp[p + w] = count; stack[sp++] = p + w; }
    }
    sizes.push(size); count++;
  }
  return { count, sizes, comp };
}

// merge regions smaller than minArea into the neighbouring label they touch most
export function mergeSmall(labels, w, h, minArea, passes = 3) {
  const lab = labels.slice();
  for (let pass = 0; pass < passes; pass++) {
    const { count, sizes, comp } = components(lab, w, h);
    let changed = 0;
    const votes = new Map();
    for (let p = 0; p < w * h; p++) {
      const c = comp[p]; if (sizes[c] >= minArea) continue;
      const x = p % w, y = (p / w) | 0;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q < 0 || comp[q] === c) continue;
        let m = votes.get(c); if (!m) votes.set(c, (m = new Map()));
        m.set(lab[q], (m.get(lab[q]) || 0) + 1);
      }
    }
    const target = new Map();
    for (const [c, m] of votes) { let best = -1, bv = -1; for (const [l, v] of m) if (v > bv) { bv = v; best = l; } target.set(c, best); }
    for (let p = 0; p < w * h; p++) { const t = target.get(comp[p]); if (t !== undefined && t !== lab[p]) { lab[p] = t; changed++; } }
    void count; if (!changed) break;
  }
  return lab;
}

// ---------- notan ----------
export function median(L) { const h = hist256(L); let acc = 0; for (let v = 0; v < 256; v++) { acc += h[v]; if (acc >= L.length / 2) return v / 2.55; } return 50; }
export function notan(L, balance = 0) { const t = median(L) + balance, out = new Uint8Array(L.length); let dark = 0; for (let i = 0; i < L.length; i++) { out[i] = L[i] >= t ? 1 : 0; dark += 1 - out[i]; } return { mask: out, threshold: t, darkRatio: dark / L.length }; }

// ---------- temperature ----------
// warmth = projection of (a*,b*) on the orange axis (hue ≈ 60°) minus the image median → relative warm/cool.
export function temperature(lab, balance = 0) {
  const n = lab.L.length, wv = new Float32Array(n), ux = Math.cos(Math.PI / 3), uy = Math.sin(Math.PI / 3);
  for (let i = 0; i < n; i++) wv[i] = lab.A[i] * ux + lab.B[i] * uy;
  const sorted = Float32Array.from(wv).sort(), med = sorted[n >> 1] + balance, out = new Float32Array(n);
  let warm = 0; for (let i = 0; i < n; i++) { out[i] = wv[i] - med; if (out[i] > 0) warm++; }
  return { rel: out, median: med, warmRatio: warm / n };
}

// ---------- k-means in Lab (palette + simplify clustering) ----------
function rand(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
export function kmeansLab(lab, k, { sample = 40000, iters = 20, seed = 7 } = {}) {
  const n = lab.L.length, step = Math.max(1, Math.floor(n / sample)), idx = [];
  for (let i = 0; i < n; i += step) idx.push(i);
  const m = idx.length, P = new Float32Array(m * 3), r = rand(seed);
  idx.forEach((p, j) => { P[j * 3] = lab.L[p]; P[j * 3 + 1] = lab.A[p]; P[j * 3 + 2] = lab.B[p]; });
  const C = new Float32Array(k * 3), D = new Float32Array(m).fill(Infinity);   // k-means++ init
  let f = Math.floor(r() * m); C.set(P.subarray(f * 3, f * 3 + 3), 0);
  for (let c = 1; c < k; c++) {
    let sum = 0;
    for (let j = 0; j < m; j++) { const d = (P[j * 3] - C[(c - 1) * 3]) ** 2 + (P[j * 3 + 1] - C[(c - 1) * 3 + 1]) ** 2 + (P[j * 3 + 2] - C[(c - 1) * 3 + 2]) ** 2; if (d < D[j]) D[j] = d; sum += D[j]; }
    let t = r() * sum, j = 0; for (; j < m - 1; j++) { t -= D[j]; if (t <= 0) break; }
    C.set(P.subarray(j * 3, j * 3 + 3), c * 3);
  }
  const asg = new Int32Array(m);
  for (let it = 0; it < iters; it++) {
    const S = new Float64Array(k * 3), N = new Float64Array(k); let moved = 0;
    for (let j = 0; j < m; j++) {
      let bi = 0, bd = Infinity;
      for (let c = 0; c < k; c++) { const d = (P[j * 3] - C[c * 3]) ** 2 + (P[j * 3 + 1] - C[c * 3 + 1]) ** 2 + (P[j * 3 + 2] - C[c * 3 + 2]) ** 2; if (d < bd) { bd = d; bi = c; } }
      if (asg[j] !== bi) moved++; asg[j] = bi; S[bi * 3] += P[j * 3]; S[bi * 3 + 1] += P[j * 3 + 1]; S[bi * 3 + 2] += P[j * 3 + 2]; N[bi]++;
    }
    for (let c = 0; c < k; c++) if (N[c]) { C[c * 3] = S[c * 3] / N[c]; C[c * 3 + 1] = S[c * 3 + 1] / N[c]; C[c * 3 + 2] = S[c * 3 + 2] / N[c]; }
    if (moved < m * 0.001) break;
  }
  return C;
}
export function assign(lab, C) {
  const k = C.length / 3, n = lab.L.length, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) { let bi = 0, bd = Infinity; for (let c = 0; c < k; c++) { const d = (lab.L[i] - C[c * 3]) ** 2 + (lab.A[i] - C[c * 3 + 1]) ** 2 + (lab.B[i] - C[c * 3 + 2]) ** 2; if (d < bd) { bd = d; bi = c; } } out[i] = bi; }
  return out;
}

// Simplify / Clustering: details ∈ [0,1] → k and min region area.
export function simplifyCluster(lab, details, smoothing = 1) {
  const { w, h } = lab, k = Math.round(4 + details * 20);
  const s = { w, h, L: smooth(lab.L, w, h, smoothing), A: smooth(lab.A, w, h, smoothing), B: smooth(lab.B, w, h, smoothing) };
  const C = kmeansLab(s, k), labels = mergeSmall(assign(s, C), w, h, Math.round(w * h * (0.002 - details * 0.0018)));
  return { labels, C, k };
}

// Simplify / Graph: Felzenszwalb–Huttenlocher (2004) on Lab, 4-neighbour grid.
export function simplifyGraph(lab, kParam = 300, minSize = 200) {
  const { w, h } = lab, n = w * h, m = (w - 1) * h + w * (h - 1);
  const ea = new Int32Array(m), eb = new Int32Array(m), ew = new Float32Array(m); let e = 0;
  const dist = (p, q) => Math.hypot(lab.L[p] - lab.L[q], lab.A[p] - lab.A[q], lab.B[p] - lab.B[q]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = y * w + x; if (x < w - 1) { ea[e] = p; eb[e] = p + 1; ew[e++] = dist(p, p + 1); } if (y < h - 1) { ea[e] = p; eb[e] = p + w; ew[e++] = dist(p, p + w); } }
  const order = new Uint32Array(m).map((_, i) => i).sort((i, j) => ew[i] - ew[j]);
  const par = new Int32Array(n).map((_, i) => i), sz = new Int32Array(n).fill(1), th = new Float32Array(n).fill(kParam);
  const find = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (const i of order) { let a = find(ea[i]), b = find(eb[i]); if (a === b) continue; if (ew[i] <= th[a] && ew[i] <= th[b]) { if (sz[a] < sz[b]) [a, b] = [b, a]; par[b] = a; sz[a] += sz[b]; th[a] = ew[i] + kParam / sz[a]; } }
  for (const i of order) { const a = find(ea[i]), b = find(eb[i]); if (a !== b && (sz[a] < minSize || sz[b] < minSize)) { if (sz[a] < sz[b]) { par[a] = b; sz[b] += sz[a]; } else { par[b] = a; sz[a] += sz[b]; } } }
  const labels = new Int32Array(n); for (let i = 0; i < n; i++) labels[i] = find(i);
  return labels;
}

export function regionMeanRgb(img, labels) {
  const sums = new Map(), out = new Uint8Array(img.rgb.length);
  for (let i = 0; i < labels.length; i++) { let s = sums.get(labels[i]); if (!s) sums.set(labels[i], (s = [0, 0, 0, 0])); s[0] += img.rgb[i * 3]; s[1] += img.rgb[i * 3 + 1]; s[2] += img.rgb[i * 3 + 2]; s[3]++; }
  for (let i = 0; i < labels.length; i++) { const s = sums.get(labels[i]); out[i * 3] = s[0] / s[3]; out[i * 3 + 1] = s[1] / s[3]; out[i * 3 + 2] = s[2] / s[3]; }
  return { w: img.w, h: img.h, rgb: out, regions: sums.size };
}

export function posterize(img, levels) { const out = new Uint8Array(img.rgb.length), st = 255 / (levels - 1); for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.round(img.rgb[i] / st) * st); return { w: img.w, h: img.h, rgb: out }; }

// ---------- palette extraction ----------
export function extractPalette(lab, n = 6) {
  const total = lab.L.length, C = kmeansLab(lab, 24), lbl = assign(lab, C), cnt = new Float64Array(24);
  for (let i = 0; i < total; i++) cnt[lbl[i]]++;
  const cl = [...Array(24).keys()].map(c => ({ L: C[c * 3], a: C[c * 3 + 1], b: C[c * 3 + 2], share: cnt[c] / total })).filter(c => c.share > 0);
  // dominant: greedy by share, skipping near-duplicates (ΔE < 10)
  const dominant = [];
  for (const c of [...cl].sort((x, y) => y.share - x.share)) { if (dominant.every(d => deltaE76(d.L, d.a, d.b, c.L, c.a, c.b) > 10)) dominant.push(c); if (dominant.length === n) break; }
  // range: mean colour in n L*-quantile bands
  const order = Uint32Array.from({ length: total }, (_, i) => i).sort((i, j) => lab.L[i] - lab.L[j]), range = [];
  for (let q = 0; q < n; q++) { let L = 0, a = 0, b = 0; const s = Math.floor(q * total / n), e = Math.floor((q + 1) * total / n); for (let t = s; t < e; t++) { const p = order[t]; L += lab.L[p]; a += lab.A[p]; b += lab.B[p]; } const m = e - s; range.push({ L: L / m, a: a / m, b: b / m, share: m / total }); }
  // accents: chroma × distance from the dominant set, ignoring clusters under 0.05 %
  const accents = cl.filter(c => c.share > 0.0005).map(c => ({ ...c, score: Math.hypot(c.a, c.b) * Math.min(...dominant.map(d => deltaE76(d.L, d.a, d.b, c.L, c.a, c.b))) })).filter(c => c.score > 300).sort((x, y) => y.score - x.score).slice(0, n);
  return { dominant, range, accents };
}

// ---------- drawing ----------
export function sobel(ch, w, h) {
  const mag = new Float32Array(w * h), dir = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = y * w + x, a = ch[p - w - 1], b = ch[p - w], c = ch[p - w + 1], d = ch[p - 1], f = ch[p + 1], g = ch[p + w - 1], i = ch[p + w], j = ch[p + w + 1];
    const gx = c + 2 * f + j - a - 2 * d - g, gy = g + 2 * i + j - a - 2 * b - c; mag[p] = Math.hypot(gx, gy); dir[p] = Math.atan2(gy, gx);
  }
  return { mag, dir };
}
// Contours: Canny (NMS + hysteresis) on smoothed L*.
export function contours(L, w, h, { blur = 2, lo = 8, hi = 20 } = {}) {
  const s = smooth(L, w, h, blur), { mag, dir } = sobel(s, w, h), nms = new Float32Array(w * h), out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = y * w + x, a = ((dir[p] * 180 / Math.PI) + 180) % 180;
    const [o1, o2] = a < 22.5 || a >= 157.5 ? [-1, 1] : a < 67.5 ? [-w - 1, w + 1] : a < 112.5 ? [-w, w] : [-w + 1, w - 1];
    if (mag[p] >= mag[p + o1] && mag[p] >= mag[p + o2]) nms[p] = mag[p];
  }
  const st = []; for (let p = 0; p < w * h; p++) if (nms[p] >= hi) { out[p] = 1; st.push(p); }
  while (st.length) { const p = st.pop(); for (const o of [-1, 1, -w, w, -w - 1, -w + 1, w - 1, w + 1]) { const q = p + o; if (q > 0 && q < w * h && !out[q] && nms[q] >= lo) { out[q] = 1; st.push(q); } } }
  return out;
}
// Sketch: XDoG (Winnemöller 2012) — difference of two blurs with soft threshold.
export function sketch(L, w, h, { r = 1, k = 2, eps = 0.4, phi = 0.6 } = {}) {
  const g = rr => boxBlur(boxBlur(boxBlur(L, w, h, rr), w, h, rr), w, h, rr);
  const g1 = g(r), g2 = g(Math.max(r + 1, Math.round(r * k))), out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) { const u = g1[i] - g2[i]; out[i] = u >= -eps ? 1 : Math.max(0, 1 + Math.tanh(phi * (u + eps))); }
  return out;   // 1 = paper, 0 = full stroke
}

// ---------- tattoo readability (Vishar-specific heuristics) ----------
// Simulate viewing a design printed widthCm wide from distanceCm, and healed-ink spread.
// Visual acuity ~1 arc-minute; blur sigma ≈ size of 1 arcmin at that distance, in pixels of the design.
export function viewBlurPx(imgW, widthCm, distanceCm, arcmin = 1) { const cmPerPx = widthCm / imgW, blurCm = distanceCm * Math.tan((arcmin / 60) * Math.PI / 180); return blurCm / cmPerPx; }
export function iou(a, b) { let i = 0, u = 0; for (let p = 0; p < a.length; p++) { const x = !a[p], y = !b[p]; if (x && y) i++; if (x || y) u++; } return u ? i / u : 1; }
// Minimum ΔL* across every boundary between adjacent value regions (low = muddy, merges with time).
export function boundaryContrast(levelMeansArr, labels, w, h) {
  const k = levelMeansArr.length, seen = new Float64Array(k * k);
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) { const p = y * w + x; for (const q of [p + 1, p + w]) if (labels[p] !== labels[q]) seen[labels[p] * k + labels[q]]++; }
  const pairs = []; for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) { const c = seen[a * k + b] + seen[b * k + a]; if (c) pairs.push({ a, b, dL: Math.abs(levelMeansArr[a] - levelMeansArr[b]), border: c }); }
  return pairs.sort((x, y) => x.dL - y.dL);
}

// ---------- experiment 2: alternatives for images with a dominant background ----------
// Same 1-D k-means but each histogram bin weighted by count^gamma (gamma<1 boosts rare tones: thin lines, highlights).
export function kmeansBinsWeighted(L, k, gamma = 0.5, iters = 60) {
  const raw = hist256(L), hst = raw.map(v => (v ? v ** gamma : 0)), total = hst.reduce((a, b) => a + b, 0);
  let c = [], acc = 0, q = 1;
  for (let v = 0; v < 256 && c.length < k; v++) { acc += hst[v]; while (acc >= (q - 0.5) * total / k && c.length < k) { c.push(v); q++; } }
  while (c.length < k) c.push(255);
  for (let it = 0; it < iters; it++) {
    const s = new Float64Array(k), n = new Float64Array(k);
    for (let v = 0; v < 256; v++) { if (!hst[v]) continue; let bi = 0, bd = 1e9; for (let j = 0; j < k; j++) { const d = Math.abs(v - c[j]); if (d < bd) { bd = d; bi = j; } } s[bi] += v * hst[v]; n[bi] += hst[v]; }
    c = c.map((cv, j) => (n[j] ? s[j] / n[j] : cv)).sort((a, b) => a - b);
  }
  return c.slice(1).map((v, j) => (c[j] + v) / 2 / 2.55);
}
// Otsu threshold on L* (maximises between-class variance) — alternative default for Notan.
export function otsu(L) {
  const h = hist256(L), n = L.length; let sum = 0; for (let v = 0; v < 256; v++) sum += v * h[v];
  let wB = 0, sB = 0, best = 0, t = 0;
  for (let v = 0; v < 256; v++) { wB += h[v]; if (!wB) continue; const wF = n - wB; if (!wF) break; sB += v * h[v]; const mB = sB / wB, mF = (sum - sB) / wF, b = wB * wF * (mB - mF) ** 2; if (b > best) { best = b; t = v; } }
  return (t + 0.5) / 2.55;
}

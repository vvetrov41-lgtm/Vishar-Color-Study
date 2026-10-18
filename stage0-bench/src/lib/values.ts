// CPU side of the Values tool: 256-bin luma histogram and 1-D k-means.
// Rec.709 luma on gamma-encoded values, as in the original's Values fit
// (see color-study-research/experiments/original_web/values_fit.txt).

export function lumaHistogram(rgba: Uint8ClampedArray | Uint8Array): Float64Array {
  const h = new Float64Array(256);
  for (let i = 0; i < rgba.length; i += 4) {
    h[(0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2] + 0.5) | 0]++;
  }
  return h;
}

/**
 * 1-D k-means over a histogram.
 * sqrtWeights=false: every pixel counts (compatibility mode with the original).
 * sqrtWeights=true: bins weighted by √count, the optional mode that keeps
 * small tonal groups from being swallowed when levels are few.
 */
export function kmeans1d(hist: Float64Array, k: number, sqrtWeights: boolean, iters = 30): number[] {
  const w = sqrtWeights ? hist.map(Math.sqrt) : hist;
  let total = 0;
  for (let i = 0; i < 256; i++) total += w[i];
  // Quantile initialisation
  const c: number[] = [];
  let acc = 0;
  let next = 0;
  for (let i = 0; i < 256 && c.length < k; i++) {
    acc += w[i];
    while (c.length < k && acc >= ((next + 0.5) / k) * total) {
      c.push(i);
      next++;
    }
  }
  while (c.length < k) c.push(255);
  for (let it = 0; it < iters; it++) {
    const sum = new Float64Array(k);
    const cnt = new Float64Array(k);
    let j = 0;
    for (let i = 0; i < 256; i++) {
      while (j < k - 1 && Math.abs(i - c[j + 1]) < Math.abs(i - c[j])) j++;
      sum[j] += i * w[i];
      cnt[j] += w[i];
    }
    let moved = false;
    for (let m = 0; m < k; m++) {
      if (cnt[m] > 0) {
        const v = sum[m] / cnt[m];
        if (Math.abs(v - c[m]) > 1e-3) moved = true;
        c[m] = v;
      }
    }
    c.sort((a, b) => a - b);
    if (!moved) break;
  }
  return c;
}

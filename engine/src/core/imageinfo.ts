// Source size from the file header, without decoding pixels. Needed to pick the
// working-copy size for decode-to-size and to estimate memory before decoding.
// Sizes are returned after EXIF / irot rotation, i.e. as the photo is displayed.

export interface ImageInfo {
  format: 'jpeg' | 'png' | 'webp' | 'heic' | 'unknown';
  width: number;
  height: number;
  /** True when the size comes from a heuristic (HEIC box scan). */
  approx?: boolean;
}

const u16be = (d: Uint8Array, i: number) => (d[i] << 8) | d[i + 1];
const u32be = (d: Uint8Array, i: number) => ((d[i] << 24) >>> 0) + (d[i + 1] << 16) + (d[i + 2] << 8) + d[i + 3];
const ascii = (d: Uint8Array, i: number, n: number) => String.fromCharCode(...d.subarray(i, i + n));

function exifOrientation(d: Uint8Array, start: number, len: number): number {
  if (ascii(d, start, 4) !== 'Exif') return 1;
  const t = start + 6, le = d[t] === 0x49;
  const r16 = (i: number) => (le ? d[i] | (d[i + 1] << 8) : u16be(d, i));
  const r32 = (i: number) => (le ? (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16)) + d[i + 3] * 0x1000000 : u32be(d, i));
  const ifd = t + r32(t + 4);
  if (ifd + 2 > start + len) return 1;
  const n = r16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > start + len) break;
    if (r16(e) === 0x0112) return r16(e + 8);
  }
  return 1;
}

function jpeg(d: Uint8Array): ImageInfo | null {
  let i = 2, orient = 1;
  while (i + 9 < d.length) {
    if (d[i] !== 0xff) { i++; continue; }
    const m = d[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = u16be(d, i + 2);
    if (m === 0xe1) orient = exifOrientation(d, i + 4, len - 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const h = u16be(d, i + 5), w = u16be(d, i + 7);
      return orient >= 5 ? { format: 'jpeg', width: h, height: w } : { format: 'jpeg', width: w, height: h };
    }
    i += 2 + len;
  }
  return null;
}

function heic(d: Uint8Array): ImageInfo | null {
  // iPhone HEIC is a grid of 512 px tiles: every tile has an 'ispe' box, the grid's
  // is the largest. Scanning for the box type is enough for a size estimate.
  let w = 0, h = 0, rot = 0;
  for (let i = 4; i + 16 < d.length; i++) {
    if (d[i] === 0x69 && d[i + 1] === 0x73 && d[i + 2] === 0x70 && d[i + 3] === 0x65) { // 'ispe'
      const ww = u32be(d, i + 8), hh = u32be(d, i + 12);
      if (ww * hh > w * h && ww < 100000 && hh < 100000) { w = ww; h = hh; }
    } else if (d[i] === 0x69 && d[i + 1] === 0x72 && d[i + 2] === 0x6f && d[i + 3] === 0x74) { // 'irot'
      rot = d[i + 4] & 3;
    }
  }
  if (!w) return null;
  return rot % 2 ? { format: 'heic', width: h, height: w, approx: true } : { format: 'heic', width: w, height: h, approx: true };
}

export function parseImageInfo(d: Uint8Array): ImageInfo {
  if (d[0] === 0xff && d[1] === 0xd8) return jpeg(d) ?? { format: 'jpeg', width: 0, height: 0 };
  if (d[0] === 0x89 && ascii(d, 1, 3) === 'PNG') return { format: 'png', width: u32be(d, 16), height: u32be(d, 20) };
  if (ascii(d, 0, 4) === 'RIFF' && ascii(d, 8, 4) === 'WEBP') {
    const kind = ascii(d, 12, 4);
    if (kind === 'VP8X') return { format: 'webp', width: 1 + (d[24] | (d[25] << 8) | (d[26] << 16)), height: 1 + (d[27] | (d[28] << 8) | (d[29] << 16)) };
    if (kind === 'VP8 ') return { format: 'webp', width: (d[26] | (d[27] << 8)) & 0x3fff, height: (d[28] | (d[29] << 8)) & 0x3fff };
    if (kind === 'VP8L') {
      const b = d[21] | (d[22] << 8) | (d[23] << 16) | (d[24] << 24);
      return { format: 'webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  if (ascii(d, 4, 4) === 'ftyp' && /hei[cx]|mif1|msf1|heim|heis|avif/.test(ascii(d, 8, 16))) {
    return heic(d) ?? { format: 'heic', width: 0, height: 0 };
  }
  return { format: 'unknown', width: 0, height: 0 };
}

/** Header bytes to read: JPEG EXIF thumbnails and HEIC meta boxes live in the first ~256 KB. */
export const HEADER_BYTES = 256 * 1024;

/** Working-copy size: long side = longSide, never upscaled. */
export function fitLongSide(w: number, h: number, longSide: number): [number, number] {
  const s = Math.min(1, longSide / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

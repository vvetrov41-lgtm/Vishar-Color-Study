// Everything the colour card shows: codes, perceptual attributes, a plain name,
// the complementary colour and the difference between two colours.

import { labToSrgb, SRGB_TO_LINEAR, srgbToLab, warmth } from './color';

export type Rgb = [number, number, number];
export type Lab = [number, number, number];

const DEG = Math.PI / 180;

/** CIEDE2000 (Sharma, Wu, Dalal 2005), kL = kC = kH = 1. */
export function deltaE2000(l1: Lab, l2: Lab): number {
  const [L1, a1, b1] = l1, [L2, a2, b2] = l2;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h = (b: number, a: number) => (a === 0 && b === 0 ? 0 : (Math.atan2(b, a) / DEG + 360) % 360);
  const h1p = h(b1, a1p), h2p = h(b2, a2p);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * DEG);
  const Lmp = (L1 + L2) / 2, Cmp = (C1p + C2p) / 2;
  let hmp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hmp /= 2;
    else hmp = h1p + h2p < 360 ? (hmp + 360) / 2 : (hmp - 360) / 2;
  }
  const T = 1 - 0.17 * Math.cos((hmp - 30) * DEG) + 0.24 * Math.cos(2 * hmp * DEG)
    + 0.32 * Math.cos((3 * hmp + 6) * DEG) - 0.2 * Math.cos((4 * hmp - 63) * DEG);
  const dTheta = 30 * Math.exp(-(((hmp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cmp ** 7 / (Cmp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lmp - 50) ** 2) / Math.sqrt(20 + (Lmp - 50) ** 2);
  const Sc = 1 + 0.045 * Cmp, Sh = 1 + 0.015 * Cmp * T;
  const Rt = -Math.sin(2 * dTheta * DEG) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

export const deltaE76 = (a: Lab, b: Lab) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function lch(lab: Lab): [number, number, number] {
  const C = Math.hypot(lab[1], lab[2]);
  return [lab[0], C, C < 1e-9 ? 0 : (Math.atan2(lab[2], lab[1]) / DEG + 360) % 360];
}

function hsv(rgb: Rgb): [number, number, number] {
  const [r, g, b] = rgb.map((v) => v / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hh = 0;
  if (d) hh = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(hh * 60 + 360) % 360, max ? d / max : 0, max];
}

function hsl(rgb: Rgb): [number, number, number] {
  const [r, g, b] = rgb.map((v) => v / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  return [hsv(rgb)[0], d ? d / (1 - Math.abs(2 * l - 1)) : 0, l];
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const pct = (v: number) => Math.round(v * 100);
export const hex = (rgb: Rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();

export interface ColorCodes {
  HEX: string; RGB: string; CMYK: string; HSL: string; HSV: string; LAB: string; LCH: string; XYZ: string; xyY: string;
}

export function colorCodes(rgb: Rgb): ColorCodes {
  const [r, g, b] = rgb, lab = srgbToLab(r, g, b), [L, C, H] = lch(lab);
  const k = 1 - Math.max(r, g, b) / 255;
  const cmy = k >= 1 ? [0, 0, 0] : [r, g, b].map((v) => (1 - v / 255 - k) / (1 - k));
  const [hh, sl, ll] = hsl(rgb), [, sv, vv] = hsv(rgb);
  const lr = SRGB_TO_LINEAR[r], lg = SRGB_TO_LINEAR[g], lb = SRGB_TO_LINEAR[b];
  const X = 100 * (0.4124 * lr + 0.3576 * lg + 0.1805 * lb), Y = 100 * (0.2126 * lr + 0.7152 * lg + 0.0722 * lb), Z = 100 * (0.0193 * lr + 0.1192 * lg + 0.9505 * lb);
  const s = X + Y + Z;
  return {
    HEX: hex(rgb),
    RGB: `${r}, ${g}, ${b}`,
    CMYK: `${pct(cmy[0])}, ${pct(cmy[1])}, ${pct(cmy[2])}, ${pct(k)}`,
    HSL: `${Math.round(hh)}°, ${pct(sl)}%, ${pct(ll)}%`,
    HSV: `${Math.round(hh)}°, ${pct(sv)}%, ${pct(vv)}%`,
    LAB: `${r1(lab[0])}, ${r1(lab[1])}, ${r1(lab[2])}`,
    LCH: `${r1(L)}, ${r1(C)}, ${Math.round(H)}°`,
    XYZ: `${r1(X)}, ${r1(Y)}, ${r1(Z)}`,
    xyY: s ? `${(X / s).toFixed(4)}, ${(Y / s).toFixed(4)}, ${r1(Y)}` : '0, 0, 0',
  };
}

export type Temperature = 'тёплый' | 'холодный' | 'нейтральный';

/** Warm / cool on the same warmth axis as the Temperature view (hue 60° = warm). */
export function temperatureOf(lab: Lab): { label: Temperature; warmth: number } {
  const w = warmth(lab[1], lab[2]);
  const label = Math.hypot(lab[1], lab[2]) < 5 || Math.abs(w) < 3 ? 'нейтральный' : w > 0 ? 'тёплый' : 'холодный';
  return { label, warmth: r1(w) };
}

/** Plain Russian name from hue, saturation and lightness ("стандартное имя"). */
export function colorName(rgb: Rgb): string {
  const lab = srgbToLab(...rgb), [L, C] = lch(lab), [h, s] = hsv(rgb);
  if (C < 6 || s < 0.1) {
    if (L < 12) return 'чёрный';
    if (L > 94) return 'белый';
    return L < 35 ? 'тёмно-серый' : L > 75 ? 'светло-серый' : 'серый';
  }
  const SECTORS: Array<[number, string]> = [
    [15, 'красный'], [40, 'оранжевый'], [65, 'жёлтый'], [90, 'жёлто-зелёный'], [150, 'зелёный'],
    [190, 'бирюзовый'], [215, 'голубой'], [255, 'синий'], [290, 'фиолетовый'], [320, 'пурпурный'],
    [345, 'малиновый'], [360, 'красный'],
  ];
  let base = SECTORS.find(([end]) => h < end)![1];
  if ((base === 'оранжевый' || base === 'красный' || base === 'жёлтый') && L < 45 && h < 60) base = 'коричневый';
  const parts = [];
  if (s < 0.35 && base !== 'коричневый') parts.push('приглушённый');
  // Brown is dark by definition: only very dark brown gets the prefix.
  const tone = L < (base === 'коричневый' ? 20 : 35) ? 'тёмно-' : L > 78 ? 'светло-' : '';
  parts.push(tone + base);
  return parts.join(' ');
}

/** Opposite hue in LCh at the same lightness; chroma is reduced until it fits sRGB. */
export function complementary(rgb: Rgb): Rgb {
  const [L, C, H] = lch(srgbToLab(...rgb)), h2 = ((H + 180) % 360) * DEG;
  for (let c = C; c >= 0; c -= 1) {
    const a = c * Math.cos(h2), b = c * Math.sin(h2);
    const out = labToSrgb(L, a, b), back = srgbToLab(...out);
    if (deltaE76(back, [L, a, b]) < 1.5) return out;
  }
  return labToSrgb(L, 0, 0);
}

export interface ColorInfo {
  rgb: Rgb;
  lab: Lab;
  /** Value = L* 0..100, hue = LCh angle, chroma = C*. */
  value: number;
  hue: number;
  chroma: number;
  saturation: number;
  temperature: { label: Temperature; warmth: number };
  name: string;
  complementary: Rgb;
  codes: ColorCodes;
}

export function colorInfo(rgb: Rgb): ColorInfo {
  const c = rgb.map((v) => Math.round(Math.min(255, Math.max(0, v)))) as Rgb;
  const lab = srgbToLab(...c), [L, C, H] = lch(lab);
  return {
    rgb: c, lab: lab.map(r1) as Lab, value: r1(L), hue: Math.round(H), chroma: r1(C), saturation: pct(hsv(c)[1]),
    temperature: temperatureOf(lab), name: colorName(c), complementary: complementary(c), codes: colorCodes(c),
  };
}

export interface ColorDiff {
  /** B minus A. */
  dValue: number;
  dWarmth: number;
  /** Signed shortest hue turn A → B, degrees. */
  dHue: number;
  dChroma: number;
  dE2000: number;
}

export function compareColors(a: Rgb, b: Rgb): ColorDiff {
  const la = srgbToLab(...a), lb = srgbToLab(...b), ca = lch(la), cb = lch(lb);
  let dh = cb[2] - ca[2];
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  return {
    dValue: r1(lb[0] - la[0]), dWarmth: r1(warmth(lb[1], lb[2]) - warmth(la[1], la[2])),
    dHue: Math.round(ca[1] < 2 || cb[1] < 2 ? 0 : dh), dChroma: r1(cb[1] - ca[1]), dE2000: r1(deltaE2000(la, lb)),
  };
}

import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { luma601, srgbToLab } from '../src/core/color';

export const FIXTURES = ['stilllife', 'landscape', 'flash', 'portrait'] as const;

export interface Rgba { w: number; h: number; data: Uint8Array }

export function loadFixture(name: string): Rgba {
  const png = PNG.sync.read(readFileSync(new URL(`./fixtures/${name}_1k.png`, import.meta.url)));
  return { w: png.width, h: png.height, data: new Uint8Array(png.data) };
}

/** CPU version of the GPU analysis buffer (L*·2.55, a*+128, b*+128, luma). */
export function lab8FromRgba(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length);
  const c = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
  for (let j = 0; j < src.length; j += 4) {
    const [L, a, b] = srgbToLab(src[j], src[j + 1], src[j + 2]);
    out[j] = c(L * 2.55); out[j + 1] = c(a + 128); out[j + 2] = c(b + 128);
    out[j + 3] = c(luma601(src[j], src[j + 1], src[j + 2]));
  }
  return out;
}

/** Prototype image format: { w, h, rgb } with 3 bytes per pixel. */
export function toRgb(img: Rgba) {
  const rgb = new Uint8Array(img.w * img.h * 3);
  for (let i = 0, j = 0; j < img.data.length; i += 3, j += 4) { rgb[i] = img.data[j]; rgb[i + 1] = img.data[j + 1]; rgb[i + 2] = img.data[j + 2]; }
  return { w: img.w, h: img.h, rgb };
}

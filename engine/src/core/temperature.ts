import { histQuantile, histTotal } from './histogram';

/**
 * Warmth = projection of (a*, b*) on hue 60°. The original's exact formula and neutral
 * point are not recovered (TECHNICAL_RESEARCH F21), so this is our own definition.
 * 'relative' neutral = median warmth of the photo; 'absolute' neutral = grey (0).
 */
export type TempMode = 'relative' | 'absolute';
/** 'map' continuous diverging map without source lightness (like the original),
 *  'shaded' the same hues with the source L* kept, 'two' flat warm / cool. */
export type TempStyle = 'map' | 'shaded' | 'two';

export interface TemperatureParams {
  mode: TempMode;
  style: TempStyle;
  /** Neutral point shift in warmth units, −30..30. Positive = more cool. */
  balance: number;
}

export const DEFAULT_TEMPERATURE: TemperatureParams = { mode: 'relative', style: 'map', balance: 0 };

/** Diverging map stops, t in −1..1 → sRGB. Close to the original's look (F20). */
export const TEMP_STOPS: ReadonlyArray<readonly [number, readonly [number, number, number]]> = [
  [-1, [48, 116, 235]],
  [0, [178, 159, 181]],
  [0.5, [255, 180, 120]],
  [1, [255, 40, 0]],
];
export const TEMP_COOL: readonly [number, number, number] = [60, 120, 230];
export const TEMP_WARM: readonly [number, number, number] = [250, 130, 60];
/** Absolute mode: |warmth| at which the map saturates. */
export const ABSOLUTE_SPREAD = 40;

export function tempColor(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(-1, t));
  for (let i = 1; i < TEMP_STOPS.length; i++) {
    const [t1, c1] = TEMP_STOPS[i];
    if (x <= t1) {
      const [t0, c0] = TEMP_STOPS[i - 1];
      const u = (x - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * u, c0[1] + (c1[1] - c0[1]) * u, c0[2] + (c1[2] - c0[2]) * u];
    }
  }
  const last = TEMP_STOPS[TEMP_STOPS.length - 1][1];
  return [last[0], last[1], last[2]];
}

export interface TemperatureStats {
  neutral: number;
  spread: number;
  warmShare: number;
}

/** Neutral point and spread from the warmth histogram (bin = warmth + 128). */
export function temperatureStats(whist: ArrayLike<number>, p: TemperatureParams): TemperatureStats {
  const neutral = (p.mode === 'relative' ? histQuantile(whist, 0.5) - 128 : 0) + p.balance;
  let spread = ABSOLUTE_SPREAD;
  if (p.mode === 'relative') {
    const dev = new Float64Array(257);
    for (let v = 0; v < 256; v++) if (whist[v]) dev[Math.min(256, Math.round(Math.abs(v - 128 - neutral)))] += whist[v];
    spread = Math.max(6, histQuantile(dev, 0.95));
  }
  const total = histTotal(whist) || 1;
  let warm = 0;
  for (let v = 0; v < 256; v++) if (v - 128 > neutral) warm += whist[v];
  return { neutral, spread, warmShare: warm / total };
}

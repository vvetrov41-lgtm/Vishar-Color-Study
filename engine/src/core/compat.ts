// Values thresholds of the original web app (colorstudy.app 2.0.5) on our synthetic
// 1024×768 photos, 9 levels, luma. Recovered from its exports in
// experiments/original_web/values_fit.txt (row "orig"), rounded to whole luma units.

import { levelOf } from './values';

export const ORIGINAL_VALUES_9: Record<string, number[]> = {
  stilllife: [31, 54, 81, 106, 134, 167, 196, 229],
  landscape: [71, 90, 122, 144, 162, 178, 192, 223],
  flash: [32, 63, 86, 103, 135, 176, 214, 236],
  portrait: [31, 49, 77, 101, 124, 146, 167, 183],
};

/** Share of tones that fall on the same level under both threshold sets. */
export function levelAgreement(tones: ArrayLike<number>, a: number[], b: number[]): number {
  let same = 0;
  for (let i = 0; i < tones.length; i++) if (levelOf(tones[i], a) === levelOf(tones[i], b)) same++;
  return tones.length ? same / tones.length : 1;
}

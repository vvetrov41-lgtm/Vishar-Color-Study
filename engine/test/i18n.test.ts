import { describe, expect, it } from 'vitest';
import { ru } from '../dev/locales/ru';
import { en } from '../dev/locales/en';
import { es } from '../dev/locales/es';
import { HINTS_EN } from '../dev/hints.en';
import { HINTS_ES } from '../dev/hints.es';
import { colorName, colorNameParts } from '../src/core/colorinfo';

// The HINTS aggregator imports the Svelte rune module, so the RU hints are read through it lazily.
const ruHints = async () => (await import('../dev/hints')).HINTS_RU as Record<string, [string, string]>;

const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const CYRILLIC = /[А-Яа-яЁё]/;

describe('interface dictionaries', () => {
  for (const [name, d] of [['en', en], ['es', es]] as const) {
    it(`${name}: same keys and placeholders as ru, no Russian left`, () => {
      expect(Object.keys(d).sort()).toEqual(Object.keys(ru).sort());
      for (const k of Object.keys(ru) as Array<keyof typeof ru>) {
        expect(holes(d[k]), `${name} ${k}`).toBe(holes(ru[k]));
        expect(d[k].trim().length, `${name} ${k} empty`).toBeGreaterThan(0);
        expect(CYRILLIC.test(d[k]), `${name} ${k}: ${d[k]}`).toBe(false);
      }
    });
  }

  it('hints: every RU hint has EN and ES, without Russian', async () => {
    const r = await ruHints();
    for (const [name, h] of [['en', HINTS_EN], ['es', HINTS_ES]] as const) {
      expect(Object.keys(h).sort()).toEqual(Object.keys(r).sort());
      for (const [k, [title, text]] of Object.entries(h)) {
        expect(title && text, `${name} ${k}`).toBeTruthy();
        expect(CYRILLIC.test(title + text), `${name} ${k}`).toBe(false);
      }
    }
  });

  it('colour names: language-neutral parts give the same Russian name as before', () => {
    expect(colorName([230, 40, 40])).toBe('красный');
    expect(colorNameParts([230, 40, 40])).toEqual({ base: 'red', tone: '', muted: false });
    expect(colorNameParts([90, 50, 20]).base).toBe('brown');
    expect(colorNameParts([20, 20, 22]).base).toBe('black');
    expect(colorNameParts([60, 60, 60])).toEqual({ base: 'grey', tone: 'dark', muted: false });
    for (const rgb of [[10, 120, 200], [180, 200, 80], [240, 240, 250], [120, 90, 160]] as Array<[number, number, number]>) {
      const p = colorNameParts(rgb);
      expect(`hue.${p.base}` in ru).toBe(true);
    }
  });
});

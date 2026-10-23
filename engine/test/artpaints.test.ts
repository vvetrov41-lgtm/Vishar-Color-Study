import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nearestPaints, paintAlternatives, parseArtCatalogue } from '../src/core/artpaints';

const cat = parseArtCatalogue(JSON.parse(readFileSync(new URL('../public/art-paints.json', import.meta.url), 'utf8')));

describe('art paints', () => {
  it('loads every type with usable colours', () => {
    expect(cat.paints.length).toBeGreaterThan(5000);
    expect(new Set(cat.paints.map((p) => p.type)).size).toBe(9);
  });

  it('finds a paint of the set nearest to its own colour', () => {
    const p = cat.paints.find((x) => x.type === 'oil' && x.brand === 'Gamblin' && x.conf === 'm')!;
    const m = nearestPaints(cat, { type: 'oil', brand: 'Gamblin', tint: false }, p.lab, 3);
    expect(m[0].paint.id).toBe(p.id);
    expect(m[0].dE).toBe(0);
    expect(m.every((x) => x.paint.type === 'oil' && x.paint.brand === 'Gamblin')).toBe(true);
  });

  it('replacements start with the same pigments from another brand', () => {
    const p = cat.paints.find((x) => x.type === 'oil' && x.pigmentKey === 'PB29' && x.brand === 'Gamblin')!;
    const alt = paintAlternatives(cat, p);
    expect(alt[0].why).toBe('тот же состав');
    expect(alt[0].paint.pigmentKey).toBe('PB29');
    expect(alt[0].paint.brand).not.toBe('Gamblin');
    expect(alt.every((a) => a.paint.type === 'oil' && a.paint.id !== p.id)).toBe(true);
  });
});

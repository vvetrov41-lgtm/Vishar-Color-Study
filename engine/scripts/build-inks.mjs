// Compacts the tattoo ink catalogue (vishar.tattoo-inks/1, collected in the project's
// tattoo-ink-palettes research) into src/core/inks.json for the pigment tool (plan 5.2).
// Usage: node scripts/build-inks.mjs path/to/tattoo-inks.json
import { readFileSync, writeFileSync } from 'node:fs';

const src = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (src.schema !== 'vishar.tattoo-inks/1') throw new Error(`unexpected schema ${src.schema}`);
const brands = [...new Set(src.inks.map((i) => i.brand))];
const conf = { medium: 'm', low: 'l', 'very-low': 'v' };
const inks = src.inks.filter((i) => i.color).map((i) => {
  const bg = i.blackAndGrey;
  return [i.id, brands.indexOf(i.brand), i.line, i.name, i.family, i.color.hex.toUpperCase(), conf[i.color.confidence],
    ...(bg ? [bg.role, bg.step ?? bg.percentBlack ?? 0] : [])];
});
const series = src.blackAndGreySeries.map((s) => ({ brand: s.brand, line: s.line, series: s.series, ids: s.orderLightToDark, names: s.names }));
const out = { source: 'vishar.tattoo-inks/1', generated: src.generated, brands, inks, series };
writeFileSync(new URL('../src/core/inks.json', import.meta.url), JSON.stringify(out));
console.log(`${inks.length} inks, ${brands.length} brands, ${series.length} B&G series`);

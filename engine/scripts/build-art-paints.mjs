// Compacts the art paint catalogue (vishar.art-paints/1, collected in the project's
// art-paint-palettes research) into public/art-paints.json, loaded on demand by the palette.
// Usage: node scripts/build-art-paints.mjs path/to/art-paints.json
import { readFileSync, writeFileSync } from 'node:fs';

const src = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (src.schema !== 'vishar.art-paints/1') throw new Error(`unexpected schema ${src.schema}`);
const types = src.types.map((t) => ({ id: t.id, ru: t.ru }));
const brands = [...new Set(src.paints.map((p) => p.brand))];
const conf = { medium: 'm', low: 'l', 'very-low': 'v' };
// Only colours usable for ΔE matching: no very-low, no metallic/pearl/fluorescent.
const paints = src.paints.filter((p) => p.color && p.color.confidence !== 'very-low' && !p.special).map((p) => [
  p.id, types.findIndex((t) => t.id === p.type), brands.indexOf(p.brand), p.line, p.name, p.code ?? '',
  p.pigmentKey ?? '', p.color.hex.toUpperCase(), conf[p.color.confidence], p.tint?.hex?.toUpperCase() ?? '',
]);
const out = { source: 'vishar.art-paints/1', generated: src.generated, types, brands, paints };
writeFileSync(new URL('../public/art-paints.json', import.meta.url), JSON.stringify(out));
console.log(`${paints.length} of ${src.paints.length} paints, ${brands.length} brands, ${types.length} types`);

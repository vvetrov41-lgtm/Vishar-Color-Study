// Interface language: Russian, English, Spanish. The choice is remembered on the device;
// the first time it follows the device language (ru/uk/be/kk → Russian, es/ca/gl/eu → Spanish,
// anything else → English). `?lang=xx` in the address overrides both, for tests and links.
import { ru } from './locales/ru';
import { en } from './locales/en';
import { es } from './locales/es';

export type Lang = 'ru' | 'en' | 'es';
export type Key = keyof typeof ru;
export const LANGS: Array<[Lang, string, string]> = [['ru', 'Русский', 'RU'], ['en', 'English', 'EN'], ['es', 'Español', 'ES']];
export const DICTS: Record<Lang, Record<Key, string>> = { ru, en, es };
const STORE = 'vishar.lang';

export function langFrom(list: readonly string[]): Lang {
  for (const l of list) {
    const b = l.toLowerCase().slice(0, 2);
    if (b === 'ru' || b === 'uk' || b === 'be' || b === 'kk') return 'ru';
    if (b === 'es' || b === 'ca' || b === 'gl' || b === 'eu') return 'es';
    if (b === 'en') return 'en';
  }
  return 'en';
}

function detect(): Lang {
  if (typeof window === 'undefined') return 'ru';
  const q = new URLSearchParams(location.search).get('lang');
  if (q && q in DICTS) return q as Lang;
  try {
    const s = localStorage.getItem(STORE);
    if (s && s in DICTS) return s as Lang;
  } catch {}
  return langFrom(navigator.languages?.length ? navigator.languages : [navigator.language ?? 'en']);
}

export const i18n = $state({ lang: detect() });
if (typeof document !== 'undefined') document.documentElement.lang = i18n.lang;

export function setLang(l: Lang) {
  i18n.lang = l;
  document.documentElement.lang = l;
  try { localStorage.setItem(STORE, l); } catch {}
}

/** Translation with `{name}` placeholders. A missing key falls back to Russian, then to the key. */
export function t(key: Key, p?: Record<string, string | number>): string {
  let s: string = DICTS[i18n.lang][key] ?? ru[key] ?? key;
  if (p) s = s.replace(/\{(\w+)\}/g, (m, k) => (p[k] != null ? String(p[k]) : m));
  return s;
}

/** Plural form by the language rules: keys `base.one`, `base.few`, `base.many`, `base.other`. */
export function plural(n: number, base: string): string {
  const form = new Intl.PluralRules(i18n.lang).select(n);
  const d = DICTS[i18n.lang] as Record<string, string>;
  return d[`${base}.${form}`] ?? d[`${base}.other`] ?? base;
}

/** Number with the language's decimal separator. */
export function num(n: number, digits = 1): string {
  return n.toLocaleString(i18n.lang, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

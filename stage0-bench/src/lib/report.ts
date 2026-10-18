import type { Check } from './types';
import type { CrashRecord } from './journal';

export const BUILD = {
  version: __BENCH_VERSION__,
  builtAt: __BENCH_BUILT_AT__,
};

export interface Report {
  schema: 'vishar-stage0-report/1';
  build: typeof BUILD;
  runId: string;
  startedAt: string;
  durationMs: number;
  url: string;
  userAgent: string;
  online: boolean;
  config: Record<string, unknown>;
  previousCrashes: CrashRecord[];
  checks: Check[];
  photo?: Check | null;
  stress?: Record<string, unknown> | null;
}

const ICON: Record<Check['status'], string> = { pass: '✅', fail: '❌', warn: '⚠️', info: 'ℹ️', skip: '⏭️' };

function short(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return '';
  return String(v);
}

export function textReport(r: Report): string {
  const lines: string[] = [];
  lines.push(`Vishar Color Study · Stage 0 · ${r.build.version}`);
  lines.push(`Прогон ${r.runId}, ${new Date(r.startedAt).toLocaleString('ru-RU')}, ${Math.round(r.durationMs / 1000)} с`);
  lines.push(r.userAgent);
  if (r.previousCrashes.length) {
    for (const c of r.previousCrashes) lines.push(`💥 Прогон не завершился на шаге «${c.stepLabel ?? c.step}» (${c.at}): вкладка перезагрузилась или была закрыта`);
  }
  const counts = { pass: 0, fail: 0, warn: 0, info: 0, skip: 0 };
  for (const c of r.checks) counts[c.status]++;
  lines.push(`Итог: ✅ ${counts.pass} ⚠️ ${counts.warn} ❌ ${counts.fail} ⏭️ ${counts.skip}`);
  lines.push('');
  const all = [...r.checks, ...(r.photo ? [r.photo] : [])];
  for (const c of all) {
    if (typeof c.value === 'object' && c.status === 'info' && c.value !== null && !c.note) continue; // raw dumps live in JSON
    const v = short(c.value);
    const ms = c.ms !== undefined ? ` · ${c.ms} мс` : '';
    const note = c.note ? ` — ${c.note}` : '';
    lines.push(`${ICON[c.status]} ${c.name}${v ? ': ' + v : ''}${ms}${note}`);
  }
  if (r.stress) lines.push('', `Стресс-тест памяти: ${JSON.stringify(r.stress)}`);
  return lines.join('\n');
}

export function jsonReport(r: Report): string {
  return JSON.stringify(r, null, 1);
}

<script lang="ts">
  import { onMount } from 'svelte';
  import { Runner, DEFAULT_OPTS } from './lib/runner';
  import { BUILD, jsonReport, textReport, type Report } from './lib/report';
  import {
    RunJournal,
    clearCrashes,
    crashHistory,
    loadLastReport,
    recoverCrash,
    saveLastReport,
    type CrashRecord,
  } from './lib/journal';
  import { memoryStress, type StressResult } from './lib/stress';
  import type { Check } from './lib/types';

  let checks = $state<Check[]>([]);
  let progress = $state({ label: '', done: 0, total: 0 });
  let running = $state(false);
  let report = $state<Report | null>(null);
  let crash = $state<CrashRecord | null>(null);
  let crashes = $state<CrashRecord[]>([]);
  let include48 = $state(true);
  let forceCrashed = $state(false);
  let toast = $state('');

  let photoCheck = $state<Check | null>(null);
  let photoBusy = $state(false);
  let previewCanvas = $state<HTMLCanvasElement>();

  let stressOpen = $state(false);
  let stressAck = $state(false);
  let stressCap = $state(1024);
  let stressMB = $state(0);
  let stressResult = $state<StressResult | null>(null);

  const runner = new Runner({
    onCheck: (c) => (checks = c),
    onProgress: (label, done, total) => (progress = { label, done, total }),
  });
  const photoRunner = new Runner({ onCheck: () => {}, onProgress: () => {} });

  // Lets automated smoke tests read the same text the "Copy text" button gives.
  (window as any).__benchReportText = () => (report ? textReport($state.snapshot(report) as Report) : null);

  onMount(() => {
    crash = recoverCrash();
    crashes = crashHistory();
    const last = loadLastReport<Report>();
    if (last && last.schema === 'vishar-stage0-report/1') report = last;
  });

  function buildReport(meta: { runId: string; startedAt: string; durationMs: number }): Report {
    return {
      schema: 'vishar-stage0-report/1',
      build: BUILD,
      runId: meta.runId,
      startedAt: meta.startedAt,
      durationMs: meta.durationMs,
      url: location.href,
      userAgent: navigator.userAgent,
      online: navigator.onLine,
      config: { include48, forceCrashed, pipeline: DEFAULT_OPTS },
      previousCrashes: crashHistory(),
      checks: $state.snapshot(checks) as Check[],
      photo: photoCheck ? ($state.snapshot(photoCheck) as Check) : null,
      stress: stressResult ? { ...stressResult } : null,
    };
  }

  async function runTests() {
    running = true;
    report = null;
    try {
      const meta = await runner.runAll({ include48, forceCrashed });
      report = buildReport(meta);
      saveLastReport(report);
    } finally {
      running = false;
    }
  }

  function refreshReport() {
    if (!report) return;
    report = { ...report, photo: photoCheck ? ($state.snapshot(photoCheck) as Check) : report.photo, stress: stressResult ? { ...stressResult } : report.stress };
    saveLastReport(report);
  }

  function flash(msg: string) {
    toast = msg;
    setTimeout(() => (toast = ''), 2500);
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    flash(`${what} скопирован`);
  }

  async function share() {
    if (!report) return;
    const text = textReport(report);
    const file = new File([jsonReport(report)], `vishar-stage0-${report.runId}.json`, { type: 'application/json' });
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: 'Vishar Stage 0', text, files: [file] });
      } else if (navigator.share) {
        await navigator.share({ title: 'Vishar Stage 0', text });
      } else {
        await copy(text, 'Отчёт');
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') flash('Поделиться не вышло: ' + (e as Error).message);
    }
  }

  function download() {
    if (!report) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([jsonReport(report)], { type: 'application/json' }));
    a.download = `vishar-stage0-${report.runId}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function onPhoto(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    photoBusy = true;
    photoCheck = null;
    const journal = new RunJournal('photo');
    journal.step('photo', `своё фото ${file.name} (${Math.round(file.size / 1024)} КБ)`);
    try {
      const r = await photoRunner.pipeline('photo', `Своё фото (${file.type || 'тип не указан'}, ${Math.round(file.size / 1024)} КБ)`, file, {
        ...DEFAULT_OPTS,
        preview: true,
      });
      photoCheck = photoRunner.checks.find((c) => c.id === 'photo') ?? null;
      if (r?.preview && previewCanvas) {
        previewCanvas.width = r.preview.width;
        previewCanvas.height = r.preview.height;
        previewCanvas.getContext('2d')!.drawImage(r.preview, 0, 0);
        r.preview.close();
      }
    } finally {
      journal.finish();
      photoBusy = false;
      input.value = '';
      refreshReport();
    }
  }

  async function runStress() {
    if (!stressAck) return;
    const ok = confirm(
      `Стресс-тест выделит до ${stressCap} МБ памяти. Safari может перезагрузить вкладку: это ожидаемо, результат сохранится. Продолжить?`,
    );
    if (!ok) return;
    stressResult = null;
    stressResult = await memoryStress(stressCap, (mb) => (stressMB = mb));
    refreshReport();
  }

  function resetCrashes() {
    clearCrashes();
    crashes = [];
    crash = null;
  }

  const statusIcon: Record<Check['status'], string> = { pass: '✅', fail: '❌', warn: '⚠️', info: 'ℹ️', skip: '⏭️' };
  const fmt = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'object' ? '' : String(v));
  let counts = $derived(
    checks.reduce((a, c) => ((a[c.status] = (a[c.status] ?? 0) + 1), a), {} as Record<string, number>),
  );
</script>

<main>
  <header>
    <h1>Vishar Color Study</h1>
    <p class="sub">Stage 0 · диагностика движка · {BUILD.version}</p>
  </header>

  {#if crash}
    <div class="banner crash">
      💥 Прошлый прогон не завершился на шаге «{crash.stepLabel ?? crash.step}»: вкладка перезагрузилась или была закрыта.
      Это попадёт в отчёт. Шаг, на котором был сбой, при следующем запуске пропускается.
    </div>
  {/if}

  <section class="run">
    <button class="primary" onclick={runTests} disabled={running}>
      {running ? 'Идёт проверка…' : 'Run Tests'}
    </button>
    {#if running || progress.total}
      <div class="progress">
        <div class="bar" style="width: {progress.total ? (progress.done / progress.total) * 100 : 0}%"></div>
      </div>
      <p class="muted">{progress.label} · {progress.done}/{progress.total}</p>
    {/if}
    <details class="opts">
      <summary>Параметры</summary>
      <label><input type="checkbox" bind:checked={include48} disabled={running} /> Тесты 48 МП (≈11 МБ загрузки)</label>
      <label><input type="checkbox" bind:checked={forceCrashed} disabled={running} /> Повторить шаги, на которых был сбой</label>
      {#if crashes.length}
        <button class="link" onclick={resetCrashes}>Сбросить историю сбоев ({crashes.length})</button>
      {/if}
    </details>
  </section>

  {#if report && !running}
    <section class="share">
      <p><strong>Отчёт готов.</strong> Отправь его в тред: «Поделиться» или «Копировать JSON».</p>
      <div class="buttons">
        <button onclick={share}>Поделиться</button>
        <button onclick={() => copy(jsonReport(report!), 'JSON')}>Копировать JSON</button>
        <button onclick={() => copy(textReport(report!), 'Текст')}>Копировать текст</button>
        <button onclick={download}>Скачать .json</button>
      </div>
    </section>
  {/if}

  {#if checks.length}
    <section>
      <p class="muted">✅ {counts.pass ?? 0} · ⚠️ {counts.warn ?? 0} · ❌ {counts.fail ?? 0} · ⏭️ {counts.skip ?? 0}</p>
      <ul class="checks">
        {#each checks.filter((c) => !(c.status === 'info' && typeof c.value === 'object' && c.value !== null && !c.note)) as c (c.id)}
          <li class={c.status}>
            <span class="icon">{statusIcon[c.status]}</span>
            <div>
              <div class="name">
                {c.name}{#if fmt(c.value)}: <b>{fmt(c.value)}</b>{/if}{#if c.ms !== undefined}<span class="ms"> · {c.ms} мс</span>{/if}
              </div>
              {#if c.note}<div class="note">{c.note}</div>{/if}
            </div>
          </li>
        {/each}
      </ul>
    </section>
  {:else if report && !running}
    <p class="muted">Показан отчёт прошлого прогона ({new Date(report.startedAt).toLocaleString('ru-RU')}).</p>
  {/if}

  <section class="photo">
    <h2>Своё фото</h2>
    <p class="muted">Тот же конвейер на реальном снимке: декодирование, рабочая копия 1600 px, GPU Values, тайлы полного разрешения. Фото не покидает телефон.</p>
    <label class="filebtn">
      <input type="file" accept="image/*,.heic,.heif" onchange={onPhoto} disabled={photoBusy || running} />
      {photoBusy ? 'Обрабатываю…' : 'Выбрать фото'}
    </label>
    {#if photoCheck}
      <div class="checks one {photoCheck.status}">
        {statusIcon[photoCheck.status]} {photoCheck.name}{#if photoCheck.ms !== undefined} · {photoCheck.ms} мс{/if}
        <div class="note">{photoCheck.note}</div>
      </div>
    {/if}
    <canvas bind:this={previewCanvas} class="preview" class:hidden={!photoCheck}></canvas>
  </section>

  <section class="stress">
    <button class="link" onclick={() => (stressOpen = !stressOpen)}>
      {stressOpen ? '▾' : '▸'} Стресс-тест памяти (по отдельному подтверждению)
    </button>
    {#if stressOpen}
      <p class="muted">
        Выделяет память блоками по 32 МБ до выбранного предела. Если iOS выгрузит вкладку, после перезагрузки стенд покажет,
        на каком объёме это случилось. В Run Tests этот тест не входит.
      </p>
      <label>
        Предел:
        <select bind:value={stressCap}>
          <option value={512}>512 МБ</option>
          <option value={1024}>1 ГБ</option>
          <option value={1536}>1,5 ГБ</option>
          <option value={2048}>2 ГБ</option>
          <option value={4096}>4 ГБ</option>
        </select>
      </label>
      <label><input type="checkbox" bind:checked={stressAck} /> Понимаю, что вкладка может перезагрузиться</label>
      <button onclick={runStress} disabled={!stressAck || running}>Запустить стресс-тест</button>
      {#if stressMB}<p class="muted">Выделено: {stressMB} МБ</p>{/if}
      {#if stressResult}
        <p>Готово: {stressResult.reachedMB} МБ из {stressResult.capMB} МБ{stressResult.error ? `, ошибка: ${stressResult.error}` : ''}.</p>
      {/if}
    {/if}
  </section>

  <footer class="muted">
    Для проверки офлайна: «Поделиться» → «На экран Домой», открыть с иконки, включить авиарежим, открыть ещё раз и нажать Run Tests.
  </footer>

  {#if toast}<div class="toast">{toast}</div>{/if}
</main>

<style>
  :global(:root) {
    --bg: #fafaf8;
    --fg: #1d1d1f;
    --muted: #6e6e73;
    --card: #ffffff;
    --line: #e3e3e0;
    --accent: #c2410c;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root) {
      --bg: #111113;
      --fg: #f2f2f2;
      --muted: #9a9aa0;
      --card: #1c1c1f;
      --line: #2c2c30;
      --accent: #fb923c;
    }
  }
  :global(body) {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font: 15px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  main {
    max-width: 720px;
    margin: 0 auto;
    padding: calc(16px + env(safe-area-inset-top)) 16px calc(32px + env(safe-area-inset-bottom));
  }
  h1 {
    font-size: 22px;
    margin: 0;
  }
  h2 {
    font-size: 17px;
    margin: 0 0 4px;
  }
  .sub,
  .muted {
    color: var(--muted);
    font-size: 13px;
    margin: 4px 0;
  }
  section {
    margin: 18px 0;
  }
  button,
  .filebtn {
    font: inherit;
    border: 1px solid var(--line);
    background: var(--card);
    color: var(--fg);
    border-radius: 10px;
    padding: 10px 14px;
    cursor: pointer;
    display: inline-block;
  }
  button:disabled {
    opacity: 0.5;
  }
  .primary {
    width: 100%;
    padding: 16px;
    font-size: 18px;
    font-weight: 600;
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .link {
    text-align: left;
    border: none;
    background: none;
    padding: 6px 0;
    color: var(--accent);
  }
  .progress {
    height: 6px;
    background: var(--line);
    border-radius: 3px;
    margin-top: 12px;
    overflow: hidden;
  }
  .bar {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s;
  }
  .opts label,
  .stress label {
    display: block;
    margin: 8px 0;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .share {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 12px;
  }
  .banner {
    border-radius: 12px;
    padding: 12px;
    margin: 12px 0;
  }
  .crash {
    background: #fde68a33;
    border: 1px solid #f59e0b;
  }
  .checks {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .checks li {
    display: flex;
    gap: 8px;
    padding: 8px 0;
    border-bottom: 1px solid var(--line);
  }
  .checks.one {
    padding: 10px 0;
  }
  .icon {
    flex: none;
  }
  .name {
    overflow-wrap: anywhere;
  }
  .note {
    color: var(--muted);
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .ms {
    color: var(--muted);
  }
  .filebtn input {
    display: none;
  }
  .preview {
    max-width: 100%;
    margin-top: 10px;
    border-radius: 8px;
  }
  .hidden {
    display: none;
  }
  .toast {
    position: fixed;
    left: 50%;
    bottom: calc(24px + env(safe-area-inset-bottom));
    transform: translateX(-50%);
    background: var(--fg);
    color: var(--bg);
    padding: 10px 16px;
    border-radius: 20px;
  }
  footer {
    margin-top: 28px;
  }
</style>

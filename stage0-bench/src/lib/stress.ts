// Memory stress test. Never part of Run Tests: the page starts it only after
// an explicit confirmation. Allocates 32 MB blocks and touches every page so
// the OS actually commits them; the journal records each step, so if iOS
// reloads the tab the next page load reports the last size that survived.
import { RunJournal } from './journal';

const BLOCK_MB = 32;

export interface StressResult {
  capMB: number;
  reachedMB: number;
  stoppedBy: 'cap' | 'error';
  error?: string;
  ms: number;
}

export async function memoryStress(capMB: number, onStep: (mb: number) => void): Promise<StressResult> {
  const journal = new RunJournal('memory-stress');
  const blocks: Uint8Array[] = [];
  const t0 = performance.now();
  let reached = 0;
  try {
    while (reached + BLOCK_MB <= capMB) {
      journal.step('stress', `стресс-тест памяти: выделяю ${reached + BLOCK_MB} МБ`);
      const b = new Uint8Array(BLOCK_MB * 1048576);
      for (let i = 0; i < b.length; i += 4096) b[i] = 1;
      blocks.push(b);
      reached += BLOCK_MB;
      onStep(reached);
      await new Promise((r) => setTimeout(r, 15));
    }
    journal.finish();
    return { capMB, reachedMB: reached, stoppedBy: 'cap', ms: Math.round(performance.now() - t0) };
  } catch (e) {
    journal.finish();
    return {
      capMB,
      reachedMB: reached,
      stoppedBy: 'error',
      error: e instanceof Error ? e.message : String(e),
      ms: Math.round(performance.now() - t0),
    };
  } finally {
    blocks.length = 0;
  }
}

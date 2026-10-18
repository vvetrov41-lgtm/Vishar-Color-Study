// Crash journal. Safari on iOS reloads a tab that ran out of memory without
// any event, so the current step is written to localStorage before it starts.
// After a reload the page sees an unfinished journal and knows where it died.
import type { Check } from './types';

const J_KEY = 'vishar-bench.journal';
const CRASH_KEY = 'vishar-bench.crashes';
const LAST_KEY = 'vishar-bench.last-report';

export interface Journal {
  runId: string;
  kind: string;
  startedAt: string;
  step: string | null;
  stepLabel: string | null;
  stepStartedAt: string | null;
  checks: Check[];
}

export interface CrashRecord {
  runId: string;
  kind: string;
  step: string;
  stepLabel: string | null;
  at: string;
  /** checks that had completed before the crash */
  checks: Check[];
}

function get<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

function set(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage full or blocked: the bench still runs, only crash recovery is lost */
  }
}

/** Called once on page load. Converts an unfinished journal into a crash record. */
export function recoverCrash(): CrashRecord | null {
  const j = get<Journal>(J_KEY);
  if (!j) return null;
  try {
    localStorage.removeItem(J_KEY);
  } catch {}
  if (!j.step) return null;
  const rec: CrashRecord = {
    runId: j.runId,
    kind: j.kind,
    step: j.step,
    stepLabel: j.stepLabel,
    at: j.stepStartedAt ?? j.startedAt,
    checks: j.checks,
  };
  const all = get<CrashRecord[]>(CRASH_KEY) ?? [];
  all.push(rec);
  set(CRASH_KEY, all.slice(-10));
  return rec;
}

export function crashedSteps(): Set<string> {
  return new Set((get<CrashRecord[]>(CRASH_KEY) ?? []).map((c) => c.step));
}

export function crashHistory(): CrashRecord[] {
  return get<CrashRecord[]>(CRASH_KEY) ?? [];
}

export function clearCrashes() {
  try {
    localStorage.removeItem(CRASH_KEY);
  } catch {}
}

export class RunJournal {
  private j: Journal;
  constructor(kind: string) {
    this.j = {
      runId: Math.random().toString(36).slice(2, 10),
      kind,
      startedAt: new Date().toISOString(),
      step: null,
      stepLabel: null,
      stepStartedAt: null,
      checks: [],
    };
    set(J_KEY, this.j);
  }
  get runId() {
    return this.j.runId;
  }
  get startedAt() {
    return this.j.startedAt;
  }
  step(id: string, label: string) {
    this.j.step = id;
    this.j.stepLabel = label;
    this.j.stepStartedAt = new Date().toISOString();
    set(J_KEY, this.j);
  }
  stepDone(checks: Check[]) {
    this.j.step = null;
    this.j.checks = checks;
    set(J_KEY, this.j);
  }
  finish() {
    try {
      localStorage.removeItem(J_KEY);
    } catch {}
  }
}

export function saveLastReport(r: unknown) {
  set(LAST_KEY, r);
}

export function loadLastReport<T>(): T | null {
  return get<T>(LAST_KEY);
}

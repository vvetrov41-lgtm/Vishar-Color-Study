export type Status = 'pass' | 'fail' | 'warn' | 'info' | 'skip';

export interface Check {
  id: string;
  group: string;
  name: string;
  status: Status;
  value?: unknown;
  note?: string;
  ms?: number;
}

/** Messages main → worker */
export interface WorkerRequest {
  id: number;
  cmd: string;
  args?: any;
}

/** Messages worker → main */
export interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: any;
  error?: string;
}

export interface PipelineOptions {
  /** long side of the interactive working copy */
  workLong: number;
  /** run the full-resolution tiled GPU pass (export simulation) */
  fullRes: boolean;
  tile: number;
  overlap: number;
  /** number of Values levels for the CPU k-means and GPU posterize */
  levels: number;
  /** return a preview bitmap of the Values result */
  preview: boolean;
}

export interface PipelineResult {
  label: string;
  bytes: number;
  type: string;
  width?: number;
  height?: number;
  megapixels?: number;
  steps: Record<string, number | string | boolean | null>;
  errors: string[];
  preview?: ImageBitmap;
}

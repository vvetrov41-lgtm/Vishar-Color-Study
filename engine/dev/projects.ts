// Projects on the device (plan stage 5): a photo, the results taken into work and the view
// settings. Metadata lives in IndexedDB; images in OPFS when the browser can write there,
// otherwise as Blobs in IndexedDB. Nothing leaves the device: a project file is written
// and read locally.

export interface ProjectStep { label: string; key: string }

export interface ProjectMeta {
  id: string;
  name: string;
  created: number;
  updated: number;
  /** Work chain: the original first, then each result taken into work. */
  steps: ProjectStep[];
  /** ViewState snapshot (JSON), restored on open. */
  view: unknown;
  /** Small JPEG of the latest step, for the list. */
  thumb?: Blob;
  bytes: number;
}

const DB = 'vishar-engine', VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode), req = fn(t.objectStore(store));
    t.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
    t.onerror = t.onabort = () => { db.close(); reject(t.error); };
  });
}

/** OPFS when it can write files (Safari 17+, Chromium); null = IndexedDB only. */
let opfs: Promise<FileSystemDirectoryHandle | null> | null = null;
function opfsDir(): Promise<FileSystemDirectoryHandle | null> {
  opfs ??= (async () => {
    // ?store=idb forces the IndexedDB path (Safari versions without createWritable), for tests.
    if (new URLSearchParams(location.search).get('store') === 'idb') return null;
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('projects', { create: true });
      const probe = await dir.getFileHandle('.probe', { create: true });
      if (!('createWritable' in probe)) return null;
      const w = await probe.createWritable();
      await w.write('ok');
      await w.close();
      return dir;
    } catch {
      return null;
    }
  })();
  return opfs;
}

export async function storageKind(): Promise<'opfs' | 'indexeddb'> {
  return (await opfsDir()) ? 'opfs' : 'indexeddb';
}

/** Storage key of each image already saved (or loaded) in this session. */
const keyOf = new WeakMap<Blob, string>();

async function putBlob(key: string, blob: Blob) {
  const dir = await opfsDir();
  if (dir) {
    const w = await (await dir.getFileHandle(key, { create: true })).createWritable();
    await w.write(blob);
    await w.close();
  } else await tx('blobs', 'readwrite', (s) => { s.put(blob, key); });
}

export async function getBlob(key: string, type = 'image/png'): Promise<Blob> {
  const dir = await opfsDir();
  if (dir) {
    try {
      const f = await (await dir.getFileHandle(key)).getFile(), b = new Blob([f], { type: f.type || type });
      keyOf.set(b, key);
      return b;
    } catch { /* saved before OPFS was usable: try IndexedDB */ }
  }
  const b = await tx<Blob>('blobs', 'readonly', (s) => s.get(key));
  if (!b) throw new Error(`нет файла проекта ${key}`);
  keyOf.set(b, key);
  return b;
}

async function dropBlob(key: string) {
  const dir = await opfsDir();
  if (dir) await dir.removeEntry(key).catch(() => {});
  await tx('blobs', 'readwrite', (s) => { s.delete(key); });
}

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export async function listProjects(): Promise<ProjectMeta[]> {
  const all = (await tx<ProjectMeta[]>('projects', 'readonly', (s) => s.getAll())) ?? [];
  return all.sort((a, b) => b.updated - a.updated);
}

export const getProject = (id: string) => tx<ProjectMeta>('projects', 'readonly', (s) => s.get(id));

async function thumbOf(blob: Blob): Promise<Blob | undefined> {
  try {
    const bmp = await createImageBitmap(blob, { resizeWidth: 160, resizeQuality: 'medium', imageOrientation: 'from-image' });
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d')!.drawImage(bmp, 0, 0);
    bmp.close();
    return await c.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  } catch {
    return undefined;
  }
}

/**
 * Saves the chain and view of a project: new steps are written, steps no longer in the chain
 * are removed. The original's blob is written once and kept.
 */
export async function saveProject(p: { id?: string; name: string; chain: Array<{ label: string; blob: Blob }>; view: unknown }): Promise<ProjectMeta> {
  const old = p.id ? await getProject(p.id) : undefined, id = old?.id ?? newId(), now = Date.now();
  const steps: ProjectStep[] = [];
  let bytes = 0;
  for (let k = 0; k < p.chain.length; k++) {
    const { label, blob } = p.chain[k], known = keyOf.get(blob);
    const key = known && old?.steps.some((s) => s.key === known) ? known : `${id}-${newId()}`;
    if (key !== known) { await putBlob(key, blob); keyOf.set(blob, key); }
    steps.push({ label, key });
    bytes += blob.size;
  }
  for (const s of old?.steps ?? []) if (!steps.some((n) => n.key === s.key)) await dropBlob(s.key);
  const last = p.chain[p.chain.length - 1]?.blob;
  const thumb = old && old.steps[old.steps.length - 1]?.key === steps[steps.length - 1]?.key ? old.thumb : last && (await thumbOf(last));
  const meta: ProjectMeta = { id, name: p.name, created: old?.created ?? now, updated: now, steps, view: p.view, thumb, bytes };
  await tx('projects', 'readwrite', (s) => { s.put(meta); });
  return meta;
}

/** Only the view settings changed (no new step): cheap, for autosave. */
export async function saveView(id: string, view: unknown) {
  const old = await getProject(id);
  if (old) await tx('projects', 'readwrite', (s) => { s.put({ ...old, view, updated: Date.now() }); });
}

export async function renameProject(id: string, name: string) {
  const old = await getProject(id);
  if (old) await tx('projects', 'readwrite', (s) => { s.put({ ...old, name }); });
}

export async function deleteProject(id: string) {
  const old = await getProject(id);
  for (const s of old?.steps ?? []) await dropBlob(s.key);
  await tx('projects', 'readwrite', (s) => { s.delete(id); });
}

/**
 * Project file (.vishar): "VSHR1\n", a 4-byte little-endian header length, the JSON header,
 * then the images back to back. The header lists each image's label, type and size.
 */
const MAGIC = 'VSHR1\n';

export async function exportProjectFile(id: string): Promise<{ blob: Blob; name: string }> {
  const p = await getProject(id);
  if (!p) throw new Error('проект не найден');
  const blobs = await Promise.all(p.steps.map((s) => getBlob(s.key)));
  const header = new TextEncoder().encode(JSON.stringify({
    app: 'vishar-engine', name: p.name, created: p.created, view: p.view,
    steps: p.steps.map((s, k) => ({ label: s.label, type: blobs[k].type, size: blobs[k].size })),
  }));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, header.length, true);
  const safe = p.name.replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 40) || 'project';
  return { blob: new Blob([MAGIC, len, header, ...blobs], { type: 'application/octet-stream' }), name: `${safe}.vishar` };
}

export async function importProjectFile(file: Blob): Promise<ProjectMeta> {
  const head = new Uint8Array(await file.slice(0, MAGIC.length + 4).arrayBuffer());
  if (new TextDecoder().decode(head.subarray(0, MAGIC.length)) !== MAGIC) throw new Error('это не файл проекта Vishar');
  const len = new DataView(head.buffer).getUint32(MAGIC.length, true);
  let at = MAGIC.length + 4;
  const h = JSON.parse(await file.slice(at, at + len).text()) as { name: string; view: unknown; steps: Array<{ label: string; type: string; size: number }> };
  at += len;
  const chain = h.steps.map((s) => {
    const blob = file.slice(at, at + s.size, s.type);
    at += s.size;
    return { label: s.label, blob };
  });
  if (at > file.size) throw new Error('файл проекта обрезан');
  // Materialise the slices so the project does not depend on the picked file.
  const owned = await Promise.all(chain.map(async (c) => ({ label: c.label, blob: new Blob([await c.blob.arrayBuffer()], { type: c.blob.type }) })));
  return saveProject({ name: h.name, chain: owned, view: h.view });
}

export interface StorageInfo { persisted: boolean | null; usage: number | null; quota: number | null; kind: 'opfs' | 'indexeddb' }

export async function storageInfo(): Promise<StorageInfo> {
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => null);
  return { persisted: persisted ?? null, usage: est?.usage ?? null, quota: est?.quota ?? null, kind: await storageKind() };
}

/** Asks the browser not to evict the projects (Safari otherwise may after 7 days without use). */
export async function askPersist(): Promise<boolean | null> {
  return (await navigator.storage?.persist?.().catch(() => null)) ?? null;
}

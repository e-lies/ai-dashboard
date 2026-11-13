/**
 * Persistance locale dans IndexedDB (navigateur de l'utilisateur seulement).
 * Les données ne quittent pas le poste ; seuls le schéma et des statistiques
 * sont envoyés au LLM.
 */
import { createStore, del, get, keys, set } from 'idb-keyval';
import type { CellValue, DashboardSpec, DatasetMeta } from '../../../shared/types';
import type { ChatThread } from './chatThreads';

const store = createStore('tq-dashboard', 'kv');

const K = {
  meta: (id: string) => `dataset:meta:${id}`,
  rows: (id: string) => `dataset:rows:${id}`,
  dash: (id: string) => `dashboard:${id}`,
  thread: (dashboardId: string, id: string) => `thread:${dashboardId}:${id}`,
};

async function listByPrefix<T>(prefix: string): Promise<T[]> {
  const all = (await keys(store)).filter((k): k is string => typeof k === 'string' && k.startsWith(prefix));
  const values: (T | undefined)[] = await Promise.all(all.map((k) => get<T>(k, store)));
  return values.filter((v): v is T => v !== undefined);
}

export const storage = {
  async saveDataset(meta: DatasetMeta, rows: CellValue[][]) {
    await set(K.rows(meta.id), rows, store);
    await set(K.meta(meta.id), meta, store);
  },
  saveDatasetMeta: (meta: DatasetMeta) => set(K.meta(meta.id), meta, store),
  listDatasets: () => listByPrefix<DatasetMeta>('dataset:meta:'),
  loadRows: (id: string) => get<CellValue[][]>(K.rows(id), store),
  async deleteDataset(id: string) {
    await del(K.meta(id), store);
    await del(K.rows(id), store);
  },

  saveDashboard: (d: DashboardSpec) => set(K.dash(d.id), d, store),
  listDashboards: () => listByPrefix<DashboardSpec>('dashboard:'),
  /** Supprime le dashboard et ses discussions enregistrées. */
  async deleteDashboard(id: string) {
    await del(K.dash(id), store);
    const threads = await listByPrefix<ChatThread>(`thread:${id}:`);
    await Promise.all(threads.map((t) => del(K.thread(t.dashboardId, t.id), store)));
  },

  saveThread: (t: ChatThread) => set(K.thread(t.dashboardId, t.id), t, store),
  listThreads: (dashboardId: string) => listByPrefix<ChatThread>(`thread:${dashboardId}:`),
  deleteThread: (dashboardId: string, id: string) => del(K.thread(dashboardId, id), store),
};

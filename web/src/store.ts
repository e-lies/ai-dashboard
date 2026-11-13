/**
 * État applicatif (Zustand). Ne contient que des métadonnées et des specs :
 * les lignes vivent dans DuckDB (moteur) et IndexedDB (persistance).
 */
import { nanoid } from 'nanoid';
import { create } from 'zustand';
import type { CellValue, DashboardSpec, DatasetMeta, Filter, WidgetSpec } from '../../shared/types';
import { dropDataset, isLoaded, loadDataset } from './lib/db';
import { storage } from './lib/storage';

type View = { kind: 'home' } | { kind: 'import' } | { kind: 'dataset'; id: string } | { kind: 'dashboard'; id: string };

interface AppState {
  ready: boolean;
  datasets: DatasetMeta[];
  dashboards: DashboardSpec[];
  view: View;
  /** Incrémenté quand des données changent, pour forcer le recalcul des widgets. */
  dataVersion: number;

  init(): Promise<void>;
  setView(view: View): void;
  ensureLoaded(datasetId: string): Promise<void>;
  addDataset(meta: DatasetMeta, rows: CellValue[][]): Promise<void>;
  updateDatasetMeta(meta: DatasetMeta): Promise<void>;
  deleteDataset(id: string): Promise<void>;

  createDashboard(datasetId: string, name: string): Promise<DashboardSpec>;
  /** Ajoute un dashboard déjà construit (import) et l'ouvre. */
  addDashboard(d: DashboardSpec): Promise<void>;
  saveDashboard(d: DashboardSpec): Promise<void>;
  deleteDashboard(id: string): Promise<void>;
  upsertWidget(dashboardId: string, widget: WidgetSpec): Promise<void>;
  removeWidget(dashboardId: string, widgetId: string): Promise<void>;
  setGlobalFilters(dashboardId: string, filters: Filter[]): Promise<void>;
}

const loading = new Map<string, Promise<void>>();

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  datasets: [],
  dashboards: [],
  view: { kind: 'home' },
  dataVersion: 0,

  async init() {
    // Demande un stockage persistant : sans cela, le navigateur peut effacer IndexedDB
    // lorsque l'espace disque manque. Le navigateur peut refuser sans le signaler.
    void navigator.storage?.persist?.().catch(() => false);
    const [datasets, dashboards] = await Promise.all([storage.listDatasets(), storage.listDashboards()]);
    datasets.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    dashboards.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    set({ datasets, dashboards, ready: true });
  },

  setView: (view) => set({ view }),

  ensureLoaded(datasetId) {
    if (isLoaded(datasetId)) return Promise.resolve();
    // Plusieurs widgets demandent le même jeu en même temps : un seul chargement.
    let pending = loading.get(datasetId);
    if (!pending) {
      pending = (async () => {
        const meta = get().datasets.find((d) => d.id === datasetId);
        const rows = await storage.loadRows(datasetId);
        if (!meta || !rows) throw new Error('Jeu de données introuvable dans le stockage local.');
        await loadDataset(meta, rows);
      })().finally(() => loading.delete(datasetId));
      loading.set(datasetId, pending);
    }
    return pending;
  },

  async addDataset(meta, rows) {
    await storage.saveDataset(meta, rows);
    await loadDataset(meta, rows);
    set((s) => ({ datasets: [meta, ...s.datasets], view: { kind: 'dataset', id: meta.id } }));
  },

  async updateDatasetMeta(meta) {
    await storage.saveDatasetMeta(meta);
    set((s) => ({ datasets: s.datasets.map((d) => (d.id === meta.id ? meta : d)) }));
  },

  async deleteDataset(id) {
    const linked = get().dashboards.filter((d) => d.datasetId === id);
    await Promise.all(linked.map((d) => storage.deleteDashboard(d.id)));
    await storage.deleteDataset(id);
    await dropDataset(id);
    set((s) => ({
      datasets: s.datasets.filter((d) => d.id !== id),
      dashboards: s.dashboards.filter((d) => d.datasetId !== id),
      view: { kind: 'home' },
    }));
  },

  async createDashboard(datasetId, name) {
    const now = new Date().toISOString();
    const d: DashboardSpec = { id: nanoid(10), name, datasetId, widgets: [], globalFilters: [], createdAt: now, updatedAt: now };
    await storage.saveDashboard(d);
    set((s) => ({ dashboards: [d, ...s.dashboards], view: { kind: 'dashboard', id: d.id } }));
    return d;
  },

  async addDashboard(d) {
    await storage.saveDashboard(d);
    set((s) => ({ dashboards: [d, ...s.dashboards], view: { kind: 'dashboard', id: d.id } }));
  },

  async saveDashboard(d) {
    const updated = { ...d, updatedAt: new Date().toISOString() };
    await storage.saveDashboard(updated);
    set((s) => ({ dashboards: s.dashboards.map((x) => (x.id === d.id ? updated : x)) }));
  },

  async deleteDashboard(id) {
    await storage.deleteDashboard(id);
    set((s) => ({ dashboards: s.dashboards.filter((d) => d.id !== id), view: { kind: 'home' } }));
  },

  async upsertWidget(dashboardId, widget) {
    const d = get().dashboards.find((x) => x.id === dashboardId);
    if (!d) return;
    const exists = d.widgets.some((w) => w.id === widget.id);
    const widgets = exists ? d.widgets.map((w) => (w.id === widget.id ? widget : w)) : [...d.widgets, widget];
    await get().saveDashboard({ ...d, widgets });
  },

  async removeWidget(dashboardId, widgetId) {
    const d = get().dashboards.find((x) => x.id === dashboardId);
    if (!d) return;
    await get().saveDashboard({ ...d, widgets: d.widgets.filter((w) => w.id !== widgetId) });
  },

  async setGlobalFilters(dashboardId, filters) {
    const d = get().dashboards.find((x) => x.id === dashboardId);
    if (!d) return;
    await get().saveDashboard({ ...d, globalFilters: filters });
  },
}));

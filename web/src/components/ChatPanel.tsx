/**
 * Chatbot d'analyse. Le LLM ne voit que le schéma et des statistiques ;
 * il produit une requête SQL exécutée localement par DuckDB, puis rédige la
 * réponse à partir du résultat agrégé.
 *
 * Les valeurs texte utilisées par le SQL (ex. une région) sont vérifiées
 * localement : une valeur absente est corrigée si une valeur réelle lui est
 * clairement équivalente (accents, casse), sinon des valeurs proches sont proposées.
 */
import { nanoid } from 'nanoid';
import { useEffect, useRef, useState } from 'react';
import type { ChatPlanRequest } from '../../../shared/contracts';
import type { DashboardSpec, DatasetMeta, QueryResult } from '../../../shared/types';
import { api } from '../lib/api';
import {
  cleanThreadName,
  defaultThreadName,
  sortThreads,
  THREAD_NAME_MAX,
  type ChatMessage as Message,
  type ChatThread,
  type History,
  type Plan,
  type Scope,
  type Suggestion,
} from '../lib/chatThreads';
import { ensureDashboardView, runSql, runUntrustedSql } from '../lib/db';
import { looksEmpty, replaceSqlLiteral } from '../lib/fuzzy';
import { dashboardViewName, describeFilter, ident, isComplete, tableName } from '../lib/sql';
import { storage } from '../lib/storage';
import { checkLiterals } from '../lib/valueMatch';
import { useApp } from '../store';
import { ResultView } from './ResultView';

const MAX_ATTEMPTS = 3;
const NO_MESSAGES: Message[] = [];

type Correction = NonNullable<ChatPlanRequest['valueCorrections']>[number];
type Outcome = { plan: Plan; result: QueryResult } | null;

/** Contexte envoyé au LLM : aucune ligne, et rien de plus que le nom et le type pour les colonnes sensibles. */
function schemaContext(meta: DatasetMeta): ChatPlanRequest['columns'] {
  return meta.columns.map((c) =>
    c.sensitive
      ? { id: c.id, name: c.name, type: c.type, role: c.role }
      : {
          id: c.id,
          name: c.name,
          type: c.type,
          role: c.role,
          description: c.description ?? null,
          nullCount: c.stats?.nullCount,
          distinctCount: c.stats?.distinctCount,
          min: c.stats?.min ?? null,
          max: c.stats?.max ?? null,
          topValues: c.stats?.topValues.map((v) => v.value),
        },
  );
}

/**
 * Sur un dashboard, le chat interroge la vue filtrée du dashboard : il répond selon les filtres actifs,
 * et ses réponses épinglées suivent ensuite ces filtres. Sans dashboard, il interroge le jeu complet.
 */
export function ChatPanel({ meta, dashboard }: { meta: DatasetMeta; dashboard?: DashboardSpec }) {
  const ensureLoaded = useApp((s) => s.ensureLoaded);
  const upsertWidget = useApp((s) => s.upsertWidget);
  const [messages, setMessages] = useState<Message[]>(NO_MESSAGES);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // Discussions enregistrées (sur un dashboard seulement). Rien n'est enregistré sans action de l'utilisateur.
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [current, setCurrent] = useState<ChatThread | null>(null);
  /** Messages tels qu'au dernier enregistrement (ou à l'ouverture) : sert à repérer les changements. */
  const [savedMessages, setSavedMessages] = useState<Message[]>(NO_MESSAGES);
  /** Saisie du nom : enregistrement d'une nouvelle discussion ou renommage. */
  const [naming, setNaming] = useState<{ mode: 'save' | 'rename'; value: string } | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const dirty = messages !== savedMessages && messages.length > 0;
  const dashboardId = dashboard?.id;

  useEffect(() => {
    if (!dashboardId) return;
    storage.listThreads(dashboardId).then((t) => setThreads(sortThreads(t)), () => setThreads([]));
  }, [dashboardId]);

  /** Avant de quitter la discussion affichée : confirmation si des messages ne sont pas enregistrés. */
  const canLeave = () =>
    !dirty ||
    window.confirm(
      current
        ? `Les derniers messages de « ${current.name} » ne sont pas enregistrés et seront perdus. Continuer ?`
        : 'Cette discussion n’est pas enregistrée et sera perdue. Continuer ?',
    );

  function show(thread: ChatThread | null) {
    const msgs = thread?.messages ?? NO_MESSAGES;
    setCurrent(thread);
    setMessages(msgs);
    setSavedMessages(msgs);
    setNaming(null);
    setThreadError(null);
  }

  function openThread(id: string) {
    if (!canLeave()) return;
    show(threads.find((t) => t.id === id) ?? null);
  }

  async function persist(thread: ChatThread) {
    try {
      await storage.saveThread(thread);
    } catch (e) {
      setThreadError(`Enregistrement impossible : ${(e as Error).message}`);
      return;
    }
    setThreads((prev) => sortThreads([thread, ...prev.filter((t) => t.id !== thread.id)]));
    setCurrent(thread);
    setSavedMessages(thread.messages);
    setNaming(null);
    setThreadError(null);
  }

  function save() {
    if (!dashboardId) return;
    if (!current) {
      setNaming({ mode: 'save', value: defaultThreadName(messages) });
      return;
    }
    void persist({ ...current, messages, updatedAt: new Date().toISOString() });
  }

  function confirmName() {
    if (!naming || !dashboardId) return;
    const name = cleanThreadName(naming.value);
    if (!name) {
      setThreadError('Donnez un nom à la discussion.');
      return;
    }
    const now = new Date().toISOString();
    if (naming.mode === 'rename' && current) {
      // Le renommage ne touche qu'au nom : les messages non enregistrés le restent.
      void persist({ ...current, name, updatedAt: now });
    } else {
      void persist({ id: nanoid(10), dashboardId, name, messages, createdAt: now, updatedAt: now });
    }
  }

  async function removeThread() {
    if (!current || !window.confirm(`Supprimer la discussion « ${current.name} » ? Cette action est irréversible.`)) return;
    await storage.deleteThread(current.dashboardId, current.id);
    setThreads((prev) => prev.filter((t) => t.id !== current.id));
    show(null);
  }

  const push = (m: Omit<Message, 'id'>) => {
    setMessages((prev) => [...prev, { ...m, id: nanoid(6) }]);
    setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
  };

  const filters = (dashboard?.globalFilters ?? []).filter(isComplete);
  const filterLabels = filters.map((f) => describeFilter(f, meta));

  /** Prépare la table interrogée selon les filtres actifs du dashboard au moment de la question. */
  async function prepareScope(): Promise<Scope> {
    if (!dashboard) return { table: tableName(meta.id), rowCount: meta.rowCount, activeFilters: [], labels: [] };
    await ensureDashboardView(dashboard.id, meta, filters);
    const table = dashboardViewName(dashboard.id);
    const [count] = await runSql(`SELECT COUNT(*) AS n FROM ${ident(table)}`);
    return {
      table,
      rowCount: Number(count?.n ?? 0),
      activeFilters: filters.map((f) => describeFilter(f, meta, { hideSensitive: true })),
      labels: filterLabels,
    };
  }

  /** Planifie puis exécute, avec jusqu'à 3 tentatives si le SQL échoue. Retourne null si un message a été affiché. */
  async function planAndRun(
    question: string,
    history: History,
    scope: Scope,
    valueCorrections: Correction[] | null,
  ): Promise<Outcome> {
    let previousError: ChatPlanRequest['previousError'] = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const plan = await api.chatPlan({
        question,
        table: scope.table,
        rowCount: scope.rowCount,
        activeFilters: scope.activeFilters,
        columns: schemaContext(meta),
        history,
        previousError,
        valueCorrections,
      });
      if (plan.kind === 'clarify' || !plan.sql) {
        push({ role: 'assistant', text: plan.message });
        return null;
      }
      try {
        return { plan: { ...plan, sql: plan.sql }, result: await runUntrustedSql(plan.sql) };
      } catch (e) {
        previousError = { sql: plan.sql, error: (e as Error).message };
      }
    }
    push({ role: 'assistant', text: `Je n’ai pas réussi à calculer la réponse (${previousError?.error}).`, error: true });
    return null;
  }

  /**
   * Applique des corrections de valeurs : remplacement direct du littéral dans le SQL, sans appel au LLM.
   * Si un littéral est introuvable dans le SQL, nouvelle planification avec les corrections, sauf pour
   * les colonnes sensibles, dont les valeurs ne quittent jamais le navigateur (la correction est alors abandonnée).
   */
  async function applyCorrections(
    question: string,
    history: History,
    scope: Scope,
    plan: Plan,
    corrections: Correction[],
  ): Promise<Outcome> {
    let sql = plan.sql;
    let needsReplan = false;
    for (const c of corrections) {
      const replaced = replaceSqlLiteral(sql, c.requested, c.actual);
      if (replaced) sql = replaced;
      else if (!meta.columns.find((col) => col.id === c.columnId)?.sensitive) needsReplan = true;
    }
    if (needsReplan) {
      const shareable = corrections.filter((c) => !meta.columns.find((col) => col.id === c.columnId)?.sensitive);
      return planAndRun(question, history, scope, shareable);
    }
    const literals = plan.literals.map((l) => {
      const c = corrections.find((x) => x.columnId === l.columnId && x.requested === l.value);
      return c ? { ...l, value: c.actual } : l;
    });
    return { plan: { ...plan, sql, literals }, result: await runUntrustedSql(sql) };
  }

  /** Vérifie les valeurs demandées, corrige ce qui est sûr, puis rédige la réponse ou propose des valeurs proches. */
  async function resolveAndAnswer(question: string, history: History, scope: Scope, plan: Plan, result: QueryResult) {
    const notes: string[] = [];
    if (scope.labels.length) notes.push(`Filtres du dashboard appliqués : ${scope.labels.join(' ; ')}.`);
    const checks = await checkLiterals(plan.literals, meta);

    const autos = checks.filter((c) => c.auto);
    if (autos.length) {
      const corrected = await applyCorrections(
        question,
        history,
        scope,
        plan,
        autos.map((c) => ({ columnId: c.column.id, requested: c.requested, actual: c.auto! })),
      );
      if (!corrected) return;
      ({ plan, result } = corrected);
      for (const c of autos) notes.push(`« ${c.requested} » a été interprété comme « ${c.auto} » (${c.column.name}).`);
    }
    for (const c of checks) {
      if (!c.auto && !c.close.length) notes.push(`Aucune valeur proche de « ${c.requested} » dans la colonne ${c.column.name}.`);
    }

    const suggestions: Suggestion[] = checks
      .filter((c) => !c.auto && c.close.length)
      .map((c) => ({
        columnId: c.column.id,
        columnName: c.column.name,
        requested: c.requested,
        options: c.close.map((v) => v.value),
      }));
    const pending = { question, history, plan, scope };

    if (suggestions.length && looksEmpty(result.rows)) {
      const missing = suggestions.map((s) => `« ${s.requested} » (${s.columnName})`).join(', ');
      push({
        role: 'assistant',
        text: `Aucun résultat : je ne trouve pas ${missing} dans les données. Vouliez-vous dire :`,
        notes,
        suggestions,
        pending,
      });
      return;
    }

    // Seul le résultat (tronqué à 50 lignes) est renvoyé au LLM pour rédiger la réponse.
    const { answer } = await api.chatAnswer({
      question,
      sql: plan.sql,
      result: result.rows.slice(0, 50),
      truncated: result.truncated || result.rows.length > 50,
      activeFilters: scope.activeFilters,
    });
    push({ role: 'assistant', text: answer, sql: plan.sql, chart: plan.chart, result, question, notes, suggestions, pending });
  }

  async function run(task: () => Promise<void>) {
    setBusy(true);
    try {
      await ensureLoaded(meta.id);
      await task();
    } catch (e) {
      push({ role: 'assistant', text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }

  function ask(question: string) {
    const history = messages.slice(-10).map((m) => ({
      role: m.role,
      content: m.sql ? `${m.text}\n(SQL : ${m.sql})` : m.text,
    }));
    push({ role: 'user', text: question });
    return run(async () => {
      const scope = await prepareScope();
      const first = await planAndRun(question, history, scope, null);
      if (first) await resolveAndAnswer(question, history, scope, first.plan, first.result);
    });
  }

  /** L'utilisateur choisit une valeur proposée : on corrige le SQL et on relance. */
  function choose(m: Message, s: Suggestion, option: string) {
    const ctx = m.pending;
    if (!ctx) return;
    setMessages((prev) =>
      prev.map((x) => (x.id === m.id ? { ...x, suggestions: x.suggestions?.filter((y) => y !== s) } : x)),
    );
    push({ role: 'user', text: `${s.columnName} : « ${option} »` });
    return run(async () => {
      const corrected = await applyCorrections(ctx.question, ctx.history, ctx.scope, ctx.plan, [
        { columnId: s.columnId, requested: s.requested, actual: option },
      ]);
      if (corrected) await resolveAndAnswer(ctx.question, ctx.history, ctx.scope, corrected.plan, corrected.result);
    });
  }

  async function pin(m: Message) {
    if (!m.sql || !dashboard) return;
    await upsertWidget(dashboard.id, {
      id: nanoid(8),
      title: m.question ?? 'Réponse du chatbot',
      kind: m.chart ?? 'table',
      span: 2,
      sql: m.sql,
      query: { datasetId: meta.id, filters: [], groupBy: [], measures: [] },
    });
  }

  return (
    <aside className="chat">
      <h3>Questions sur les données</h3>
      <p className="hint chat-scope">
        {!dashboard
          ? 'Réponses sur le jeu de données complet, sans filtre.'
          : filterLabels.length
            ? `Réponses selon les filtres du dashboard : ${filterLabels.join(' ; ')}.`
            : 'Aucun filtre actif : réponses sur tout le jeu de données.'}
      </p>
      {dashboard && (
        <div className="thread-bar">
          <div className="row">
            <select
              aria-label="Discussion"
              value={current?.id ?? ''}
              disabled={busy}
              onChange={(e) => (e.target.value ? openThread(e.target.value) : canLeave() && show(null))}
            >
              <option value="">{current ? 'Nouvelle discussion' : 'Nouvelle discussion (non enregistrée)'}</option>
              {threads.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <button disabled={busy || !dirty} onClick={save} title="Enregistrer la discussion pour la reprendre plus tard">
              Enregistrer
            </button>
          </div>
          {(current || dirty) && (
            <div className="row small">
              {dirty && <span className="muted">{current ? 'Modifications non enregistrées' : 'Discussion non enregistrée'}</span>}
              {current && !naming && (
                <>
                  <button className="link" disabled={busy} onClick={() => setNaming({ mode: 'rename', value: current.name })}>
                    Renommer
                  </button>
                  <button className="link danger-text" disabled={busy} onClick={() => void removeThread()}>
                    Supprimer
                  </button>
                </>
              )}
            </div>
          )}
          {naming && (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                confirmName();
              }}
            >
              <input
                autoFocus
                aria-label="Nom de la discussion"
                maxLength={THREAD_NAME_MAX}
                value={naming.value}
                onChange={(e) => setNaming({ ...naming, value: e.target.value })}
              />
              <button className="primary">OK</button>
              <button type="button" onClick={() => (setNaming(null), setThreadError(null))}>
                Annuler
              </button>
            </form>
          )}
          {threadError && <p className="error small">{threadError}</p>}
        </div>
      )}
      <div className="chat-log">
        {messages.length === 0 && (
          <p className="muted small">
            Ex. : « Quel est le total par région pour 2024 ? », « Quels mois ont le plus de valeurs manquantes ? »
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}${m.error ? ' error' : ''}`}>
            <div className="msg-text">{m.text}</div>
            {m.suggestions?.map((sg) => (
              <div key={sg.columnId + sg.requested} className="suggestions">
                <span className="small muted">
                  {sg.columnName}, au lieu de « {sg.requested} » :
                </span>
                {sg.options.map((o) => (
                  <button key={o} className="chip" disabled={busy} onClick={() => void choose(m, sg, o)}>
                    {o}
                  </button>
                ))}
              </div>
            ))}
            {m.notes?.map((n) => (
              <p key={n} className="hint">
                {n}
              </p>
            ))}
            {m.result && (
              <>
                <ResultView kind={m.chart ?? 'table'} result={m.result} height={200} />
                <details>
                  <summary>SQL exécuté</summary>
                  <pre className="sql">{m.sql}</pre>
                </details>
                {dashboard && (
                  <button className="link" onClick={() => pin(m)}>
                    Épingler au dashboard
                  </button>
                )}
              </>
            )}
          </div>
        ))}
        {busy && <p className="muted small">Analyse en cours…</p>}
        <div ref={endRef} />
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          const q = input.trim();
          if (!q || busy) return;
          setInput('');
          void ask(q);
        }}
      >
        <textarea
          rows={2}
          value={input}
          placeholder="Posez une question…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button className="primary" disabled={busy}>
          Envoyer
        </button>
      </form>
    </aside>
  );
}

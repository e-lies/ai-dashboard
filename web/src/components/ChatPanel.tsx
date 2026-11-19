/**
 * Chatbot d'analyse. L'IA infonuagique ne reçoit que le schéma (noms, types, rôles et
 * descriptions des colonnes) : elle produit une requête SQL et une phrase de
 * présentation. La requête est exécutée localement par DuckDB ; son résultat
 * n'est jamais renvoyé à l'IA infonuagique, seulement à l'IA locale qui rédige la réponse.
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
  historyFor,
  isRefreshable,
  isStale,
  redactDbError,
  schemaContext,
  sortThreads,
  THREAD_NAME_MAX,
  type ChatMessage as Message,
  type ChatThread,
  type History,
  type Plan,
  type Scope,
  type Suggestion,
} from '../lib/chatThreads';
import { ensureDashboardView, runUntrustedSql } from '../lib/db';
import { looksEmpty, replaceSqlLiteral } from '../lib/fuzzy';
import { dashboardViewName, describeFilter, isComplete, tableName } from '../lib/sql';
import { storage } from '../lib/storage';
import { checkLiterals } from '../lib/valueMatch';
import { useApp } from '../store';
import { ResultView } from './ResultView';

const MAX_ATTEMPTS = 3;
const NO_MESSAGES: Message[] = [];

// Largeur du panneau : réglable à la souris ou au clavier, mémorisée dans ce navigateur.
const WIDTH_KEY = 'tq-dashboard:chat-width';
const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 300;
const maxWidth = () => Math.max(MIN_WIDTH, Math.min(1000, Math.round(window.innerWidth * 0.7)));
const clampWidth = (w: number) => Math.round(Math.min(maxWidth(), Math.max(MIN_WIDTH, w)));

function readWidth(): number {
  try {
    const w = Number(localStorage.getItem(WIDTH_KEY));
    return w ? clampWidth(w) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function useChatWidth() {
  const [width, setWidth] = useState(readWidth);
  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      // Stockage indisponible (navigation privée, etc.) : la largeur n'est simplement pas mémorisée.
    }
  }, [width]);

  const handleProps = {
    role: 'separator',
    'aria-orientation': 'vertical' as const,
    'aria-label': 'Largeur du chat',
    'aria-valuenow': width,
    'aria-valuemin': MIN_WIDTH,
    'aria-valuemax': maxWidth(),
    tabIndex: 0,
    title: 'Glisser pour changer la largeur (double-clic : largeur par défaut)',
    onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
      e.preventDefault();
      const startX = e.clientX;
      const start = width;
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      document.body.classList.add('resizing');
      // Le panneau est à droite : glisser vers la gauche l'élargit.
      const move = (ev: PointerEvent) => setWidth(clampWidth(start + startX - ev.clientX));
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        document.body.classList.remove('resizing');
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    },
    onDoubleClick: () => setWidth(clampWidth(DEFAULT_WIDTH)),
    onKeyDown(e: React.KeyboardEvent) {
      const step = e.shiftKey ? 80 : 20;
      if (e.key === 'ArrowLeft') setWidth((w) => clampWidth(w + step));
      else if (e.key === 'ArrowRight') setWidth((w) => clampWidth(w - step));
      else if (e.key === 'Home') setWidth(clampWidth(DEFAULT_WIDTH));
      else return;
      e.preventDefault();
    },
  };
  return { width, handleProps };
}

/** Valeur demandée remplacée par une valeur réelle de la colonne (corrigée localement, jamais envoyée à l'IA). */
type Correction = { columnId: string; requested: string; actual: string };
type Outcome = { plan: Plan; result: QueryResult } | null;


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
  const { width, handleProps } = useChatWidth();

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
    if (!dashboard) return { table: tableName(meta.id), activeFilters: [], labels: [] };
    await ensureDashboardView(dashboard.id, meta, filters);
    return {
      table: dashboardViewName(dashboard.id),
      // Le LLM apprend quelles colonnes sont filtrées, et comment, mais pas les valeurs.
      activeFilters: filters.map((f) => describeFilter(f, meta, { hideValues: true })),
      labels: filterLabels,
    };
  }

  /** Planifie puis exécute, avec jusqu'à 3 tentatives si le SQL échoue. Retourne null si un message a été affiché. */
  async function planAndRun(question: string, history: History, scope: Scope): Promise<Outcome> {
    let previousError: ChatPlanRequest['previousError'] = null;
    let lastError = '';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const plan = await api.chatPlan({
        question,
        table: scope.table,
        activeFilters: scope.activeFilters,
        columns: schemaContext(meta),
        history,
        previousError,
      });
      if (plan.kind === 'unanswerable') {
        // Impossible avec ces colonnes : rien n'est exécuté et l'IA locale n'est pas appelée.
        const alternative = plan.alternative?.trim();
        push({
          role: 'assistant',
          text: plan.message,
          explanation: plan.message,
          unanswerable: true,
          ...(alternative ? { alternative } : {}),
        });
        return null;
      }
      if (plan.kind === 'clarify' || !plan.sql) {
        // Question de précision : la réponse de l'utilisateur repartira avec cet échange dans l'historique.
        push({ role: 'assistant', text: plan.message, explanation: plan.message });
        return null;
      }
      try {
        // modelSql garde le SQL tel qu'écrit par le LLM, avant toute correction de valeur faite localement.
        return { plan: { ...plan, sql: plan.sql, modelSql: plan.sql }, result: await runUntrustedSql(plan.sql) };
      } catch (e) {
        lastError = (e as Error).message;
        // Les messages de DuckDB peuvent citer des valeurs des données : elles sont retirées avant l'envoi.
        previousError = { sql: plan.sql, error: redactDbError(lastError) };
      }
    }
    push({ role: 'assistant', text: `Je n’ai pas réussi à calculer la réponse (${lastError}).`, error: true });
    return null;
  }

  /**
   * Applique des corrections de valeurs en remplaçant directement le littéral dans le SQL, sans appel au LLM :
   * les valeurs réelles des données ne lui sont jamais envoyées. Si le littéral est introuvable dans le SQL,
   * l'utilisateur est invité à reformuler sa question avec la valeur existante.
   */
  async function applyCorrections(plan: Plan, corrections: Correction[]): Promise<Outcome> {
    let sql = plan.sql;
    const failed: Correction[] = [];
    for (const c of corrections) {
      const replaced = replaceSqlLiteral(sql, c.requested, c.actual);
      if (replaced) sql = replaced;
      else failed.push(c);
    }
    if (failed.length) {
      const list = failed
        .map((c) => `« ${c.requested} » → « ${c.actual} » (${meta.columns.find((x) => x.id === c.columnId)?.name ?? ''})`)
        .join(', ');
      push({
        role: 'assistant',
        text: `Je n’ai pas pu appliquer automatiquement la valeur existante : ${list}. Reformulez votre question avec cette valeur.`,
        local: true,
      });
      return null;
    }
    const literals = plan.literals.map((l) => {
      const c = corrections.find((x) => x.columnId === l.columnId && x.requested === l.value);
      return c ? { ...l, value: c.actual } : l;
    });
    return { plan: { ...plan, sql, literals }, result: await runUntrustedSql(sql) };
  }

  /**
   * Rédaction de la réponse par l'IA locale, à partir du résultat (50 lignes au plus). Sans IA locale, ou en cas
   * d'échec, la phrase de présentation produite avec le SQL est utilisée.
   */
  async function answerLocally(
    question: string,
    plan: Pick<Plan, 'sql' | 'message'>,
    result: QueryResult,
    scope: Scope,
    notes: string[],
  ) {
    const { localModel } = await api.capabilities();
    if (!localModel) return plan.message;
    try {
      const { answer } = await api.chatAnswer({
        question,
        sql: plan.sql,
        result: result.rows.slice(0, 50),
        truncated: result.truncated || result.rows.length > 50,
        activeFilters: scope.labels,
        notes: notes.filter((n) => n.includes('interprété')),
      });
      return answer.trim() || plan.message;
    } catch (e) {
      notes.push(`Réponse non rédigée : l’IA locale n’a pas répondu (${(e as Error).message.replace(/\.+$/, '')}).`);
      return plan.message;
    }
  }

  /** Vérifie les valeurs demandées, corrige ce qui est sûr, puis affiche le résultat ou propose des valeurs proches. */
  async function resolveAndAnswer(question: string, history: History, scope: Scope, plan: Plan, result: QueryResult) {
    const notes: string[] = [];
    if (scope.labels.length) notes.push(`Filtres du dashboard appliqués : ${scope.labels.join(' ; ')}.`);
    const checks = await checkLiterals(plan.literals, meta);

    const autos = checks.filter((c) => c.auto);
    if (autos.length) {
      const corrected = await applyCorrections(
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
        local: true,
      });
      return;
    }

    // Le résultat n'est jamais envoyé à l'IA infonuagique. Si une IA locale est configurée, c'est elle qui rédige
    // la réponse à partir du résultat ; sinon, le résultat est affiché sous la phrase de présentation du SQL.
    const text = await answerLocally(question, plan, result, scope, notes);
    if (looksEmpty(result.rows)) notes.push('La requête ne renvoie aucun résultat.');
    else if (result.truncated) notes.push('Résultat tronqué : seules les premières lignes sont affichées.');
    push({
      role: 'assistant',
      // `text` (rédigé localement, avec des chiffres) n'est jamais renvoyé à l'IA infonuagique : seul `explanation` l'est.
      text,
      explanation: plan.message,
      modelSql: plan.modelSql,
      sql: plan.sql,
      chart: plan.chart,
      result,
      question,
      notes,
      suggestions,
      pending,
      computedAt: new Date().toISOString(),
      computedFilters: scope.labels,
    });
  }

  /**
   * Actualise les résultats de la discussion : chaque SQL enregistré est réexécuté sur les données et les filtres
   * actuels, sans nouvel appel à l'IA infonuagique. Si une IA locale est configurée, elle rédige de nouveau la réponse.
   * Les modifications ne sont enregistrées qu'au prochain « Enregistrer », comme le reste de la discussion.
   */
  function refreshResults() {
    return run(async () => {
      const scope = await prepareScope();
      const now = new Date().toISOString();
      const date = new Date(now).toLocaleDateString('fr-CA');
      const updated = new Map<string, Message>();
      for (const m of messages) {
        if (!isRefreshable(m)) continue;
        try {
          const result = await runUntrustedSql(m.sql!);
          // Les valeurs interprétées (« montreal » → « Montréal ») restent valables : le SQL les contient déjà.
          const notes = [
            ...(scope.labels.length ? [`Filtres du dashboard appliqués : ${scope.labels.join(' ; ')}.`] : []),
            ...(m.notes ?? []).filter((n) => n.includes('interprété')),
          ];
          // Une réponse sans `explanation` date d'avant la séparation des IA : son texte vient de l'ancien résultat.
          const fallback = m.explanation ?? m.text;
          const text = await answerLocally(m.question ?? '', { sql: m.sql!, message: fallback }, result, scope, notes);
          if (text === fallback && m.explanation === undefined) {
            notes.push('Le texte ci-dessus a été rédigé avec les données précédentes ; le résultat ci-dessous est à jour.');
          }
          if (looksEmpty(result.rows)) notes.push('La requête ne renvoie aucun résultat.');
          else if (result.truncated) notes.push('Résultat tronqué : seules les premières lignes sont affichées.');
          notes.push(`Résultat actualisé le ${date}, sur les données et les filtres actuels.`);
          updated.set(m.id, { ...m, text, result, notes, suggestions: undefined, computedAt: now, computedFilters: scope.labels });
        } catch (e) {
          updated.set(m.id, {
            ...m,
            notes: [...(m.notes ?? []), `Ce résultat n’a pas pu être actualisé : ${(e as Error).message}`],
          });
        }
      }
      setMessages((prev) => prev.map((m) => updated.get(m.id) ?? m));
    });
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
    const history = historyFor(messages);
    push({ role: 'user', text: question });
    return run(async () => {
      const scope = await prepareScope();
      const first = await planAndRun(question, history, scope);
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
    // Valeur issue des données : affichée, mais jamais transmise à l'IA (ni maintenant ni dans l'historique).
    push({ role: 'user', text: `${s.columnName} : « ${option} »`, local: true });
    return run(async () => {
      const corrected = await applyCorrections(ctx.plan, [{ columnId: s.columnId, requested: s.requested, actual: option }]);
      if (corrected) await resolveAndAnswer(ctx.question, ctx.history, ctx.scope, corrected.plan, corrected.result);
    });
  }

  const staleCount = messages.filter((m) =>
    isStale(m, { dataUpdatedAt: meta.updatedAt, filters: filterLabels, savedAt: current?.updatedAt }),
  ).length;

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
    <aside className="chat" style={{ '--chat-width': `${width}px` } as React.CSSProperties}>
      <div className="chat-resizer" {...handleProps} />
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
      {staleCount > 0 && (
        <div className="stale-banner" role="status">
          <span>
            {staleCount === 1
              ? 'Un résultat de cette discussion a été calculé'
              : `${staleCount} résultats de cette discussion ont été calculés`}{' '}
            avant la dernière mise à jour des données ou avec d’autres filtres.
          </span>
          <button className="link" disabled={busy} onClick={() => void refreshResults()}>
            Actualiser les résultats
          </button>
        </div>
      )}
      <div className="chat-log">
        {messages.length === 0 && (
          <p className="muted small">
            Ex. : « Quel est le total par région pour 2024 ? », « Quels mois ont le plus de valeurs manquantes ? »
          </p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`msg ${m.role}${m.error ? ' error' : ''}${m.unanswerable ? ' unanswerable' : ''}`}
          >
            {m.unanswerable && <div className="msg-label small">Impossible de répondre avec ces données</div>}
            <div className="msg-text">{m.text}</div>
            {m.alternative && (
              <div className="suggestions">
                <span className="small muted">Question possible :</span>
                <button className="chip" disabled={busy} onClick={() => void ask(m.alternative!)}>
                  {m.alternative}
                </button>
              </div>
            )}
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

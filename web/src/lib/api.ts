import type {
  Capabilities,
  ChatAnswerRequest,
  ChatAnswerResponse,
  ChatPlanRequest,
  ChatPlanResponse,
  InferTypesRequest,
  InferTypesResponse,
} from '../../../shared/contracts';

async function post<TReq, TRes>(url: string, body: TReq): Promise<TRes> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Erreur ${res.status}`);
  }
  return (await res.json()) as TRes;
}

let capabilities: Promise<Capabilities> | null = null;

export const api = {
  /** IA infonuagique : génération du SQL à partir du schéma. Aucune valeur des données n'est transmise. */
  chatPlan: (body: ChatPlanRequest) => post<ChatPlanRequest, ChatPlanResponse>('/api/chat/plan', body),

  /** IA locale : analyse des colonnes (échantillons masqués). */
  inferTypes: (body: InferTypesRequest) => post<InferTypesRequest, InferTypesResponse>('/api/infer-types', body),
  /** IA locale : rédaction de la réponse à partir du résultat. */
  chatAnswer: (body: ChatAnswerRequest) => post<ChatAnswerRequest, ChatAnswerResponse>('/api/chat/answer', body),

  /** Capacités du serveur (IA locale configurée ou non), mises en cache pour la session. */
  capabilities(): Promise<Capabilities> {
    capabilities ??= fetch('/api/capabilities')
      .then((r) => (r.ok ? (r.json() as Promise<Capabilities>) : { localModel: null }))
      .catch(() => {
        capabilities = null; // nouvel essai au prochain appel
        return { localModel: null };
      });
    return capabilities;
  },
};

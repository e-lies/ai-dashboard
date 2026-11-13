import type {
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

export const api = {
  inferTypes: (body: InferTypesRequest) => post<InferTypesRequest, InferTypesResponse>('/api/infer-types', body),
  chatPlan: (body: ChatPlanRequest) => post<ChatPlanRequest, ChatPlanResponse>('/api/chat/plan', body),
  chatAnswer: (body: ChatAnswerRequest) => post<ChatAnswerRequest, ChatAnswerResponse>('/api/chat/answer', body),
};

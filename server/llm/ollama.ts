import { z } from 'zod';
import type { LLMProvider } from './provider.js';

/**
 * IA locale servie par Ollama (ex. sur un Mac du réseau interne). Sortie structurée :
 * le schéma JSON est passé dans `format`, puis la réponse est validée avec Zod.
 */
export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';

  constructor(
    private baseUrl: string,
    readonly model: string,
    private opts: { timeoutMs?: number; numCtx?: number } = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async structured<S extends z.ZodType>({
    system,
    messages,
    schema,
  }: {
    system: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
    schema: S;
    effort?: 'low' | 'medium' | 'high';
  }): Promise<z.infer<S>> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 180_000),
        body: JSON.stringify({
          model: this.model,
          stream: false,
          messages: [{ role: 'system', content: system }, ...messages],
          format: z.toJSONSchema(schema),
          // Réponses déterministes ; contexte assez grand pour 50 lignes de résultat.
          options: { temperature: 0, num_ctx: this.opts.numCtx ?? 8192 },
        }),
      });
    } catch (e) {
      throw new LocalLLMUnavailableError(`IA locale injoignable (${(e as Error).message}).`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new LocalLLMUnavailableError(`IA locale : erreur ${res.status} ${detail.slice(0, 200)}`.trim());
    }
    const data = (await res.json()) as { message?: { content?: string }; done_reason?: string };
    if (data.done_reason === 'length') throw new Error('Réponse de l’IA locale tronquée (contexte ou longueur atteints).');
    let json: unknown;
    try {
      json = JSON.parse(data.message?.content ?? '');
    } catch {
      throw new Error('Réponse de l’IA locale illisible (JSON invalide).');
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new Error('Réponse de l’IA locale non conforme au schéma attendu.');
    return parsed.data;
  }
}

export class LocalLLMUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalLLMUnavailableError';
  }
}

import type { z } from 'zod';

/**
 * Abstraction du fournisseur LLM. Les prompts et la logique métier n'en
 * dépendent pas : ajouter OpenAI ou Gemini revient à écrire une autre
 * implémentation de cette interface.
 */
export interface LLMProvider {
  readonly name: string;
  /** Appel unique dont la sortie est validée contre un schéma Zod. */
  structured<S extends z.ZodType>(args: {
    system: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
    schema: S;
    effort?: 'low' | 'medium' | 'high';
  }): Promise<z.infer<S>>;
}

export class LLMRefusalError extends Error {
  constructor(message = 'Le modèle a refusé de répondre à cette requête.') {
    super(message);
    this.name = 'LLMRefusalError';
  }
}

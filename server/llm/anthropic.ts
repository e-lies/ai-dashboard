import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import { LLMRefusalError, type LLMProvider } from './provider.js';

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(private model: string) {
    // Lit ANTHROPIC_API_KEY (ou un profil `ant auth login`) dans l'environnement.
    this.client = new Anthropic();
  }

  async structured<S extends z.ZodType>({
    system,
    messages,
    schema,
    effort = 'medium',
  }: {
    system: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
    schema: S;
    effort?: 'low' | 'medium' | 'high';
  }): Promise<z.infer<S>> {
    const response = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: 16000,
      system,
      messages,
      output_config: { effort, format: betaZodOutputFormat(schema) },
      // Repli côté serveur si le modèle principal refuse la requête.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });

    if (response.stop_reason === 'refusal') throw new LLMRefusalError();
    if (response.stop_reason === 'max_tokens') {
      throw new Error('Réponse du LLM tronquée (max_tokens atteint).');
    }
    if (response.parsed_output == null) {
      throw new Error('Réponse du LLM non conforme au schéma attendu.');
    }
    return response.parsed_output as z.infer<S>;
  }
}

import 'dotenv/config';
import Fastify from 'fastify';
import { z } from 'zod';
import {
  ChatAnswerRequest,
  ChatAnswerResponse,
  ChatPlanRequest,
  ChatPlanResponse,
  InferTypesRequest,
  InferTypesResponse,
  type Capabilities,
} from '../shared/contracts.js';
import { AnthropicProvider } from './llm/anthropic.js';
import { LocalLLMUnavailableError, OllamaProvider } from './llm/ollama.js';
import { LLMRefusalError, type LLMProvider } from './llm/provider.js';
import { INFER_TYPES_SYSTEM, chatAnswerSystem, chatAnswerUser, chatPlanSystem, inferTypesUser } from './prompts.js';

/** IA infonuagique : génération du SQL, à partir du schéma seulement. */
function createSqlProvider(): LLMProvider {
  const provider = process.env.LLM_PROVIDER ?? 'anthropic';
  const model = process.env.LLM_MODEL ?? 'claude-sonnet-5-5';
  switch (provider) {
    case 'anthropic':
      return new AnthropicProvider(model);
    case 'ollama':
      // Possible aussi : tout faire en local.
      return new OllamaProvider(requiredEnv('LOCAL_LLM_URL'), model);
    default:
      throw new Error(`Fournisseur LLM non pris en charge : ${provider}`);
  }
}

/**
 * IA locale : analyse des colonnes et rédaction des réponses, qui voient des valeurs des données.
 * Facultative : sans elle, l'import reste heuristique et le chat affiche le résultat sans le commenter.
 */
function createLocalProvider(): OllamaProvider | null {
  const url = process.env.LOCAL_LLM_URL?.trim();
  const model = process.env.LOCAL_LLM_MODEL?.trim();
  if (!url || !model) return null;
  return new OllamaProvider(url, model, {
    timeoutMs: Number(process.env.LOCAL_LLM_TIMEOUT_MS) || 180_000,
    numCtx: Number(process.env.LOCAL_LLM_NUM_CTX) || 8192,
  });
}

function requiredEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Variable d'environnement manquante : ${name}`);
  return v;
}

const sqlLlm = createSqlProvider();
const localLlm = createLocalProvider();

const app = Fastify({
  logger: {
    level: 'info',
    // Ne jamais journaliser le contenu des requêtes : il peut contenir des données.
    serializers: { req: (req) => ({ method: req.method, url: req.url }) },
  },
  bodyLimit: 2 * 1024 * 1024,
});

class LocalLLMNotConfiguredError extends Error {}

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof z.ZodError) {
    return reply.status(400).send({ error: 'Requête invalide', details: err.issues });
  }
  if (err instanceof LLMRefusalError) {
    return reply.status(422).send({ error: err.message });
  }
  if (err instanceof LocalLLMNotConfiguredError) {
    return reply.status(503).send({ error: 'Aucune IA locale n’est configurée (LOCAL_LLM_URL, LOCAL_LLM_MODEL).' });
  }
  if (err instanceof LocalLLMUnavailableError) {
    app.log.warn(err.message);
    return reply.status(503).send({ error: err.message });
  }
  app.log.error(err);
  return reply.status(502).send({ error: 'Erreur lors de l’appel au LLM.' });
});

/** Les routes qui transportent des valeurs des données n'utilisent que l'IA locale, jamais l'IA infonuagique. */
function requireLocal(): OllamaProvider {
  if (!localLlm) throw new LocalLLMNotConfiguredError();
  return localLlm;
}

app.get('/api/health', async () => ({ ok: true, sql: sqlLlm.name, local: localLlm?.model ?? null }));

app.get('/api/capabilities', async (): Promise<Capabilities> => ({ localModel: localLlm?.model ?? null }));

// IA infonuagique : la génération du SQL, à partir du schéma seulement.
app.post('/api/chat/plan', async (req) => {
  const body = ChatPlanRequest.parse(req.body);
  const messages = [...body.history];
  let content = body.question;
  if (body.previousError) {
    content +=
      `\n\nTa requête précédente a échoué.\nSQL : ${body.previousError.sql}\n` +
      `Erreur : ${body.previousError.error}\nCorrige-la.`;
  }
  messages.push({ role: 'user', content });
  return sqlLlm.structured({
    system: chatPlanSystem(body),
    messages,
    schema: ChatPlanResponse,
    effort: 'medium',
  });
});

// IA locale : analyse des colonnes à l'import (noms et échantillons masqués).
app.post('/api/infer-types', async (req) => {
  const body = InferTypesRequest.parse(req.body);
  return requireLocal().structured({
    system: INFER_TYPES_SYSTEM,
    messages: [{ role: 'user', content: inferTypesUser(body) }],
    schema: InferTypesResponse,
  });
});

// IA locale : rédaction de la réponse à partir du résultat de la requête.
app.post('/api/chat/answer', async (req) => {
  const body = ChatAnswerRequest.parse(req.body);
  return requireLocal().structured({
    system: chatAnswerSystem(),
    messages: [{ role: 'user', content: chatAnswerUser(body) }],
    schema: ChatAnswerResponse,
  });
});

const port = Number(process.env.API_PORT ?? 8787);
await app.listen({ port, host: '127.0.0.1' });
app.log.info(
  `SQL : ${sqlLlm.name} · IA locale : ${localLlm ? `${localLlm.model} (${process.env.LOCAL_LLM_URL})` : 'non configurée'}`,
);

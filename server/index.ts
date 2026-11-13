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
} from '../shared/contracts.js';
import { AnthropicProvider } from './llm/anthropic.js';
import { LLMRefusalError, type LLMProvider } from './llm/provider.js';
import {
  INFER_TYPES_SYSTEM,
  chatAnswerSystem,
  chatAnswerUser,
  chatPlanSystem,
  inferTypesUser,
} from './prompts.js';

function createProvider(): LLMProvider {
  const provider = process.env.LLM_PROVIDER ?? 'anthropic';
  const model = process.env.LLM_MODEL ?? 'claude-opus-5-5';
  switch (provider) {
    case 'anthropic':
      return new AnthropicProvider(model);
    // case 'openai': return new OpenAIProvider(model);
    // case 'gemini': return new GeminiProvider(model);
    default:
      throw new Error(`Fournisseur LLM non pris en charge : ${provider}`);
  }
}

const llm = createProvider();
const app = Fastify({
  logger: {
    level: 'info',
    // Ne jamais journaliser le contenu des requêtes : il peut contenir des données.
    serializers: { req: (req) => ({ method: req.method, url: req.url }) },
  },
  bodyLimit: 2 * 1024 * 1024,
});

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof z.ZodError) {
    return reply.status(400).send({ error: 'Requête invalide', details: err.issues });
  }
  if (err instanceof LLMRefusalError) {
    return reply.status(422).send({ error: err.message });
  }
  app.log.error(err);
  return reply.status(502).send({ error: 'Erreur lors de l’appel au LLM.' });
});

app.get('/api/health', async () => ({ ok: true, provider: llm.name }));

app.post('/api/infer-types', async (req) => {
  const body = InferTypesRequest.parse(req.body);
  return llm.structured({
    system: INFER_TYPES_SYSTEM,
    messages: [{ role: 'user', content: inferTypesUser(body) }],
    schema: InferTypesResponse,
    effort: 'low',
  });
});

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
  return llm.structured({
    system: chatPlanSystem(body),
    messages,
    schema: ChatPlanResponse,
    effort: 'medium',
  });
});

app.post('/api/chat/answer', async (req) => {
  const body = ChatAnswerRequest.parse(req.body);
  return llm.structured({
    system: chatAnswerSystem(),
    messages: [{ role: 'user', content: chatAnswerUser(body) }],
    schema: ChatAnswerResponse,
    effort: 'low',
  });
});

const port = Number(process.env.API_PORT ?? 8787);
await app.listen({ port, host: '127.0.0.1' });

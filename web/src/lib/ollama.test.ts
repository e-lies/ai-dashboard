import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { LocalLLMUnavailableError, OllamaProvider } from '../../../server/llm/ollama';

const schema = z.object({ answer: z.string() });
const reply = (body: unknown, ok = true, status = 200) =>
  vi.fn(async () => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) }));

afterEach(() => vi.unstubAllGlobals());

describe('IA locale (Ollama)', () => {
  it('impose le schéma JSON et valide la réponse', async () => {
    const fetchMock = reply({ message: { content: '{"answer":"Le total est de 640 $."}' }, done_reason: 'stop' });
    vi.stubGlobal('fetch', fetchMock);
    const llm = new OllamaProvider('http://mac-m2.local:11434/', 'qwen2.5:14b', { numCtx: 4096 });
    const out = await llm.structured({ system: 'sys', messages: [{ role: 'user', content: 'q' }], schema });
    expect(out).toEqual({ answer: 'Le total est de 640 $.' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe('http://mac-m2.local:11434/api/chat');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('qwen2.5:14b');
    expect(body.stream).toBe(false);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(body.format.properties.answer.type).toBe('string');
    expect(body.options).toEqual({ temperature: 0, num_ctx: 4096 });
  });

  it('signale une réponse tronquée, illisible ou non conforme', async () => {
    const llm = new OllamaProvider('http://x:11434', 'm');
    const call = () => llm.structured({ system: '', messages: [], schema });
    vi.stubGlobal('fetch', reply({ message: { content: '{"answer":"Le to' }, done_reason: 'length' }));
    await expect(call()).rejects.toThrow(/tronquée/);
    vi.stubGlobal('fetch', reply({ message: { content: 'pas du json' } }));
    await expect(call()).rejects.toThrow(/illisible/);
    vi.stubGlobal('fetch', reply({ message: { content: '{"autre":1}' } }));
    await expect(call()).rejects.toThrow(/non conforme/);
  });

  it('distingue une IA locale injoignable ou en erreur', async () => {
    const llm = new OllamaProvider('http://x:11434', 'm');
    const call = () => llm.structured({ system: '', messages: [], schema });
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))));
    await expect(call()).rejects.toBeInstanceOf(LocalLLMUnavailableError);
    vi.stubGlobal('fetch', reply({ error: 'model "m" not found' }, false, 404));
    await expect(call()).rejects.toThrow(/erreur 404/);
  });
});

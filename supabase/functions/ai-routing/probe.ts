import { isObject, loadCatalog, type CatalogModel, type Provider } from '../_shared/ai-routing.ts';

const colors = [
  { name: 'red', image: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC' },
  { name: 'blue', image: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdNvJ8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ2oPcf88OIhvJ6vAAAAAElFTkSuQmCC' },
  { name: 'green', image: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLu58QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ24Pbjs8OLsrFddAAAAAElFTkSuQmCC' },
];

export async function probe(provider: Provider, target: { base: string; key: string }, model: CatalogModel, send: typeof fetch) {
  if (provider === 'nous') {
    const scope = await loadCatalog(provider, target, send).catch(() => null);
    if (!scope?.length) return { passed: false, stop: true };
    if (!scope.some(m => m.id === model.id && (model.vision ? m.vision : m.text))) return { passed: false, stop: false };
  }
  const color = colors[crypto.getRandomValues(new Uint8Array(1))[0] % colors.length];
  const challenge = 'OK' + crypto.randomUUID().slice(0,8);
  const content = model.vision ? [
    { type: 'text', text: 'Return only a JSON object with key color naming the single color of the image in English.' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,' + color.image } },
  ] : 'Reply with exactly ' + challenge;
  const res = await send(target.base + '/chat/completions', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(35000),
    headers: { Authorization: 'Bearer ' + target.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model.id, max_tokens: 4000, stream: false, ...(model.vision ? { response_format: { type: 'json_object' } } : {}),
      messages: [{ role: 'user', content }] }),
  }).catch(() => null);
  if (!res) return { passed: false, stop: false };
  if (!res.ok) return { passed: false, stop: [401,402,429].includes(res.status) };
  const data = await res.json().catch(() => null);
  if (!data || typeof data !== 'object') return { passed: false, stop: false };
  if (provider === 'nous' && data.model !== model.id) return { passed: false, stop: false };
  if (provider === 'nous' && [data.billing_mode, data.usage?.billing_mode, res.headers.get('x-billing-mode')].some(v => v === 'credits' || v === 'credit')) return { passed: false, stop: true };
  try {
    const text = data.choices[0].message.content;
    if (!model.vision) return { passed: typeof text === 'string' && text.trim() === challenge, stop: false };
    const answer: unknown = JSON.parse(text);
    return { passed: isObject(answer) && String(answer.color).toLowerCase() === color.name, stop: false };
  } catch { return { passed: false, stop: false }; }
}

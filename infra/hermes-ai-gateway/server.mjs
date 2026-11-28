import http from 'node:http';
import https from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

const destinations = new Map(Object.entries({
  '9router': 'http://127.0.0.1:20128/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  nous: 'https://inference-api.nousresearch.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  deepseek: 'https://api.deepseek.com/v1',
  openai: 'https://api.openai.com/v1',
  qwen: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  anthropic: 'https://api.anthropic.com/v1',
}));

function matches(actual, expected) {
  if (typeof actual !== 'string' || !expected) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function fail(res, status) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'Cache-Control': 'no-store' });
  res.end();
}

export function gateway({ key, ownerKey, ownerSocket }, connect = (url, options) =>
  (url.protocol === 'https:' ? https : http).request(url, options)) {
  if (!key || key.length < 32 || (ownerKey && (ownerKey.length < 32 || ownerKey === key))) {
    throw Error('invalid_gateway_configuration');
  }
  return http.createServer({ requestTimeout: 30000, headersTimeout: 15000 }, async (req, res) => {
    if (!matches(req.headers['x-crm-ai-key'], key)) return fail(res, 401);
    const match = /^\/ai-gateway\/([a-z0-9-]+)\/(models|chat\/completions)$/.exec(req.url);
    if (!match) return fail(res, 404);
    const [, provider, operation] = match;
    const owner = provider === 'nous-owner';
    if (!(destinations.has(provider) || owner)) return fail(res, 404);
    if (req.method !== (operation === 'models' ? 'GET' : 'POST')) return fail(res, 405);
    const bearer = req.headers.authorization;
    if (!bearer?.startsWith('Bearer ') || (owner && (!ownerKey || !matches(bearer, 'Bearer ' + ownerKey)))) return fail(res, 403);
    if (!owner && ownerKey && matches(bearer, 'Bearer ' + ownerKey)) return fail(res, 403);
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > (owner ? 1024 * 1024 : 24 * 1024 * 1024)) return fail(res, 413);
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (operation === 'models' && body.length) return fail(res, 400);
      if (operation !== 'models' && req.headers['content-type']?.split(';')[0] !== 'application/json') return fail(res, 415);
      if (owner && operation !== 'models') {
        let payload;
        try { payload = JSON.parse(body); } catch { return fail(res, 400); }
        const allowed = ['model','messages','response_format','stream','max_tokens'];
        if (!payload || typeof payload !== 'object' || Object.keys(payload).some(k => !allowed.includes(k)) ||
            !/^openai\/[\w.:@()[\]+~-]+$/.test(payload.model) || !Array.isArray(payload.messages) ||
            payload.stream !== false || !Number.isSafeInteger(payload.max_tokens) || payload.max_tokens < 1 ||
            payload.max_tokens > 8000) return fail(res, 400);
      }
      const url = new URL((owner ? 'http://localhost/v1' : destinations.get(provider)) + '/' + operation);
      const headers = { Authorization: owner ? 'Bearer crm' : bearer };
      if (body.length) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': body.length });
      if (provider === 'openrouter') Object.assign(headers, { 'HTTP-Referer':'https://ptcrm.vercel.app', 'X-Title':'iHome CRM' });
      const upstream = connect(url, { method: req.method, headers, ...(owner ? { socketPath: ownerSocket } : {}),
        signal: AbortSignal.timeout(180000) });
      res.on('close', () => upstream.destroy());
      upstream.on('error', () => fail(res, 502));
      upstream.on('response', async answer => {
        if (answer.statusCode >= 300 && answer.statusCode < 400) {
          answer.destroy(); return fail(res, 502);
        }
        const outHeaders = { 'Cache-Control':'no-store' };
        for (const name of ['content-type','retry-after','x-billing-mode','content-encoding']) {
          if (answer.headers[name]) outHeaders[name] = answer.headers[name];
        }
        res.writeHead(answer.statusCode, outHeaders);
        try { await pipeline(answer, res); } catch { res.destroy(); }
      });
      upstream.end(body);
    } catch { fail(res, 502); }
  });
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const server = gateway({ key: process.env.CRM_AI_VPS_KEY, ownerKey: process.env.CRM_AI_OWNER_CONNECTOR_KEY,
    ownerSocket: '/run/ihome-hermes-models/nous.sock' });
  server.maxConnections = 64;
  server.listen(18763, '127.0.0.1');
}

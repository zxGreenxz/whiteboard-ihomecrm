import http from 'node:http';
import { pathToFileURL } from 'node:url';

const MAX_BODY = 64 * 1024;
const MAX_REPLY = 8 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_ID = /^[0-9a-f]{64}$/;
const BEARER = /^Bearer [A-Za-z0-9._~+/-]+={0,2}$/;
const EVENTS = new Set(['sms.received', 'notification.received', 'gateway.test', 'gateway.heartbeat']);

export function configuration(env = process.env) {
  const upstream = new URL(env.BANK_EVENT_UPSTREAM ?? '');
  if (upstream.protocol !== 'https:' || upstream.username || upstream.password ||
      upstream.search || upstream.hash || upstream.pathname !== '/functions/v1/bank-event-ingest') {
    throw new Error('BANK_EVENT_UPSTREAM must be the HTTPS bank-event-ingest function URL');
  }
  const port = Number(env.PORT ?? 8791);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid PORT');
  return { upstream: upstream.href, port };
}

function send(res, status, body, extra = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  res.end(JSON.stringify(body));
}

function uniqueHeader(req, name) {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name) count++;
  }
  return count === 1 ? req.headers[name] : undefined;
}

function readRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const onError = error => { cleanup(); reject(error); };
    const onAborted = () => onError(new Error('CLIENT_ABORTED'));
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const onData = chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        const error = new Error('BODY_TOO_LARGE');
        error.status = 413;
        onError(error);
        req.resume();
      } else chunks.push(chunk);
    };
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });
}

async function readReply(response) {
  if (!response.body) throw new Error('EMPTY_UPSTREAM_REPLY');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_REPLY) throw new Error('UPSTREAM_REPLY_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function durableReceipt(reply, event) {
  const data = reply?.data;
  if (reply?.schemaVersion !== 1 || reply?.ok !== true || !data || !UUID.test(data.sourceId) ||
      data.externalId !== event.id || typeof data.acceptedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T/.test(data.acceptedAt) || !Number.isFinite(Date.parse(data.acceptedAt))) return false;
  if (event.event === 'gateway.heartbeat') return data.status === 'heartbeat' && data.eventId === null;
  return ['accepted', 'duplicate'].includes(data.status) && UUID.test(data.eventId);
}

/** Stateless transport. The central database is the only durable acknowledgement. */
export function createGateway({ upstream, fetchImpl = fetch, timeoutMs = 15_000, maxInflight = 32 } = {}) {
  // Validate production configuration even when a test injects its transport.
  configuration({ BANK_EVENT_UPSTREAM: upstream });
  let inflight = 0;
  // Global token bucket bounds load even behind a proxy; untrusted forwarding headers are unused.
  let tokens = 120;
  let replenishedAt = Date.now();
  const server = http.createServer({ maxHeaderSize: 4096 }, async (req, res) => {
    if (req.url === '/healthz' && req.method === 'GET') return send(res, 200, { ok: true });
    if (req.url !== '/webhooks/sms') return send(res, 404, { error: 'NOT_FOUND' });
    if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' }, { Allow: 'POST' });
    const now = Date.now();
    tokens = Math.min(120, tokens + (now - replenishedAt) / 1000 * 2);
    replenishedAt = now;
    if (inflight >= maxInflight || tokens < 1) return send(res, 429, { error: 'BUSY' }, { 'Retry-After': '30' });
    tokens--;
    const auth = uniqueHeader(req, 'authorization');
    const eventId = uniqueHeader(req, 'x-idempotency-key');
    if (typeof auth !== 'string' || !BEARER.test(auth) || auth.length < 39 || auth.length > 263) {
      return send(res, 401, { error: 'INVALID_AUTHORIZATION' });
    }
    if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) return send(res, 400, { error: 'INVALID_IDEMPOTENCY_KEY' });
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(req.headers['content-type'] ?? '')) ||
        req.headers['content-encoding']) return send(res, 415, { error: 'JSON_REQUIRED' });
    if (Number(req.headers['content-length']) > MAX_BODY) return send(res, 413, { error: 'BODY_TOO_LARGE' });
    inflight++;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      send(res, 504, { error: 'UPSTREAM_TIMEOUT' });
      req.destroy();
    }, timeoutMs);
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose);
    try {
      const raw = await readRequest(req);
      let event;
      try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
      catch { return send(res, 400, { error: 'INVALID_JSON' }); }
      if (event?.schemaVersion !== 1 || event.id !== eventId || !EVENTS.has(event.event)) {
        return send(res, 400, { error: 'INVALID_EVENT' });
      }
      const response = await fetchImpl(upstream, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth, 'X-Idempotency-Key': eventId },
        body: raw,
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.status >= 200 && response.status < 300) {
        const reply = await readReply(response);
        if (!durableReceipt(reply, event)) return send(res, 502, { error: 'INVALID_DURABLE_RECEIPT' });
        return send(res, reply.data.status === 'accepted' ? 201 : 200, reply);
      }
      // Never echo upstream diagnostics, which may contain request content or credentials.
      await response.body?.cancel().catch(() => {});
      if ([400, 401, 403, 409, 413, 415, 422].includes(response.status)) {
        return send(res, response.status, { error: 'INGEST_REJECTED' });
      }
      if (response.status === 429) return send(res, 429, { error: 'INGEST_BUSY' }, { 'Retry-After': '30' });
      return send(res, 502, { error: 'INGEST_UNAVAILABLE' });
    } catch (error) {
      send(res, error.status === 413 ? 413 : controller.signal.aborted ? 504 : 502,
        { error: error.status === 413 ? 'BODY_TOO_LARGE' : 'INGEST_UNAVAILABLE' },
        error.status === 413 ? { Connection: 'close' } : {});
    } finally {
      clearTimeout(timer);
      res.off('close', onClose);
      inflight--;
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 20_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = configuration();
  const server = createGateway(config);
  server.listen(config.port, '127.0.0.1', () => console.info('Bank gateway ready on loopback'));
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 20_000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

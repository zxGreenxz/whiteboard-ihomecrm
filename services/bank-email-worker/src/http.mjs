import { createServer } from 'node:http';
import { OAuth2Client } from 'google-auth-library';
import { beginOAuth, completeOAuth } from './oauth.mjs';

const MAX_REQUEST_BYTES = 16 * 1024;

function send(res, status, value, origin) {
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (origin) headers['access-control-allow-origin'] = origin;
  if (status === 204) { res.writeHead(status, headers); res.end(); return; }
  headers['content-type'] = 'application/json; charset=utf-8';
  res.writeHead(status, headers);
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('type'), { status: 415 });
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw Object.assign(new Error('size'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('json'), { status: 400 }); }
}

export async function verifyPubsubToken(token, config) {
  if (typeof token !== 'string' || token.length > 8 * 1024) throw new Error('INVALID_TOKEN');
  const client = new OAuth2Client();
  const ticket = await client.verifyIdToken({ idToken: token, audience: config.pubsubAudience });
  const payload = ticket.getPayload();
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload?.iss) ||
      payload?.email !== config.pubsubServiceAccountEmail || payload?.email_verified !== true) {
    throw new Error('INVALID_PUBSUB_IDENTITY');
  }
  return payload;
}

export function createHttpServer({ config, key, rpc, google, verifyPush = token => verifyPubsubToken(token, config) }) {
  const server = createServer(async (req, res) => {
    req.setTimeout(10_000, () => req.destroy());
    const path = new URL(req.url ?? '/', 'http://worker.invalid').pathname;
    const origin = req.headers.origin;
    if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
    if (req.method === 'OPTIONS' && path === '/oauth/start') {
      if (origin !== config.appOrigin) return send(res, 403, { error: 'ORIGIN_DENIED' });
      res.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '600' });
      return res.end();
    }
    if (req.method === 'POST' && path === '/oauth/start') {
      if (origin && origin !== config.appOrigin) return send(res, 403, { error: 'ORIGIN_DENIED' });
      const bearer = /^Bearer ([^\s]{1,8192})$/u.exec(req.headers.authorization ?? '');
      if (!bearer) return send(res, 401, { error: 'AUTH_REQUIRED' }, origin);
      try {
        const body = await readJson(req);
        const result = await beginOAuth({ connectionId: body.connectionId, userJwt: bearer[1], config, key, rpc });
        return send(res, 200, result, origin);
      } catch (error) {
        const status = error.status === 401 ? 401 :
          error.status === 403 || error.code === '42501' ? 403 :
          error.status === 409 || error.code === '23505' ? 409 :
          [400, 413, 415].includes(error.status) || error instanceof TypeError ? 400 : 503;
        return send(res, status, { error: status === 401 ? 'AUTH_REQUIRED' : status === 403 ? 'FORBIDDEN' :
          status === 409 ? 'CONFLICT' : status === 400 ? 'INVALID_REQUEST' : 'UNAVAILABLE' }, origin);
      }
    }
    if (req.method === 'GET' && path === '/oauth/callback') {
      try {
        const url = new URL(req.url, 'http://worker.invalid');
        if (url.searchParams.has('error')) throw new Error('OAUTH_DENIED');
        await completeOAuth({ state: url.searchParams.get('state'), code: url.searchParams.get('code'), config, key, rpc, google });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' });
        return res.end('<!doctype html><meta charset="utf-8"><title>ACB Gmail</title><p>Đã kết nối Gmail. Có thể đóng cửa sổ này và quay lại ứng dụng.</p>');
      } catch {
        return send(res, 400, { error: 'OAUTH_CALLBACK_FAILED' });
      }
    }
    if (req.method === 'POST' && path === '/pubsub') {
      const bearer = /^Bearer ([^\s]{1,8192})$/u.exec(req.headers.authorization ?? '');
      if (!bearer) return send(res, 401, { error: 'AUTH_REQUIRED' });
      try {
        const identity = await verifyPush(bearer[1]);
        if (identity?.email !== config.pubsubServiceAccountEmail || identity?.email_verified !== true) {
          return send(res, 401, { error: 'INVALID_IDENTITY' });
        }
      } catch { return send(res, 401, { error: 'INVALID_IDENTITY' }); }
      let email;
      try {
        const body = await readJson(req);
        const encoded = body?.message?.data;
        if (typeof encoded !== 'string' || encoded.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw new Error('INVALID_PUSH');
        const notice = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
        if (typeof notice.emailAddress !== 'string' || notice.emailAddress.length > 254 ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(notice.emailAddress) || !/^\d+$/u.test(notice.historyId ?? '')) throw new Error('INVALID_PUSH');
        email = notice.emailAddress.toLowerCase();
      } catch { return send(res, 400, { error: 'INVALID_PUSH' }); }
      try {
        await rpc('enqueue', { email });
        return send(res, 204);
      } catch { return send(res, 503, { error: 'ENQUEUE_FAILED' }); }
    }
    return send(res, 404, { error: 'NOT_FOUND' });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return server;
}

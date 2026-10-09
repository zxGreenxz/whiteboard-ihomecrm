import { createHash, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const MAX_JSON_BYTES = 64 * 1024;
const HASH_ID = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE_KEYS = ['schemaVersion', 'event', 'id', 'deviceId', 'receivedAt'];
const SMS_KEYS = [...BASE_KEYS, 'sender', 'body', 'subscriptionId'];
const NOTIFICATION_KEYS = [...BASE_KEYS, 'packageName', 'appName', 'title', 'body'];
const digest = (value) => createHash('sha256').update(value).digest();

function textWithin(value, bytes, nonempty = false) {
  return typeof value === 'string' && value.isWellFormed()
    && (!nonempty || value.length > 0) && Buffer.byteLength(value, 'utf8') <= bytes;
}

function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second, offset] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1]
    && Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59
    && (offset === 'Z' || (Number(offset.slice(1, 3)) <= 23 && Number(offset.slice(4)) <= 59));
}

function canonicalPayload(value, idempotencyKey) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const notification = value.event === 'notification.received';
  if (!notification && value.event !== 'sms.received' && value.event !== 'gateway.test') return null;
  const keys = notification ? NOTIFICATION_KEYS : SMS_KEYS;
  if (Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) return null;
  if (value.schemaVersion !== 1 || typeof value.id !== 'string' || !HASH_ID.test(value.id)
    || value.id !== idempotencyKey || typeof value.deviceId !== 'string' || !UUID.test(value.deviceId)
    || !validTimestamp(value.receivedAt) || !textWithin(value.body, 8192)) return null;
  if (notification) {
    if (!textWithin(value.packageName, 255, true) || !textWithin(value.appName, 512)
      || !textWithin(value.title, 512)) return null;
  } else if (!textWithin(value.sender, 256)
    || !(value.subscriptionId === null || Number.isSafeInteger(value.subscriptionId))) return null;
  // A deterministic key order accepts retries even if the sender reorders JSON fields.
  return JSON.stringify(Object.fromEntries(keys.map((key) => [key, value[key]])));
}

function singleHeader(request, name) {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) count++;
  }
  return count === 1 ? request.headers[name] : undefined;
}

function send(response, status, code, extra = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  response.end(JSON.stringify({ status: code }));
}

function readJson(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let bytes = 0;
    let finished = false;
    const fail = (status) => {
      if (finished) return;
      finished = true;
      chunks.length = 0;
      reject({ status });
    };
    request.on('data', (chunk) => {
      if (finished) return;
      bytes += chunk.length;
      if (bytes > MAX_JSON_BYTES) return fail(413);
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (finished) return;
      finished = true;
      try {
        const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        resolveBody(JSON.parse(utf8));
      } catch {
        reject({ status: 400 });
      }
    });
    request.on('aborted', () => fail(400));
    request.on('error', () => fail(400));
  });
}

function openStore(dbPath) {
  const path = resolve(dbPath);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = lstatSync(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
    || (process.platform !== 'win32' && (directoryInfo.mode & 0o077) !== 0)) {
    throw new Error('DB_PATH requires a private data directory (0700).');
  }
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) {
    throw new Error('DB_PATH must be a regular file.');
  }
  const database = new DatabaseSync(path, { timeout: 500 });
  try {
    chmodSync(path, 0o600);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS received_events (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        accepted_at TEXT NOT NULL
      ) STRICT;
    `);
    const insert = database.prepare('INSERT INTO received_events (id, payload, accepted_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING');
    const select = database.prepare('SELECT payload FROM received_events WHERE id = ?');
    return {
      save(id, payload) {
        // SQLite commits the insert before this returns; acknowledgements never precede storage.
        if (insert.run(id, payload, new Date().toISOString()).changes === 1) return 'accepted';
        return select.get(id)?.payload === payload ? 'duplicate' : 'id_conflict';
      },
      close() { database.close(); },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

export function createReceiver({ token, dbPath }) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 256
    || !/^[A-Za-z0-9._~+/-]+={0,2}$/.test(token)) {
    throw new Error('WEBHOOK_TOKEN must contain 32–256 Bearer token characters.');
  }
  if (typeof dbPath !== 'string' || !dbPath.trim() || dbPath === ':memory:') {
    throw new Error('DB_PATH must identify a persistent database file.');
  }
  const expectedAuthorization = digest(`Bearer ${token}`);
  const store = openStore(dbPath);
  const server = createServer({
    maxHeaderSize: 8192,
    requestTimeout: 15_000,
    headersTimeout: 10_000,
    keepAliveTimeout: 5_000,
    connectionsCheckingInterval: 1_000,
  }, async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') return send(response, 200, 'ok');
    if (request.method !== 'POST' || request.url !== '/webhooks/sms') {
      request.resume();
      return send(response, 404, 'not_found');
    }
    const authorization = singleHeader(request, 'authorization');
    const candidate = typeof authorization === 'string' && authorization.length <= 263 ? authorization : '';
    if (!timingSafeEqual(digest(candidate), expectedAuthorization)) {
      request.resume();
      return send(response, 401, 'unauthorized', { 'WWW-Authenticate': 'Bearer' });
    }
    const contentType = singleHeader(request, 'content-type');
    if (typeof contentType !== 'string'
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
      || request.headers['content-encoding'] !== undefined) {
      request.resume();
      return send(response, 415, 'unsupported_media_type');
    }
    if (Number(request.headers['content-length']) > MAX_JSON_BYTES) {
      request.resume();
      return send(response, 413, 'payload_too_large');
    }
    const key = singleHeader(request, 'x-idempotency-key');
    if (typeof key !== 'string' || !HASH_ID.test(key)) {
      request.resume();
      return send(response, 400, 'invalid_idempotency_key');
    }
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      return send(response, error.status === 413 ? 413 : 400,
        error.status === 413 ? 'payload_too_large' : 'invalid_json');
    }
    const payload = canonicalPayload(body, key);
    if (payload === null) return send(response, 400, 'invalid_payload');
    try {
      const result = store.save(key, payload);
      return send(response, result === 'accepted' ? 201 : result === 'duplicate' ? 200 : 409, result);
    } catch {
      // Never expose SQLite errors: they can contain paths or untrusted payload data.
      return send(response, 503, 'storage_unavailable', { 'Retry-After': '30' });
    }
  });
  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  server.once('close', () => store.close());
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.versions.node !== '24.18.0') throw new Error('Use pinned Node runtime.');
    const port = process.env.PORT === undefined ? 8787 : Number(process.env.PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
    const server = createReceiver({
      token: process.env.WEBHOOK_TOKEN,
      dbPath: process.env.DB_PATH ?? fileURLToPath(new URL('./data/events.sqlite', import.meta.url)),
    });
    server.on('error', () => {
      console.error('Receiver could not start. Check runtime, configuration, port and private storage.');
      process.exit(1);
    });
    server.listen(port, '127.0.0.1', () => console.log('Webhook receiver ready on loopback.'));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      server.close(() => process.exit(0));
      server.closeIdleConnections();
      setTimeout(() => process.exit(1), 20_000).unref();
    });
  } catch {
    console.error('Receiver could not start. Use Node 24.18.0 and check WEBHOOK_TOKEN, PORT and private DB_PATH.');
    process.exitCode = 1;
  }
}

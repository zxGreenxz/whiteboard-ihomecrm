import { createServer, request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = 'hermes-gateway:8787';
const ROUTES = new Set(['/mcp', '/v1/chat/completions']);
const privateV4 = value => isIP(value) === 4 && (/^10\./.test(value) || /^192\.168\./.test(value) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(value) || /^127\./.test(value));
const safeReply = (res, status, code) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
  res.end(JSON.stringify({ error: { code } }));
};

/** Credential-free sidecar. It forwards only to its one mounted Unix socket;
 * no request may choose host, socket, authority, actor, company or destination.
 * Factory is inert. Deployment must inspect a single isolated private bridge,
 * exact socket mount and no published ports before enabling runtime admission.
 */
export function createGatewayRelay({ socketPath, listenHost, port = 8787, timeoutMs = 120_000,
  maxConcurrent = 4, maxRequestBytes = 262_144, maxResponseBytes = 131_072 } = {}) {
  const namedPipe = process.platform === 'win32' && /^\\\\\.\\pipe\\hermes-[a-z0-9-]+$/.test(socketPath ?? '');
  if (typeof socketPath !== 'string' || socketPath.length > 256 || /[\0\r\n]/.test(socketPath) ||
      (!namedPipe && (!path.posix.isAbsolute(socketPath) || path.posix.normalize(socketPath) !== socketPath)) ||
      !privateV4(listenHost) || !Number.isSafeInteger(port) || port < 0 || port > 65535 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
      !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4 ||
      !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > 262_144 ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 131_072) throw new TypeError('invalid_gateway_relay_config');
  let closing = false, closePromise;
  const pending = new Set(), upstream = new Set();
  const server = createServer({ maxHeaderSize: 16_384 }, (req, res) => {
    if (closing) { safeReply(res, 503, 'gateway_closed'); return; }
    if (pending.size >= maxConcurrent) { safeReply(res, 429, 'gateway_busy'); return; }
    if (req.method !== 'POST' || !ROUTES.has(req.url)) { safeReply(res, 404, 'not_found'); return; }
    const names = new Set();
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i].toLowerCase();
      if (names.has(name)) { safeReply(res, 400, 'invalid_headers'); return; }
      names.add(name);
    }
    if (names.size > 32 || req.headers.host !== HOST || req.headers.origin !== undefined ||
        req.headers['content-encoding'] !== undefined || req.headers['transfer-encoding'] !== undefined ||
        !/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] ?? '') ||
        (req.headers.authorization !== undefined && req.headers.authorization !== 'Bearer gateway-no-credential') ||
        Object.keys(req.headers).some(name => /^(?:x-(?:forwarded|organization|user|task|actor)|proxy-|cookie$)/.test(name))) {
      safeReply(res, 400, 'invalid_headers'); return;
    }
    const declared = req.headers['content-length'];
    if (typeof declared !== 'string' || !/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maxRequestBytes) {
      safeReply(res, 413, 'invalid_body_length'); return;
    }
    const work = (async () => {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > maxRequestBytes) { safeReply(res, 413, 'request_too_large'); return; }
        chunks.push(chunk);
      }
      if (bytes !== Number(declared) || res.destroyed || closing) return;
      // The destination is fixed by the mount, never a URL or runtime header.
      const headers = { host: HOST, 'content-type': 'application/json', accept: 'application/json',
        'content-length': bytes, connection: 'close' };
      if (req.headers['mcp-protocol-version'] !== undefined) headers['mcp-protocol-version'] = req.headers['mcp-protocol-version'];
      await new Promise(resolve => {
        const out = httpRequest({ socketPath, path: req.url, method: 'POST', headers, agent: false });
        upstream.add(out);
        const disconnected = () => { if (!res.writableEnded) out.destroy(); };
        res.on('close', disconnected);
        out.setTimeout(timeoutMs, () => out.destroy());
        out.once('close', () => { upstream.delete(out); res.off('close', disconnected); resolve(); });
        out.on('error', () => safeReply(res, 503, 'gateway_unavailable'));
        out.on('response', incoming => {
          const result = []; let size = 0;
          if (!/^application\/json(?:\s*;|$)/i.test(incoming.headers['content-type'] ?? '') ||
              Number(incoming.headers['content-length']) > maxResponseBytes) { out.destroy(); safeReply(res, 503, 'invalid_gateway_response'); return; }
          incoming.on('data', part => {
            size += part.length;
            if (size > maxResponseBytes) { out.destroy(); safeReply(res, 503, 'invalid_gateway_response'); }
            else result.push(part);
          });
          incoming.on('error', () => safeReply(res, 503, 'gateway_unavailable'));
          incoming.on('end', () => {
            if (res.destroyed || res.writableEnded || closing) return;
            const status = incoming.statusCode;
            if (![200, 202, 204, 400, 401, 403, 404, 409, 413, 429, 503, 504].includes(status)) { safeReply(res, 503, 'gateway_unavailable'); return; }
            res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
            res.end(Buffer.concat(result));
          });
        });
        out.end(Buffer.concat(chunks));
      });
    })();
    pending.add(work);
    void work.catch(() => safeReply(res, 503, 'gateway_unavailable')).finally(() => pending.delete(work));
  });
  server.maxHeadersCount = 32; server.headersTimeout = 10_000; server.requestTimeout = 15_000;
  // Leave enough time to return the safe upstream-timeout result before the
  // outer socket idle deadline; equal timers can reset the client first.
  server.setTimeout(timeoutMs + 15_000, socket => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());
  return Object.freeze({ server, start() {
    if (closing || server.listening) return Promise.reject(new Error('gateway_relay_unavailable'));
    return new Promise((resolve, reject) => {
      const error = () => { server.off('listening', ready); reject(new Error('gateway_relay_unavailable')); };
      const ready = () => { server.off('error', error); resolve(); };
      server.once('error', error); server.once('listening', ready); server.listen(port, listenHost);
    });
  }, close() {
    if (!closePromise) {
      closing = true;
      closePromise = (async () => {
        const stopped = new Promise(resolve => server.close(() => resolve()));
        server.closeAllConnections();
        for (const request of upstream) request.destroy();
        await stopped;
        await Promise.allSettled([...pending]);
      })();
    }
    return closePromise;
  } });
}

// Product sidecar has one explicit socket and discovers its one private IPv4
// interface. No env lookup, request-configured endpoint, request logging or proxy.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== 'linux' || process.argv.length !== 3 || process.argv[2] !== '/run/hermes-gateway/gateway.sock') throw new Error();
    const addresses = Object.values(networkInterfaces()).flat().filter(entry => entry && !entry.internal && entry.family === 'IPv4');
    if (addresses.length !== 1 || !privateV4(addresses[0].address)) throw new Error();
    const relay = createGatewayRelay({ socketPath: process.argv[2], listenHost: addresses[0].address });
    await relay.start();
    // One fixed frame lets the host distinguish a spawned docker attach client
    // from a relay whose private listener is actually ready. Never include data.
    process.stdout.write('gateway_ready_v1\n');
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void relay.close().then(() => { process.exitCode = 0; }); });
  } catch { process.stderr.write('gateway_relay_failed\n'); process.exitCode = 1; }
}

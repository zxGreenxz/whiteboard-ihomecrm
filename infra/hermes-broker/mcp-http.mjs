import { createServer } from 'node:http';
import { BrokerError, REQUEST_RECEIPT_UNKNOWN } from './broker.mjs';
import { CONNECTOR_VERSION } from './connector-health.mjs';
import { READ_MISUSE_HINT_TEXTS } from './read-misuse-hints.mjs';

const VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every((key) => allowed.includes(key));
function reply(response, status, value, headers = {}) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', ...headers });
  response.end(value === undefined ? undefined : JSON.stringify(value));
}
// Whole seconds for Retry-After and the model-visible hint; never below 1.
const retryAfterSeconds = error => Number.isSafeInteger(error?.retryAfterMs) && error.retryAfterMs > 0
  ? Math.min(60, Math.ceil(error.retryAfterMs / 1000)) : 1;
// SQL read over its size cap: the model should narrow the call, not retry it unchanged.
const RESULT_TOO_LARGE_HINT = 'Kết quả quá lớn: gọi lại với limit nhỏ hơn hoặc bộ lọc hẹp hơn (query, buildingId, month).';
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }
async function readBody(request, cap) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > cap) throw new BrokerError('invalid_request');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// Stateless Streamable HTTP JSON subset. No SSE, subscriptions, OAuth issuer,
// sessions, batch JSON-RPC, or remotely callable connection-management endpoints.
// Embeddable handler keeps the legacy hostname allowlist semantics. A shared
// browser/MCP server can enforce an exact authority (including port) outside it.
// Broker calls retain their own deadlines; this handler does not add a caller
// AbortSignal to the existing broker API or claim disconnect cancels that work.
export function createMcpHttpHandler({ broker, allowedHosts = ['127.0.0.1', 'localhost', '[::1]'],
  allowedOrigins = [], maxBodyBytes = 16_384, maxConcurrentRequests = 16 } = {}) {
  if (!broker || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 65_536 ||
      !Number.isSafeInteger(maxConcurrentRequests) || maxConcurrentRequests < 1) throw new TypeError('invalid_http_config');
  let active = 0;
  return async (request, response) => {
    let host;
    try {
      const parsed = new URL(`http://${request.headers.host ?? ''}`);
      if (parsed.username || parsed.password || parsed.pathname !== '/') throw new Error();
      host = parsed.hostname;
    } catch { reply(response, 403, { error: 'forbidden' }); return; }
    if (!allowedHosts.includes(host) || (request.headers.origin && !allowedOrigins.includes(request.headers.origin))) {
      reply(response, 403, { error: 'forbidden' }); return;
    }
    if (request.url !== '/mcp') { reply(response, 404, { error: 'not_found' }); return; }
    if (request.method !== 'POST') { response.setHeader('allow', 'POST'); reply(response, 405, { error: 'method_not_allowed' }); return; }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
      reply(response, 415, { error: 'unsupported_content_type' }); return;
    }
    if (request.headers['content-length'] && Number(request.headers['content-length']) > maxBodyBytes) {
      reply(response, 413, { error: 'body_too_large' }); request.resume(); return;
    }
    if (request.headers['mcp-protocol-version'] && !VERSIONS.has(request.headers['mcp-protocol-version'])) {
      reply(response, 400, { error: 'unsupported_protocol_version' }); return;
    }
    if (active >= maxConcurrentRequests) { reply(response, 429, { error: 'busy' }); return; }
    active += 1;
    let message;
    try {
      try { message = await readBody(request, maxBodyBytes); }
      catch { reply(response, 400, rpcError(null, -32700, 'invalid_json')); return; }
      if (!keys(message, ['jsonrpc', 'id', 'method', 'params']) || message.jsonrpc !== '2.0' ||
          typeof message.method !== 'string' ||
          (Object.hasOwn(message, 'id') && !(Number.isSafeInteger(message.id) || (typeof message.id === 'string' && message.id.length <= 128)))) {
        reply(response, 400, rpcError(null, -32600, 'invalid_request')); return;
      }
      const match = /^Bearer (hc_[A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '');
      if (!match) throw new BrokerError('unauthorized');
      const presentedToken = match[1];
      const id = message.id;
      let result;
      if (message.method === 'notifications/initialized' && !Object.hasOwn(message, 'id')) {
        await broker.authenticate(presentedToken);
        reply(response, 202); return;
      }
      if (!Object.hasOwn(message, 'id')) { reply(response, 400, rpcError(null, -32600, 'invalid_request')); return; }
      if (message.method === 'initialize') {
        if (!keys(message.params, ['protocolVersion', 'capabilities', 'clientInfo', '_meta']) ||
            typeof message.params.protocolVersion !== 'string' || !object(message.params.capabilities) || !object(message.params.clientInfo)) {
          reply(response, 200, rpcError(id, -32602, 'invalid_params')); return;
        }
        await broker.authenticate(presentedToken);
        result = { protocolVersion: VERSIONS.has(message.params.protocolVersion) ? message.params.protocolVersion : '2025-03-26',
          capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'ihomecrm-hermes-broker-p1', version: CONNECTOR_VERSION } };
      } else if (message.method === 'tools/list') {
        if (message.params !== undefined && (!keys(message.params, ['_meta']) || Object.hasOwn(message.params, 'cursor'))) {
          reply(response, 200, rpcError(id, -32602, 'invalid_params')); return;
        }
        result = await broker.listTools(presentedToken);
      } else if (message.method === 'tools/call') {
        if (!keys(message.params, ['name', 'arguments', '_meta']) || typeof message.params.name !== 'string') {
          reply(response, 200, rpcError(id, -32602, 'invalid_params')); return;
        }
        result = await broker.callTool(presentedToken, message.params.name, message.params.arguments ?? {});
      } else if (message.method === 'ping') {
        await broker.authenticate(presentedToken); result = {};
      } else {
        await broker.authenticate(presentedToken);
        reply(response, 200, rpcError(id, -32601, 'method_not_found')); return;
      }
      reply(response, 200, { jsonrpc: '2.0', id, result });
    } catch (error) {
      const safe = error instanceof BrokerError ? error : new BrokerError('backend_unavailable');
      const admission = ['rate_limited', 'busy'].includes(safe.code);
      // Per-connection quota is a tool outcome the model can read and wait on;
      // a transport-level 429 would make an MCP client drop/reconnect instead.
      if (message?.method === 'tools/call' && safe.code !== 'unauthorized') {
        const receipt = admission ? { retryAfterSeconds: retryAfterSeconds(safe) }
          : safe.code === 'send_outcome_unknown' && typeof safe.dispatchId === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(safe.dispatchId)
          ? { dispatchId: safe.dispatchId } : REQUEST_RECEIPT_UNKNOWN.includes(safe.code) && typeof safe.requestId === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(safe.requestId)
          ? { requestId: safe.requestId } : safe.code === 'result_too_large' ? { hint: RESULT_TOO_LARGE_HINT }
          // B5d: tên toà/phòng không giải được — mô hình cần lý do (toà/phòng trong phạm vi của chính kết nối) để hỏi lại.
          : safe.code === 'read_name_unresolved' && typeof safe.detail === 'string' ? { detail: safe.detail }
          // R2b: invalid_request của tool đọc gọi sai cách mang MỘT trong các hint tĩnh của read-misuse-hints.mjs (danh sách
          // đóng, chỉ nêu tool/tham số đúng); chuỗi nào khác — kể cả gán nhầm vào detail — không tới mô hình.
          : safe.code === 'invalid_request' && READ_MISUSE_HINT_TEXTS.includes(safe.detail) ? { detail: safe.detail } : {};
        reply(response, 200, { jsonrpc: '2.0', id: message.id, result: {
          content: [{ type: 'text', text: JSON.stringify({ error: safe.code, ...receipt }) }], isError: true,
        } });
      } else {
        reply(response, safe.status, { error: safe.code }, admission ? { 'retry-after': String(retryAfterSeconds(safe)) } : {});
      }
    } finally { active -= 1; }
  };
}

export function createMcpHttpServer(options = {}) {
  const server = createServer(createMcpHttpHandler(options));
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  return server;
}

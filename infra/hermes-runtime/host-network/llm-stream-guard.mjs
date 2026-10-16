#!/usr/bin/env node
// llm-stream-guard: relay HTTP giữa Hermes (cửa docker0) và 9router (127.0.0.1:20128).
// Chuyển nguyên mọi request/response theo luồng, không đệm. Chỉ đọc kèm SSE của
// POST /v1/chat/completions để cắt khi model sinh `arguments` của tool call không dứt
// (Hermes v0.21.6 không bắt được, 9router bỏ qua max_tokens). Lý do và cách vận hành: README.md.
import { realpathSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const DEFAULT_LARGE_TOOLS = Object.freeze([
  'write_file', 'patch', 'skill_manage', 'execute_code', 'terminal', 'memory', 'delegate_task',
  'mcp__ihomecrm__crm_room_pass_upsert',
]);
// Header chỉ có nghĩa trên một chặng; agent của guard tự quản kết nối hai phía.
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'expect']);
// Một dòng SSE dài hơn mức này thì bỏ qua (không đếm, không giữ trong bộ nhớ) nhưng vẫn chuyển tiếp.
const MAX_LINE_CHARS = 1 << 20;
const SHUTDOWN_GRACE_MS = 10_000;

function positiveNumber(env, name, fallback, integer = true) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!(value > 0) || (integer && !Number.isSafeInteger(value))) throw new Error(`${name} phải là số dương`);
  return value;
}

export function loadConfig(env = process.env) {
  const upstream = new URL(env.GUARD_UPSTREAM || 'http://127.0.0.1:20128');
  if (upstream.protocol !== 'http:') throw new Error('GUARD_UPSTREAM chỉ nhận http://');
  const tools = env.GUARD_LARGE_TOOLS === undefined ? DEFAULT_LARGE_TOOLS
    : env.GUARD_LARGE_TOOLS.split(',').map(name => name.trim()).filter(Boolean);
  return {
    upstream,
    argsMax: positiveNumber(env, 'GUARD_ARGS_MAX', 8192),
    largeArgsMax: positiveNumber(env, 'GUARD_LARGE_ARGS_MAX', 131_072),
    largeTools: new Set(tools),
    maxStreamMs: Math.round(positiveNumber(env, 'GUARD_MAX_STREAM_SECONDS', 300, false) * 1000),
    maxEvents: positiveNumber(env, 'GUARD_MAX_EVENTS', 40_000),
  };
}

// Tên tool/model do model sinh ra: chỉ giữ ký tự an toàn cho log, tối đa 100 ký tự.
const safeLabel = value => (typeof value === 'string' && value ? value.replace(/[^\w.:/@+-]/g, '?').slice(0, 100) : null);

/** Đọc SSE theo từng mảnh TCP; push() trả vi phạm đầu tiên hoặc null. Không bao giờ ném lỗi vì dữ liệu lạ. */
export function createStreamInspector({ argsMax, largeArgsMax, largeTools, maxEvents }) {
  const decoder = new StringDecoder('utf8');
  const calls = new Map(), seen = [];
  let tail = '', skipping = false, events = 0, model = null;

  function track(key, id, fn) {
    if (!fn || typeof fn !== 'object') return null;
    let call = calls.get(key);
    // `id` chỉ có ở delta đầu của mỗi tool call; id mới ở cùng index là call mới, đếm lại từ 0.
    if (!call || (typeof id === 'string' && id && call.id && id !== call.id)) {
      calls.set(key, call = { id: typeof id === 'string' ? id : '', name: '', chars: 0 });
      seen.push(call);
    }
    if (!call.name && typeof fn.name === 'string') call.name = fn.name;
    if (typeof fn.arguments === 'string') call.chars += fn.arguments.length;
    const limit = largeTools.has(call.name) ? largeArgsMax : argsMax;
    return call.chars > limit ? { reason: 'tool_args', tool: safeLabel(call.name), argsChars: call.chars, limit } : null;
  }

  // Mỗi dòng `data:` là một sự kiện: chunk OpenAI luôn là JSON một dòng.
  function onLine(line) {
    if (!line.startsWith('data:')) return null; // chú thích ":", event:, id:, retry:, dòng trống
    if (++events > maxEvents) return { reason: 'events', limit: maxEvents };
    const data = line.slice(line.startsWith('data: ') ? 6 : 5);
    if (data === '[DONE]') return null;
    let chunk;
    try { chunk = JSON.parse(data); } catch { return null; } // không phải JSON: bỏ qua, vẫn chuyển tiếp
    if (model === null && typeof chunk?.model === 'string') model = safeLabel(chunk.model);
    for (const choice of Array.isArray(chunk?.choices) ? chunk.choices : []) {
      const delta = choice?.delta;
      if (!delta || typeof delta !== 'object') continue;
      const at = Number.isInteger(choice.index) ? choice.index : 0;
      const parts = Array.isArray(delta.tool_calls)
        ? delta.tool_calls.map(call => [`${at}:${Number.isInteger(call?.index) ? call.index : 0}`, call?.id, call?.function]) : [];
      if (delta.function_call) parts.push([`${at}:legacy`, undefined, delta.function_call]);
      for (const [key, id, fn] of parts) {
        const violation = track(key, id, fn);
        if (violation) return violation;
      }
    }
    return null;
  }

  return {
    push(bytes) {
      const lines = (tail + decoder.write(bytes)).split('\n');
      tail = lines.pop();
      for (const line of lines) {
        if (skipping) { skipping = false; continue; }
        const violation = onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
        if (violation) return violation;
      }
      if (tail.length > MAX_LINE_CHARS) { tail = ''; skipping = true; }
      return null;
    },
    summary() {
      let top = null;
      for (const call of seen) if (!top || call.chars > top.chars) top = call;
      return { tool: safeLabel(top?.name), argsChars: top?.chars ?? 0, events, model };
    },
  };
}

function forwardHeaders(source, close = false) {
  const named = String(source.connection ?? '').toLowerCase().split(',').map(token => token.trim());
  const headers = {};
  for (const [name, value] of Object.entries(source)) {
    if (!HOP_BY_HOP.has(name) && !named.includes(name)) headers[name] = value;
  }
  if (close) headers.connection = 'close';
  return headers;
}

export function createGuard(config, { log = line => process.stdout.write(`${line}\n`) } = {}) {
  const emit = record => log(JSON.stringify(record));
  const agent = new http.Agent({ keepAlive: true }); // socket rảnh tự hết hạn theo header Keep-Alive của upstream
  const upstreamHost = config.upstream.hostname.replace(/^\[|\]$/g, '');
  const upstreamPort = Number(config.upstream.port) || 80;
  const basePath = config.upstream.pathname.replace(/\/+$/, '');
  const active = new Set();
  let closing = false;

  const server = http.createServer((req, res) => {
    const startedAt = Date.now();
    const inspect = req.method === 'POST' && req.url.split('?')[0] === '/v1/chat/completions';
    const headers = forwardHeaders(req.headers);
    if (inspect) delete headers['accept-encoding']; // SSE nén thì không đọc được; chặng loopback không cần nén
    const upReq = http.request({ host: upstreamHost, port: upstreamPort, method: req.method,
      path: basePath + req.url, headers, agent });
    const flow = { upReq, res };
    let timer, cut = false;
    active.add(flow);

    res.on('close', () => {
      clearTimeout(timer);
      active.delete(flow);
      if (!res.writableFinished) upReq.destroy(); // client bỏ ngang hoặc guard cắt: dừng upstream
    });
    req.on('error', () => upReq.destroy());
    upReq.on('error', error => {
      if (res.destroyed || cut) return;
      if (res.headersSent) { res.destroy(); return; }
      emit({ event: 'llm_stream_guard_upstream_error', code: error.code ?? 'unknown' });
      res.writeHead(502, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ error: { message: 'llm-stream-guard: upstream unavailable',
        type: 'upstream_unavailable', code: error.code ?? null } }));
    });

    upReq.on('response', upRes => {
      if (res.destroyed) { upReq.destroy(); return; }
      const sse = inspect && /^text\/event-stream/i.test(upRes.headers['content-type'] ?? '');
      const encoding = upRes.headers['content-encoding'];
      const encoded = sse && encoding !== undefined && encoding !== 'identity';
      if (encoded) emit({ event: 'llm_stream_guard_skip', reason: 'content_encoding' });
      const inspector = sse && !encoded ? createStreamInspector(config) : null;

      const stop = violation => {
        if (cut) return;
        cut = true;
        clearTimeout(timer);
        const seen = inspector.summary();
        emit({ event: 'llm_stream_guard_cut', reason: violation.reason, tool: violation.tool ?? seen.tool,
          argsChars: violation.argsChars ?? seen.argsChars, limit: violation.limit,
          elapsedMs: Date.now() - startedAt, events: seen.events, model: seen.model });
        upReq.destroy(); // 9router thấy client rời đi, ngừng gọi backend
        res.destroy(); // client nhận chunked dở dang = stream drop, Hermes tự thử lại
      };

      try {
        res.writeHead(upRes.statusCode, upRes.statusMessage, forwardHeaders(upRes.headers, closing));
        res.flushHeaders();
      } catch { // header upstream không hợp lệ phía client: đóng cả hai phía, không làm chết tiến trình
        upReq.destroy();
        res.destroy();
        return;
      }
      if (inspector) {
        const remaining = Math.max(0, config.maxStreamMs - (Date.now() - startedAt));
        timer = setTimeout(() => stop({ reason: 'wall_clock', limit: config.maxStreamMs }), remaining);
      }
      upRes.on('data', bytes => {
        if (cut || res.destroyed) return;
        const violation = inspector?.push(bytes);
        if (violation) { stop(violation); return; } // mảnh vi phạm không được chuyển đi
        if (!res.write(bytes)) upRes.pause();
      });
      res.on('drain', () => upRes.resume());
      upRes.on('end', () => { clearTimeout(timer); if (!cut) res.end(); });
      upRes.on('close', () => { if (!upRes.complete && !cut) res.destroy(); }); // upstream đứt giữa chừng
    });
    req.pipe(upReq);
  });
  server.keepAliveTimeout = 65_000; // lâu hơn keep-alive 5 s của httpx để client luôn đóng trước
  server.headersTimeout = 66_000;
  server.maxConnections = 64; // như --connections-max=64 của systemd-socket-proxyd cũ

  return {
    server,
    listen: target => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(target, () => { server.off('error', reject); resolve(server.address()); });
    }),
    // Ngừng nhận kết nối, chờ luồng đang chạy tối đa graceMs rồi cắt phần còn lại.
    async close(graceMs = SHUTDOWN_GRACE_MS) {
      closing = true;
      const closed = new Promise(resolve => server.close(() => resolve()));
      const deadline = Date.now() + graceMs;
      while (active.size > 0 && Date.now() < deadline) {
        server.closeIdleConnections();
        await delay(50);
      }
      for (const { upReq, res } of active) { upReq.destroy(); res.destroy(); }
      server.closeAllConnections();
      agent.destroy();
      await closed;
    },
  };
}

function listenTarget(env, args) {
  if (env.LISTEN_FDS && Number(env.LISTEN_PID) === process.pid) {
    if (env.LISTEN_FDS !== '1') throw new Error('cần đúng một socket từ systemd (LISTEN_FDS=1)');
    return { fd: 3 }; // SD_LISTEN_FDS_START; libuv tự đặt O_NONBLOCK khi mở fd
  }
  const at = args.indexOf('--listen');
  const match = at >= 0 ? /^\[?([^\]]+)\]?:(\d+)$/.exec(args[at + 1] ?? '') : null;
  if (!match) throw new Error('chạy bằng systemd socket activation hoặc --listen host:port');
  return { host: match[1], port: Number(match[2]) };
}

async function main() {
  const config = loadConfig();
  const target = listenTarget(process.env, process.argv.slice(2));
  const guard = createGuard(config);
  const address = await guard.listen(target);
  console.log(JSON.stringify({ event: 'llm_stream_guard_start',
    listen: target.fd === 3 ? 'systemd-fd:3' : `${address.address}:${address.port}`,
    upstream: config.upstream.origin + config.upstream.pathname.replace(/\/+$/, ''),
    argsMax: config.argsMax, largeArgsMax: config.largeArgsMax, largeTools: [...config.largeTools],
    maxStreamSeconds: config.maxStreamMs / 1000, maxEvents: config.maxEvents }));
  const shutdown = () => guard.close().then(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

// So realpath: chạy qua symlink vẫn khởi động (import.meta.url luôn là đường thật).
if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`llm-stream-guard: ${error.message}`); process.exit(1); });
}

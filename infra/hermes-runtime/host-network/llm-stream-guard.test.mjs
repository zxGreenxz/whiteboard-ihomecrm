import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGuard, createStreamInspector, loadConfig, listenTarget, DEFAULT_LARGE_TOOLS } from './llm-stream-guard.mjs';

const GUARD_FILE = fileURLToPath(new URL('./llm-stream-guard.mjs', import.meta.url));
const MODEL = 'gpt-6-luna';
const event = payload => `data: ${JSON.stringify(payload)}\n\n`;
const chunk = delta => event({ id: 'c1', object: 'chat.completion.chunk', model: MODEL,
  choices: [{ index: 0, delta, finish_reason: null }] });
const toolStart = (name, index = 0) => chunk({ tool_calls: [{ index, id: `call_${index}`, type: 'function',
  function: { name, arguments: '' } }] });
const toolArgs = (text, index = 0) => chunk({ tool_calls: [{ index, function: { arguments: text } }] });
const content = text => chunk({ content: text });
const ENDING = event({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n';
const tick = () => new Promise(done => setImmediate(done));
const sleep = ms => new Promise(done => setTimeout(done, ms));
/** Chờ promise tối đa ms; hẹn giờ được huỷ để không giữ tiến trình test sống thêm. */
function within(promise, ms, message) {
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}
const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' };

/** Upstream giả + guard trong cùng tiến trình. handler(req, res, call) nhận body đã đọc xong. */
async function setup(t, handler, overrides = {}) {
  const calls = [];
  const upstream = http.createServer((req, res) => {
    const call = { method: req.method, url: req.url, headers: req.headers, body: '', aborted: false };
    call.closed = new Promise(done => res.on('close', () => { call.aborted = !res.writableFinished; done(); }));
    calls.push(call);
    const parts = [];
    req.on('data', part => parts.push(part));
    req.on('end', () => { call.body = Buffer.concat(parts).toString(); handler(req, res, call); });
  });
  await new Promise(done => upstream.listen(0, '127.0.0.1', done));
  const logs = [];
  const config = { ...loadConfig({ GUARD_UPSTREAM: `http://127.0.0.1:${upstream.address().port}` }), ...overrides };
  const guard = createGuard(config, { log: line => logs.push(line) });
  const { port } = await guard.listen({ host: '127.0.0.1', port: 0 });
  // Ghi lại đúng các byte guard gọi res.write: kiểm "mảnh vi phạm không được chuyển" không phụ thuộc TCP.
  const written = [];
  guard.server.on('request', (req, res) => {
    const write = res.write;
    res.write = function (bytes, ...rest) { written.push(Buffer.from(bytes)); return write.call(this, bytes, ...rest); };
  });
  t.after(async () => {
    await guard.close(0);
    upstream.closeAllConnections();
    await new Promise(done => upstream.close(done));
  });
  return { port, logs, calls, guard, written: () => Buffer.concat(written).toString() };
}

function send(port, { method = 'POST', path = '/v1/chat/completions', body = '{"model":"gpt-6-luna","stream":true}',
  headers = {}, onData } = {}) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, method, path, agent: false,
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test-secret', ...headers } }, res => {
      const parts = [];
      res.on('data', part => { parts.push(part); onData?.(req, part); });
      res.on('error', () => {});
      res.on('close', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts),
        complete: res.complete }));
    });
    req.on('error', error => resolve({ error }));
    req.end(method === 'GET' ? undefined : body);
  });
}

async function writeSlowly(res, pieces) {
  for (const piece of pieces) {
    if (res.destroyed) return;
    res.write(piece);
    await tick();
  }
  if (!res.destroyed) res.end();
}

test('luồng SSE bình thường đi qua nguyên byte, gồm [DONE]; header Authorization và body request tới upstream', async t => {
  const sent = toolStart('skill_view') + toolArgs('{"name":') + toolArgs('"hermes-crm"}') + ENDING;
  const requestBody = JSON.stringify({ model: MODEL, stream: true, messages: [{ role: 'user', content: 'xin chào' }] });
  const f = await setup(t, (req, res) => { res.writeHead(200, SSE_HEADERS); writeSlowly(res, [sent.slice(0, 50), sent.slice(50)]); });
  const reply = await send(f.port, { body: requestBody });
  assert.equal(reply.status, 200);
  assert.equal(reply.complete, true);
  assert.equal(reply.body.toString(), sent);
  assert.equal(reply.headers['content-type'], 'text/event-stream');
  assert.equal(f.calls[0].body, requestBody);
  assert.equal(f.calls[0].headers.authorization, 'Bearer sk-test-secret');
  assert.equal(f.calls[0].headers.host, `127.0.0.1:${f.port}`, 'Host của client đi nguyên như socket-proxyd cũ');
  assert.equal(f.calls[0].headers['accept-encoding'], undefined, 'SSE cần đọc được nên không xin nén');
  assert.deepEqual(f.logs, []);
});

test('SSE đã nén thì đi qua không kiểm và ghi skip; POST khác giữ Accept-Encoding', async t => {
  const f = await setup(t, (req, res) => {
    if (req.url === '/v1/embeddings') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
    res.writeHead(200, { ...SSE_HEADERS, 'content-encoding': 'gzip' });
    res.end(Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
  });
  const reply = await send(f.port, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(reply.complete, true);
  assert.deepEqual([...reply.body], [0x1f, 0x8b, 0x08, 0x00]);
  assert.deepEqual(f.logs.map(line => JSON.parse(line)), [{ event: 'llm_stream_guard_skip', reason: 'content_encoding' }]);
  await send(f.port, { path: '/v1/embeddings', headers: { 'accept-encoding': 'gzip' } });
  assert.equal(f.calls[1].headers['accept-encoding'], 'gzip');
});

test('tool nhỏ sinh arguments không dứt: cắt trước khi chuyển quá giới hạn, huỷ upstream, một dòng log không chứa nội dung', async t => {
  const f = await setup(t, (req, res) => {
    res.writeHead(200, SSE_HEADERS);
    const runaway = Array.from({ length: 2000 }, (_, i) => toolArgs(`${i === 81 ? 'OFFENDING-' : 'SECRETARG-'}${'x'.repeat(90)}`));
    writeSlowly(res, [toolStart('skill_view'), ...runaway]);
  });
  const reply = await send(f.port);
  assert.equal(reply.status, 200);
  assert.equal(reply.complete, false, 'client phải thấy body chunked dở dang để Hermes thử lại');
  const forwarded = f.written();
  assert.doesNotMatch(forwarded, /OFFENDING/, 'mảnh thứ 82 (8200 > 8192) không được chuyển');
  assert.ok(forwarded.split('SECRETARG-').length - 1 <= 81);
  assert.doesNotMatch(reply.body.toString(), /OFFENDING/);
  await f.calls[0].closed;
  assert.equal(f.calls[0].aborted, true, 'upstream phải bị huỷ');
  assert.equal(f.logs.length, 1);
  assert.doesNotMatch(f.logs[0], /SECRETARG|xxxx|Bearer|sk-test/);
  const record = JSON.parse(f.logs[0]);
  assert.equal(record.event, 'llm_stream_guard_cut');
  assert.equal(record.reason, 'tool_args');
  assert.equal(record.tool, 'skill_view');
  assert.equal(record.argsChars, 8200);
  assert.equal(record.limit, 8192);
  assert.equal(record.model, MODEL);
  assert.equal(typeof record.elapsedMs, 'number');
});

test('tool lớn (skill_manage) với 20 KB arguments đi qua trọn vẹn', async t => {
  const sent = toolStart('skill_manage') + Array.from({ length: 200 }, (_, i) => toolArgs(`${i}`.padEnd(100, 'y'))).join('') + ENDING;
  const f = await setup(t, (req, res) => { res.writeHead(200, SSE_HEADERS); res.end(sent); });
  const reply = await send(f.port);
  assert.equal(reply.complete, true);
  assert.equal(reply.body.toString(), sent);
  assert.deepEqual(f.logs, []);
});

test('tool lớn vượt GUARD_LARGE_ARGS_MAX vẫn bị cắt', async t => {
  const f = await setup(t, (req, res) => {
    res.writeHead(200, SSE_HEADERS);
    writeSlowly(res, [toolStart('skill_manage'), ...Array.from({ length: 400 }, () => toolArgs('z'.repeat(100)))]);
  }, { largeArgsMax: 30_000 });
  const reply = await send(f.port);
  assert.equal(reply.complete, false);
  const record = JSON.parse(f.logs[0]);
  assert.deepEqual([record.reason, record.tool, record.argsChars, record.limit], ['tool_args', 'skill_manage', 30_100, 30_000]);
});

test('sự kiện SSE bị cắt ở biên byte lẻ (cả giữa ký tự UTF-8 nhiều byte, CRLF) vẫn đếm đúng', () => {
  const limits = loadConfig({});
  const line = (text, index = 0) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: text } }] } }] })}\r\n\r\n`;
  const head = `: keep-alive\r\n\r\n${toolStart('skill_view').replace(/\n/g, '\r\n')}${toolStart('skill_manage', 1)}`;
  // 81 mảnh 100 ký tự (8100) + một mảnh 92 ký tự = đúng 8192: chưa vượt. Mảnh tiếp theo vượt.
  const piece = 'ở'.repeat(50) + 'a'.repeat(50); // 'ở' = 3 byte UTF-8
  const exact = head + Array.from({ length: 81 }, () => line(piece)).join('') + line('b'.repeat(92)) + line('c'.repeat(9000), 1);
  const over = exact + line('d');
  const feed = (text, size) => {
    const bytes = Buffer.from(text);
    const inspector = createStreamInspector(limits);
    for (let at = 0; at < bytes.length; at += size) {
      const violation = inspector.push(bytes.subarray(at, at + size));
      if (violation) return { violation, at, summary: inspector.summary() };
    }
    return { violation: null, summary: inspector.summary() };
  };
  for (const size of [1, 2, 3, 7, 13, 4096, Infinity]) {
    const ok = feed(exact, size);
    assert.equal(ok.violation, null, `size ${size}`);
    assert.deepEqual([ok.summary.tool, ok.summary.argsChars], ['skill_manage', 9000], `size ${size}`);
    const cut = feed(over, size);
    assert.deepEqual(cut.violation, { reason: 'tool_args', tool: 'skill_view', argsChars: 8193, limit: 8192 }, `size ${size}`);
  }
  // Dòng vi phạm kết thúc bằng "\r\n\r\n": phát hiện đúng ở byte '\n' đầu tiên, trước dòng trống.
  assert.equal(feed(over, 1).at, Buffer.byteLength(over) - 3);
});

test('tool call mới ở cùng index (id khác) được đếm riêng; tool song song đếm theo index', () => {
  const inspector = createStreamInspector(loadConfig({}));
  const sent = toolStart('skill_view') + toolArgs('a'.repeat(5000))
    + chunk({ tool_calls: [{ index: 0, id: 'call_next', type: 'function', function: { name: 'write_file', arguments: '' } }] })
    + toolArgs('b'.repeat(20_000)) + toolStart('skill_view', 1) + toolArgs('c'.repeat(5000), 1);
  assert.equal(inspector.push(Buffer.from(sent)), null);
  assert.deepEqual(inspector.summary(), { tool: 'write_file', argsChars: 20_000, events: 6, model: MODEL });
  assert.deepEqual(inspector.push(Buffer.from(toolArgs('d'.repeat(4000), 1))),
    { reason: 'tool_args', tool: 'skill_view', argsChars: 9000, limit: 8192 });
});

test('response JSON không stream và GET /v1/models đi qua nguyên vẹn', async t => {
  const bigJson = JSON.stringify({ id: 'x', model: MODEL, choices: [{ index: 0, message: { role: 'assistant',
    tool_calls: [{ id: 'c', type: 'function', function: { name: 'skill_view', arguments: 'q'.repeat(50_000) } }] } }] });
  const models = JSON.stringify({ object: 'list', data: [{ id: MODEL }] });
  const f = await setup(t, (req, res) => {
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'models' }); res.end(models); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bigJson) });
    res.end(bigJson);
  });
  const chat = await send(f.port, { body: '{"stream":false}' });
  assert.equal(chat.status, 200);
  assert.equal(chat.body.toString(), bigJson);
  assert.equal(chat.headers['content-length'], String(Buffer.byteLength(bigJson)));
  const list = await send(f.port, { method: 'GET', path: '/v1/models?limit=5', headers: { 'accept-encoding': 'gzip' } });
  assert.equal(list.status, 200);
  assert.equal(list.body.toString(), models);
  assert.equal(list.headers['x-upstream'], 'models');
  assert.equal(f.calls[1].url, '/v1/models?limit=5');
  assert.equal(f.calls[1].headers['accept-encoding'], 'gzip');
  assert.equal(f.calls[1].headers.authorization, 'Bearer sk-test-secret');
  assert.deepEqual(f.logs, []);
});

test('lỗi upstream 401/500 giữ nguyên status, header và body', async t => {
  const f = await setup(t, (req, res) => {
    const status = req.url.includes('denied') ? 401 : 500;
    res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': `r${status}` });
    res.end(JSON.stringify({ error: { message: `status ${status}` } }));
  });
  for (const [path, status] of [['/v1/chat/completions?denied=1', 401], ['/v1/chat/completions', 500]]) {
    const reply = await send(f.port, { path });
    assert.equal(reply.status, status);
    assert.equal(reply.headers['x-request-id'], `r${status}`);
    assert.deepEqual(JSON.parse(reply.body.toString()), { error: { message: `status ${status}` } });
  }
  assert.deepEqual(f.logs, []);
});

test('đồng hồ tổng: luồng nhỏ giọt quá GUARD_MAX_STREAM_SECONDS bị cắt', async t => {
  const f = await setup(t, async (req, res) => {
    res.writeHead(200, SSE_HEADERS);
    while (!res.destroyed) { res.write(content('đang trả lời ')); await sleep(20); }
  }, { maxStreamMs: 200 });
  const reply = await send(f.port);
  assert.equal(reply.complete, false);
  await f.calls[0].closed;
  assert.equal(f.calls[0].aborted, true);
  const record = JSON.parse(f.logs[0]);
  assert.equal(record.reason, 'wall_clock');
  assert.equal(record.limit, 200);
  assert.ok(record.elapsedMs >= 190 && record.elapsedMs < 2000, `elapsedMs ${record.elapsedMs}`);
  assert.ok(record.events > 0);
});

test('trần số sự kiện cắt luồng quá GUARD_MAX_EVENTS', async t => {
  const f = await setup(t, (req, res) => {
    res.writeHead(200, SSE_HEADERS);
    writeSlowly(res, Array.from({ length: 60 }, () => content('a')));
  }, { maxEvents: 50 });
  const reply = await send(f.port);
  assert.equal(reply.complete, false);
  const record = JSON.parse(f.logs[0]);
  assert.deepEqual([record.reason, record.limit, record.events], ['events', 50, 51]);
});

test('client bỏ ngang thì upstream bị huỷ, không ghi log cắt', async t => {
  const f = await setup(t, async (req, res) => {
    res.writeHead(200, SSE_HEADERS);
    while (!res.destroyed) { res.write(content('x')); await sleep(10); }
  });
  const reply = await send(f.port, { onData: req => req.destroy() });
  assert.equal(reply.complete, false);
  await within(f.calls[0].closed, 2000, 'upstream không bị huỷ');
  assert.equal(f.calls[0].aborted, true);
  assert.deepEqual(f.logs, []);
});

test('dòng rác, chú thích, JSON lạ và byte không phải UTF-8 không làm hỏng luồng', async t => {
  const sent = Buffer.concat([
    Buffer.from(': ping\n\ndata: {not json\n\nevent: x\ndata: [1,2\n\ndata: null\n\ndata: {"choices":"weird"}\n\n'),
    Buffer.from('data: {"choices":[{"delta":{"tool_calls":[null,{"function":5},{"index":"a"}]}},null,{"delta":7}]}\n\n'),
    Buffer.from([0xff, 0xfe, 0x00, 0x0a, 0x0a]), Buffer.from('retry: 10\nid: 7\ndata:\n\n'),
    Buffer.from(toolStart('skill_view') + toolArgs('{}') + ENDING),
  ]);
  const f = await setup(t, (req, res) => { res.writeHead(200, SSE_HEADERS); writeSlowly(res, [sent.subarray(0, 33), sent.subarray(33)]); });
  const reply = await send(f.port);
  assert.equal(reply.complete, true);
  assert.ok(reply.body.equals(sent));
  assert.deepEqual(f.logs, []);
});

test('upstream đứt giữa chừng thì client cũng thấy đứt; upstream không kết nối được trả 502 JSON', async t => {
  const f = await setup(t, (req, res) => {
    res.writeHead(200, SSE_HEADERS);
    res.write(content('một nửa'));
    setTimeout(() => res.socket.destroy(), 20);
  });
  const reply = await send(f.port);
  assert.equal(reply.complete, false);
  assert.deepEqual(f.logs, []);

  const closed = net.createServer();
  await new Promise(done => closed.listen(0, '127.0.0.1', done));
  const deadPort = closed.address().port;
  await new Promise(done => closed.close(done));
  const logs = [];
  const guard = createGuard(loadConfig({ GUARD_UPSTREAM: `http://127.0.0.1:${deadPort}` }), { log: line => logs.push(line) });
  const { port } = await guard.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => guard.close(0));
  const down = await send(port);
  assert.equal(down.status, 502);
  assert.equal(JSON.parse(down.body.toString()).error.type, 'upstream_unavailable');
  assert.deepEqual(logs.map(line => JSON.parse(line)), [{ event: 'llm_stream_guard_upstream_error', code: 'ECONNREFUSED' }]);
});

test('cấu hình từ env: mặc định, ghi đè và giá trị sai', () => {
  const defaults = loadConfig({});
  assert.equal(defaults.upstream.href, 'http://127.0.0.1:20128/');
  assert.deepEqual([defaults.argsMax, defaults.largeArgsMax, defaults.maxStreamMs, defaults.maxEvents], [8192, 131_072, 300_000, 40_000]);
  assert.deepEqual([...defaults.largeTools], DEFAULT_LARGE_TOOLS);
  const custom = loadConfig({ GUARD_ARGS_MAX: '100', GUARD_LARGE_TOOLS: ' write_file , patch,', GUARD_MAX_STREAM_SECONDS: '0.5' });
  assert.deepEqual([custom.argsMax, [...custom.largeTools], custom.maxStreamMs], [100, ['write_file', 'patch'], 500]);
  assert.throws(() => loadConfig({ GUARD_ARGS_MAX: '-1' }), /GUARD_ARGS_MAX/);
  assert.throws(() => loadConfig({ GUARD_MAX_EVENTS: '1.5' }), /GUARD_MAX_EVENTS/);
  assert.throws(() => loadConfig({ GUARD_UPSTREAM: 'https://127.0.0.1:20128' }), /http/);
  assert.throws(() => loadConfig({ GUARD_MAX_STREAM_SECONDS: '0.0001' }), /GUARD_MAX_STREAM_SECONDS/);
  assert.throws(() => loadConfig({ GUARD_MAX_STREAM_SECONDS: '3000000' }), /GUARD_MAX_STREAM_SECONDS/);
});

test('chọn cửa nghe: fd 3 chỉ khi LISTEN_PID đúng pid, còn lại cần --listen', () => {
  const pid = String(process.pid);
  assert.deepEqual(listenTarget({ LISTEN_FDS: '1', LISTEN_PID: pid }, []), { fd: 3 });
  assert.throws(() => listenTarget({ LISTEN_FDS: '2', LISTEN_PID: pid }, []), /LISTEN_FDS=1/);
  assert.throws(() => listenTarget({ LISTEN_FDS: '1', LISTEN_PID: '1' }, []), /--listen/);
  assert.deepEqual(listenTarget({}, ['--listen', '127.0.0.1:20129']), { host: '127.0.0.1', port: 20129 });
  assert.deepEqual(listenTarget({}, ['--listen', '[::1]:8080']), { host: '::1', port: 8080 });
});

test('choices index khác 0 và function_call kiểu cũ cũng được đếm', () => {
  const inspector = createStreamInspector(loadConfig({}));
  const legacy = event({ choices: [{ index: 1, delta: { function_call: { name: 'skill_view', arguments: 'x'.repeat(8000) } } }] });
  assert.equal(inspector.push(Buffer.from(legacy)), null);
  const more = event({ choices: [{ index: 1, delta: { function_call: { arguments: 'y'.repeat(300) } } }] });
  assert.deepEqual(inspector.push(Buffer.from(more)), { reason: 'tool_args', tool: 'skill_view', argsChars: 8300, limit: 8192 });
});

test('dừng êm: luồng xong trong hạn đi trọn, luồng dài bị cắt khi hết hạn và upstream bị huỷ', async t => {
  const f = await setup(t, async (req, res) => {
    res.writeHead(200, SSE_HEADERS);
    if (req.url.includes('short')) { await sleep(30); res.end(content('xong') + 'data: [DONE]\n\n'); return; }
    while (!res.destroyed) { res.write(content('x')); await sleep(10); }
  });
  let stopped;
  const long = send(f.port, { onData: () => { stopped ??= f.guard.close(150); } });
  const short = send(f.port, { path: '/v1/chat/completions?short=1' });
  const started = Date.now();
  const [longReply, shortReply] = await Promise.all([long, short]);
  await stopped;
  assert.equal(shortReply.complete, true);
  assert.equal(longReply.complete, false);
  assert.ok(Date.now() - started >= 100, 'luồng dài phải được chờ gần hết hạn');
  const longCall = f.calls.find(call => !call.url.includes('short'));
  const shortCall = f.calls.find(call => call.url.includes('short'));
  await within(longCall.closed, 2000, 'upstream của luồng dài không bị huỷ');
  assert.equal(longCall.aborted, true);
  assert.equal(shortCall.aborted, false);
});

test('socket activation: nhận fd 3 từ systemd và thoát 0 khi SIGTERM', {
  skip: process.platform === 'win32' && 'cần /bin/sh và truyền fd kiểu POSIX', timeout: 10_000 }, async t => {
  const upstream = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); });
  await new Promise(done => upstream.listen(0, '127.0.0.1', done));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const listener = net.createServer();
  await new Promise(done => listener.listen(0, '127.0.0.1', done));
  t.after(() => listener.close());
  const { port } = listener.address();
  // Giống systemd: fd 3 là socket đang nghe, LISTEN_PID là pid của chính tiến trình node (exec giữ pid).
  // Truyền số fd (kiểu 'fd'); truyền thẳng net.Server làm spawn gọi pause() không tồn tại.
  const child = spawn('/bin/sh', ['-c', 'export LISTEN_PID=$$ LISTEN_FDS=1; exec "$0" "$@"', process.execPath, GUARD_FILE], {
    stdio: ['ignore', 'pipe', 'pipe', listener._handle.fd],
    env: { ...process.env, GUARD_UPSTREAM: `http://127.0.0.1:${upstream.address().port}` } });
  t.after(() => child.kill('SIGKILL'));
  listener.close(); // tiến trình test bỏ bản sao fd của mình; con giữ socket đang nghe
  const exited = new Promise(done => child.on('exit', code => done(code)));
  let stdout = '', stderr = '';
  child.stderr.on('data', part => { stderr += part; });
  const started = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`guard không khởi động: ${stderr}`)), 3000);
    child.stdout.on('data', part => {
      stdout += part;
      if (stdout.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(stdout.split('\n')[0])); }
    });
  });
  assert.equal(started.event, 'llm_stream_guard_start');
  assert.equal(started.listen, 'systemd-fd:3');
  const reply = await send(port, { method: 'GET', path: '/v1/models' });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.toString(), '{"data":[]}');
  child.kill('SIGTERM');
  assert.equal(await within(exited, 3000, 'guard không thoát sau SIGTERM'), 0);
});

/** Đẩy text qua inspector mới theo từng mảnh `size` byte; trả vi phạm đầu tiên (hoặc null) và summary. */
function feedArgs(pieces, size, config = loadConfig({})) {
  const inspector = createStreamInspector(config);
  const bytes = Buffer.from(pieces.join(''));
  for (let at = 0; at < bytes.length; at += size) {
    const violation = inspector.push(bytes.subarray(at, at + size));
    if (violation) return { violation, summary: inspector.summary() };
  }
  return { violation: null, summary: inspector.summary() };
}

test('khoảng trắng dài TRONG chuỗi JSON (mô tả nhiều dấu cách, tin nhắn xuống dòng) không bị cắt, qua mọi biên mảnh', () => {
  // Dấu cách, xuống dòng thô và tab trong chuỗi đều dài hơn ngưỡng 512; ngoài chuỗi chỉ có thụt lề ngắn.
  const message = `Chào anh,${'\n'.repeat(300)}${' '.repeat(700)}phòng 203 còn trống.${'\t'.repeat(600)}Hẹn gặp \\"sớm\\"!`;
  const pretty = JSON.stringify({ room: 'A1', note: ' '.repeat(600), tags: ['a b', 'c  d'] }, null, 4);
  const args = `{"content":"${message}","note":"${' '.repeat(1000)}",\n    "extra": ${pretty}\n}`;
  const pieces = [toolStart('skill_view'), toolArgs(args.slice(0, 40)), toolArgs(args.slice(40))];
  for (const size of [1, 7, 64, 4096, Infinity]) {
    const { violation, summary } = feedArgs(pieces, size);
    assert.equal(violation, null, `size ${size}`);
    assert.deepEqual([summary.tool, summary.argsChars], ['skill_view', args.length], `size ${size}`);
  }
});

test('chạy loạn kiểu khoảng trắng: `{"command":"date","background":f` + 600 dấu cách bị cắt dưới ngưỡng byte, cả với tool lớn', async t => {
  const prefix = '{"command":"date","background":f';
  const f = await setup(t, (req, res) => {
    res.writeHead(200, SSE_HEADERS);
    writeSlowly(res, [toolStart('terminal'), toolArgs(prefix), toolArgs(`${' '.repeat(600)}OFFENDING`),
      ...Array.from({ length: 50 }, () => toolArgs(' '.repeat(100)))]);
  });
  const reply = await send(f.port);
  assert.equal(reply.status, 200);
  assert.equal(reply.complete, false, 'client phải thấy body chunked dở dang để Hermes thử lại');
  assert.doesNotMatch(f.written(), /OFFENDING| {20}/, 'mảnh chứa chuỗi trắng vi phạm không được chuyển');
  assert.match(f.written(), /background/, 'các mảnh trước đó vẫn đi qua');
  await f.calls[0].closed;
  assert.equal(f.calls[0].aborted, true, 'upstream phải bị huỷ');
  assert.equal(f.logs.length, 1);
  assert.doesNotMatch(f.logs[0], /OFFENDING|date| {4}|Bearer|sk-test/);
  const record = JSON.parse(f.logs[0]);
  assert.deepEqual(Object.keys(record), ['event', 'reason', 'tool', 'argsChars', 'limit', 'elapsedMs', 'events', 'model'], 'giữ đúng các khoá log cũ');
  assert.equal(record.event, 'llm_stream_guard_cut');
  assert.equal(record.reason, 'whitespace_run');
  assert.equal(record.tool, 'terminal');
  assert.equal(record.argsChars, prefix.length + 609, 'đếm cả delta vi phạm, như tool_args');
  assert.ok(record.argsChars < 8192, 'cắt sớm hơn hẳn ngưỡng byte');
  assert.equal(record.limit, 512);
  assert.equal(record.events, 3);
  assert.equal(record.model, MODEL);
  assert.equal(typeof record.elapsedMs, 'number');
});

test('khoảng trắng chia nhỏ qua nhiều delta (100 × 6 dấu cách) bị cắt ngay khi chạm 512; ký tự khác ngoài chuỗi đặt lại bộ đếm', () => {
  const prefix = '{"status":null,"query":"","limit":1,"cursor":';
  const inspector = createStreamInspector(loadConfig({}));
  assert.equal(inspector.push(Buffer.from(toolStart('skill_view') + toolArgs(prefix))), null);
  const cutAt = Math.ceil(512 / 6); // delta thứ 86 đưa chuỗi trắng từ 510 lên 512
  for (let i = 1; i < cutAt; i++) assert.equal(inspector.push(Buffer.from(toolArgs(' '.repeat(6)))), null, `delta ${i}`);
  assert.deepEqual(inspector.push(Buffer.from(toolArgs(' '.repeat(6)))),
    { reason: 'whitespace_run', tool: 'skill_view', argsChars: prefix.length + cutAt * 6, limit: 512 });

  // 500 trắng, một ký tự thường, 500 trắng nữa: hai chuỗi riêng, chưa chạm ngưỡng; thêm 12 thì chạm.
  const again = createStreamInspector(loadConfig({}));
  assert.equal(again.push(Buffer.from(toolStart('skill_view') + toolArgs(`{"a":${' '.repeat(500)}`) + toolArgs(`1${'\n\t\r '.repeat(125)}`))), null);
  assert.equal(again.push(Buffer.from(toolArgs(' '.repeat(11)))), null);
  assert.equal(again.push(Buffer.from(toolArgs(' ')))?.reason, 'whitespace_run');
});

test('dấu nháy escape `\\"` và `\\\\` không làm lệch trạng thái chuỗi, kể cả khi delta kết thúc bằng `\\`', () => {
  // `\` cuối delta 1 escape dấu `"` đầu delta 2: chuỗi vẫn mở, 600 dấu cách nằm trong chuỗi → không cắt.
  const open = [toolStart('skill_view'), toolArgs('{"msg":"x\\'), toolArgs(`"${' '.repeat(600)}y"}`)];
  for (const size of [1, 5, Infinity]) assert.equal(feedArgs(open, size).violation, null, `size ${size}`);
  // `\\` chia đôi qua biên delta rồi `"` đóng chuỗi đúng chỗ: 600 dấu cách sau đó là ngoài chuỗi → cắt.
  const closed = [toolStart('skill_view'), toolArgs('{"msg":"a\\'), toolArgs('\\",'), toolArgs(`"k":${' '.repeat(600)}`)];
  for (const size of [1, 5, Infinity]) assert.equal(feedArgs(closed, size).violation?.reason, 'whitespace_run', `size ${size}`);
  // Escape ngay trước dấu đóng trong cùng delta.
  assert.equal(feedArgs([toolStart('skill_view'), toolArgs(`{"msg":"a\\\\","k":${' '.repeat(600)}`)], Infinity).violation?.reason, 'whitespace_run');
  assert.equal(feedArgs([toolStart('skill_view'), toolArgs(`{"msg":"a\\"${' '.repeat(600)}b"}`)], Infinity).violation, null);
});

test('hai tool call song song có bộ đếm khoảng trắng riêng; call mới cùng index (id khác) đếm lại từ đầu', () => {
  const inspector = createStreamInspector(loadConfig({}));
  const sent = toolStart('skill_view') + toolStart('terminal', 1)
    + toolArgs(`{"a":${' '.repeat(300)}`) + toolArgs(`{"b":${' '.repeat(300)}`, 1)
    + toolArgs(`${' '.repeat(200)}`, 1) + toolArgs('1', 1) + toolArgs(' '.repeat(400), 1);
  assert.equal(inspector.push(Buffer.from(sent)), null, 'tổng 600 nhưng mỗi call chỉ 300; call 1 được đặt lại');
  assert.deepEqual(inspector.push(Buffer.from(toolArgs(' '.repeat(212)))),
    { reason: 'whitespace_run', tool: 'skill_view', argsChars: 5 + 300 + 212, limit: 512 });

  const renewed = createStreamInspector(loadConfig({}));
  const first = toolStart('skill_view') + toolArgs(`{"a":${' '.repeat(400)}`)
    + chunk({ tool_calls: [{ index: 0, id: 'call_next', type: 'function', function: { name: 'write_file', arguments: '' } }] })
    + toolArgs(`{"c":${' '.repeat(400)}`);
  assert.equal(renewed.push(Buffer.from(first)), null, 'call mới ở cùng index không thừa hưởng 400 trắng của call cũ');
  assert.deepEqual(renewed.push(Buffer.from(toolArgs(' '.repeat(112)))),
    { reason: 'whitespace_run', tool: 'write_file', argsChars: 5 + 400 + 112, limit: 512 });
});

test('GUARD_WHITESPACE_RUN: mặc định 512, ghi đè được, giá trị sai thì thoát; ngưỡng byte vẫn xét trước', () => {
  assert.equal(loadConfig({}).whitespaceRunLimit, 512);
  assert.equal(loadConfig({ GUARD_WHITESPACE_RUN: '100' }).whitespaceRunLimit, 100);
  assert.throws(() => loadConfig({ GUARD_WHITESPACE_RUN: '0' }), /GUARD_WHITESPACE_RUN/);
  assert.throws(() => loadConfig({ GUARD_WHITESPACE_RUN: 'abc' }), /GUARD_WHITESPACE_RUN/);
  const small = feedArgs([toolStart('skill_view'), toolArgs(`{"a":${' '.repeat(100)}`)], Infinity, loadConfig({ GUARD_WHITESPACE_RUN: '100' }));
  assert.deepEqual(small.violation, { reason: 'whitespace_run', tool: 'skill_view', argsChars: 105, limit: 100 });
  assert.equal(feedArgs([toolStart('skill_view'), toolArgs(`{"a":${' '.repeat(99)}`)], Infinity, loadConfig({ GUARD_WHITESPACE_RUN: '100' })).violation, null);
  // Một delta vi phạm cả hai: giữ hành vi cũ (tool_args).
  const both = feedArgs([toolStart('skill_view'), toolArgs('x'.repeat(8000)), toolArgs(' '.repeat(600))], Infinity);
  assert.deepEqual(both.violation, { reason: 'tool_args', tool: 'skill_view', argsChars: 8600, limit: 8192 });
});

import assert from 'node:assert/strict';
import {createHandler, MAX_PASSWORD_BYTES, MIN_PASSWORD_CHARS, passwordProblem} from './index.ts';

// Thay `fetch` (đường truyền thật) chứ không thay hàm rpc: header Content-Profile, khoá nào đi
// đâu, mật khẩu nằm ở thân nào đều phải soi được trên đúng yêu cầu HTTP sẽ gửi đi.
const BASE = 'https://proj.supabase.co';
const ANON = 'anon-key-xyz';
const SERVICE = 'service-key-xyz';
const JWT = 'Bearer aaa.bbb.ccc';
const TARGET = '30000000-0000-4000-8000-000000000001';
const REQUEST_ID = '40000000-0000-4000-8000-000000000002';
const FINISH_TOKEN = 'c0ffee'.repeat(10) + 'beef';
const PASSWORD = 'Moi-mat-khau-9';
const env = (name: string): string | undefined => ({SUPABASE_URL: `${BASE}/`, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE} as Record<string, string>)[name];

interface Call {url: string; method: string; headers: Record<string, string>; body: unknown}
type Responder = (call: Call) => Response | Promise<Response>;

function harness(routes: {begin?: Responder; auth?: Responder; finish?: Responder}, envFn = env) {
  const calls: Call[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const call: Call = {url: String(input), method: init?.method ?? 'GET', headers, body: init?.body ? JSON.parse(String(init.body)) : null};
    calls.push(call);
    if (call.url.endsWith('/rest/v1/rpc/user_password_reset_begin_v1')) return (routes.begin ?? (() => json(200, {requestId: REQUEST_ID, via: 'COMPANY_OWNER', finishToken: FINISH_TOKEN})))(call);
    if (call.url === `${BASE}/auth/v1/admin/users/${TARGET}`) return (routes.auth ?? (() => json(200, {id: TARGET})))(call);
    if (call.url.endsWith('/rest/v1/rpc/user_password_reset_finish_v1')) return (routes.finish ?? (() => json(200, {status: 'SUCCEEDED'})))(call);
    throw new Error(`gọi lạ: ${call.url}`);
  }) as typeof fetch;
  return {calls, handler: createHandler({env: envFn, fetch: fakeFetch})};
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
const post = (body: unknown, headers: Record<string, string> = {}) => new Request('https://edge.test/admin-reset-user-password', {
  method: 'POST',
  headers: {authorization: JWT, 'content-type': 'application/json', ...headers},
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const valid = {userId: TARGET, password: PASSWORD};
async function read(response: Response) { return {status: response.status, body: await response.json()}; }

Deno.test('thành công: bắt đầu bằng JWT người bấm → Auth bằng khoá service → chốt SUCCEEDED; trả via', async () => {
  const {calls, handler} = harness({});
  const r = await read(await handler(post(valid)));
  assert.deepEqual(r, {status: 200, body: {ok: true, via: 'COMPANY_OWNER'}});
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
    `POST ${BASE}/rest/v1/rpc/user_password_reset_begin_v1`,
    `PUT ${BASE}/auth/v1/admin/users/${TARGET}`,
    `POST ${BASE}/rest/v1/rpc/user_password_reset_finish_v1`,
  ]);
  const [begin, auth, finish] = calls;
  for (const rpc of [begin, finish]) {
    assert.equal(rpc.headers.authorization, JWT);
    assert.equal(rpc.headers.apikey, ANON);
    assert.equal(rpc.headers['content-profile'], 'public');
    assert.equal(rpc.headers['accept-profile'], 'public');
  }
  assert.deepEqual(begin.body, {p_target_user_id: TARGET});
  assert.deepEqual(finish.body, {p_request_id: REQUEST_ID, p_finish_token: FINISH_TOKEN, p_outcome: 'SUCCEEDED', p_error_code: null});
  // Mã chốt không đi tới Auth và không trả về trình duyệt.
  assert.equal(JSON.stringify(auth).includes(FINISH_TOKEN), false);
  assert.equal(JSON.stringify(r.body).includes(FINISH_TOKEN), false);
  assert.equal(auth.headers.authorization, `Bearer ${SERVICE}`);
  assert.equal(auth.headers.apikey, SERVICE);
  assert.deepEqual(auth.body, {password: PASSWORD});
  // Mật khẩu chỉ ở thân gọi Auth; khoá service chỉ ở header gọi Auth.
  for (const c of [begin, finish]) {
    assert.equal(JSON.stringify(c).includes(PASSWORD), false);
    assert.equal(JSON.stringify(c).includes(SERVICE), false);
  }
});

Deno.test('superadmin: via SUPER_ADMIN đi nguyên; userId chữ hoa được chuẩn hoá', async () => {
  const {calls, handler} = harness({begin: () => json(200, {requestId: REQUEST_ID, via: 'SUPER_ADMIN', finishToken: FINISH_TOKEN})});
  const r = await read(await handler(post({userId: TARGET.toUpperCase(), password: PASSWORD})));
  assert.deepEqual(r.body, {ok: true, via: 'SUPER_ADMIN'});
  assert.deepEqual(calls[0].body, {p_target_user_id: TARGET});
});

Deno.test('luật mật khẩu: biên ký tự/byte, khoảng trắng hai đầu, chữ có dấu', () => {
  assert.equal(MIN_PASSWORD_CHARS, 6);
  assert.equal(MAX_PASSWORD_BYTES, 72);
  assert.match(passwordProblem('abcde') ?? '', /ít nhất 6 ký tự/);
  assert.equal(passwordProblem('abcdef'), null);
  assert.equal(passwordProblem('đặtlại'), null); // 6 ký tự, 9 byte
  assert.match(passwordProblem('đđđđđ') ?? '', /ít nhất 6 ký tự/); // 5 ký tự dù 10 byte
  assert.equal(passwordProblem('a'.repeat(72)), null);
  assert.match(passwordProblem('a'.repeat(73)) ?? '', /quá dài/);
  assert.match(passwordProblem('đ'.repeat(37)) ?? '', /quá dài/); // 37 ký tự nhưng 74 byte
  assert.match(passwordProblem(' abcdef') ?? '', /khoảng trắng/);
  assert.match(passwordProblem('abcdef\n') ?? '', /khoảng trắng/);
  assert.match(passwordProblem('') ?? '', /Nhập mật khẩu/);
  assert.match(passwordProblem(123456) ?? '', /Nhập mật khẩu/);
  assert.match(passwordProblem('abc\uD800def') ?? '', /không hợp lệ/);
});

Deno.test('yêu cầu sai bị chặn TRƯỚC mọi lời gọi ra ngoài', async () => {
  const cases: Array<[Request, number, string]> = [
    [new Request('https://edge.test/x', {method: 'GET', headers: {authorization: JWT}}), 405, 'method_not_allowed'],
    [post(valid, {authorization: ''}), 401, 'unauthorized'],
    [post(valid, {authorization: 'Basic abc'}), 401, 'unauthorized'],
    [post(valid, {'content-type': 'text/plain'}), 415, 'unsupported_media_type'],
    [post('{bad json'), 400, 'invalid_request'],
    [post([valid]), 400, 'invalid_request'],
    [post({...valid, role: 'admin'}), 400, 'invalid_request'],
    [post({password: PASSWORD}), 400, 'invalid_request'],
    [post({userId: 'không-phải-uuid', password: PASSWORD}), 400, 'invalid_request'],
    [post({userId: TARGET, password: '12345'}), 400, 'invalid_request'],
    [post({userId: TARGET, password: ` ${PASSWORD}`}), 400, 'invalid_request'],
    [post({userId: TARGET, password: 'x'.repeat(5000)}), 413, 'payload_too_large'],
  ];
  for (const [request, status, error] of cases) {
    const {calls, handler} = harness({});
    const r = await read(await handler(request));
    assert.equal(r.status, status, `${error}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, error);
    assert.equal(typeof r.body.message, 'string');
    assert.equal(calls.length, 0, `${error} không được gọi ra ngoài`);
  }
  const weak = await read(await harness({}).handler(post({userId: TARGET, password: '12345'})));
  assert.match(weak.body.message, /ít nhất 6 ký tự/);
});

Deno.test('OPTIONS trả CORS, không gọi ra ngoài', async () => {
  const {calls, handler} = harness({});
  const response = await handler(new Request('https://edge.test/x', {method: 'OPTIONS'}));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal(calls.length, 0);
});

Deno.test('bắt đầu bị từ chối ⇒ không chạm Auth; mã SQL ánh xạ đúng HTTP', async () => {
  const cases: Array<[Response, number, string, RegExp]> = [
    [json(403, {code: '42501', message: 'permission denied for function user_password_reset_begin_v1'}), 403, 'forbidden', /không có quyền/],
    [json(400, {code: '22023', message: 'Đổi mật khẩu của chính bạn ở trang Hồ sơ.'}), 400, 'invalid_request', /trang Hồ sơ/],
    [json(400, {code: '54000', message: 'Đặt lại mật khẩu quá nhiều lần — thử lại sau ít phút.'}), 429, 'rate_limited', /quá nhiều lần/],
    [json(401, {code: 'PGRST301', message: 'JWT expired'}), 401, 'unauthorized', /đăng nhập lại/],
    [json(500, {code: 'XX000', message: 'boom'}), 503, 'service_unavailable', /chưa có gì thay đổi/],
    [new Response('<html>', {status: 502}), 503, 'service_unavailable', /chưa có gì thay đổi/],
    [json(200, {requestId: 'x', via: 'COMPANY_OWNER'}), 503, 'service_unavailable', /chưa có gì thay đổi/],
    [json(200, {requestId: REQUEST_ID, via: 'ROOT', finishToken: FINISH_TOKEN}), 503, 'service_unavailable', /chưa có gì thay đổi/],
    [json(200, {requestId: REQUEST_ID, via: 'COMPANY_OWNER'}), 503, 'service_unavailable', /chưa có gì thay đổi/],
    [json(200, {requestId: REQUEST_ID, via: 'COMPANY_OWNER', finishToken: 'ngan'}), 503, 'service_unavailable', /chưa có gì thay đổi/],
  ];
  for (const [response, status, error, message] of cases) {
    const {calls, handler} = harness({begin: () => response.clone()});
    const r = await read(await handler(post(valid)));
    assert.equal(r.status, status, JSON.stringify(r.body));
    assert.equal(r.body.error, error);
    assert.match(r.body.message, message);
    assert.equal(calls.length, 1, 'chỉ có lời gọi bắt đầu');
  }
  const {calls, handler} = harness({begin: () => { throw new TypeError('network'); }});
  const r = await read(await handler(post(valid)));
  assert.deepEqual([r.status, r.body.error, calls.length], [503, 'service_unavailable', 1]);
});

Deno.test('Auth từ chối hoặc không rõ ⇒ chốt đúng kết quả và mã lỗi, trả HTTP đúng', async () => {
  const cases: Array<[Responder, number, string, string, string]> = [
    [() => json(422, {error_code: 'weak_password', msg: 'Password is too weak'}), 422, 'weak_password', 'FAILED', 'weak_password'],
    [() => json(404, {error_code: 'user_not_found'}), 400, 'invalid_request', 'FAILED', 'user_not_found'],
    [() => json(429, {}), 429, 'rate_limited', 'FAILED', 'auth_rate_limited'],
    [() => json(400, {}), 400, 'invalid_request', 'FAILED', 'auth_rejected'],
    [() => json(401, {}), 503, 'service_unavailable', 'FAILED', 'auth_config'],
    [() => json(500, {}), 502, 'outcome_unknown', 'UNKNOWN', 'auth_unavailable'],
    [() => json(504, {}), 502, 'outcome_unknown', 'UNKNOWN', 'auth_unavailable'],
    [() => { throw new TypeError('connection reset'); }, 502, 'outcome_unknown', 'UNKNOWN', 'auth_unreachable'],
    [() => { throw new DOMException('timed out', 'TimeoutError'); }, 502, 'outcome_unknown', 'UNKNOWN', 'auth_timeout'],
  ];
  for (const [auth, status, error, outcome, code] of cases) {
    const {calls, handler} = harness({auth});
    const r = await read(await handler(post(valid)));
    assert.equal(r.status, status, `${code}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, error);
    assert.equal(calls.length, 3, `${code}: phải chốt`);
    assert.deepEqual(calls[2].body, {p_request_id: REQUEST_ID, p_finish_token: FINISH_TOKEN, p_outcome: outcome, p_error_code: code});
    assert.equal(JSON.stringify(r.body).includes(PASSWORD), false);
  }
});

Deno.test('chốt hỏng sau khi Auth đã đổi ⇒ vẫn báo thành công (mật khẩu đã đổi thật)', async () => {
  for (const finish of [() => json(500, {code: 'XX000'}), () => { throw new TypeError('network'); }] as Responder[]) {
    const {calls, handler} = harness({finish});
    const r = await read(await handler(post(valid)));
    assert.deepEqual(r, {status: 200, body: {ok: true, via: 'COMPANY_OWNER'}});
    assert.equal(calls.length, 3);
  }
});

Deno.test('lỗi bất ngờ: trước khi gọi Auth ⇒ 503 chắc chắn chưa đổi; sau khi gọi Auth ⇒ 502 chưa rõ', async () => {
  // Phản hồi "hỏng" tới mức đọc `ok` cũng ném: lỗi lọt ra khỏi lớp RPC, rơi vào nhánh bắt chung.
  const hong: Responder = () => ({get ok(): boolean { throw new Error('hỏng'); }, json: async () => ({})}) as unknown as Response;
  let r = await read(await harness({begin: hong}).handler(post(valid)));
  assert.deepEqual([r.status, r.body.error], [503, 'service_unavailable']);
  const h = harness({finish: hong});
  r = await read(await h.handler(post(valid)));
  assert.deepEqual([r.status, r.body.error], [502, 'outcome_unknown']);
  assert.equal(h.calls.length, 3);
});

Deno.test('thiếu biến môi trường ⇒ 503, không gọi ra ngoài', async () => {
  for (const missing of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
    const {calls, handler} = harness({}, (name) => (name === missing ? undefined : env(name)));
    const r = await read(await handler(post(valid)));
    assert.deepEqual([r.status, r.body.error, calls.length], [503, 'service_unavailable', 0]);
  }
});

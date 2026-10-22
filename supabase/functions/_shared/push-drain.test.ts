// Test module drain push dùng chung: RPC giả ghi lại thứ tự gọi, fetch giả đóng vai send-push.
// Không mạng, không Supabase thật — chạy: deno test --config supabase/functions/lifecycle-reminders/deno.json …
import assert from 'node:assert/strict';
import { buildPushData } from '../send-push/policy.ts';
import {
  callSendPush,
  classifySendPushResponse,
  configErrorCountsAsFailure,
  EdgeRpcError,
  formatEdgeError,
  parseClaimBatch,
  PRODUCTION_PROJECT_REF,
  runGenericPushDrain,
  type DrainRpc,
  type FetchLike,
} from './push-drain.ts';

const URL_BASE = 'https://test-project.supabase.co';
/** URL dạng project Supabase KHÁC production (như project TEST) ⇒ CONFIG_ERROR được miễn. */
const URL_TEST_PROJECT = 'https://abcdefghijklmnopqrst.supabase.co';
const URL_PRODUCTION = `https://${PRODUCTION_PROJECT_REF}.supabase.co`;
const KEY = 'test-only-service-key';
const ORG = '0e5d1f9a-3c2b-4a1d-9f00-112233445566';
const U1 = '7a7a7a7a-0000-4000-8000-000000000001';
const U2 = '7a7a7a7a-0000-4000-8000-000000000002';
const N1 = '11111111-1111-4111-8111-111111111111';
const N2 = '22222222-2222-4222-8222-222222222222';

type RpcReply = { data?: unknown; error?: unknown };
type Handler = (args?: Record<string, unknown>) => RpcReply;

/** RPC giả: mỗi tên nhận một handler hoặc một dãy handler dùng lần lượt (hết dãy thì lặp phần tử cuối). */
function fakeRpc(handlers: Record<string, Handler | Handler[]>) {
  const calls: { name: string; args?: Record<string, unknown> }[] = [];
  const used: Record<string, number> = {};
  const rpc: DrainRpc = (name, args) => {
    calls.push({ name, args });
    const entry = handlers[name];
    if (!entry) return Promise.resolve({ data: null, error: { message: `RPC ngoài dự kiến: ${name}` } });
    const index = used[name] ?? 0;
    used[name] = index + 1;
    const handler = Array.isArray(entry) ? entry[Math.min(index, entry.length - 1)] : entry;
    const reply = handler(args);
    return Promise.resolve({ data: reply.data ?? null, error: reply.error ?? null });
  };
  return { rpc, calls, names: () => calls.map((c) => c.name) };
}

function fakeFetch(respond: (body: Record<string, unknown>) => Response | Promise<Response>) {
  const requests: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const fetcher: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push({ url, init, body });
    return await respond(body);
  };
  return { fetcher, requests };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const sentReply = (body: Record<string, unknown>) =>
  json({ outcome: 'SENT', sent: 1, failed: 0, retryable: false, idempotencyKey: body.idempotencyKey });

const claimRow = (idem: string, user = U1, extra: Record<string, unknown> = {}) => ({
  notification_ids: [N1, N2], user_id: user, organization_id: ORG, idem_key: idem,
  title: '2 thông báo mới', body: 'Phiếu chờ duyệt', url: '/approvals', tag: `crm-${user}`,
  data: { notificationIds: [N1, N2], organizationId: ORG }, ...extra,
});

// ── Phân loại phản hồi send-push: đọc outcome trong body, không suy từ HTTP status ──────────────

Deno.test('207 PARTIAL vẫn là đã gửi; 422 NO_DEVICE không phải lỗi retry', () => {
  const partial = classifySendPushResponse(207, JSON.stringify({ outcome: 'PARTIAL', sent: 1, failed: 1, retryable: true, idempotencyKey: 'k' }), 'k');
  assert.equal(partial.outcome, 'PARTIAL');
  assert.equal(partial.sent, 1);
  const none = classifySendPushResponse(422, JSON.stringify({ outcome: 'NO_DEVICE', retryable: false, idempotencyKey: 'k' }), 'k');
  assert.equal(none.outcome, 'NO_DEVICE');
  assert.equal(none.retryable, false);
});

Deno.test('SENT mà sent=0 hoặc khoá khác lượt này ⇒ PROVIDER_ERROR retryable, không ghi SENT giả', () => {
  const zero = classifySendPushResponse(200, JSON.stringify({ outcome: 'SENT', sent: 0, idempotencyKey: 'k' }), 'k');
  assert.deepEqual([zero.outcome, zero.retryable, zero.sent], ['PROVIDER_ERROR', true, 0]);
  const other = classifySendPushResponse(200, JSON.stringify({ outcome: 'SENT', sent: 2, idempotencyKey: 'khac' }), 'k');
  assert.equal(other.outcome, 'PROVIDER_ERROR');
});

Deno.test('cổng edge trả HTML 502 / outcome lạ ⇒ PROVIDER_ERROR retryable; retryable khai trong body được tôn trọng', () => {
  const html = classifySendPushResponse(502, '<html>Bad gateway</html>', 'k');
  assert.deepEqual([html.outcome, html.retryable], ['PROVIDER_ERROR', true]);
  const weird = classifySendPushResponse(200, JSON.stringify({ outcome: 'MAYBE' }), 'k');
  assert.deepEqual([weird.outcome, weird.retryable], ['PROVIDER_ERROR', true]);
  const allFailed = classifySendPushResponse(502, JSON.stringify({ outcome: 'ALL_FAILED', retryable: false, error: 'gone' }), 'k');
  assert.deepEqual([allFailed.outcome, allFailed.retryable, allFailed.error], ['ALL_FAILED', false, 'gone']);
});

Deno.test('đường lùi send-push cũ (không có outcome) suy từ sent/failed/total', () => {
  assert.equal(classifySendPushResponse(200, JSON.stringify({ sent: 1, failed: 0, total: 1 }), 'k').outcome, 'SENT');
  assert.equal(classifySendPushResponse(200, JSON.stringify({ sent: 0, failed: 0, total: 0 }), 'k').outcome, 'NO_DEVICE');
  assert.equal(classifySendPushResponse(401, JSON.stringify({ message: 'Invalid JWT' }), 'k').outcome, 'UNAUTHORIZED');
});

Deno.test('callSendPush: mạng đứt ⇒ PROVIDER_ERROR retryable; gửi kèm AbortSignal 8 s và khoá service', async () => {
  const broken: FetchLike = () => Promise.reject(new TypeError('connection reset'));
  const failed = await callSendPush(broken, URL_BASE, KEY, { userId: U1, idempotencyKey: 'k', title: 't', body: 'b', url: '/' });
  assert.deepEqual([failed.outcome, failed.retryable, failed.httpStatus], ['PROVIDER_ERROR', true, null]);

  const { fetcher, requests } = fakeFetch(sentReply);
  const ok = await callSendPush(fetcher, URL_BASE, KEY, { userId: U1, idempotencyKey: 'k', title: 't', body: 'b', url: '/' });
  assert.equal(ok.outcome, 'SENT');
  assert.equal(requests[0].url, `${URL_BASE}/functions/v1/send-push`);
  assert.ok(requests[0].init.signal instanceof AbortSignal);
  assert.equal((requests[0].init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
});

Deno.test('parseClaimBatch: dòng hỏng còn khoá thì giữ khoá để settle; mất khoá thì không settle được', () => {
  const good = parseClaimBatch(claimRow('a'));
  assert.ok(good.ok);
  const badTitle = parseClaimBatch(claimRow('b', U1, { title: 5 }));
  assert.deepEqual(badTitle, { ok: false, idemKey: 'b', reason: 'Dòng claim hỏng: title' });
  const noKey = parseClaimBatch(claimRow('', U1));
  assert.equal(noKey.ok, false);
  assert.equal(noKey.ok === false && noKey.idemKey, null);
});

// ── Vòng drain ─────────────────────────────────────────────────────────────────────────────────

Deno.test('lặp claim → gửi → settle tới khi claim rỗng rồi ghi record_run một lần', async () => {
  const { rpc, calls, names } = fakeRpc({
    notify_claim_push_batch_v2: [() => ({ data: [claimRow('k1', U1), claimRow('k2', U2)] }), () => ({ data: [claimRow('k3')] }), () => ({ data: [] })],
    notify_settle_push_batch_v2: [() => ({ data: 4 }), () => ({ data: 2 })],
    notify_drain_record_run_v1: () => ({ data: null }),
  });
  const { fetcher, requests } = fakeFetch(sentReply);
  const result = await runGenericPushDrain(rpc, fetcher, URL_BASE, KEY);

  assert.deepEqual(names(), [
    'notify_claim_push_batch_v2', 'notify_settle_push_batch_v2',
    'notify_claim_push_batch_v2', 'notify_settle_push_batch_v2',
    'notify_claim_push_batch_v2', 'notify_drain_record_run_v1',
  ]);
  assert.deepEqual(calls[0].args, { p_limit: 100 });
  assert.equal(requests.length, 3);
  assert.deepEqual(
    { ok: result.ok, rounds: result.rounds, batches: result.batches, settled: result.settled, settledRows: result.settledRows, stoppedBy: result.stoppedBy },
    { ok: true, rounds: 2, batches: 3, settled: 3, settledRows: 6, stoppedBy: 'empty' },
  );
  assert.deepEqual(result.outcomes, { SENT: 3 });
  assert.deepEqual(calls.at(-1)?.args, { p_batches: 3, p_settled: 6, p_outcomes: { SENT: 3 }, p_error: null });
  const settleItems = calls[1].args?.p_results as Record<string, unknown>[];
  assert.deepEqual(settleItems[0], { idem_key: 'k1', outcome: 'SENT', retryable: false, error: null, sent: 1 });
});

Deno.test('body gửi send-push mang userId/khoá/notificationIds (= data.notificationIds) và data {notificationIds, organizationId}', async () => {
  const { rpc } = fakeRpc({
    notify_claim_push_batch_v2: [() => ({ data: [claimRow('k1', U1, { data: { notificationIds: [N1] } })] }), () => ({ data: [] })],
    notify_settle_push_batch_v2: () => ({ data: 2 }),
    notify_drain_record_run_v1: () => ({ data: null }),
  });
  const { fetcher, requests } = fakeFetch(sentReply);
  await runGenericPushDrain(rpc, fetcher, URL_BASE, KEY);
  assert.deepEqual(requests[0].body, {
    userId: U1, idempotencyKey: 'k1', notificationIds: [N1], title: '2 thông báo mới', body: 'Phiếu chờ duyệt',
    url: '/approvals', tag: `crm-${U1}`, data: { notificationIds: [N1], organizationId: ORG },
  });
});

Deno.test('EDGE-2: nhóm 25 id ⇒ body gửi send-push và payload cuối mang ĐÚNG 20 id MỚI NHẤT', async () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const all = Array.from({ length: 25 }, (_, i) => id(i + 1)); // claim v2: notification_ids xếp cũ → mới
  const recent = all.slice(5).reverse(); // claim v2: data.notificationIds = 20 id mới nhất
  const { rpc } = fakeRpc({
    notify_claim_push_batch_v2: [
      () => ({ data: [claimRow('k25', U1, { notification_ids: all, title: '25 thông báo mới', data: { notificationIds: recent, organizationId: ORG } })] }),
      () => ({ data: [] }),
    ],
    notify_settle_push_batch_v2: () => ({ data: 25 }),
    notify_drain_record_run_v1: () => ({ data: null }),
  });
  const { fetcher, requests } = fakeFetch(sentReply);
  await runGenericPushDrain(rpc, fetcher, URL_BASE, KEY);
  const sent = requests[0].body;
  assert.deepEqual(sent.notificationIds, recent);
  // send-push dựng payload bằng chính hàm thuần của nó (ưu tiên notificationIds cấp trên — giữ nguyên).
  const data = buildPushData({ data: sent.data, notificationIds: sent.notificationIds, organizationId: undefined });
  const picked = data.notificationIds as string[];
  assert.equal(picked.length, 20);
  assert.deepEqual([...picked].sort(), all.slice(5).sort());
  for (const oldest of all.slice(0, 5)) assert.ok(!picked.includes(oldest), `không được mang id cũ ${oldest}`);
  assert.equal(data.organizationId, ORG);
});

Deno.test('data.notificationIds vắng/rỗng/sai kiểu ⇒ notificationIds cấp trên lùi về notification_ids của claim', async () => {
  for (const data of [{}, { notificationIds: [] }, { notificationIds: [N1, 7] }]) {
    const { rpc } = fakeRpc({
      notify_claim_push_batch_v2: [() => ({ data: [claimRow('k1', U1, { data })] }), () => ({ data: [] })],
      notify_settle_push_batch_v2: () => ({ data: 2 }),
      notify_drain_record_run_v1: () => ({ data: null }),
    });
    const { fetcher, requests } = fakeFetch(sentReply);
    await runGenericPushDrain(rpc, fetcher, URL_BASE, KEY);
    assert.deepEqual(requests[0].body.notificationIds, [N1, N2], JSON.stringify(data));
  }
});

Deno.test('dừng ở trần maxBatches vòng dù claim còn dữ liệu', async () => {
  let n = 0;
  const { rpc, names } = fakeRpc({
    notify_claim_push_batch_v2: () => ({ data: [claimRow(`k${n++}`)] }),
    notify_settle_push_batch_v2: () => ({ data: 2 }),
    notify_drain_record_run_v1: () => ({ data: null }),
  });
  const { fetcher } = fakeFetch(sentReply);
  const result = await runGenericPushDrain(rpc, fetcher, URL_BASE, KEY, { maxBatches: 5 });
  assert.equal(names().filter((x) => x === 'notify_claim_push_batch_v2').length, 5);
  assert.deepEqual([result.rounds, result.stoppedBy, result.ok], [5, 'max_batches', true]);
});

Deno.test('một lô lỗi mạng không chặn settle của lô khác; lỗi tạm ⇒ dừng, không claim vòng sau', async () => {
  const { rpc, calls, names } = fakeRpc({
    notify_claim_push_batch_v2: () => ({ data: [claimRow('k1', U1), claimRow('k2', U2)] }),
    notify_settle_push_batch_v2: () => ({ data: 4 }),
    notify_drain_record_run_v1: () => ({ data: null }),
  });
  const { fetcher } = fakeFetch((body) => {
    if (body.userId === U1) throw new TypeError('socket hang up');
    return sentReply(body);
  });
  const result = await runGenericPushDrain(rpc, fetcher, URL_BASE, KEY);
  assert.deepEqual(names(), ['notify_claim_push_batch_v2', 'notify_settle_push_batch_v2', 'notify_drain_record_run_v1']);
  const items = calls[1].args?.p_results as Record<string, unknown>[];
  assert.deepEqual(items.map((i) => [i.idem_key, i.outcome, i.retryable]), [['k1', 'PROVIDER_ERROR', true], ['k2', 'SENT', false]]);
  assert.equal(result.stoppedBy, 'retryable');
  assert.equal(result.ok, true); // chuỗi RPC trọn vẹn; lỗi giao vận nằm ở failures
  assert.deepEqual(result.failures, ['k1: PROVIDER_ERROR']);
});

Deno.test('DUPLICATE ⇒ settle rồi dừng, không claim lại trong cùng lượt, không phải lỗi', async () => {
  const { rpc, names } = fakeRpc({
    notify_claim_push_batch_v2: () => ({ data: [claimRow('k1')] }),
    notify_settle_push_batch_v2: () => ({ data: 2 }),
    notify_drain_record_run_v1: () => ({ data: null }),
  });
  const { fetcher } = fakeFetch((body) => json({ outcome: 'DUPLICATE', retryable: false, sent: 0, idempotencyKey: body.idempotencyKey }));
  const result = await runGenericPushDrain(rpc, fetcher, URL_BASE, KEY);
  assert.deepEqual(names(), ['notify_claim_push_batch_v2', 'notify_settle_push_batch_v2', 'notify_drain_record_run_v1']);
  assert.deepEqual([result.stoppedBy, result.ok, result.failures.length], ['retryable', true, 0]);
});

const configErrorReply = () =>
  json({ outcome: 'CONFIG_ERROR', retryable: false, sent: 0, idempotencyKey: null, error: 'Thiếu VAPID_PUBLIC_KEY' }, 500);

Deno.test('EDGE-4: CONFIG_ERROR ⇒ settle outcome CONFIG_ERROR (SQL giữ HOLD), dừng vòng; production ⇒ vào failures, TEST ⇒ miễn', async () => {
  for (const [url, failing] of [[URL_PRODUCTION, true], [URL_BASE, true], [URL_TEST_PROJECT, false]] as const) {
    const { rpc, calls, names } = fakeRpc({
      notify_claim_push_batch_v2: () => ({ data: [claimRow('k1')] }),
      notify_settle_push_batch_v2: () => ({ data: 2 }),
      notify_drain_record_run_v1: () => ({ data: null }),
    });
    const result = await runGenericPushDrain(rpc, fakeFetch(configErrorReply).fetcher, url, KEY);
    assert.deepEqual(names(), ['notify_claim_push_batch_v2', 'notify_settle_push_batch_v2', 'notify_drain_record_run_v1'], url);
    const items = calls[1].args?.p_results as Record<string, unknown>[];
    assert.deepEqual(items.map((i) => [i.idem_key, i.outcome]), [['k1', 'CONFIG_ERROR']], url);
    assert.equal(result.stoppedBy, 'config_error', url);
    assert.equal(result.ok, true, url); // chuỗi RPC trọn; báo động đi qua failures ⇒ runner trả 503 + '[drain]'
    assert.equal(result.failures.length, failing ? 1 : 0, url);
    if (failing) assert.match(result.failures[0], /^k1: CONFIG_ERROR Thiếu VAPID/);
  }
  // Bên gọi ép được cờ bất kể URL.
  const forced = fakeRpc({
    notify_claim_push_batch_v2: () => ({ data: [claimRow('k1')] }),
    notify_settle_push_batch_v2: () => ({ data: 2 }),
    notify_drain_record_run_v1: () => ({ data: null }),
  });
  const r = await runGenericPushDrain(forced.rpc, fakeFetch(configErrorReply).fetcher, URL_TEST_PROJECT, KEY, { configErrorIsFailure: true });
  assert.equal(r.failures.length, 1);
});

Deno.test('EDGE-4: gặp CONFIG_ERROR thì không mở lời gọi send-push mới trong vòng; lô còn lại settle DEFERRED', async () => {
  const { rpc, calls } = fakeRpc({
    notify_claim_push_batch_v2: () => ({ data: [claimRow('k1', U1), claimRow('k2', U2), claimRow('k3', U1)] }),
    notify_settle_push_batch_v2: () => ({ data: 6 }),
    notify_drain_record_run_v1: () => ({ data: null }),
  });
  const { fetcher, requests } = fakeFetch(configErrorReply);
  const result = await runGenericPushDrain(rpc, fetcher, URL_PRODUCTION, KEY, { concurrency: 1 });
  assert.equal(requests.length, 1);
  const items = calls[1].args?.p_results as Record<string, unknown>[];
  assert.deepEqual(items.map((i) => [i.idem_key, i.outcome, i.retryable, i.sent]), [
    ['k1', 'CONFIG_ERROR', false, 0], ['k2', 'DEFERRED', true, 0], ['k3', 'DEFERRED', true, 0],
  ]);
  assert.deepEqual(result.outcomes, { CONFIG_ERROR: 1, DEFERRED: 2 });
  assert.deepEqual(result.failures, ['k1: CONFIG_ERROR Thiếu VAPID_PUBLIC_KEY']);
  assert.deepEqual([result.stoppedBy, result.settled, result.batches], ['config_error', 3, 3]);
});

Deno.test('configErrorCountsAsFailure: chỉ miễn URL chứng minh là project Supabase KHÁC production', () => {
  assert.equal(configErrorCountsAsFailure(URL_PRODUCTION), true);
  assert.equal(configErrorCountsAsFailure(`https://${PRODUCTION_PROJECT_REF.toUpperCase()}.supabase.co/`), true);
  assert.equal(configErrorCountsAsFailure(URL_TEST_PROJECT), false);
  assert.equal(configErrorCountsAsFailure('https://test-project.supabase.co'), true);
  assert.equal(configErrorCountsAsFailure('https://api.ptcrm.vn'), true);
  assert.equal(configErrorCountsAsFailure('http://kong:8000'), true);
  assert.equal(configErrorCountsAsFailure('không phải url'), true);
  assert.equal(configErrorCountsAsFailure(''), true);
});

Deno.test('dòng claim hỏng: còn khoá ⇒ settle BAD_REQUEST không gửi; mất khoá ⇒ lượt lỗi nhưng settle vẫn chạy', async () => {
  const { rpc, calls } = fakeRpc({
    notify_claim_push_batch_v2: () => ({ data: [claimRow('k1'), claimRow('k2', U2, { url: null }), { user_id: U1 }] }),
    notify_settle_push_batch_v2: () => ({ data: 3 }),
    notify_drain_record_run_v1: () => ({ data: null }),
  });
  const { fetcher, requests } = fakeFetch(sentReply);
  const result = await runGenericPushDrain(rpc, fetcher, URL_BASE, KEY);
  assert.equal(requests.length, 1);
  const items = calls[1].args?.p_results as Record<string, unknown>[];
  assert.deepEqual(items.map((i) => [i.idem_key, i.outcome]), [['k2', 'BAD_REQUEST'], ['k1', 'SENT']]);
  assert.equal(result.ok, false);
  assert.equal(result.stoppedBy, 'error');
  assert.match(result.error ?? '', /không settle được/);
  const record = calls.at(-1);
  assert.equal(record?.name, 'notify_drain_record_run_v1');
  assert.equal(record?.args?.p_error, result.error);
});

Deno.test('claim lỗi ⇒ không settle, record_run ghi lỗi dạng JSON {code,message,details,hint}', async () => {
  const { rpc, calls, names } = fakeRpc({
    notify_claim_push_batch_v2: () => ({ error: { code: '42501', message: 'permission denied', details: null, hint: 'grant' } }),
    notify_drain_record_run_v1: () => ({ data: null }),
  });
  const { fetcher, requests } = fakeFetch(sentReply);
  const result = await runGenericPushDrain(rpc, fetcher, URL_BASE, KEY);
  assert.deepEqual(names(), ['notify_claim_push_batch_v2', 'notify_drain_record_run_v1']);
  assert.equal(requests.length, 0);
  assert.equal(result.ok, false);
  const parsed = JSON.parse(result.error ?? '{}');
  assert.deepEqual(parsed, { code: '42501', message: 'notify_claim_push_batch_v2: permission denied', details: null, hint: 'grant' });
  assert.equal(calls[1].args?.p_error, result.error);
});

Deno.test('settle lỗi ⇒ dừng, record_run vẫn chạy; record_run lỗi ⇒ ok=false với recordError', async () => {
  const settleFails = fakeRpc({
    notify_claim_push_batch_v2: () => ({ data: [claimRow('k1')] }),
    notify_settle_push_batch_v2: () => ({ error: { code: '22023', message: 'bad results' } }),
    notify_drain_record_run_v1: () => ({ data: null }),
  });
  const first = await runGenericPushDrain(settleFails.rpc, fakeFetch(sentReply).fetcher, URL_BASE, KEY);
  assert.equal(first.ok, false);
  assert.equal(first.settled, 0);
  assert.equal(settleFails.names().at(-1), 'notify_drain_record_run_v1');

  const recordFails = fakeRpc({
    notify_claim_push_batch_v2: () => ({ data: [] }),
    notify_drain_record_run_v1: () => ({ error: { code: 'PGRST202', message: 'function not found' } }),
  });
  const second = await runGenericPushDrain(recordFails.rpc, fakeFetch(sentReply).fetcher, URL_BASE, KEY);
  assert.deepEqual([second.ok, second.error, second.stoppedBy], [false, null, 'empty']);
  assert.match(second.recordError ?? '', /PGRST202/);
});

Deno.test('EDGE-7: hết ngân sách giữa vòng ⇒ ngừng mở lời gọi send-push mới, lô chưa gửi settle DEFERRED (HOLD)', async () => {
  let clock = 1_000;
  const { rpc, calls, names } = fakeRpc({
    notify_claim_push_batch_v2: () => ({ data: [claimRow('k1', U1), claimRow('k2', U2), claimRow('k3', U1), claimRow('k4', U2)] }),
    notify_settle_push_batch_v2: () => ({ data: 8 }),
    notify_drain_record_run_v1: () => ({ data: null }),
  });
  // Mỗi lời gọi send-push tốn 5 s. Ngân sách 20 s tính từ startedAt=0, timeout 8 s ⇒ chỉ mở lời gọi khi now ≤ 12 s.
  const { fetcher, requests } = fakeFetch((body) => { clock += 5_000; return sentReply(body); });
  const result = await runGenericPushDrain(rpc, fetcher, URL_BASE, KEY, {
    startedAt: 0, deadlineMs: 20_000, timeoutMs: 8_000, concurrency: 1, now: () => clock,
  });
  // now=1 s gửi k1 → 6 s gửi k2 → 11 s gửi k3 → 16 s: 16+8 > 20 ⇒ k4 DEFERRED.
  assert.equal(requests.length, 3);
  const items = calls[1].args?.p_results as Record<string, unknown>[];
  assert.deepEqual(items.map((i) => [i.idem_key, i.outcome, i.retryable]), [
    ['k1', 'SENT', false], ['k2', 'SENT', false], ['k3', 'SENT', false], ['k4', 'DEFERRED', true],
  ]);
  assert.match(String(items[3].error), /hết ngân sách/);
  assert.deepEqual(names(), ['notify_claim_push_batch_v2', 'notify_settle_push_batch_v2', 'notify_drain_record_run_v1']);
  assert.deepEqual([result.stoppedBy, result.ok, result.failures.length, result.settled], ['deadline', true, 0, 4]);
  assert.deepEqual(result.outcomes, { SENT: 3, DEFERRED: 1 });
});

Deno.test('EDGE-7: pha trước đã tiêu hết ngân sách (startedAt từ đầu request) ⇒ không claim, record_run vẫn ghi', async () => {
  const { rpc, calls, names } = fakeRpc({
    notify_claim_push_batch_v2: () => ({ data: [claimRow('k1')] }),
    notify_drain_record_run_v1: () => ({ data: null }),
  });
  const { fetcher, requests } = fakeFetch(sentReply);
  const result = await runGenericPushDrain(rpc, fetcher, URL_BASE, KEY, { startedAt: 0, deadlineMs: 110_000, now: () => 103_000 });
  assert.deepEqual(names(), ['notify_drain_record_run_v1']);
  assert.equal(requests.length, 0);
  assert.deepEqual([result.stoppedBy, result.ok, result.rounds], ['deadline', true, 0]);
  assert.deepEqual(calls[0].args, { p_batches: 0, p_settled: 0, p_outcomes: {}, p_error: null });
});

Deno.test('quá ngân sách thời gian thì không mở vòng claim mới', async () => {
  let clock = 0;
  const { rpc, names } = fakeRpc({
    notify_claim_push_batch_v2: () => ({ data: [claimRow(`k${clock}`)] }),
    notify_settle_push_batch_v2: () => { clock += 50_000; return { data: 2 }; },
    notify_drain_record_run_v1: () => ({ data: null }),
  });
  const result = await runGenericPushDrain(rpc, fakeFetch(sentReply).fetcher, URL_BASE, KEY, { deadlineMs: 45_000, now: () => clock });
  assert.equal(names().filter((x) => x === 'notify_claim_push_batch_v2').length, 1);
  assert.equal(result.stoppedBy, 'deadline');
});

Deno.test('formatEdgeError không bao giờ ra [object Object]', () => {
  const postgrest = { code: 'P0001', message: 'boom', details: 'chi tiết', hint: null };
  assert.equal(formatEdgeError(postgrest), JSON.stringify({ code: 'P0001', message: 'boom', details: 'chi tiết', hint: null }));
  assert.equal(JSON.parse(formatEdgeError(new Error('x'))).message, 'x');
  assert.equal(JSON.parse(formatEdgeError('chuỗi')).message, 'chuỗi');
  const wrapped = new EdgeRpcError('v5_run_digest', postgrest);
  assert.deepEqual(JSON.parse(formatEdgeError(wrapped)), { code: 'P0001', message: 'v5_run_digest: boom', details: 'chi tiết', hint: null });
  assert.ok(!formatEdgeError({}).includes('[object Object]'));
});

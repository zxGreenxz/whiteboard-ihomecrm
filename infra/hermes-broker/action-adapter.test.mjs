import test from 'node:test';
import assert from 'node:assert/strict';
// external-group-mount nạp broker.mjs ngược lại: nạp trước.
import './external-group-mount.mjs';
import { actionRequest, createActionAuth, createActionReads } from './action-adapter.mjs';
import { createActionCatalog } from './action-catalog.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
import { PROBE_KEY, probeCatalog } from './action-probe-contract.mjs';

// Adapter SQL của thao tác ghi dùng chung (Mốc 6): đúng tên RPC + đối số, ghi/không ghi theo phase, thiếu hàm (PGRST202) ⇒
// không cấp khoá nào (họ thao tác ẩn), chỉ khoá danh mục biết mới được gộp, khuôn capabilities sai ⇒ context_changed.
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const JWT = `${b64({ alg: 'none' })}.${b64({ role: 'authenticated', sub: id(1), session_id: id(2) })}.sig`;
const BINDING = { connectionId: id(3), tokenDigest: 'a'.repeat(64), expectedEpoch: 1, expectedPolicyVersion: 0, expectedMembershipId: id(4),
  expectedAuthorizationVersion: 1, expectedSessionRevision: 1 };
const ORG = id(5), USER = id(1), B1 = id(10);
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function reads(t, catalog, reply) {
  const scope = createDependencyScope(); t.after(() => scope.close());
  const calls = [];
  const fetch = async (url, init) => { calls.push([new URL(url).pathname.replace('/rest/v1/rpc/', ''), JSON.parse(init.body)]); return reply(calls.at(-1)); };
  return { calls, reads: createActionReads({ catalog, url: 'https://crm.example.test/', publishableKey: 'sb_publishable_test', fetch, dependencyScope: scope }) };
}
const hooks = () => { const seen = []; return { seen, signal: new AbortController().signal, onDispatch() { seen.push('dispatch'); }, onRejected() { seen.push('rejected'); } }; };

test('actionRequest: only run/status shapes the runtime sends; apply carries resolved + basis', () => {
  const catalog = probeCatalog();
  const run = { op: 'run', action: 'probe.note', phase: 'auto', requestId: id(7), params: { note: 'x' } };
  assert.equal(actionRequest(catalog, 'run', run), run);
  assert.ok(actionRequest(catalog, 'run', { ...run, phase: 'apply', resolved: {}, basis: 'b' }));
  assert.ok(actionRequest(catalog, 'status', { op: 'status', requestId: id(7) }));
  for (const [op, bad] of [['run', { ...run, action: 'probe.nope' }], ['run', { ...run, phase: 'later' }], ['run', { ...run, phase: 'apply' }],
    ['run', { ...run, extra: 1 }], ['run', { ...run, requestId: 'x' }], ['status', { op: 'run', requestId: id(7) }], ['status', { op: 'status' }], ['run', null]])
    assert.throws(() => actionRequest(catalog, op, bad), /invalid_action_request/, JSON.stringify(bad));
});

test('reads.execute: page RPC from the catalog with the fixed argument set; preview reads, auto/apply are writes; status RPC', async t => {
  const { calls, reads: r } = reads(t, probeCatalog(), () => json(200, { kind: 'applied', result: {}, link: null }));
  const preview = hooks();
  await r.execute('run', { accessToken: JWT, binding: BINDING, input: { op: 'run', action: 'probe.confirm', phase: 'preview', requestId: id(7), params: { amount: 1 } } }, preview);
  assert.deepEqual(calls.at(-1), ['hermes_action_probe_v1', { p_binding: BINDING, p_action: 'probe.confirm', p_phase: 'preview', p_request_id: id(7),
    p_params: { amount: 1 }, p_resolved: null, p_expected_basis: null }]);
  assert.deepEqual(preview.seen, [], 'xem trước không phải lệnh ghi');
  const apply = hooks();
  await r.execute('run', { accessToken: JWT, binding: BINDING, input: { op: 'run', action: 'probe.confirm', phase: 'apply', requestId: id(7), params: { amount: 1 },
    resolved: { buildingId: B1 }, basis: 'b1' } }, apply);
  assert.deepEqual(calls.at(-1)[1].p_resolved, { buildingId: B1 }); assert.equal(calls.at(-1)[1].p_expected_basis, 'b1');
  assert.deepEqual(apply.seen, ['dispatch']);
  await r.execute('status', { accessToken: JWT, binding: BINDING, input: { op: 'status', requestId: id(7) } }, hooks());
  assert.deepEqual(calls.at(-1), ['hermes_action_status_v1', { p_binding: BINDING, p_request_id: id(7) }]);
  await assert.rejects(r.execute('run', { accessToken: JWT, binding: { ...BINDING, tokenDigest: 'x' }, input: {} }, hooks()), error => error.code === 'invalid_request');
  // Only declared names reach the transport: a catalog without probe never calls the probe RPC.
  const empty = reads(t, createActionCatalog([], { keys: [] }), () => json(200, {})).reads;
  await assert.rejects(empty.execute('run', { accessToken: JWT, binding: BINDING, input: { op: 'run', action: 'probe.note', phase: 'auto', requestId: id(7), params: {} } }, hooks()),
    error => error.code === 'invalid_request');
});

test('review #253 mục 4 + 6: lỗi SQL của RPC trang ⇒ kết cục đã biết (onRejected), đúng mã đóng; không bao giờ "chưa rõ" hay "CRM tạm lỗi"', async t => {
  const pgError = code => ({ code, message: 'm', details: null, hint: null });
  const write = { op: 'run', action: 'probe.note', phase: 'auto', requestId: id(7), params: { note: 'x' } };
  for (const [status, code, expect] of [[500, '40001', ['action_rejected', 'state_changed']], [500, '40P01', ['action_rejected', 'state_changed']],
    [500, '55P03', ['action_rejected', 'state_changed']],
    // Thu chi lượt 14: statement_timeout huỷ câu lệnh trước khi commit ⇒ đã lùi (nghiệm thu 24/10: trước đây action_outcome_unknown).
    [500, '57014', ['action_rejected', 'state_changed']], [404, 'PGRST202', ['action_rejected', 'action_disabled']],
    [403, '42501', ['forbidden']], [409, 'PT409', ['context_changed']]]) {
    const { reads: r } = reads(t, probeCatalog(), () => json(status, pgError(code)));
    const seen = hooks();
    await assert.rejects(r.execute('run', { accessToken: JWT, binding: BINDING, input: write }, seen),
      error => error.code === expect[0] && (expect[1] === undefined || error.reason === expect[1]), code);
    assert.deepEqual(seen.seen, ['dispatch', 'rejected'], `${code}: kết cục đã biết, không bất định`);
  }
  // Lỗi khác (500 không mã đã biết) vẫn là lỗi chung, và lệnh ghi đã gửi thì giữ bất định.
  const { reads: other } = reads(t, probeCatalog(), () => json(500, pgError('XX000')));
  const unknown = hooks();
  await assert.rejects(other.execute('run', { accessToken: JWT, binding: BINDING, input: write }, unknown), error => error.code === 'backend_unavailable');
  assert.deepEqual(unknown.seen, ['dispatch']);
  // Lượt xem trước (không ghi) với lỗi tạm: vẫn state_changed, không có hook ghi.
  const { reads: previewReads } = reads(t, probeCatalog(), () => json(500, pgError('40001')));
  const preview = hooks();
  await assert.rejects(previewReads.execute('run', { accessToken: JWT, binding: BINDING, input: { ...write, action: 'probe.confirm', phase: 'preview', params: { amount: 1 } } }, preview),
    error => error.code === 'action_rejected' && error.reason === 'state_changed');
  assert.deepEqual(preview.seen, []);
});

test('auth: function not deployed (PGRST202) ⇒ no action keys; catalog keys only; malformed capabilities ⇒ context_changed; empty catalog makes no call', async t => {
  const membership = { membershipId: id(4), authorizationVersion: 1 };
  const base = { verifySession: async () => ({}), readAuthorization: async () => ({ userId: USER, isSuperadmin: false, membership, epoch: 'e',
    permissions: { read: [], action: [] }, companyCeilings: { read: [], action: [] }, scopesByPermission: {} }) };
  const input = { accessToken: JWT, userId: USER, organizationId: ORG, signal: new AbortController().signal };
  let reply;
  const { calls, reads: r } = reads(t, probeCatalog(), () => reply());
  const auth = createActionAuth({ baseAuth: base, reads: r, catalog: probeCatalog() });
  reply = () => json(404, { code: 'PGRST202', message: 'not found', details: null, hint: null });
  assert.deepEqual((await auth.readAuthorization(input)).permissions.action, []);
  const caps = extra => ({ organizationId: ORG, userId: USER, membershipId: id(4), authorizationVersion: 1, isSuperadmin: false, policyVersion: 0,
    permissions: { [PROBE_KEY]: { allowed: true, companyEnabled: true, buildingIds: [B1] }, 'contracts.renew': { allowed: true, companyEnabled: true, buildingIds: [B1] } },
    actions: {}, ...extra });
  reply = () => json(200, caps());
  const granted = await auth.readAuthorization(input);
  assert.deepEqual(granted.permissions.action, [PROBE_KEY], 'khoá SQL khai mà danh mục connector không biết thì không cấp');
  assert.deepEqual(granted.scopesByPermission[PROBE_KEY], { buildingIds: [B1], cashbookIds: [] });
  for (const bad of [caps({ userId: id(9) }), caps({ actions: undefined }), caps({ permissions: { [PROBE_KEY]: { allowed: true, companyEnabled: false, buildingIds: [] } } }),
    caps({ permissions: { [PROBE_KEY]: { allowed: false, companyEnabled: true, buildingIds: [B1] } } })]) {
    reply = () => json(200, bad);
    await assert.rejects(auth.readAuthorization(input), error => error.code === 'context_changed', JSON.stringify(bad));
  }
  const before = calls.length;
  const none = createActionAuth({ baseAuth: base, reads: r, catalog: createActionCatalog([], { keys: [] }) });
  assert.deepEqual((await none.readAuthorization(input)).permissions.action, []);
  assert.equal(calls.length, before, 'danh mục rỗng (production Đợt 1) không gọi RPC nào');
});

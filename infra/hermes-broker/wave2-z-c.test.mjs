import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sharedW2c, NOTE } from './wave2-c-sql-fixture.mjs';
import { USER, ORG, FOREIGN } from './wave2-sql-fixture.mjs';
import { changedFunctions } from './full-read-sql-fixture.mjs';
import { W2 } from './wave2-registry.mjs';

// Gói Z — bản sửa tích hợp của Gói C (20261018080200_hermes_w2z_notifications_org_v1) trên harness Gói C + dải Z. MỘT
// PGlite cho cả file, mỗi ca BEGIN … ROLLBACK. Theo web main #209 (useNotifications.ts inboxScope): đã chọn công ty thì chỉ
// thông báo của đúng công ty đó. Đi qua cổng thật public.hermes_w2_read_v1 + rào broker. Dữ liệu tổng hợp.
const Z = readFileSync('supabase/migrations/20261018080200_hermes_w2z_notifications_org_v1.sql', 'utf8');
let shared;
before(async () => { shared = await sharedW2c({ packages: ['c', 'z'] }); });
after(async () => { await shared?.close(); });
const inCase = work => shared.isolated(work);
const full = (reportId, values = {}) => ({ ...Object.fromEntries(W2.reports[reportId].params.map(name => [name, null])), ...values });
async function run(env, values = {}) {
  const params = full('notifications', values);
  const value = await env.report('notifications', params, { limit: 50, offset: 0 });
  const identity = { effective: { read: ['notifications.view'] }, scopesByPermission: { 'notifications.view': { buildingIds: [] } } };
  return W2.reads.report.result(value, identity, W2.reads.report.input({ report: 'notifications', params, limit: 50, offset: 0 }));
}
const ids = value => value.items.map(row => row.id);
// Bộ lọc web sau #209 (đã chọn công ty ORG): user_id + IN_APP + organization_id = công ty, mới trước, trần 200.
const web = env => env.call(`SELECT COALESCE(jsonb_agg(x.id),'[]') result FROM (SELECT id FROM public.notifications WHERE user_id=$1 AND channel='IN_APP'
  AND organization_id=$2 ORDER BY created_at DESC LIMIT 200) x`, [USER, ORG]);
const OLD = `AND (n.organization_id=p_organization_id OR n.organization_id IS NULL AND COALESCE(n.metadata->>'event','')<>'LIFECYCLE')`;
const FIX = 'AND n.organization_id=p_organization_id';

test('Z-C thông báo: đúng công ty kết nối như web #209 (không còn dòng chưa gắn công ty); người dùng thuộc hai công ty vẫn chỉ công ty kết nối', () => inCase(async env => {
  await env.grant(['notifications.view']);
  let page = await run(env);
  assert.deepEqual(ids(page), [NOTE.unread, NOTE.read, NOTE.lifecycle]);
  assert.deepEqual(page.summary, { total: 3, unread: 1 });
  assert.deepEqual(ids(page), await web(env), 'cùng tập/thứ tự với web');
  assert.deepEqual(ids(await run(env, { unreadOnly: true })), [NOTE.unread]);
  await env.db.exec(`CREATE OR REPLACE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql AS $$
    SELECT CASE WHEN auth.uid()='${USER}'::uuid THEN ARRAY['${ORG}'::uuid,'${FOREIGN}'::uuid] ELSE '{}'::uuid[] END$$`);
  page = await run(env);
  assert.ok(!ids(page).includes(NOTE.otherOrg) && !ids(page).includes(NOTE.legacy) && !ids(page).includes(NOTE.lifecycleFree));
  assert.deepEqual(ids(page), await web(env));
}));

test('mutation is caught: Z-C điều kiện công ty của bản gói C (dòng chưa gắn công ty lọt)', () => inCase(async env => {
  await env.grant(['notifications.view']);
  assert.equal(ids(await run(env)).includes(NOTE.legacy), false);
  assert.equal(Z.split(FIX).length, 2);
  for (const statement of changedFunctions(Z, Z.replace(FIX, () => OLD))) await env.db.exec(statement);
  assert.equal(ids(await run(env)).includes(NOTE.legacy), true);
}));

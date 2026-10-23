import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { setupFollow, ASSIGNEE, ORG, BUILDING, u } from './task-follow-fixture.mjs';
import { taskFollowResult } from './task-follow-contract.mjs';

// Lượt 11 — sửa theo nghiệm thu (23–24/10): đường đọc "việc giao cho tôi / tôi giao / nhóm" (public.hermes_task_follow_read_v1,
// 20261023185118) trả tổng + summary của cả tập lọc và tên toà / phòng của từng dòng; connector (task-follow-contract.mjs) nhận
// cả khuôn cũ lẫn mới, kiểm chặt khi có. Nền fixture theo dõi việc (thân SQL thật) + 20261022031600 (vế người nhận) + file mới.
const migration = slug => { const found = readdirSync('supabase/migrations').filter(name => new RegExp(`^\\d{14}_${slug}\\.sql$`).test(name));
  assert.equal(found.length, 1, slug); return readFileSync(`supabase/migrations/${found[0]}`, 'utf8').replaceAll('\r\n', '\n'); };
const VISIBLE = migration('jobs_assignee_visible_v1');
export const TOTAL_SQL = migration('hermes_task_follow_read_total_v1');
const ROOM_101 = u(951);
const input = (over = {}) => ({ organizationId: ORG, role: 'assigned_to_me', assigneeUserId: null, status: 'all', limit: 20, offset: 0, ...over });
const identity = { row: { userId: ASSIGNEE, organizationId: ORG }, scopesByPermission: { 'tasks.view': { buildingIds: [BUILDING] } } };

async function setup(t, { total = TOTAL_SQL } = {}) {
  const f = await setupFollow(t);
  const { db } = f;
  await db.exec(`ALTER TABLE public.buildings ADD COLUMN IF NOT EXISTS name text; ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS name text;
    UPDATE public.buildings SET name='Toà A' WHERE id='${BUILDING}';
    INSERT INTO public.rooms(id,organization_id,building_id,name) VALUES('${ROOM_101}','${ORG}','${BUILDING}','101');`);
  await db.exec(VISIBLE); await db.exec(VISIBLE);
  if (total) { await db.exec(total); await db.exec(total); }
  // 25 việc giao cho ASSIGNEE: 18 đang mở (5 quá hạn), 7 đã xong; 10 việc có phòng 101.
  for (let i = 0; i < 25; i += 1) {
    const id = await f.job({ title: `Việc số ${i + 1}`, deadline: i < 5 ? '2026-01-01T00:00:00Z' : new Date(Date.now() + (i + 1) * 86400000).toISOString(),
      status: i >= 18 ? 'COMPLETED' : 'IN_PROGRESS' });
    if (i % 2 === 0 && i < 20) await db.query('UPDATE public.jobs SET room_id=$1 WHERE id=$2', [ROOM_101, id]);
  }
  return f;
}

test('assigned_to_me: a 20-row page carries the total and summary of the whole filtered set, plus building / room names; page 2 completes it', { timeout: 300000 }, async t => {
  const f = await setup(t);
  const first = await f.read(input(), 'assignee');
  assert.equal(first.items.length, 20);
  assert.equal(first.nextOffset, 20);
  assert.equal(first.total, 25, 'tổng cả tập, không phải 20 dòng của trang');
  assert.deepEqual(first.summary, { total: 25, open: 18, overdue: 5, completed: 7,
    byBuilding: [{ buildingId: BUILDING, buildingName: 'Toà A', count: 25, overdue: 5 }] });
  assert.ok(first.items.every(item => item.buildingName === 'Toà A'));
  assert.equal(first.items.filter(item => item.roomName === '101').length, first.items.filter(item => item.roomId === ROOM_101).length);
  assert.ok(first.items.some(item => item.roomName === null && item.roomId === null), 'việc cả toà: roomName null');
  assert.doesNotThrow(() => taskFollowResult('list', first, identity, input()), 'connector nhận khuôn mới');
  const second = await f.read(input({ offset: 20 }), 'assignee');
  assert.deepEqual([second.items.length, second.nextOffset, second.total], [5, null, 25]);
  assert.doesNotThrow(() => taskFollowResult('list', second, identity, input({ offset: 20 })));
  const open = await f.read(input({ status: 'open' }), 'assignee');
  assert.deepEqual([open.total, open.summary.open, open.summary.completed, open.summary.overdue], [18, 18, 0, 5]);
  assert.doesNotThrow(() => taskFollowResult('list', open, identity, input({ status: 'open' })));
  const beyond = await f.read(input({ offset: 200 }), 'assignee');
  assert.deepEqual([beyond.items.length, beyond.total], [0, 25], 'trang rỗng vẫn có tổng');
  assert.doesNotThrow(() => taskFollowResult('list', beyond, identity, input({ offset: 200 })));
});

test('connector: old shape still accepted (release window); inconsistent totals, half the new keys or names without totals are refused', { timeout: 300000 }, async t => {
  const f = await setup(t);
  const value = await f.read(input(), 'assignee');
  const oldShape = structuredClone(value);
  delete oldShape.total; delete oldShape.summary;
  for (const item of oldShape.items) { delete item.buildingName; delete item.roomName; }
  assert.doesNotThrow(() => taskFollowResult('list', oldShape, identity, input()), 'SQL cũ (chưa áp file mới) vẫn qua');
  const bad = [
    ['total thiếu', v => { v.total = 19; }],
    ['summary.total lệch', v => { v.summary.total = 24; }],
    ['open + completed ≠ total', v => { v.summary.open = 17; }],
    ['quá hạn > đang mở', v => { v.summary.overdue = 19; }],
    ['nhóm toà cộng lệch', v => { v.summary.byBuilding[0].count = 24; }],
    ['chỉ có total', v => { delete v.summary; }],
    ['tên toà trên dòng mà không có tổng', v => { delete v.total; delete v.summary; }],
    ['dòng thiếu tên khi có tổng', v => { delete v.items[0].roomName; delete v.items[0].buildingName; }],
    ['tên phòng mà không có phòng', v => { const item = v.items.find(x => x.roomId === null); item.roomName = '999'; }],
  ];
  for (const [label, change] of bad) {
    const copy = structuredClone(value); change(copy);
    assert.throws(() => taskFollowResult('list', copy, identity, input()), /invalid_task_follow/, label);
  }
});

test('mutation: the summary is computed over the whole filtered set, not the page', { timeout: 300000 }, async t => {
  const mutant = TOTAL_SQL.replace('      FROM base b)\n    INTO v_rows,v_summary;', '      FROM (SELECT * FROM base LIMIT 20) b)\n    INTO v_rows,v_summary;');
  assert.notEqual(mutant, TOTAL_SQL, 'anchor');
  const probe = async f => (await f.read(input(), 'assignee')).total === 25;
  assert.equal(await probe(await setup(t)), true, 'bản sửa đúng');
  // Đột biến chạy câu lệnh hàm đã sửa trên nền đã nạp file thật (khối $requires$ ghim md5 thân nên không nạp nguyên file đột biến được).
  const f = await setup(t);
  const fn = mutant.slice(mutant.indexOf('CREATE OR REPLACE FUNCTION public.hermes_task_follow_read_v1('), mutant.indexOf('END $fn$;') + 'END $fn$;'.length);
  await f.db.exec(fn);
  assert.equal(await probe(f), false, 'đột biến lọt ⇒ test không rỗng');
});

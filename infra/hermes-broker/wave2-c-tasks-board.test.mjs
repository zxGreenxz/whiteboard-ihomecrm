import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sharedW2c, STAFF2, OUTSIDER } from './wave2-c-sql-fixture.mjs';
import { BUILDING, OTHER_BUILDING, ROOM, USER, ORG } from './wave2-sql-fixture.mjs';
import { W2 } from './wave2-registry.mjs';

// Công việc Mốc 4 (CONG-VIEC-THAO-TAC-GHI.md mục 4, 21): báo cáo W2 tasks_board trên PGlite — cổng đợt 2 thật + hàm đọc gói C bản
// production (20261019040948) + nhánh tasks_board (20261022180402) + hàm dùng chung public.jobs_board_v1 (20261022180400), dưới RLS jobs thật
// của baseline (cổng tổng hợp cùng chữ ký của fixture gói C). Phạm vi rls_buildings: toà công ty ∩ phạm vi kết nối, RLS quyết từng việc —
// kể cả việc giao cho chính người hỏi ở toà RLS khác không cho xem (Q35, policy jobs_select_own_assignee của 20261022031600 dựng trong ca).
// Tóm tắt trên CẢ tập khớp; rào broker (fence) nhận đúng các hàng. Dữ liệu tổng hợp, mỗi ca BEGIN … ROLLBACK.
const SHARED_SQL = readFileSync('supabase/migrations/20261022180400_hermes_w2c_jobs_board_shared_v1.sql', 'utf8').replaceAll('\r\n', '\n');
const u = n => `0d0d0d0d-0000-4000-8000-${String(n).padStart(12, '0')}`;
const J = { overdue: u(1), doneWeek: u(2), doneOld: u(3), otherBuilding: u(4), noBuilding: u(5), mineOutside: u(6) };
const TYPE = u(9);
const VN = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(d);
const today = VN(new Date());
const monday = (() => { const day = new Date(`${today}T00:00:00Z`); day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7)); return day.toISOString().slice(0, 10); })();
let shared;
before(async () => { shared = await sharedW2c(); });
after(async () => { await shared?.close(); });
const inCase = work => shared.isolated(work);
const full = values => ({ ...Object.fromEntries(W2.reports.tasks_board.params.map(name => [name, null])), ...values });
const identity = buildings => ({ effective: { read: ['tasks.view'] }, scopesByPermission: { 'tasks.view': { buildingIds: buildings } } });
async function board(env, values = {}, buildings = [BUILDING, OTHER_BUILDING], extra = {}) {
  const params = full(values), limit = extra.limit ?? 50, offset = extra.offset ?? 0;
  const value = await env.report('tasks_board', params, { limit, offset });
  const input = W2.reads.report.input({ report: 'tasks_board', params, limit, offset });
  assert.deepEqual(W2.reads.report.result(value, identity(buildings), input).items, value.items, 'rào broker nhận đúng các hàng');
  return value;
}
const codes = value => value.items.map(row => row.code).sort();
async function seed(env) {
  const { db } = env;
  await env.grant(['tasks.view']);
  await db.exec(`INSERT INTO public.job_types VALUES('${TYPE}','${ORG}','sửa',true);
    UPDATE public.jobs SET status='IN_PROGRESS',deadline=NULL;
    INSERT INTO public.jobs(id,user_id,organization_id,code,title,building_id,room_id,job_type_id,assignee_id,status,deadline,completion_time,completion_description,created_at) VALUES
      ('${J.overdue}','${USER}','${ORG}','CV-QH','Thay bóng đèn','${BUILDING}','${ROOM}','${TYPE}','${STAFF2}','IN_PROGRESS',now()-interval '3 days 2 hours',NULL,'đã mua bóng',now()-interval '10 days'),
      ('${J.doneWeek}','${STAFF2}','${ORG}','CV-XONG','Sửa vòi tầng 2','${BUILDING}',NULL,'${TYPE}','${STAFF2}','COMPLETED',now()+interval '1 day',now()-interval '1 minute',NULL,now()-interval '2 days'),
      ('${J.doneOld}','${USER}','${ORG}','CV-CU','Sửa cửa kho','${BUILDING}',NULL,NULL,'${USER}','COMPLETED',now()-interval '50 days',now()-interval '40 days',NULL,now()-interval '60 days'),
      ('${J.otherBuilding}','${USER}','${ORG}','CV-B2','Kiểm điện toà B','${OTHER_BUILDING}',NULL,NULL,'${STAFF2}','IN_PROGRESS',now()+interval '2 days',NULL,NULL,now()),
      ('${J.noBuilding}','${USER}','${ORG}','CV-CHUNG','Việc chung công ty',NULL,NULL,NULL,NULL,'IN_PROGRESS',NULL,NULL,NULL,now());`);
}

test('tasks_board: rows like /tasks under RLS within the connection scope; summary over the whole set; filters (status, day axis, name, staff)', () => inCase(async env => {
  await seed(env);
  // Phạm vi kết nối mặc định của fixture: toà A ⇒ không có việc toà B, không có việc không gắn toà.
  const page = await board(env, {}, [BUILDING]);
  assert.deepEqual(codes(page), ['CV-A', 'CV-CU', 'CV-QH', 'CV-XONG'].sort());
  const late = page.items.find(row => row.id === J.overdue);
  assert.deepEqual([late.assigneeName, late.assignerName, late.jobType, late.status, late.overdueDays, late.progress, late.link, late.roomName],
    ['Quản lý Hai', 'Quản lý Một', 'sửa', 'IN_PROGRESS', 3, 'đã mua bóng', `/tasks?job=${J.overdue}`, 'P101']);
  assert.match(late.deadline, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(page.items[0].id, J.overdue, 'đang làm + quá hạn đứng đầu');
  assert.deepEqual(page.summary, { total: 4, overdue: 1,
    byAssignee: [{ assigneeName: 'Quản lý Hai', count: 2, overdue: 1 }, { assigneeName: 'Quản lý Một', count: 1, overdue: 0 }, { assigneeName: null, count: 1, overdue: 0 }],
    byBuilding: [{ buildingId: BUILDING, buildingName: page.items[0].buildingName, count: 4, overdue: 1 }] });
  // CV-R09: việc xong từ thứ Hai tuần này (giờ công ty), ai làm nhiều nhất.
  const week = await board(env, { status: 'COMPLETED', kind: 'completed', fromDate: monday, toDate: today }, [BUILDING]);
  assert.deepEqual([codes(week), week.summary.total, week.summary.byAssignee], [['CV-XONG'], 1, [{ assigneeName: 'Quản lý Hai', count: 1, overdue: 0 }]]);
  assert.equal(week.items[0].completedOn, today);
  assert.deepEqual(codes(await board(env, { status: 'COMPLETED' }, [BUILDING])), ['CV-CU', 'CV-XONG'], 'COMPLETED không ngày ⇒ mọi việc xong');
  assert.deepEqual(codes(await board(env, { status: 'OVERDUE' }, [BUILDING])), ['CV-QH']);
  assert.deepEqual(codes(await board(env, { status: 'IN_PROGRESS' }, [BUILDING])), ['CV-A', 'CV-QH']);
  assert.deepEqual(codes(await board(env, { query: 'quan ly hai' }, [BUILDING])), ['CV-QH', 'CV-XONG'], 'tên người nhận bỏ dấu');
  assert.deepEqual(codes(await board(env, { query: 'thay bong' }, [BUILDING])), ['CV-QH'], 'tiêu đề bỏ dấu');
  assert.deepEqual(codes(await board(env, { staffId: STAFF2 }, [BUILDING])), ['CV-QH', 'CV-XONG']);
  assert.deepEqual(codes(await board(env, { kind: 'created', fromDate: monday, toDate: today }, [BUILDING])).includes('CV-CU'), false, 'trục ngày tạo');
  assert.deepEqual(codes(await board(env, { roomId: ROOM }, [BUILDING])), ['CV-QH']);
}));

test('tasks_board: Toàn tổ chức ⇒ every building of the company and tasks without a building; byBuilding names the null group last', () => inCase(async env => {
  await seed(env);
  await env.orgWide('tasks.view');
  const page = await board(env);
  // Việc mẫu của fixture: CV-A (toà A), CV-B (toà B).
  assert.deepEqual(codes(page), ['CV-A', 'CV-B', 'CV-B2', 'CV-CHUNG', 'CV-CU', 'CV-QH', 'CV-XONG'].sort());
  assert.equal(page.summary.total, 7);
  assert.deepEqual(page.summary.byBuilding.map(entry => [entry.buildingId, entry.count]), [[BUILDING, 4], [OTHER_BUILDING, 2], [null, 1]]);
}));

test('tasks_board: Q35 — a task assigned to the asker in a building RLS otherwise hides is visible, nobody else\'s task there', () => inCase(async env => {
  await seed(env);
  await env.orgWide('tasks.view');
  const { db } = env;
  await db.exec(`DELETE FROM public.fixture_building_access WHERE building_id='${OTHER_BUILDING}';
    INSERT INTO public.jobs(id,user_id,organization_id,code,title,building_id,assignee_id,status,created_at) VALUES
      ('${J.mineOutside}','${STAFF2}','${ORG}','CV-CUA-TOI','Việc giao cho tôi ở toà B','${OTHER_BUILDING}','${USER}','IN_PROGRESS',now())`);
  assert.equal(codes(await board(env)).includes('CV-CUA-TOI'), false, 'chưa có vế người nhận: RLS giấu');
  await db.exec('CREATE POLICY jobs_select_own_assignee ON public.jobs FOR SELECT TO authenticated USING (assignee_id=(SELECT auth.uid()))');
  const page = await board(env);
  assert.deepEqual([codes(page).includes('CV-CUA-TOI'), codes(page).includes('CV-B2')], [true, false], 'như /tasks: việc của mình hiện, việc người khác ở toà đó không');
}));

test('tasks_board: mutants of the shared function are caught (connection scope, name match, overdue axis)', () => inCase(async env => {
  await seed(env);
  const { db } = env;
  const live = SHARED_SQL.slice(SHARED_SQL.indexOf('CREATE OR REPLACE FUNCTION public.jobs_board_v1('), SHARED_SQL.indexOf('END $fn$;') + 'END $fn$;'.length);
  const mutate = (from, to) => { assert.equal(live.split(from).length, 2, `anchor: ${from}`); return live.replace(from, () => to); };
  const probes = [
    ['phạm vi kết nối bị bỏ', mutate('    AND (j.building_id=ANY(p_building_ids) OR (j.building_id IS NULL AND COALESCE(p_org_wide,false)))\n', ''),
      async () => { await assert.rejects(board(env, {}, [BUILDING]), 'hàng ngoài toà của rào ⇒ broker từ chối'); }],
    ['tên người nhận không còn khớp', mutate("||' '||COALESCE(NULLIF(pa.full_name,''),j.assignee_name,'')", ''),
      async () => { assert.deepEqual(codes(await board(env, { query: 'quan ly hai' }, [BUILDING])), []); }],
    ['quá hạn tính cả việc đã xong', mutate("(p_status='OVERDUE' AND j.status='IN_PROGRESS' AND j.deadline<v_now)", "(p_status='OVERDUE' AND j.deadline<v_now)"),
      async () => { assert.deepEqual(codes(await board(env, { status: 'OVERDUE' }, [BUILDING])), ['CV-CU', 'CV-QH']); }],
  ];
  for (const [label, sql, run] of probes) {
    await db.exec(sql);
    await run();
    await db.exec(live);
    assert.deepEqual(codes(await board(env, { status: 'OVERDUE' }, [BUILDING])), ['CV-QH'], `${label}: bản sống khôi phục`);
  }
  void OUTSIDER;
}));

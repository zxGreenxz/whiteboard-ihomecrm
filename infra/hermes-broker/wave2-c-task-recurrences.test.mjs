import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { sharedW2c, STAFF2 } from './wave2-c-sql-fixture.mjs';
import { BUILDING, OTHER_BUILDING, ROOM, USER, ORG } from './wave2-sql-fixture.mjs';
import { W2 } from './wave2-registry.mjs';

// Công việc Mốc 5 (CONG-VIEC-THAO-TAC-GHI.md mục 4, 22): báo cáo W2 task_recurrences trên PGlite — cổng đợt 2 thật + hàm đọc gói C
// (20261023042450, dựng từ 180402) + hàm dùng chung public.job_recurrences_list_v1 (20261023042445) + bảng / RLS / câu lịch / ngày sinh
// của CRM (20261023042424, nạp một lần cho cả file; vài hàm quyền mà file đó đòi được thay bằng bản tối thiểu của fixture). Phạm vi
// rls_buildings: toà công ty ∩ phạm vi kết nối, RLS quyết từng quy tắc. Tóm tắt trên CẢ tập khớp; rào broker nhận đúng các hàng.
const file = slug => readFileSync(`supabase/migrations/${readdirSync('supabase/migrations').find(name => name.endsWith(`_${slug}.sql`))}`, 'utf8').replaceAll('\r\n', '\n');
const STUBS = `CREATE OR REPLACE FUNCTION app_private.buildings_for_v3(p_permission text) RETURNS uuid[] LANGUAGE sql STABLE AS $f$
    SELECT ARRAY(SELECT b.id FROM public.buildings b WHERE b.organization_id='${ORG}') $f$;
  CREATE OR REPLACE FUNCTION app_private.authorize_tenant_action_v3(p_user uuid,p_org uuid,p_permission text,p_building uuid,p_cashbook uuid)
    RETURNS TABLE(allowed boolean,authorization_version bigint,nearest_deadline timestamptz) LANGUAGE sql AS $f$ SELECT true,1::bigint,NULL::timestamptz $f$;
  CREATE OR REPLACE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $f$ SELECT ARRAY['${ORG}'::uuid] $f$;
  DO $d$ BEGIN IF to_regprocedure('public.org_today_v1(uuid)') IS NULL THEN
    CREATE FUNCTION public.org_today_v1(p_org uuid DEFAULT NULL) RETURNS date LANGUAGE sql STABLE AS 'SELECT (now() AT TIME ZONE ''Asia/Ho_Chi_Minh'')::date';
  END IF; END $d$;
  GRANT EXECUTE ON FUNCTION public.my_org_ids(),public.org_today_v1(uuid),app_private.buildings_for_v3(text) TO authenticated;
  -- jobs của fixture đợt 2 không có khoá chính id như production; khoá ngoại job_id của bảng lần sinh cần nó.
  CREATE UNIQUE INDEX IF NOT EXISTS fixture_jobs_id_key ON public.jobs(id);`;
const u = n => `0e0e0e0e-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TYPE = u(9);
const plus = (date, days) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
let shared;
before(async () => {
  shared = await sharedW2c();
  await shared.db.exec(STUBS);
  await shared.db.exec(file('job_recurrence_v1'));
});
after(async () => { await shared?.close(); });
const inCase = work => shared.isolated(work);
const full = values => ({ ...Object.fromEntries(W2.reports.task_recurrences.params.map(name => [name, null])), ...values });
const identity = buildings => ({ effective: { read: ['tasks.view'] }, scopesByPermission: { 'tasks.view': { buildingIds: buildings } } });
async function list(env, values = {}, buildings = [BUILDING, OTHER_BUILDING]) {
  const params = full(values);
  const value = await env.report('task_recurrences', params, { limit: 50, offset: 0 });
  const input = W2.reads.report.input({ report: 'task_recurrences', params, limit: 50, offset: 0 });
  assert.deepEqual(W2.reads.report.result(value, identity(buildings), input).items, value.items, 'rào broker nhận đúng các hàng');
  return value;
}
const codes = value => value.items.map(row => row.code);
// Ngày của fixture đợt 2 (org_today_v1 của fixture có thể cố định), không phải đồng hồ máy.
async function seed(env) {
  const today = (await env.db.query('SELECT public.org_today_v1($1)::text d', [ORG])).rows[0].d;
  await env.grant(['tasks.view']);
  // Ghi như hàm hệ thống (vai chủ bảng ⇒ trigger 'system'): được đặt ngày bắt đầu/kết thúc trong quá khứ để có quy tắc đã kết thúc.
  await env.db.exec(`INSERT INTO public.job_types VALUES('${TYPE}','${ORG}','kiểm tra',true);
    INSERT INTO public.job_recurrence_rules(organization_id,building_id,room_id,job_type_id,title,assignee_id,frequency,weekdays,month_day,start_date,end_date,created_by) VALUES
      ('${ORG}','${BUILDING}','${ROOM}','${TYPE}','Kiểm máy bơm','${STAFF2}','weekly','{1,4}',NULL,'${today}',NULL,'${USER}'),
      ('${ORG}','${BUILDING}',NULL,'${TYPE}','Thu rác','${USER}','monthly',NULL,-1,'${today}',NULL,'${USER}'),
      ('${ORG}','${BUILDING}',NULL,'${TYPE}','Kiểm cũ','${USER}','daily',NULL,NULL,'${plus(today, -30)}','${plus(today, -5)}','${USER}'),
      ('${ORG}','${OTHER_BUILDING}',NULL,'${TYPE}','Kiểm điện toà B','${STAFF2}','daily',NULL,NULL,'${today}',NULL,'${USER}');
    UPDATE public.job_recurrence_rules SET paused_at=now(),paused_reason='permission_lost' WHERE title='Thu rác';`);
  return today;
}

test('task_recurrences: rules like a future /tasks tab under RLS within the connection scope; schedule text, next date, status; summary over the whole set', () => inCase(async env => {
  const today = await seed(env);
  const page = await list(env, {}, [BUILDING]);
  assert.deepEqual(codes(page), ['DK-0001', 'DK-0002', 'DK-0003'], 'đang chạy trước; không có quy tắc toà B');
  const pump = page.items[0];
  const next = (await env.db.query(`SELECT min(d)::text v FROM public.job_recurrence_dates_v1('weekly',1,'{1,4}',NULL,$1::date,NULL,$1::date,$1::date+14) d`, [today])).rows[0].v;
  assert.deepEqual([pump.title, pump.jobType, pump.roomName, pump.assigneeName, pump.schedule, pump.status, pump.nextDate, pump.dueDays],
    ['Kiểm máy bơm', 'kiểm tra', 'P101', 'Quản lý Hai', 'mỗi thứ Hai, thứ Năm', 'ACTIVE', next, 0]);
  assert.deepEqual(page.items.slice(1).map(row => [row.code, row.status, row.pausedReason, row.nextDate, row.schedule]),
    [['DK-0002', 'PAUSED', 'permission_lost', null, 'ngày cuối tháng hằng tháng'], ['DK-0003', 'ENDED', null, null, 'hằng ngày']]);
  assert.deepEqual(page.summary, { total: 3, active: 1, paused: 1, ended: 1 });
  assert.deepEqual(codes(await list(env, { status: 'ACTIVE' }, [BUILDING])), ['DK-0001']);
  assert.deepEqual(codes(await list(env, { status: 'PAUSED' }, [BUILDING])), ['DK-0002']);
  assert.deepEqual(codes(await list(env, { query: 'quan ly hai' }, [BUILDING])), ['DK-0001'], 'tên người nhận bỏ dấu');
  assert.deepEqual(codes(await list(env, { query: 'dk-0003' }, [BUILDING])), ['DK-0003'], 'mã');
}));

test('task_recurrences: Toàn tổ chức ⇒ every building of the company; RLS hides a building the asker cannot view', () => inCase(async env => {
  await seed(env);
  await env.orgWide('tasks.view');
  const all = await list(env);
  assert.deepEqual([...codes(all)].sort(), ['DK-0001', 'DK-0002', 'DK-0003', 'DK-0004']);
  assert.deepEqual(all.summary, { total: 4, active: 2, paused: 1, ended: 1 });
  await env.db.exec(`DELETE FROM public.fixture_building_access WHERE building_id='${OTHER_BUILDING}'`);
  assert.equal(codes(await list(env)).includes('DK-0004'), false, 'RLS (buildings.view) giấu quy tắc của toà không xem được');
}));

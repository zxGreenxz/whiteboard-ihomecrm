import test from 'node:test';
import assert from 'node:assert/strict';
import { setupRecurring, GENERATE_SQL, RECURRENCE_SQL, ORG, USER, BUILDING, OTHER_BUILDING, MANAGER, STAFF, TYPE_SUA } from './task-recurring-fixture.mjs';

// Công việc Mốc 5 (CONG-VIEC-THAO-TAC-GHI.md mục 5, 22): việc định kỳ trên PGlite — ngày sinh (thuần), bốn thao tác Hermes (luôn xem
// trước → ghi → phát lại), hàm ghi CRM dùng chung dưới RLS + trigger kiểm đúng khoá, bộ sinh chống trùng / tạm dừng khi mất quyền,
// và đột biến của các rào chính. Dữ liệu tổng hợp.
const rid = n => `00000000-0000-4000-8000-${String(7000 + n).padStart(12, '0')}`;
const VN = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(d);
const today = VN(new Date());
const plus = (date, days) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const ddmm = date => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
const KEYS = "UPDATE app_private.hermes_org_policies SET action_capabilities=action_capabilities||ARRAY['tasks.edit','tasks.delete'];" +
  "UPDATE app_private.hermes_connections SET action_capabilities=action_capabilities||ARRAY['tasks.edit','tasks.delete'];";
const grantDelete = db => db.query("INSERT INTO public.fixture_acl(permission,building_ids) VALUES('tasks.delete',$1) ON CONFLICT(permission) DO UPDATE SET building_ids=excluded.building_ids,allowed=true",
  [[BUILDING, OTHER_BUILDING]]);
// Ghi CRM thẳng (như web về sau) dưới vai authenticated của một người.
const crm = (f, sql, args, actor = USER) => f.call(`SELECT to_jsonb(x) result FROM ${sql} x`, args, { actor });
const createRule = (f, { title = 'kiểm máy bơm', building = BUILDING, frequency = 'daily', weekdays = null, monthDay = null, start = today, end = null,
  due = 0, assignee = MANAGER } = {}, actor = USER) =>
  crm(f, 'public.job_recurrence_create_v1($1,$2,NULL,$3,$4,NULL,$5,NULL,$6,1,$7::integer[],$8,$9::date,$10::date,$11)',
    [ORG, building, TYPE_SUA, title, assignee, frequency, weekdays, monthDay, start, end, due], actor);
const jobsOf = async db => (await db.query(`SELECT j.code,j.title,j.description,j.user_id,j.assignee_id,j.building_id,j.status,
  to_char(j.deadline AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY-MM-DD HH24:MI:SS.MS') deadline,o.occurrence_date::text AS day
  FROM public.job_recurrence_occurrences o JOIN public.jobs j ON j.id=o.job_id ORDER BY o.occurrence_date`)).rows;

test('job_recurrence_dates_v1 + schedule text: anchored months (29–31, Feb, leap year), ISO weeks every N, end date, window', { timeout: 300000 }, async t => {
  const { db } = await setupRecurring(t, { generate: null, recurring: null, enable: false });
  const dates = async (frequency, every, weekdays, monthDay, start, end, from, to) => (await db.query(
    'SELECT COALESCE(array_agg(d::text ORDER BY d),\'{}\') v FROM public.job_recurrence_dates_v1($1,$2,$3::smallint[],$4,$5::date,$6::date,$7::date,$8::date) d',
    [frequency, every, weekdays, monthDay, start, end, from, to])).rows[0].v;
  assert.deepEqual(await dates('daily', 1, null, null, '2026-01-30', null, '2026-01-29', '2026-02-02'), ['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']);
  assert.deepEqual(await dates('daily', 3, null, null, '2026-01-01', null, '2026-01-05', '2026-01-12'), ['2026-01-07', '2026-01-10']);
  assert.deepEqual(await dates('weekly', 1, [1, 4], null, '2026-10-21', null, '2026-10-21', '2026-10-31'), ['2026-10-22', '2026-10-26', '2026-10-29']);
  assert.deepEqual(await dates('weekly', 2, [1], null, '2026-10-19', null, '2026-10-19', '2026-11-20'), ['2026-10-19', '2026-11-02', '2026-11-16']);
  assert.deepEqual(await dates('monthly', 1, null, 31, '2026-01-31', null, '2026-01-01', '2026-05-31'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  assert.deepEqual(await dates('monthly', 1, null, -1, '2028-01-15', null, '2028-01-01', '2028-03-31'), ['2028-01-31', '2028-02-29', '2028-03-31']);
  assert.deepEqual(await dates('monthly', 2, null, 29, '2026-12-29', null, '2026-12-01', '2027-04-30'), ['2026-12-29', '2027-02-28', '2027-04-29']);
  assert.deepEqual(await dates('daily', 1, null, null, '2026-01-01', '2026-01-03', '2026-01-01', '2026-01-10'), ['2026-01-01', '2026-01-02', '2026-01-03'], 'tới ngày kết thúc');
  assert.deepEqual(await dates('weekly', 1, [3], null, '2026-10-21', null, '2026-10-01', '2026-10-20'), [], 'trước ngày bắt đầu');
  const text = async (frequency, every, weekdays, monthDay) => (await db.query('SELECT public.job_recurrence_schedule_text_v1($1,$2,$3::smallint[],$4) v',
    [frequency, every, weekdays, monthDay])).rows[0].v;
  assert.equal(await text('daily', 1, null, null), 'hằng ngày');
  assert.equal(await text('daily', 2, null, null), 'mỗi 2 ngày');
  assert.equal(await text('weekly', 1, [1, 4], null), 'mỗi thứ Hai, thứ Năm');
  assert.equal(await text('weekly', 2, [7], null), 'mỗi 2 tuần vào Chủ nhật');
  assert.equal(await text('monthly', 1, null, -1), 'ngày cuối tháng hằng tháng');
  assert.equal(await text('monthly', 3, null, 15), 'ngày 15, mỗi 3 tháng');
});

test('CRM write functions under RLS + trigger: code, defaults, immutables, CAS, delete needs tasks.delete, column grants, cap 100', { timeout: 300000 }, async t => {
  const f = await setupRecurring(t, { generate: null, recurring: null, enable: false });
  const { db } = f;
  const a = await createRule(f, { frequency: 'weekly' });
  assert.deepEqual([a.code, a.weekdays, a.created_by, a.version, a.last_generated_date], ['DK-0001', [new Date(`${today}T00:00:00Z`).getUTCDay() || 7], USER, 1, plus(today, -1)],
    'mã DK-0001; weekly mặc định thứ của ngày bắt đầu; người tạo = người gọi');
  const b = await createRule(f, { frequency: 'monthly', title: 'thu rác' });
  assert.deepEqual([b.code, b.month_day], ['DK-0002', Number(today.slice(8, 10))]);
  await assert.rejects(createRule(f, { start: plus(today, -1) }), /job_recurrence_start_past/);
  await assert.rejects(crm(f, 'public.job_recurrence_create_v1($1,$2,$3,$4,$5,NULL,$6,NULL,$7,1,NULL,NULL,NULL,NULL,0)',
    [ORG, BUILDING, '00000000-0000-4000-8000-000000000999', TYPE_SUA, 'x', MANAGER, 'daily']), /job_recurrence_target_invalid/, 'phòng không thuộc toà');
  // RLS INSERT: không có tasks.create ở toà ⇒ chặn.
  await db.query('UPDATE public.fixture_rls SET deny_insert=true');
  await assert.rejects(createRule(f, { title: 'bị chặn' }), /row-level security/);
  await db.query('UPDATE public.fixture_rls SET deny_insert=false');
  // CAS theo version; đổi lịch ⇒ version tăng, chuẩn hoá lại thứ/ngày.
  await assert.rejects(crm(f, 'public.job_recurrence_update_v1($1,$2,$3::jsonb)', [a.id, 9, JSON.stringify({ title: 'x' })]), /job_recurrence_conflict/);
  const a2 = await crm(f, 'public.job_recurrence_update_v1($1,$2,$3::jsonb)', [a.id, 1, JSON.stringify({ frequency: 'monthly', month_day: -1 })]);
  assert.deepEqual([a2.version, a2.frequency, a2.weekdays, a2.month_day], [2, 'monthly', null, -1]);
  // Cột bất biến / không cấp quyền cột: vai API không đổi được mã, toà.
  await assert.rejects(f.call('UPDATE public.job_recurrence_rules SET code=\'DK-9999\' WHERE id=$1 RETURNING 1 result', [a.id]), /permission denied/);
  await assert.rejects(f.call('INSERT INTO public.job_recurrence_occurrences(rule_id,occurrence_date,organization_id,outcome) VALUES($1,$2,$3,\'generated\') RETURNING 1 result',
    [a.id, today, ORG]), /permission denied/);
  // Tạm dừng / chạy lại; xoá mềm đòi tasks.delete (trigger, không chỉ policy).
  const paused = await crm(f, 'public.job_recurrence_set_paused_v1($1,$2,true)', [a.id, 2]);
  assert.deepEqual([paused.paused_reason, paused.version], ['user', 3]);
  await assert.rejects(crm(f, 'public.job_recurrence_set_paused_v1($1,$2,true)', [a.id, 3]), /job_recurrence_unchanged/);
  await db.query("INSERT INTO public.fixture_acl(permission,building_ids,allowed) VALUES('tasks.delete','{}',false) ON CONFLICT(permission) DO UPDATE SET building_ids='{}',allowed=false");
  await db.query(`INSERT INTO public.fixture_acl(permission,building_ids) VALUES('tasks.edit',$1) ON CONFLICT(permission) DO UPDATE SET building_ids=excluded.building_ids,allowed=true`, [[BUILDING, OTHER_BUILDING]]);
  await assert.rejects(crm(f, 'public.job_recurrence_delete_v1($1,$2)', [a.id, 3]), /job_recurrence_denied/, 'có tasks.edit, thiếu tasks.delete ⇒ không xoá được');
  await grantDelete(db);
  const deleted = await crm(f, 'public.job_recurrence_delete_v1($1,$2)', [a.id, 3]);
  assert.equal(deleted.version, 4);
  await assert.rejects(crm(f, 'public.job_recurrence_update_v1($1,$2,$3::jsonb)', [a.id, 4, JSON.stringify({ title: 'y' })]), /job_recurrence_not_found/);
  // Trần 100 quy tắc đang chạy mỗi công ty (đếm cả quy tắc người gọi không thấy qua RLS).
  await db.query(`INSERT INTO public.job_recurrence_rules(organization_id,building_id,job_type_id,title,frequency,start_date,created_by)
    SELECT $1,$2,$3,'mẫu '||g,'daily',$4::date,$5 FROM generate_series(1,99) g`, [ORG, OTHER_BUILDING, TYPE_SUA, today, MANAGER]);
  await assert.rejects(createRule(f, { title: 'thứ 101' }), /job_recurrence_limit/);
  void STAFF;
});

test('Hermes task.recurring_create: one preview (schedule, three next dates, Q31), apply, replay, audit; schedule errors ask again; no policy row ⇒ off', { timeout: 300000 }, async t => {
  const f = await setupRecurring(t, { generate: null });
  const { db, run } = f;
  const params = { buildingName: 'Toà A', jobType: 'sửa', content: 'kiểm máy bơm', assigneeName: 'Nathan', frequency: 'weekly', weekdays: ['MON', 'THU'], dueDays: 1 };
  const preview = await run('task.recurring_create', 'auto', rid(1), params);
  assert.equal(preview.kind, 'preview', JSON.stringify(preview));
  assert.equal(preview.confirm, 'required');
  const next = (await db.query(`SELECT array_agg(d::text ORDER BY d) v FROM (SELECT d FROM public.job_recurrence_dates_v1('weekly',1,'{1,4}',NULL,$1::date,NULL,$1::date,$1::date+30) d ORDER BY d LIMIT 3) x`,
    [today])).rows[0].v;
  assert.deepEqual(preview.preview.nextDates, next);
  assert.equal(preview.preview.schedule, 'mỗi thứ Hai, thứ Năm');
  assert.match(preview.preview.text, new RegExp(`^Tạo việc định kỳ 'sửa kiểm máy bơm' \\(loại sửa\\) — toà Toà A, cả toà — giao Nathan Quản Lý — mỗi thứ Hai, thứ Năm, từ .+; hạn cuối ngày thứ 1 sau ngày sinh\\. Ba lần tới: ${next.map(ddmm).join(', ')}\\.`));
  assert.ok(preview.warnings.some(w => w.includes('CẢ TOÀ')));
  assert.equal((await f.rules()).length, 0, 'xem trước không ghi');
  const applied = await run('task.recurring_create', 'apply', rid(1), params, preview);
  assert.equal(applied.kind, 'applied', JSON.stringify(applied));
  assert.equal(applied.link, '/tasks');
  assert.deepEqual([applied.result.rule.code, applied.result.rule.schedule, applied.result.rule.nextDates], ['DK-0001', 'mỗi thứ Hai, thứ Năm', next]);
  const [rule] = await f.rules();
  assert.deepEqual([rule.title, rule.frequency, rule.weekdays, rule.due_days, rule.assignee_id, rule.created_by, rule.building_id, rule.room_id],
    ['sửa kiểm máy bơm', 'weekly', [1, 4], 1, MANAGER, USER, BUILDING, null]);
  assert.deepEqual(await run('task.recurring_create', 'apply', rid(1), params, preview), applied, 'cùng requestId ⇒ phát lại');
  assert.equal((await f.rules()).length, 1);
  const audit = (await db.query("SELECT new_state FROM public.authorization_audit_events WHERE event_type='HERMES_TASK_RECURRING_CREATED'")).rows;
  assert.deepEqual(audit.map(row => [row.new_state.code, row.new_state.action]), [['DK-0001', 'task.recurring_create']]);
  // Q31: thiếu người nhận ⇒ đề xuất người quản lý toà (Nathan) trong bản xem trước.
  const suggested = await run('task.recurring_create', 'auto', rid(2), { buildingName: 'Toà A', jobType: 'sửa', content: 'kiểm đồng hồ', frequency: 'daily' });
  assert.equal(suggested.kind, 'preview', JSON.stringify(suggested));
  assert.match(suggested.preview.text, /^Chưa nêu người nhận — đề xuất giao Nathan Quản Lý \(quản lý toà Toà A\)\. /);
  // Lịch sai ⇒ hỏi lại, không ghi.
  for (const [extra, reason] of [[{ frequency: 'daily', weekdays: ['MON'] }, 'invalid_params'], [{ frequency: 'monthly', monthDay: 0 }, 'invalid_params'],
    [{ frequency: 'daily', every: 13 }, 'invalid_params'], [{ frequency: 'daily', startDate: plus(today, -1) }, 'date_out_of_range'],
    [{ frequency: 'daily', startDate: plus(today, 3), endDate: plus(today, 1) }, 'date_out_of_range'],
    [{ frequency: 'weekly', weekdays: ['MON'], startDate: plus(today, 1), endDate: plus(today, 1) }, null]]) {
    const value = await run('task.recurring_create', 'auto', rid(3), { buildingName: 'Toà A', jobType: 'sửa', content: 'x', assigneeName: 'tôi', ...extra });
    if (reason === null) {
      const day = new Date(`${plus(today, 1)}T00:00:00Z`).getUTCDay();
      assert.deepEqual([value.kind, value.reason], day === 1 ? ['preview', undefined] : ['needs_input', 'date_out_of_range'], 'cửa sổ một ngày không trúng thứ ⇒ không có lần nào');
    } else assert.deepEqual([value.kind, value.reason], ['needs_input', reason], JSON.stringify(extra));
  }
  assert.equal((await f.rules()).length, 1);
  // Khoá để TẮT: không có dòng chính sách ⇒ guard từ chối mọi thao tác việc định kỳ.
  await db.query("DELETE FROM app_private.hermes_action_policies WHERE action LIKE 'task.recurring\\_%'");
  await assert.rejects(run('task.recurring_create', 'auto', rid(4), params));
});

test('Hermes update / pause / resume / delete: exact rule (code, folded title), never picks on ambiguity, unchanged asks, version guards turn 2', { timeout: 300000 }, async t => {
  const f = await setupRecurring(t, { generate: null });
  const { db, run } = f;
  await db.exec(KEYS);
  const pump = await createRule(f, { title: 'kiểm máy bơm tầng hầm', frequency: 'weekly', weekdays: [1] });
  await createRule(f, { title: 'kiểm bình chữa cháy', frequency: 'monthly', monthDay: 15 });
  const ambiguous = await run('task.recurring_pause', 'auto', rid(10), { rule: 'kiểm' });
  assert.deepEqual([ambiguous.kind, ambiguous.reason, ambiguous.field, ambiguous.why, ambiguous.candidates.length],
    ['needs_input', 'name_unresolved', 'recurrence', 'ambiguous', 2], JSON.stringify(ambiguous));
  assert.match(ambiguous.candidates[0].name, /^DK-0001 · kiểm máy bơm tầng hầm \(cả toà, mỗi thứ Hai\)$/);
  const missing = await run('task.recurring_pause', 'auto', rid(11), { rule: 'DK-0099' });
  assert.deepEqual([missing.kind, missing.why], ['needs_input', 'not_visible']);
  // Tạm dừng theo mã viết tắt "dk1" ⇒ DK-0001; luôn xem trước.
  const pause = await run('task.recurring_pause', 'auto', rid(12), { rule: 'dk1' });
  assert.equal(pause.kind, 'preview', JSON.stringify(pause));
  assert.match(pause.preview.text, /^Tạm dừng việc định kỳ DK-0001 'kiểm máy bơm tầng hầm'/);
  assert.equal((await run('task.recurring_pause', 'apply', rid(12), { rule: 'dk1' }, pause)).kind, 'applied');
  assert.deepEqual((await f.rules())[0].paused_reason, 'user');
  const again = await run('task.recurring_pause', 'auto', rid(13), { rule: 'DK-0001' });
  assert.deepEqual([again.kind, again.reason], ['needs_input', 'recurrence_unchanged']);
  // Chạy lại theo nội dung bỏ dấu.
  const resume = await run('task.recurring_pause', 'auto', rid(14), { rule: 'may bom', resume: true });
  assert.match(resume.preview.text, /^Chạy lại việc định kỳ DK-0001 .+Không sinh bù các ngày đã dừng\. Lần tới: /);
  assert.equal((await run('task.recurring_pause', 'apply', rid(14), { rule: 'may bom', resume: true }, resume)).kind, 'applied');
  assert.deepEqual([(await f.rules())[0].paused, (await f.rules())[0].last_generated_date], [false, plus(today, -1)]);
  // Sửa: đổi thứ + người nhận ⇒ xem trước liệt kê thay đổi; lượt 2 ghi; version tăng.
  const update = await run('task.recurring_update', 'auto', rid(15), { rule: 'DK-0001', weekdays: ['TUE', 'FRI'], assigneeName: 'tôi', dueDays: 2 });
  assert.equal(update.kind, 'preview', JSON.stringify(update));
  assert.match(update.preview.text, /người nhận Nathan Quản Lý → chính anh\/chị; lịch mỗi thứ Hai → mỗi thứ Ba, thứ Sáu; hạn cuối ngày thứ 2 sau ngày sinh\./);
  const before = (await f.rules())[0].version;
  assert.equal((await run('task.recurring_update', 'apply', rid(15), { rule: 'DK-0001', weekdays: ['TUE', 'FRI'], assigneeName: 'tôi', dueDays: 2 }, update)).kind, 'applied');
  const after = (await f.rules())[0];
  assert.deepEqual([after.weekdays, after.assignee_id, after.due_days, after.version], [[2, 5], USER, 2, before + 1]);
  const same = await run('task.recurring_update', 'auto', rid(16), { rule: 'DK-0001', weekdays: ['TUE', 'FRI'] });
  assert.deepEqual([same.kind, same.reason], ['needs_input', 'recurrence_unchanged']);
  // Đổi giữa hai lượt (web sửa) ⇒ state_changed, không ghi.
  const stale = await run('task.recurring_pause', 'auto', rid(17), { rule: 'DK-0001' });
  await crm(f, 'public.job_recurrence_update_v1($1,NULL,$2::jsonb)', [pump.id, JSON.stringify({ title: 'kiểm máy bơm (web sửa)' })]);
  assert.deepEqual([(await run('task.recurring_pause', 'apply', rid(17), { rule: 'DK-0001' }, stale)).reason], ['state_changed']);
  // Xoá: người hỏi thiếu quyền CRM tasks.delete ⇒ guard chung chặn ngay (như task.cancel); có ⇒ luôn xem trước rồi xoá mềm, audit giữ mã.
  await assert.rejects(run('task.recurring_delete', 'auto', rid(18), { rule: 'DK-0002' }), /hermes_action_denied/);
  await grantDelete(db);
  const del2 = await run('task.recurring_delete', 'auto', rid(19), { rule: 'DK-0002' });
  assert.match(del2.preview.text, /^Xoá việc định kỳ DK-0002 'kiểm bình chữa cháy' .+việc đã sinh giữ nguyên/);
  assert.equal((await run('task.recurring_delete', 'apply', rid(19), { rule: 'DK-0002' }, del2)).kind, 'applied');
  assert.deepEqual((await f.rules()).map(row => [row.code, row.deleted]), [['DK-0001', false], ['DK-0002', true]]);
  const gone = await run('task.recurring_pause', 'auto', rid(20), { rule: 'chua chay' });
  assert.deepEqual([gone.kind, gone.why], ['needs_input', 'not_visible'], 'quy tắc đã xoá không còn tìm được');
  const events = (await db.query("SELECT event_type FROM public.authorization_audit_events WHERE event_type LIKE 'HERMES_TASK_RECURRING_%' ORDER BY occurred_at,id")).rows.map(row => row.event_type);
  assert.deepEqual([...events].sort(), ['HERMES_TASK_RECURRING_DELETED', 'HERMES_TASK_RECURRING_PAUSED', 'HERMES_TASK_RECURRING_RESUMED', 'HERMES_TASK_RECURRING_UPDATED']);
});

test('generator: once per (rule, day), rerun-safe, backfill ≤ 7 days, creator owns the job, end-of-day deadline + due days, ledger source=recurrence', { timeout: 300000 }, async t => {
  const f = await setupRecurring(t, { recurring: null, enable: false });
  const { db } = f;
  await createRule(f, { title: 'kiểm máy bơm', frequency: 'daily', due: 2 });
  assert.deepEqual(await f.generate(today), { checked: 1, generated: 1, paused: 0, failed: 0, busy: 0 });
  assert.deepEqual((await f.generate(today)).generated, 0, 'chạy lại cùng ngày ⇒ không sinh thêm');
  let jobs = await jobsOf(db);
  assert.equal(jobs.length, 1);
  assert.deepEqual([jobs[0].user_id, jobs[0].assignee_id, jobs[0].building_id, jobs[0].status, jobs[0].title, jobs[0].day],
    [USER, MANAGER, BUILDING, 'IN_PROGRESS', 'kiểm máy bơm', today]);
  assert.match(jobs[0].code, /^JOB-\d{8}-\d{4}$/);
  assert.equal(jobs[0].deadline, `${plus(today, 2)} 23:59:59.999`);
  assert.match(jobs[0].description, /\(định kỳ DK-0001\)$/);
  assert.equal((await f.generate(plus(today, 2))).generated, 2, 'bù đúng các ngày còn thiếu');
  // Sự cố 20 ngày ⇒ chỉ bù 7 ngày gần nhất.
  assert.equal((await f.generate(plus(today, 22))).generated, 7);
  jobs = await jobsOf(db);
  assert.deepEqual(jobs.slice(-7).map(row => row.day), Array.from({ length: 7 }, (_, i) => plus(today, 16 + i)));
  const ledger = (await db.query("SELECT action,source,actor_id FROM app_private.hermes_task_jobs WHERE source='recurrence'")).rows;
  assert.equal(ledger.length, 10);
  assert.ok(ledger.every(row => row.action === 'task.recurring_create' && row.actor_id === USER));
  assert.equal((await db.query("SELECT app_private.hermes_task_quota_v1($1,$2,ARRAY[$3]::uuid[]) q", [ORG, USER, MANAGER])).rows[0].q, null,
    'việc định kỳ không tính hạn mức giao việc qua bot');
  // Việc bị xoá ⇒ lần sinh còn (job_id NULL), không sinh lại.
  await db.query('DELETE FROM public.jobs WHERE id=(SELECT job_id FROM public.job_recurrence_occurrences ORDER BY occurrence_date LIMIT 1)');
  assert.equal((await f.generate(plus(today, 22))).generated, 0);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.job_recurrence_occurrences WHERE job_id IS NULL')).rows[0].n, 1);
});

test('generator runs as cron (no JWT claims): the real member helper is false there, the generator reads memberships itself and pauses nothing', { timeout: 300000 }, async t => {
  const f = await setupRecurring(t, { recurring: null, enable: false });
  const { db } = f;
  await createRule(f, { title: 'chạy như cron', frequency: 'daily' });
  const ctx = (await db.query('SELECT auth.role() r,auth.uid() u,app_private.hermes_task_assignee_member_v1($1,$2) m', [USER, ORG])).rows[0];
  assert.deepEqual([ctx.r || null, ctx.u, ctx.m], [null, null, false], 'ngữ cảnh cron: không JWT ⇒ helper thành viên trả false');
  assert.deepEqual(await f.generate(today), { checked: 1, generated: 1, paused: 0, failed: 0, busy: 0 });
  assert.equal((await f.rules())[0].paused_reason, null);
});

test('generator: lost permission / membership / target ⇒ pauses with reason, skipped occurrence, audit; paused and deleted rules are not generated', { timeout: 300000 }, async t => {
  const f = await setupRecurring(t, { recurring: null, enable: false });
  const { db } = f;
  const a = await createRule(f, { title: 'mất quyền', frequency: 'daily' });
  const b = await createRule(f, { title: 'mất loại', frequency: 'daily', building: OTHER_BUILDING });
  const c = await createRule(f, { title: 'người nhận nghỉ', frequency: 'daily', building: OTHER_BUILDING, assignee: STAFF });
  const d = await createRule(f, { title: 'đang tạm dừng', frequency: 'daily' });
  await crm(f, 'public.job_recurrence_set_paused_v1($1,NULL,true)', [d.id]);
  // Người tạo mất tasks.create ở toà A; loại 'sửa' vẫn sống cho toà B nhưng C có người nhận rời công ty.
  await db.query("UPDATE public.fixture_acl SET building_ids=$1 WHERE permission='tasks.create'", [[OTHER_BUILDING]]);
  await db.query("UPDATE public.organization_memberships SET status='SUSPENDED' WHERE user_id=$1", [STAFF]);
  let r = await f.generate(today);
  assert.deepEqual([r.generated, r.paused], [1, 2]);
  let rules = await f.rules();
  assert.deepEqual(rules.map(row => [row.code, row.paused_reason]), [['DK-0001', 'permission_lost'], ['DK-0002', null], ['DK-0003', 'membership_lost'], ['DK-0004', 'user']]);
  const skipped = (await db.query("SELECT rule_id,reason FROM public.job_recurrence_occurrences WHERE outcome='skipped' ORDER BY reason")).rows;
  assert.deepEqual(skipped.map(row => [row.rule_id, row.reason]), [[c.id, 'membership_lost'], [a.id, 'permission_lost']]);
  const audit = (await db.query("SELECT new_state->>'reason' reason FROM public.authorization_audit_events WHERE event_type='JOB_RECURRENCE_PAUSED' ORDER BY 1")).rows;
  assert.deepEqual(audit.map(row => row.reason), ['membership_lost', 'permission_lost']);
  // Loại việc bị tắt ⇒ target_deleted ở lượt kế.
  await db.query('UPDATE public.job_types SET is_active=false WHERE id=$1', [TYPE_SUA]);
  r = await f.generate(plus(today, 1));
  rules = await f.rules();
  assert.deepEqual([r.generated, rules[1].paused_reason], [0, 'target_deleted']);
  // Quy tắc xoá mềm không sinh.
  await db.query('UPDATE public.job_types SET is_active=true WHERE id=$1', [TYPE_SUA]);
  await grantDelete(db);
  await crm(f, 'public.job_recurrence_delete_v1($1,NULL)', [b.id]);
  assert.equal((await f.generate(plus(today, 2))).generated, 0);
});

test('mutation: generator permission recheck, cron-safe membership, trigger delete key, resolver ambiguity guard are each load-bearing', { timeout: 300000 }, async t => {
  const recurringSource = (await import('./task-recurring-fixture.mjs')).RECURRING_SQL;
  const generator = GENERATE_SQL.slice(GENERATE_SQL.indexOf('CREATE OR REPLACE FUNCTION app_private.hermes_task_recurrence_generate_v1'), GENERATE_SQL.indexOf('END $fn$;') + 'END $fn$;'.length);
  const guardStart = RECURRENCE_SQL.indexOf('CREATE OR REPLACE FUNCTION app_private.job_recurrence_guard_v1()');
  const guard = RECURRENCE_SQL.slice(guardStart, RECURRENCE_SQL.indexOf('END $fn$;', guardStart) + 'END $fn$;'.length);
  const coreStart = recurringSource.indexOf('CREATE OR REPLACE FUNCTION app_private.hermes_task_resolve_core_v1(');
  const core = recurringSource.slice(coreStart, recurringSource.indexOf('END $fn$;', coreStart) + 'END $fn$;'.length);
  const mutate = (text, from, to) => { assert.equal(text.split(from).length, 2, `anchor: ${from.slice(0, 60)}`); return text.replace(from, () => to); };
  const probes = [
    ['generator rechecks tasks.create of the rule creator', mutate(generator, "ELSIF NOT COALESCE((SELECT a.allowed FROM app_private.authorize_tenant_action_v3(r.created_by,r.organization_id,'tasks.create',",
      "ELSIF false AND NOT COALESCE((SELECT a.allowed FROM app_private.authorize_tenant_action_v3(r.created_by,r.organization_id,'tasks.create',"),
      async f => {
        await createRule(f, { frequency: 'daily' });
        await f.db.query("UPDATE public.fixture_acl SET building_ids='{}' WHERE permission='tasks.create'");
        return (await f.generate(today)).generated === 0;
      }],
    ['generator reads memberships itself, not the JWT-bound helper (cron has no JWT)', mutate(generator,
      "IF NOT EXISTS(SELECT 1 FROM public.organization_memberships m WHERE m.user_id=r.created_by AND m.organization_id=r.organization_id\n" +
      "          AND m.status='ACTIVE' AND m.revoked_at IS NULL AND (m.valid_from IS NULL OR m.valid_from<=clock_timestamp())\n" +
      "          AND (m.valid_to IS NULL OR m.valid_to>clock_timestamp())) THEN v_reason:='membership_lost';",
      "IF NOT COALESCE(app_private.hermes_task_assignee_member_v1(r.created_by,r.organization_id),false) THEN v_reason:='membership_lost';"),
      async f => {
        await createRule(f, { frequency: 'daily' });
        const r = await f.generate(today);
        return r.generated === 1 && r.paused === 0;
      }],
    ['soft delete needs tasks.delete, not only tasks.edit', mutate(guard, "v_need:=CASE WHEN NEW.deleted_at IS NOT NULL THEN 'tasks.delete' ELSE 'tasks.edit' END;", "v_need:='tasks.edit';"),
      async f => {
        const rule = await createRule(f, { frequency: 'daily' });
        await f.db.query("INSERT INTO public.fixture_acl(permission,building_ids,allowed) VALUES('tasks.delete','{}',false) ON CONFLICT(permission) DO UPDATE SET building_ids='{}',allowed=false");
        try { await crm(f, 'public.job_recurrence_delete_v1($1,NULL)', [rule.id]); return false; } catch { return true; }
      }],
    ['resolver never picks a rule when several match', mutate(core, "    ELSIF jsonb_array_length(v_hits)>1 THEN\n      RETURN jsonb_build_object('status','unresolved','field','recurrence'",
      "    ELSIF false THEN\n      RETURN jsonb_build_object('status','unresolved','field','recurrence'"),
      async f => {
        await f.db.exec(KEYS);
        await createRule(f, { title: 'kiểm a' }); await createRule(f, { title: 'kiểm b' });
        return (await f.run('task.recurring_pause', 'auto', rid(90), { rule: 'kiểm' })).kind === 'needs_input';
      }],
  ];
  for (const [label, mutant, probe] of probes) {
    await t.test(label, async () => {
      assert.equal(await probe(await setupRecurring(t)), true, 'bản gốc chặn');
      const f = await setupRecurring(t);
      await f.db.exec(mutant);
      assert.equal(await probe(f), false, 'đột biến lọt ⇒ test không rỗng');
    });
  }
});

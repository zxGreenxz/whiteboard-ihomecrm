import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTaskActions, binding, BUILDING, OTHER_BUILDING, ROOM, USER, ORG, MANAGER, STAFF, CO_OWNER, MINH, ROOM_A201, TYPE_SUA, TYPE_VE_SINH,
  CREATE_SQL } from './task-action-fixture.mjs';
import { taskFollowInput } from './task-follow-contract.mjs';

// CV-M1 (CONG-VIEC-THAO-TAC-GHI.md mục 2–3) trên PGlite: task.create bằng tên qua RPC trang bốn tầng. Kiểm: ghi thẳng khi tự giao
// đủ thông tin (Q32), xem trước khi giao người khác / đoán / trùng / đề xuất người nhận (Q31, Q35, Q36), basis lượt 2, hạn mặc định
// hết ngày mai giờ công ty (Q30), giải tên (mơ hồ, ngoài phạm vi, toà ảo), hạn mức theo hạng (Q37), lỗi RLS của tầng ghi ⇒ lý do
// đóng + chốt biên nhận, sổ việc + audit. INSERT jobs đi qua RLS + trigger thật của bảng (mã việc, người tạo).
const rid = n => `00000000-0000-4000-8000-${String(700 + n).padStart(12, '0')}`;
const code = expected => error => error.code === expected;
// Ngày mai theo giờ Việt Nam tính ĐỘC LẬP với SQL (Intl, không dùng org_today_v1): bắt lỗi lấy nhầm ngày UTC (review Mốc 2, ghi nhận).
const tomorrowVN = () => { const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
  const next = new Date(`${today}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1); return next.toISOString().slice(0, 10); };
const inDays = async (db, n) => (await db.query("SELECT to_char((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date+$1::int,'YYYY-MM-DD') d", [n])).rows[0].d;

test('task.create (CV-M1): name resolution, confirm policy, basis, quota, RLS writer, ledger', { timeout: 300000 }, async t => {
  const f = await setupTaskActions(t);
  const { db, action, jobs, receipts, ledger, call } = f;

  await t.test('schema: policy row, limits seeded, shell is SQL-standard INVOKER, no app_private USAGE, quota/ledger closed to authenticated', async () => {
    assert.deepEqual((await db.query("SELECT capability,crm_permission,action_class,confirm,private_only FROM app_private.hermes_action_policies WHERE action='task.create'")).rows,
      [{ capability: 'tasks.create', crm_permission: 'tasks.create', action_class: 'reversible', confirm: 'never', private_only: true }]);
    assert.deepEqual((await db.query('SELECT tier,per_actor_hour,per_pair_hour FROM app_private.hermes_task_limits WHERE organization_id IS NULL ORDER BY tier')).rows,
      [{ tier: 'member', per_actor_hour: 30, per_pair_hour: 10 }, { tier: 'owner', per_actor_hour: 60, per_pair_hour: 40 }]);
    const shell = (await db.query("SELECT prosecdef,prosqlbody IS NOT NULL sqlbody FROM pg_proc WHERE oid='public.hermes_task_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)'::regprocedure")).rows[0];
    assert.deepEqual(shell, { prosecdef: false, sqlbody: true });
    assert.equal((await db.query("SELECT has_schema_privilege('authenticated','app_private','USAGE') ok")).rows[0].ok, false);
    assert.equal((await db.query("SELECT has_function_privilege('authenticated','app_private.hermes_task_quota_v1(uuid,uuid,uuid[])','EXECUTE') ok")).rows[0].ok, false);
    assert.equal((await db.query("SELECT has_table_privilege('authenticated','app_private.hermes_task_jobs','SELECT') ok")).rows[0].ok, false);
    const caps = await call('SELECT public.hermes_action_capabilities_v1($1::uuid) result', [ORG]);
    assert.deepEqual(caps.permissions['tasks.create'], { allowed: true, companyEnabled: true, buildingIds: [BUILDING, OTHER_BUILDING].sort() });
  });

  await t.test('self-assign with full info writes at once (Q32); default deadline = end of tomorrow (Q30); replay by requestId', async () => {
    const params = { buildingName: 'toa a', roomName: 'P101', jobType: 'sua', content: 'sửa vòi nước', assigneeName: 'tôi' };
    const applied = await action('auto', rid(1), params);
    assert.equal(applied.kind, 'applied', JSON.stringify(applied));
    assert.match(applied.link, /^\/tasks\?job=[0-9a-f-]{36}$/);
    const [job] = await jobs();
    assert.equal(job.title, 'sửa vòi nước', 'nội dung đã mở đầu bằng tên loại ⇒ không lặp');
    assert.equal(job.description, 'sửa vòi nước');
    assert.deepEqual([job.building_id, job.room_id, job.job_type_id, job.assignee_id, job.user_id, job.priority, job.status],
      [BUILDING, ROOM, TYPE_SUA, USER, USER, 'NORMAL', 'IN_PROGRESS']);
    const instant = (await db.query("SELECT to_char(deadline AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS') u FROM public.jobs WHERE id=$1", [job.id])).rows[0].u;
    assert.equal(instant, new Date(`${tomorrowVN()}T23:59:59.999+07:00`).toISOString().slice(0, 23), 'hết ngày mai giờ VN, đúng thời điểm UTC');
    assert.match(job.code, /^JOB-\d{8}-\d{4}$/);
    assert.equal(applied.result.deadlineDefaulted, true);
    assert.match(applied.result.text, /mặc định/);
    assert.equal(applied.result.job.assigneeSelf, true);
    // jobId (review Mốc 2 mục 5): dùng tiếp được cho crm_task_follow_set (luồng giao rồi theo dõi).
    assert.equal(applied.result.job.jobId, job.id);
    assert.equal(applied.link, `/tasks?job=${job.id}`);
    assert.equal(taskFollowInput('set', { requestId: rid(90), jobId: applied.result.job.jobId, objective: 'nhắc khi trễ' }).jobId, job.id);
    const { jobId: _jobId, ...namedJob } = applied.result.job;
    assert.ok(!JSON.stringify({ ...applied.result, job: namedJob }).match(/[0-9a-f]{8}-[0-9a-f]{4}-/), 'ngoài jobId (và link), kết quả chỉ có tên');
    assert.deepEqual(await ledger(), [{ job_id: job.id, actor_id: USER, assignee_id: USER, action: 'task.create', source: 'action' }]);
    assert.deepEqual((await receipts()).map(r => [r.request_id, r.state]), [[rid(1), 'applied']]);
    assert.equal((await db.query("SELECT count(*)::int n FROM public.authorization_audit_events WHERE event_type='HERMES_TASK_CREATED'")).rows[0].n, 1);
    assert.deepEqual(await action('auto', rid(1), params), applied, 'phát lại y nguyên, không tạo việc thứ hai');
    assert.equal((await jobs()).length, 1);
    const status = await call('SELECT public.hermes_action_status_v1($1::jsonb,$2::uuid) result', [JSON.stringify(binding), rid(1)]);
    assert.equal(status.outcome, 'applied');
  });

  await t.test('assigning someone else needs a preview (Q32); apply with the same basis writes; wrong basis ⇒ state_changed, no receipt', async () => {
    const params = { buildingName: 'Toà A', roomName: '201', jobType: 'sửa', content: 'vòi nước', assigneeName: 'nathan', deadline: await inDays(db, 3), deadlineTime: '17:00',
      description: 'Khoá van tổng trước khi thay', priority: 'URGENT' };
    const preview = await action('auto', rid(2), params);
    assert.equal(preview.kind, 'preview', JSON.stringify(preview));
    assert.equal(preview.confirm, 'required');
    assert.match(preview.preview.text, /Tạo việc 'sửa vòi nước' \(loại sửa\) — toà Toà A, phòng 201 — giao Nathan Quản Lý — hạn 17:00 /);
    assert.equal(preview.preview.assigneeManagesBuilding, true);
    assert.equal((await jobs()).length, 1, 'xem trước không ghi');
    assert.equal((await receipts()).some(r => r.request_id === rid(2)), false, 'xem trước không mở biên nhận');
    assert.deepEqual(await action('apply', rid(2), params, { resolved: preview.resolved, basis: 'khác' }), { kind: 'rejected', reason: 'state_changed' });
    assert.equal((await receipts()).some(r => r.request_id === rid(2)), false);
    const applied = await action('apply', rid(2), params, preview);
    assert.equal(applied.kind, 'applied', JSON.stringify(applied));
    const job = (await jobs()).at(-1);
    assert.deepEqual([job.room_id, job.assignee_id, job.title, job.local_deadline.slice(11), job.description, job.priority],
      [ROOM_A201, MANAGER, 'sửa vòi nước', '17:00:00.000', 'Khoá van tổng trước khi thay', 'URGENT']);
  });

  await t.test('missing assignee (Q31): exactly one manager ⇒ suggested in the preview; none ⇒ needs_input with why unspecified', async () => {
    const one = await action('auto', rid(3), { buildingName: 'Toà A', roomName: 'P101', jobType: 'sửa', content: 'khoá cửa' });
    assert.equal(one.kind, 'preview', JSON.stringify(one));
    assert.match(one.preview.text, /^Chưa nêu người nhận — đề xuất giao Nathan Quản Lý \(quản lý toà Toà A\)\. /);
    assert.equal(one.resolved.assigneeId, MANAGER);
    assert.equal(one.resolved.assigneeSuggested, true);
    // Toà B: chỉ chủ (OWNER) có tasks.edit ⇒ không ai được đề xuất.
    assert.deepEqual(await action('auto', rid(4), { buildingName: 'Toà B', roomName: 'P201', jobType: 'sửa', content: 'khoá cửa' }),
      { kind: 'needs_input', reason: 'name_unresolved', field: 'person', wanted: '', why: 'unspecified', candidates: [], more: false });
    await f.rollbackCase(async () => {
      // Người hỏi là người quản lý duy nhất của toà B (không phải OWNER): đề xuất chính họ vẫn phải hỏi lại (Q31), không ghi thẳng.
      await db.query("UPDATE public.organization_memberships SET member_type='STAFF' WHERE user_id=$1", [USER]);
      const self = await action('auto', rid(24), { buildingName: 'Toà B', roomName: 'P201', jobType: 'sửa', content: 'khoá cửa' });
      assert.equal(self.kind, 'preview', JSON.stringify(self));
      assert.match(self.preview.text, /^Chưa nêu người nhận — đề xuất giao chính anh\/chị \(quản lý toà Toà B\)\. /);
    });
  });

  await t.test('assignee words that can be names (review Mốc 2, chặn 1): Minh/mình/anh/own name never write straight to the asker', async () => {
    const base = { buildingName: 'Toà A', roomName: 'P101', jobType: 'checkin', content: 'kiểm đồng hồ' };
    // Có thành viên "Nguyễn Văn Minh": "Minh" và cả "mình" (bỏ dấu cũng là "minh") ⇒ giao cho người đó, qua xem trước có câu nói rõ.
    for (const [n, said] of [[30, 'Minh'], [31, 'mình']]) {
      const preview = await action('auto', rid(n), { ...base, assigneeName: said });
      assert.equal(preview.kind, 'preview', `${said}: ${JSON.stringify(preview)}`);
      assert.equal(preview.resolved.assigneeId, MINH, `${said} ⇒ Nguyễn Văn Minh, không phải người hỏi`);
      assert.ok(preview.warnings.includes(`Hiểu '${said}' là người nhận Nguyễn Văn Minh; nếu ý là chính anh/chị, nói "giao cho tôi".`), said);
    }
    await f.rollbackCase(async () => {
      // Không còn ai tên Minh: "mình" hiểu là chính người hỏi nhưng LUÔN xem trước (không ghi thẳng như "tôi").
      await db.query("UPDATE public.organization_memberships SET status='SUSPENDED' WHERE user_id=$1", [MINH]);
      for (const [n, said] of [[32, 'mình'], [33, 'anh']]) {
        const preview = await action('auto', rid(n), { ...base, assigneeName: said });
        assert.equal(preview.kind, 'preview', said);
        assert.equal(preview.resolved.assigneeId, USER);
        assert.ok(preview.warnings.includes(`Hiểu '${said}' là chính anh/chị; nếu là người khác, nêu đủ tên người đó.`), said);
      }
      assert.equal((await receipts()).some(r => [rid(32), rid(33)].includes(r.request_id)), false, 'không ghi gì');
    });
    // Tên giải ra đúng người hỏi cũng là mơ hồ ⇒ xem trước; chỉ "tôi"/"tui"/"chính mình"… mới ghi thẳng (ca tự giao ở trên).
    const own = await action('auto', rid(34), { ...base, assigneeName: 'Chủ Thử' });
    assert.equal(own.kind, 'preview');
    assert.equal(own.resolved.assigneeId, USER);
    // Người nhận không có tasks.edit ở toà ⇒ cảnh báo (Q35); câu "vẫn thấy việc" đúng khi 20261022031600 đã áp (áp trước/cùng file này).
    const outsider = await action('auto', rid(35), { ...base, assigneeName: 'huy' });
    assert.equal(outsider.kind, 'preview');
    assert.equal(outsider.preview.assigneeManagesBuilding, false);
    assert.ok(outsider.warnings.includes('Huy Nhân Viên không có quyền công việc ở toà Toà A: vẫn thấy việc nhưng không sửa/hoàn thành được trên web.'));
  });

  await t.test('names: ambiguous room, virtual building, outside scope never write; job type guessed by the longest prefix', async () => {
    const ambiguous = await action('auto', rid(5), { roomName: '201', jobType: 'sửa', content: 'x', assigneeName: 'tôi' });
    assert.equal(ambiguous.kind, 'needs_input'); assert.equal(ambiguous.field, 'room'); assert.equal(ambiguous.why, 'ambiguous');
    assert.deepEqual(ambiguous.candidates, [{ name: '201', buildingName: 'Toà A' }, { name: 'P201', buildingName: 'Toà B' }], 'khoá phòng: P201 = 201 như web');
    const virtual = await action('auto', rid(6), { buildingName: 'Kho Văn Phòng Chung', jobType: 'sửa', content: 'x', assigneeName: 'tôi' });
    assert.deepEqual([virtual.kind, virtual.field, virtual.why], ['needs_input', 'building', 'not_visible'], 'toà ảo không nhận (khớp web)');
    const guessed = await action('auto', rid(7), { buildingName: 'Toà A', roomName: 'cả toà', content: 'vệ sinh hành lang', assigneeName: 'tôi' });
    assert.equal(guessed.kind, 'preview', 'loại do máy chủ đoán ⇒ xem trước dù tự giao');
    assert.equal(guessed.resolved.jobTypeId, TYPE_VE_SINH, 'vệ sinh (dài nhất), không phải vệ');
    assert.deepEqual(guessed.warnings, ["Loại việc 'vệ sinh' do bot chọn theo nội dung."], 'cả toà nói rõ ⇒ không cảnh báo thiếu phòng');
    const noType = await action('auto', rid(8), { buildingName: 'Toà A', content: 'kiểm máy bơm', assigneeName: 'tôi' });
    assert.deepEqual([noType.kind, noType.field, noType.why, noType.wanted], ['needs_input', 'jobType', 'unspecified', '']);
    assert.deepEqual(noType.candidates.map(c => c.name), ['checkin', 'sửa', 'vệ', 'vệ sinh'], 'loại đã tắt không hiện');
    const noRoom = await action('auto', rid(9), { buildingName: 'Toà A', jobType: 'sửa', content: 'bóng đèn hành lang', assigneeName: 'tôi' });
    assert.equal(noRoom.kind, 'preview');
    assert.ok(noRoom.warnings.includes('Chưa nêu phòng: việc cho CẢ TOÀ.'));
    assert.deepEqual(await action('auto', rid(10), { jobType: 'sửa', content: 'x', assigneeName: 'tôi' }),
      { kind: 'needs_input', reason: 'name_unresolved', field: 'building', wanted: '', why: 'unspecified', candidates: [], more: false });
    assert.equal((await jobs()).length, 2);
  });

  await t.test('duplicate open job (Q36) ⇒ preview names it; a new duplicate between turns ⇒ state_changed', async () => {
    const params = { buildingName: 'Toà A', roomName: 'P101', jobType: 'sửa', content: 'vòi nước lại', assigneeName: 'tôi' };
    const preview = await action('auto', rid(11), params);
    assert.equal(preview.kind, 'preview', 'đã có việc sửa đang mở ở P101 ⇒ xem trước dù tự giao');
    assert.match(preview.warnings[0], /^Đã có việc JOB-\d{8}-\d{4} 'sửa vòi nước' đang mở ở chỗ này \(giao Chủ Thử, hạn \d\d\/\d\d\) — vẫn tạo thêm\?$/);
    assert.equal(preview.preview.duplicates, 1);
    await db.query(`INSERT INTO public.jobs(user_id,organization_id,title,building_id,room_id,job_type_id,priority,status) VALUES($1,$2,'sửa ống',$3,$4,$5,'NORMAL','IN_PROGRESS')`,
      [USER, ORG, BUILDING, ROOM, TYPE_SUA]);
    assert.deepEqual(await action('apply', rid(11), params, preview), { kind: 'rejected', reason: 'state_changed' });
  });

  await t.test('deadline in the past ⇒ needs_input date_out_of_range; tampered resolved ids at apply ⇒ not_allowed', async () => {
    assert.deepEqual(await action('auto', rid(12), { buildingName: 'Toà A', jobType: 'sửa', content: 'x', assigneeName: 'tôi', deadline: await inDays(db, -1) }),
      { kind: 'needs_input', reason: 'date_out_of_range' });
    const preview = await action('auto', rid(13), { buildingName: 'Toà A', roomName: 'P101', jobType: 'sửa', content: 'x', assigneeName: 'nathan' });
    const forged = { ...preview.resolved, buildingId: '00000000-0000-4000-8000-0000000000d1' };
    assert.deepEqual(await action('apply', rid(13), {}, { resolved: forged, basis: preview.basis }), { kind: 'rejected', reason: 'not_allowed' });
    await assert.rejects(action('apply', rid(14), {}, { resolved: {}, basis: 'x' }), code('22023'));
  });

  await t.test('outside the write scope of the key: named building ⇒ outside_scope without names; RLS refusal in the writer is final', async () => {
    await f.rollbackCase(async () => {
      await db.query("UPDATE public.fixture_acl SET building_ids=$1 WHERE permission='tasks.create'", [[BUILDING]]);
      assert.deepEqual(await action('auto', rid(15), { buildingName: 'Toà B', jobType: 'sửa', content: 'x', assigneeName: 'tôi' }),
        { kind: 'needs_input', reason: 'name_unresolved', field: 'building', wanted: 'Toà B', why: 'outside_scope', candidates: [], more: false });
    });
    await f.rollbackCase(async () => {
      // Bản đã giải ở lượt 1 hợp lệ; khoá bị thu hẹp trước lượt 2 ⇒ lượt 2 kiểm lại phạm vi và từ chối, không ghi.
      const params = { buildingName: 'Toà B', roomName: 'P201', jobType: 'sửa', content: 'thu hẹp phạm vi', assigneeName: 'nathan' };
      const preview = await action('auto', rid(23), params);
      assert.equal(preview.kind, 'preview');
      await db.query("UPDATE public.fixture_acl SET building_ids=$1 WHERE permission='tasks.create'", [[BUILDING]]);
      assert.deepEqual(await action('apply', rid(23), params, preview), { kind: 'rejected', reason: 'not_allowed' });
      assert.equal((await receipts()).some(r => r.request_id === rid(23)), false);
    });
    await f.rollbackCase(async () => {
      await db.query('UPDATE public.fixture_rls SET deny_insert=true');
      const before = (await jobs()).length;
      const refused = await action('auto', rid(16), { buildingName: 'Toà A', roomName: 'P101', jobType: 'checkin', content: 'x', assigneeName: 'tôi' });
      assert.deepEqual(refused, { kind: 'rejected', reason: 'not_allowed' });
      assert.equal((await jobs()).length, before, 'RLS chặn ⇒ không có việc');
      assert.deepEqual((await receipts()).filter(r => r.request_id === rid(16)).map(r => [r.state, r.sqlstate]), [['rejected', '42501']]);
      assert.deepEqual(await action('auto', rid(16), { buildingName: 'Toà A', roomName: 'P101', jobType: 'checkin', content: 'x', assigneeName: 'tôi' }), refused, 'phát lại');
    });
  });

  await t.test('quota (Q37): member and owner tiers, per actor and per pair, refused before the receipt (not stored)', async () => {
    await f.rollbackCase(async () => {
      await db.query("UPDATE app_private.hermes_task_limits SET per_actor_hour=4,per_pair_hour=3 WHERE organization_id IS NULL AND tier='owner'");
      // Đã có 1 việc tự giao (rid 1) + 1 việc giao Nathan (rid 2) trong giờ: cặp (chủ, chủ) còn 2, tổng còn 2.
      for (const [n, room] of [[17, 'cả toà'], [18, 'P101']]) assert.equal((await action('auto', rid(n), { buildingName: 'Toà A', roomName: room, jobType: 'checkin', content: `c${n}`, assigneeName: 'tôi' })).kind, 'applied');
      assert.deepEqual(await action('auto', rid(19), { buildingName: 'Toà A', roomName: '201', jobType: 'checkin', content: 'c19', assigneeName: 'tôi' }),
        { kind: 'rejected', reason: 'task_quota_user' });
      assert.equal((await receipts()).some(r => r.request_id === rid(19)), false, 'từ chối trước khi ghi: không chốt');
    });
    await f.rollbackCase(async () => {
      // Cặp (chủ, Nathan) đã có 1 việc trong giờ (rid 2): trần cặp 2 ⇒ thêm được 1, việc kế bị từ chối theo cặp.
      await db.query("UPDATE app_private.hermes_task_limits SET per_actor_hour=60,per_pair_hour=2 WHERE organization_id IS NULL AND tier='owner'");
      const params = n => ({ buildingName: 'Toà A', roomName: 'P101', jobType: 'checkin', content: `kiểm ${n}`, assigneeName: 'nathan' });
      const first = await action('auto', rid(20), params(20));
      assert.equal((await action('apply', rid(20), params(20), first)).kind, 'applied');
      const second = await action('auto', rid(21), params(21));
      assert.deepEqual(await action('apply', rid(21), params(21), second), { kind: 'rejected', reason: 'task_quota_pair' });
      assert.equal((await receipts()).some(r => r.request_id === rid(21)), false);
    });
    await f.rollbackCase(async () => {
      // Hạng theo member_type: người hỏi không còn OWNER ⇒ dòng member.
      await db.query("UPDATE public.organization_memberships SET member_type='STAFF' WHERE user_id=$1", [USER]);
      await db.query("UPDATE app_private.hermes_task_limits SET per_actor_hour=2 WHERE organization_id IS NULL AND tier='member'");
      assert.deepEqual(await action('auto', rid(22), { buildingName: 'Toà A', roomName: 'cả toà', jobType: 'checkin', content: 'c22', assigneeName: 'tôi' }),
        { kind: 'rejected', reason: 'task_quota_user' });
    });
  });

  await t.test('managers helper: excludes OWNER members, needs a member caller who sees the building', async () => {
    const managers = async (building, actor = USER) => call('SELECT to_jsonb(app_private.hermes_task_building_managers_v1($1::uuid,$2::uuid)) result', [ORG, building], { role: 'postgres', actor });
    assert.deepEqual(await managers(BUILDING), [MANAGER], 'Chủ Hai (OWNER) có tasks.edit nhưng không được đề xuất');
    assert.deepEqual(await managers(OTHER_BUILDING), []);
    assert.deepEqual(await managers(BUILDING, '00000000-0000-4000-8000-0000000000c4'), [], 'người ngoài công ty');
    assert.deepEqual(await managers(BUILDING, STAFF), [], 'Huy không xem được toà A');
    void CO_OWNER;
  });

  await t.test('idempotent re-apply keeps policy/limits/ledger', async () => {
    const before = await ledger();
    await db.exec(CREATE_SQL);
    assert.deepEqual(await ledger(), before);
  });
});

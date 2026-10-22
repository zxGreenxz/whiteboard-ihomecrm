import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTaskActions, binding, BUILDING, OTHER_BUILDING, ORG, USER, MANAGER, STAFF, MINH } from './task-action-fixture.mjs';

// Mốc 3 (CONG-VIEC-THAO-TAC-GHI.md mục 19) trên PGlite: task.update + task.cancel qua cùng vỏ hermes_task_action_v1 (20261022074741).
// Kiểm: tìm việc theo mã / 4 số cuối / "vừa giao" / tiêu đề, mơ hồ ⇒ hỏi lại kèm mã + toà, KHÔNG tự chọn (sự cố huỷ nhầm 21/10);
// ghi chú tiến độ ghi nối; đổi hạn / người nhận / tiêu đề ⇒ xem trước; ưu tiên hoặc ghi chú theo mã đầy đủ ⇒ ghi thẳng; huỷ LUÔN xem
// trước, xoá hẳn như web, nhật ký giữ mã + tiêu đề; việc có vật tư / ảnh hoàn thành ⇒ cancel_blocked kèm link (CV12); việc đã xong ⇒
// task_not_open kèm link; basis lượt 2; phát lại theo requestId. UPDATE / DELETE đi qua RLS jobs (tasks.edit / tasks.delete) thật.
const rid = n => `00000000-0000-4000-8000-${String(500 + n).padStart(12, '0')}`;
const VN = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(d);
const inDaysVN = n => { const day = new Date(`${VN(new Date())}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + n); return day.toISOString().slice(0, 10); };

test('Mốc 3: task.update / task.cancel by name on the shared shell — never picks among ambiguous jobs, cancel always previews', { timeout: 300000 }, async t => {
  const f = await setupTaskActions(t);
  const { db, action, call } = f;
  // Kết nối + trần công ty giữ thêm tasks.edit / tasks.delete; quyền CRM của người hỏi: tasks.delete chỉ ở toà A.
  await db.query("UPDATE app_private.hermes_org_policies SET action_capabilities=action_capabilities||ARRAY['tasks.edit','tasks.delete']");
  await db.query("UPDATE app_private.hermes_connections SET action_capabilities=action_capabilities||ARRAY['tasks.edit','tasks.delete']");
  await db.query("INSERT INTO public.fixture_acl(permission,building_ids) VALUES('tasks.delete',$1) ON CONFLICT(permission) DO UPDATE SET building_ids=excluded.building_ids,allowed=true", [[BUILDING]]);
  const edit = (name, phase, requestId, params, extra = {}) => call('SELECT public.hermes_task_action_v1($1::jsonb,$2,$3,$4::uuid,$5::jsonb,$6::jsonb,$7) result',
    [JSON.stringify(binding), name, phase, requestId, JSON.stringify(params), extra.resolved ? JSON.stringify(extra.resolved) : null, extra.basis ?? null]);
  const job = async code => (await db.query('SELECT * FROM public.jobs WHERE code=$1', [code])).rows[0];
  const create = async (n, params) => {
    const out = await action('auto', rid(n), { assigneeName: 'tôi', jobType: 'sửa', ...params });
    assert.equal(out.kind, 'applied', JSON.stringify(out)); return out.result.job;
  };
  const a = await create(1, { buildingName: 'Toà A', roomName: 'P101', content: 'sửa vòi nước bếp' });
  const b = await create(2, { buildingName: 'Toà B', roomName: 'P201', content: 'sửa vòi nước tắm' });
  const c = await create(3, { buildingName: 'Toà A', roomName: 'cả toà', content: 'sửa đèn hành lang' });

  await t.test('note by exact code: written at once, APPENDED with time + author; second note on a new line; audit keeps code', async () => {
    const first = await edit('task.update', 'auto', rid(10), { job: a.code, note: 'đã mua vòi' });
    assert.equal(first.kind, 'applied', JSON.stringify(first));
    assert.deepEqual(first.result.changed, ['ghi chú tiến độ']);
    assert.equal(first.link, `/tasks?job=${a.jobId}`);
    const second = await edit('task.update', 'auto', rid(11), { job: a.code.toLowerCase(), note: 'chiều lắp' });
    assert.equal(second.kind, 'applied');
    const note = (await job(a.code)).completion_description;
    assert.match(note, /^\d{2}\/\d{2} \d{2}:\d{2} Chủ Thử: đã mua vòi\n\d{2}\/\d{2} \d{2}:\d{2} Chủ Thử: chiều lắp$/);
    const audit = (await db.query("SELECT old_state,new_state FROM public.authorization_audit_events WHERE event_type='HERMES_TASK_UPDATED' ORDER BY occurred_at,id")).rows;
    assert.equal(audit.length, 2);
    assert.equal(audit[0].old_state.code, a.code);
    assert.deepEqual(audit[0].new_state.changed, ['note']);
    // Cùng requestId gọi lại ⇒ phát lại, không nối thêm lần nữa.
    assert.deepEqual(await edit('task.update', 'auto', rid(11), { job: a.code.toLowerCase(), note: 'chiều lắp' }), second);
    assert.equal((await job(a.code)).completion_description, note);
  });

  await t.test('title in two buildings ⇒ ask with code + building, never pick; narrowing by building ⇒ one job, still previewed (matched by title)', async () => {
    const asked = await edit('task.update', 'auto', rid(20), { job: 'vòi nước', priority: 'URGENT' });
    assert.deepEqual([asked.kind, asked.field, asked.why, asked.wanted], ['needs_input', 'job', 'ambiguous', 'vòi nước'], JSON.stringify(asked));
    assert.deepEqual(asked.candidates.map(x => [x.name.split(' · ')[0], x.buildingName]).sort(), [[a.code, 'Toà A'], [b.code, 'Toà B']].sort());
    assert.match(asked.candidates[0].name, /^JOB-\d{8}-\d{4} · sửa vòi nước (bếp|tắm) \((P101|P201), Chủ Thử\)$/);
    const narrowed = await edit('task.update', 'auto', rid(21), { job: 'vòi nước', buildingName: 'Toà A', priority: 'URGENT' });
    assert.equal(narrowed.kind, 'preview', 'tìm theo tiêu đề ⇒ luôn xem trước');
    assert.ok(narrowed.warnings.some(w => w.startsWith('Tìm theo tiêu đề')));
    assert.match(narrowed.preview.text, new RegExp(`^Việc ${a.code} 'sửa vòi nước bếp' \\(toà Toà A, phòng P101 — giao chính anh/chị\\): ưu tiên Bình thường → Gấp\\.$`));
    const applied = await edit('task.update', 'apply', rid(21), { job: 'vòi nước', buildingName: 'Toà A', priority: 'URGENT' }, narrowed);
    assert.equal(applied.kind, 'applied', JSON.stringify(applied));
    assert.equal((await job(a.code)).priority, 'URGENT');
    assert.equal((await job(b.code)).priority, 'NORMAL', 'việc cùng tên ở toà khác không bị chạm');
  });

  await t.test('suffix digits, "vừa giao"; deadline / assignee / title changes preview; basis guards the second turn', async () => {
    const bySuffix = await edit('task.update', 'auto', rid(30), { job: c.code.slice(-4), priority: 'LOW' });
    assert.equal(bySuffix.kind, 'preview');
    assert.ok(bySuffix.warnings.some(w => w.startsWith('Tìm theo số cuối của mã')));
    const recent = await edit('task.update', 'preview', rid(31), { job: 'việc vừa giao', note: 'x' });
    assert.equal(recent.preview.code, c.code, '"vừa giao" = việc mới nhất người hỏi tạo trong 24 giờ');
    const day = inDaysVN(4);
    const moved = await edit('task.update', 'auto', rid(32), { job: c.code, deadline: day });
    assert.equal(moved.kind, 'preview', 'đổi hạn ⇒ xem trước');
    assert.match(moved.preview.text, /hạn hết .* → hết .*\(còn 4 ngày\)/);
    // Việc đổi giữa hai lượt ⇒ state_changed, không ghi.
    await db.query("UPDATE public.jobs SET title='sửa đèn hành lang tầng 2' WHERE code=$1", [c.code]);
    assert.deepEqual(await edit('task.update', 'apply', rid(32), { job: c.code, deadline: day }, moved), { kind: 'rejected', reason: 'state_changed' });
    const again = await edit('task.update', 'auto', rid(33), { job: c.code, deadline: day });
    assert.equal((await edit('task.update', 'apply', rid(33), { job: c.code, deadline: day }, again)).kind, 'applied');
    const local = (await db.query("SELECT to_char(deadline AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY-MM-DD HH24:MI:SS.MS') d FROM public.jobs WHERE code=$1", [c.code])).rows[0].d;
    assert.equal(local, `${day} 23:59:59.999`);
    const toStaff = await edit('task.update', 'auto', rid(34), { job: c.code, assigneeName: 'Huy Nhân Viên' });
    assert.equal(toStaff.kind, 'preview');
    assert.ok(toStaff.warnings.includes('Huy Nhân Viên không có quyền công việc ở toà Toà A: vẫn thấy việc nhưng không sửa/hoàn thành được trên web.'));
    assert.equal(toStaff.preview.assigneeManagesBuilding, false);
    const toManager = await edit('task.update', 'auto', rid(35), { job: c.code, assigneeName: 'Nathan', content: 'Thay bóng đèn hành lang' });
    assert.equal(toManager.kind, 'preview');
    assert.match(toManager.preview.text, /người nhận chính anh\/chị → Nathan Quản Lý; tiêu đề → 'Thay bóng đèn hành lang'/);
    assert.equal((await edit('task.update', 'apply', rid(35), { job: c.code, assigneeName: 'Nathan', content: 'Thay bóng đèn hành lang' }, toManager)).kind, 'applied');
    const row = await job(c.code);
    assert.deepEqual([row.assignee_id, row.title], [MANAGER, 'Thay bóng đèn hành lang']);
    const mine = await edit('task.update', 'auto', rid(36), { job: c.code, assigneeName: 'mình' });
    assert.equal(mine.kind, 'preview');
    assert.ok(mine.warnings.some(w => w.startsWith("Hiểu 'mình' là người nhận Nguyễn Văn Minh")), 'xưng hô mơ hồ như task.create');
    assert.notEqual(MINH, USER);
  });

  await t.test('nothing to change, unknown job, finished job (task_not_open + link)', async () => {
    assert.deepEqual(await edit('task.update', 'auto', rid(40), { job: a.code }), { kind: 'needs_input', reason: 'invalid_params' });
    assert.deepEqual(await edit('task.update', 'auto', rid(41), { job: a.code, priority: 'URGENT' }), { kind: 'needs_input', reason: 'invalid_params' }, 'đổi sang đúng giá trị đang có');
    const missing = await edit('task.update', 'auto', rid(42), { job: 'JOB-20200101-9999', note: 'x' });
    assert.deepEqual([missing.kind, missing.why, missing.candidates], ['needs_input', 'not_visible', []]);
    await db.query("UPDATE public.jobs SET status='COMPLETED' WHERE code=$1", [b.code]);
    assert.deepEqual(await edit('task.update', 'auto', rid(43), { job: b.code, note: 'x' }),
      { kind: 'rejected', reason: 'task_not_open', link: `/tasks?job=${b.jobId}` });
    assert.deepEqual(await edit('task.update', 'auto', rid(44), { job: 'vòi nước tắm', note: 'x' }), { kind: 'rejected', reason: 'task_not_open' },
      'chỉ khớp việc đã xong theo tiêu đề ⇒ không mở việc khác');
  });

  await t.test('cancel: always previews (even auto), deletes like web, audit keeps code + title; replay; out of delete scope ⇒ not found', async () => {
    const d = await create(50, { buildingName: 'Toà A', roomName: '201', content: 'sửa cửa sổ' });
    const preview = await edit('task.cancel', 'auto', rid(51), { job: d.code, reason: 'khách tự sửa rồi' });
    assert.equal(preview.kind, 'preview', 'irreversible ⇒ luôn xem trước');
    assert.match(preview.preview.text, new RegExp(`^Huỷ hẳn việc ${d.code} 'sửa cửa sổ' — toà Toà A, phòng 201 — giao chính anh/chị — hạn hết .* — đang làm\\. Không khôi phục được; nhật ký giữ mã và tiêu đề\\.$`));
    assert.ok(await job(d.code), 'xem trước không xoá');
    const applied = await edit('task.cancel', 'apply', rid(51), { job: d.code, reason: 'khách tự sửa rồi' }, preview);
    assert.equal(applied.kind, 'applied', JSON.stringify(applied));
    assert.match(applied.result.text, new RegExp(`^Đã huỷ việc ${d.code} 'sửa cửa sổ' — toà Toà A, phòng 201\\. Nhật ký giữ mã và tiêu đề\\.$`));
    assert.equal(await job(d.code), undefined);
    const audit = (await db.query("SELECT old_state,reason FROM public.authorization_audit_events WHERE event_type='HERMES_TASK_CANCELLED'")).rows;
    assert.deepEqual([audit.length, audit[0].old_state.code, audit[0].old_state.title, audit[0].reason], [1, d.code, 'sửa cửa sổ', 'Hermes task cancel: khách tự sửa rồi']);
    assert.deepEqual(await edit('task.cancel', 'apply', rid(51), { job: d.code, reason: 'khách tự sửa rồi' }, preview), applied, 'phát lại theo requestId');
    // tasks.delete chỉ ở toà A: việc ở toà B không nằm trong phạm vi tìm của khoá xoá.
    await db.query("UPDATE public.jobs SET status='IN_PROGRESS' WHERE code=$1", [b.code]);
    const outside = await edit('task.cancel', 'auto', rid(52), { job: b.code });
    assert.deepEqual([outside.kind, outside.why], ['needs_input', 'not_visible']);
  });

  await t.test('cancel blocked by materials or completion photos ⇒ cancel_blocked + web link (CV12); changed job between turns ⇒ state_changed', async () => {
    const e = await create(60, { buildingName: 'Toà A', roomName: '201', content: 'sửa ổ khoá' });
    await db.query('INSERT INTO public.material_usages(job_id) SELECT id FROM public.jobs WHERE code=$1', [e.code]);
    assert.deepEqual(await edit('task.cancel', 'auto', rid(61), { job: e.code }), { kind: 'rejected', reason: 'cancel_blocked', link: `/tasks?job=${e.jobId}` });
    const g = await create(62, { buildingName: 'Toà A', roomName: 'cả toà', jobType: 'vệ sinh', content: 'vệ sinh bể nước' });
    await db.query(`UPDATE public.jobs SET completion_attachments='["x"]'::jsonb WHERE code=$1`, [g.code]);
    assert.equal((await edit('task.cancel', 'auto', rid(63), { job: g.code })).reason, 'cancel_blocked');
    const h = await create(64, { buildingName: 'Toà A', roomName: 'P101', jobType: 'vệ sinh', content: 'vệ sinh rèm' });
    const preview = await edit('task.cancel', 'auto', rid(65), { job: h.code });
    assert.ok(preview.warnings.includes('Chưa nêu lý do huỷ (không bắt buộc; nêu thì vào nhật ký).'));
    await db.query("UPDATE public.jobs SET assignee_id=$2 WHERE code=$1", [h.code, MANAGER]);
    assert.deepEqual(await edit('task.cancel', 'apply', rid(65), { job: h.code }, preview), { kind: 'rejected', reason: 'state_changed' });
    assert.ok(await job(h.code), 'không xoá');
    assert.equal((await db.query('SELECT count(*)::int n FROM public.jobs WHERE organization_id=$1', [ORG])).rows[0].n >= 5, true);
    assert.notEqual(OTHER_BUILDING, BUILDING); assert.notEqual(STAFF, USER);
  });
});

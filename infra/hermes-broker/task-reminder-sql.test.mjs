import assert from 'node:assert/strict';
import test from 'node:test';
import { setupReminders, bindUser, REMINDER_SQL, WORKER_SQL, ORG, USER, ACCOUNT, INSTANCE, BINDING, FOREIGN, STAFF, OTHER_INSTANCE } from './task-reminder-fixture.mjs';

// Công việc Mốc 6 (CONG-VIEC-THAO-TAC-GHI.md mục 6, 23): hàng đợi nhắc việc Zalo trên PGlite. Bộ sinh nhận p_now cố định (thứ Sáu
// 23/10/2026 giờ Việt Nam); RPC worker dùng giờ thật nên đi thẳng vào hàng đợi với ngày hôm nay giờ Việt Nam.
const AT = '2026-10-23 08:05:00+07';
const DUE = '2026-10-23 23:59:59.999+07', OVER2 = '2026-10-21 23:59:59.999+07', OVER5 = '2026-10-18 23:59:59.999+07';
const TOMORROW = '2026-10-24 23:59:59.999+07';
const iso = value => new Date(value).toISOString();
const todayEnd = async db => iso((await db.query(
  "SELECT (((clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date+1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')-interval '1 millisecond' t")).rows[0].t);
const noQuiet = db => db.query('INSERT INTO app_private.notification_org_config(organization_id,quiet_start,quiet_end) VALUES($1,0,0) ON CONFLICT(organization_id) DO UPDATE SET quiet_start=0,quiet_end=0', [ORG]);
const clear = db => db.query('DELETE FROM app_private.task_reminder_outbox');
const zero = { organizations: 0, queued: 0, quiet: 0, busy: 0, failed: 0, reaped: 0, pruned: 0 };

test('locked OFF: no config row ⇒ nothing queued; enabled ⇒ only inside [due_hour, send_until_hour)', { timeout: 300000 }, async t => {
  const f = await setupReminders(t);
  await f.job('JOB-A', USER, DUE);
  assert.deepEqual(await f.enqueue(AT), zero);
  await f.enable();
  assert.equal((await f.enqueue('2026-10-23 07:59:00+07')).queued, 0, 'trước 08:00');
  assert.equal((await f.enqueue('2026-10-23 11:00:00+07')).queued, 0, 'từ 11:00 không sinh nhắc mới');
  assert.equal((await f.outbox()).length, 0);
  assert.equal((await f.enqueue(AT)).queued, 1);
});

test('picks due-today + overdue ≤ N days for the bound assignee, one message per kind per day, rerun-safe, content has no extra fields', { timeout: 300000 }, async t => {
  const f = await setupReminders(t);
  const { db } = f;
  await f.enable({ url: 'https://app.example.vn' });
  const a = await f.job('JOB-A', USER, DUE, { title: 'Sửa vòi nước' });
  const b = await f.job('JOB-B', USER, DUE, { title: 'Kiểm bình\n  chữa cháy', room: false });
  const c = await f.job('JOB-C', USER, OVER2);
  await f.job('JOB-D', USER, OVER5);
  await f.job('JOB-E', USER, TOMORROW);
  await f.job('JOB-F', USER, DUE, { status: 'COMPLETED' });
  await f.job('JOB-G', STAFF, DUE);
  await f.job('JOB-H', USER, DUE, { org: FOREIGN });
  const r = await f.enqueue(AT);
  assert.deepEqual([r.organizations, r.queued, r.quiet, r.failed], [1, 2, 0, 0]);
  const rows = await f.outbox();
  assert.deepEqual(rows.map(row => [row.user_id, row.kind, row.reminder_date, row.job_ids, row.job_total, row.binding_id, row.state, iso(row.not_before)]), [
    [USER, 'due_today', '2026-10-23', [a, b], 2, BINDING, 'queued', iso(AT)],
    [USER, 'overdue', '2026-10-23', [c], 1, BINDING, 'queued', iso(AT)]]);
  assert.equal(rows[0].body, 'Nhắc việc: 2 việc hạn hôm nay (23/10):\n• JOB-A · Sửa vòi nước · 111PVC/101 · hạn 23:59\n'
    + '• JOB-B · Kiểm bình chữa cháy · 111PVC · hạn 23:59\nXem và cập nhật: https://app.example.vn/tasks');
  assert.equal(rows[1].body, 'Nhắc việc: 1 việc đã quá hạn:\n• JOB-C · việc JOB-C · 111PVC/101 · quá hạn 2 ngày (hạn 21/10)\n'
    + 'Xem và cập nhật: https://app.example.vn/tasks');
  assert.equal((await f.enqueue(AT)).queued, 0, 'chạy lại ⇒ không gửi trùng');
  assert.equal((await f.enqueue('2026-10-23 08:20:00+07')).queued, 0, 'lượt cron sau ⇒ không gửi trùng');
  // Nhân viên chưa liên kết Zalo không nhận gì; liên kết xong thì lượt sau có tin của họ.
  await bindUser(db, STAFF, '31', '789');
  assert.equal((await f.enqueue('2026-10-23 08:35:00+07')).queued, 1);
  // Ngày hôm sau: quá hạn tính lại (JOB-C quá 3 ngày vẫn nhắc, JOB-A/B quá 1 ngày), JOB-E thành hạn hôm nay.
  await clear(db);
  assert.equal((await f.enqueue('2026-10-24 08:05:00+07')).queued, 3);
  const next = (await f.outbox()).filter(row => row.user_id === USER);
  assert.deepEqual(next.map(row => [row.kind, row.job_total]), [['due_today', 1], ['overdue', 3]]);
  // > 10 việc ⇒ liệt kê 10, phần còn lại thành "… và N việc khác"; luôn ≤ 1000 ký tự.
  await clear(db);
  for (let i = 0; i < 13; i += 1) await f.job(`JOB-X${String(i).padStart(2, '0')}`, USER, '2026-10-25 23:59:59.999+07', { title: 'x'.repeat(200) });
  await f.enqueue('2026-10-25 08:05:00+07');
  const many = (await f.outbox()).find(row => row.user_id === USER && row.kind === 'due_today');
  assert.equal(many.job_total, 13);
  assert.ok(many.job_ids.length <= 10 && many.body.length <= 1000, `${many.job_ids.length} việc, ${many.body.length} ký tự`);
  assert.match(many.body, new RegExp(`… và ${13 - many.job_ids.length} việc khác\\.`));
});

test('scope and switches: E4 off, membership gone, link revoked, bot disabled ⇒ no Zalo reminder; daily cap 1 keeps the due-today message', { timeout: 300000 }, async t => {
  const f = await setupReminders(t);
  const { db } = f;
  await f.enable({ cap: 1 });
  await f.job('JOB-A', USER, DUE);
  await f.job('JOB-C', USER, OVER2);
  assert.equal((await f.enqueue(AT)).queued, 1);
  assert.deepEqual((await f.outbox()).map(row => row.kind), ['due_today']);
  await f.enable();
  const cases = [
    ['E4 tắt cả chuông lẫn push', "INSERT INTO public.fixture_gate VALUES('" + USER + "',false,false)", 'DELETE FROM public.fixture_gate'],
    ['thành viên SUSPENDED', "UPDATE public.organization_memberships SET status='SUSPENDED' WHERE user_id='" + USER + "' AND organization_id='" + ORG + "'",
      "UPDATE public.organization_memberships SET status='ACTIVE' WHERE user_id='" + USER + "'"],
    ['hết hạn thành viên', "UPDATE public.organization_memberships SET valid_to=clock_timestamp()-interval '1 day' WHERE user_id='" + USER + "'",
      "UPDATE public.organization_memberships SET valid_to=NULL WHERE user_id='" + USER + "'"],
    ['liên kết thu hồi', "UPDATE app_private.hermes_zalo_bindings SET state='REVOKED',revoked_at=clock_timestamp() WHERE id='" + BINDING + "'",
      "UPDATE app_private.hermes_zalo_bindings SET state='ACTIVE',revoked_at=NULL WHERE id='" + BINDING + "'"],
    ['nick bot tắt', "UPDATE app_private.hermes_zalo_bots SET enabled=false WHERE account_id='" + ACCOUNT + "'",
      "UPDATE app_private.hermes_zalo_bots SET enabled=true WHERE account_id='" + ACCOUNT + "'"],
  ];
  for (const [label, apply, undo] of cases) {
    await clear(db); await db.exec(apply);
    assert.equal((await f.enqueue(AT)).queued, 0, label);
    await db.exec(undo);
  }
  await clear(db);
  assert.equal((await f.enqueue(AT)).queued, 2, 'đối chứng: đủ điều kiện ⇒ hai tin');
  // Chỉ tắt chuông (push còn) ⇒ vẫn nhắc.
  await clear(db); await db.exec(`INSERT INTO public.fixture_gate VALUES('${USER}',false,true)`);
  assert.equal((await f.enqueue(AT)).queued, 2);
});

test('quiet hours: company 21→9 ⇒ not_before 09:00; quiet past send_until ⇒ dropped; company + personal helper used when present', { timeout: 300000 }, async t => {
  const f = await setupReminders(t);
  const { db } = f;
  await f.enable();
  await f.job('JOB-A', USER, DUE);
  await db.query('INSERT INTO app_private.notification_org_config(organization_id,quiet_start,quiet_end) VALUES($1,21,9)', [ORG]);
  assert.equal((await f.enqueue(AT)).queued, 1);
  assert.equal(iso((await f.outbox())[0].not_before), iso('2026-10-23 09:00:00+07'));
  await clear(db);
  await db.query('UPDATE app_private.notification_org_config SET quiet_end=12 WHERE organization_id=$1', [ORG]);
  assert.deepEqual([(await f.enqueue(AT)).queued, (await f.enqueue(AT)).quiet], [0, 1]);
  // Production có helper giờ yên công ty + cá nhân (đợt thông báo 21/10): có thì dùng.
  await db.query('UPDATE app_private.notification_org_config SET quiet_end=7 WHERE organization_id=$1', [ORG]);
  await db.exec(`CREATE FUNCTION app_private.notify_in_quiet_hours_v1(p_user uuid,p_org uuid,p_at timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT p_user='${USER}' AND extract(hour FROM p_at AT TIME ZONE 'Asia/Ho_Chi_Minh')<10 $$;`);
  assert.equal((await f.enqueue(AT)).queued, 1);
  assert.equal(iso((await f.outbox())[0].not_before), iso('2026-10-23 10:00:00+07'));
});

test('worker: lease-bound claim, begin re-checks and rebuilds the body from open jobs, settle sent is replay-safe; ACL service_role only', { timeout: 300000 }, async t => {
  const f = await setupReminders(t);
  const { db } = f;
  await f.enable(); await noQuiet(db);
  const end = await todayEnd(db);
  const a = await f.job('JOB-A', USER, end), b = await f.job('JOB-B', USER, end);
  const id = await f.queueNow([a, b]);
  await assert.rejects(f.claim(INSTANCE, 5, 'authenticated'), /permission denied/);
  await assert.rejects(f.asRole('SELECT count(*) n FROM app_private.task_reminder_outbox', [], 'service_role'), /permission denied/);
  await assert.rejects(f.asRole('SELECT app_private.task_reminder_enqueue_v1() r', [], 'service_role'), /permission denied/);
  assert.deepEqual(await f.claim(OTHER_INSTANCE), { ok: false, reason: 'lease_lost', items: [] });
  const claimed = await f.claim();
  assert.equal(claimed.ok, true);
  assert.deepEqual(claimed.items.map(item => [item.id, item.accountId, item.peerUid, item.kind]), [[id, ACCOUNT, '456', 'due_today']]);
  assert.equal((await f.claim()).items.length, 0, 'đang giữ ⇒ không trao lại');
  await db.query("UPDATE public.jobs SET status='COMPLETED' WHERE id=$1", [b]);
  const started = await f.begin(id);
  assert.equal(started.ok, true);
  assert.deepEqual([started.accountId, started.peerUid], [ACCOUNT, '456']);
  assert.match(started.body, /^Nhắc việc: 1 việc hạn hôm nay/);
  assert.match(started.body, /JOB-A/); assert.doesNotMatch(started.body, /JOB-B/);
  assert.deepEqual(await f.begin(id), { ok: false, reason: 'not_claimed', state: 'sending' });
  assert.deepEqual(await f.settle(id, 'sent', null, OTHER_INSTANCE), { ok: false, reason: 'not_owner', state: 'sending' });
  assert.deepEqual(await f.settle(id, 'sent'), { ok: true, state: 'sent', attempts: 0 });
  assert.deepEqual(await f.settle(id, 'sent'), { ok: true, state: 'sent', attempts: 0, replay: true });
  const [row] = await f.outbox();
  assert.deepEqual([row.state, row.job_ids, row.job_total, row.started, row.sent, row.instance_id], ['sent', [a], 1, true, true, INSTANCE]);
  await assert.rejects(f.settle(id, 'maybe'), /task_reminder_invalid/);
});

test('worker: failed retries ≤ 3 with backoff, unknown is never resent, expired leases are reaped, stale messages are skipped', { timeout: 300000 }, async t => {
  const f = await setupReminders(t);
  const { db } = f;
  await f.enable(); await noQuiet(db);
  const a = await f.job('JOB-A', USER, await todayEnd(db));
  const due = () => db.query('UPDATE app_private.task_reminder_outbox SET not_before=clock_timestamp()-interval \'1 second\' WHERE state=\'queued\'');
  let id = await f.queueNow([a]);
  await f.claim();
  assert.deepEqual(await f.settle(id, 'failed', 'ACCOUNT-OFFLINE'), { ok: true, state: 'queued', attempts: 1 });
  let [row] = await f.outbox();
  assert.equal(row.error_code, 'account_offline');
  assert.ok(new Date(row.not_before) - Date.now() > 4 * 60 * 1000, 'giãn 5 phút');
  await due(); await f.claim(); await f.begin(id);
  assert.deepEqual(await f.settle(id, 'failed'), { ok: true, state: 'queued', attempts: 2 });
  [row] = await f.outbox();
  assert.ok(new Date(row.not_before) - Date.now() > 29 * 60 * 1000, 'giãn 30 phút');
  await due(); await f.claim();
  assert.deepEqual(await f.settle(id, 'failed'), { ok: true, state: 'failed', attempts: 3 });
  assert.equal((await f.claim()).items.length, 0);
  // unknown: đã gọi Zalo mà mất kết quả ⇒ không bao giờ trao lại.
  await clear(db); id = await f.queueNow([a]);
  await f.claim();
  assert.deepEqual(await f.settle(id, 'unknown'), { ok: false, reason: 'not_started', state: 'claimed' });
  await f.begin(id);
  assert.deepEqual(await f.settle(id, 'unknown', 'TIMEOUT'), { ok: true, state: 'unknown', attempts: 0 });
  assert.deepEqual(await f.settle(id, 'unknown'), { ok: true, state: 'unknown', attempts: 0, replay: true });
  assert.equal((await f.claim()).items.length, 0);
  // Lease quá hạn: claimed ⇒ queued (trao lại); sending ⇒ unknown.
  await clear(db); id = await f.queueNow([a]);
  await f.claim();
  await db.query("UPDATE app_private.task_reminder_outbox SET lease_until=clock_timestamp()-interval '1 second'");
  assert.deepEqual((await f.claim()).items.map(item => item.id), [id]);
  await f.begin(id);
  await db.query("UPDATE app_private.task_reminder_outbox SET lease_until=clock_timestamp()-interval '1 second'");
  assert.equal((await f.claim()).items.length, 0);
  [row] = await f.outbox();
  assert.deepEqual([row.state, row.error_code], ['unknown', 'lease_expired_after_start']);
  // Tin cũ: cấu hình tắt / qua ngày / liên kết thu hồi ⇒ skipped ở claim; hết việc ⇒ skipped ở begin.
  const stale = [
    ['disabled', 'UPDATE app_private.task_reminder_config SET enabled=false', 'UPDATE app_private.task_reminder_config SET enabled=true'],
    ['expired', 'UPDATE app_private.task_reminder_outbox SET reminder_date=reminder_date-1', null],
    ['recipient_unbound', `UPDATE app_private.hermes_zalo_bindings SET state='REVOKED',revoked_at=clock_timestamp() WHERE id='${BINDING}'`,
      `UPDATE app_private.hermes_zalo_bindings SET state='ACTIVE',revoked_at=NULL WHERE id='${BINDING}'`],
  ];
  for (const [reason, apply, undo] of stale) {
    await clear(db); await f.queueNow([a]); await db.exec(apply);
    assert.equal((await f.claim()).items.length, 0, reason);
    [row] = await f.outbox();
    assert.deepEqual([row.state, row.error_code], ['skipped', reason]);
    if (undo) await db.exec(undo);
  }
  await clear(db); id = await f.queueNow([a]);
  await f.claim();
  await db.query("UPDATE public.jobs SET status='COMPLETED' WHERE id=$1", [a]);
  assert.deepEqual(await f.begin(id), { ok: false, reason: 'jobs_closed' });
  [row] = await f.outbox();
  assert.deepEqual([row.state, row.error_code], ['skipped', 'jobs_closed']);
});

test('mutation: recipient membership, NULL gate = on, worker lease, unknown never resent, quiet hours and begin re-check are each load-bearing', { timeout: 300000 }, async t => {
  const slice = (text, head) => { const start = text.indexOf(head); assert.ok(start >= 0, head); return text.slice(start, text.indexOf('$fn$;', start) + 5); };
  const mutate = (text, from, to) => { assert.equal(text.split(from).length, 2, `anchor: ${from.slice(0, 60)}`); return text.replace(from, () => to); };
  const recipient = slice(REMINDER_SQL, 'CREATE OR REPLACE FUNCTION app_private.task_reminder_recipient_v1(');
  const enqueue = slice(REMINDER_SQL, 'CREATE OR REPLACE FUNCTION app_private.task_reminder_enqueue_v1(');
  const claim = slice(WORKER_SQL, 'CREATE OR REPLACE FUNCTION public.zalo_worker_claim_task_reminders_v1(');
  const begin = slice(WORKER_SQL, 'CREATE OR REPLACE FUNCTION public.zalo_worker_begin_task_reminder_v1(');
  const ready = async f => { await f.enable(); await noQuiet(f.db); return f.job('JOB-A', USER, await todayEnd(f.db)); };
  const probes = [
    ['recipient must still be an ACTIVE member', mutate(recipient, "AND EXISTS(SELECT 1 FROM public.organization_memberships m", "AND true OR EXISTS(SELECT 1 FROM public.organization_memberships m"),
      async f => {
        await f.enable(); await f.job('JOB-A', USER, DUE);
        await f.db.query("UPDATE public.organization_memberships SET status='SUSPENDED' WHERE user_id=$1", [USER]);
        return (await f.enqueue(AT)).queued === 0;
      }],
    ['a user with no preference row (gate NULL, NULL) is still reminded', mutate(enqueue,
      "SELECT COALESCE(g.g_in_app,true) OR COALESCE(g.g_push,true)\n            FROM app_private.notify_gate_v1(u.user_id,c.organization_id,'E4',NULL) g LIMIT 1),true)",
      "SELECT g.g_in_app OR g.g_push\n            FROM app_private.notify_gate_v1(u.user_id,c.organization_id,'E4',NULL) g LIMIT 1),false)"),
      async f => { await f.enable(); await f.job('JOB-A', USER, DUE); return (await f.enqueue(AT)).queued === 1; }],
    ['claim requires the worker lease', mutate(claim, "IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','lease_lost','items','[]'::jsonb); END IF;", ''),
      async f => { await f.queueNow([await ready(f)]); return (await f.claim(OTHER_INSTANCE)).ok === false; }],
    ['unknown is never claimed again', mutate(claim, "WHERE x.state='queued' AND x.not_before<=v_now", "WHERE x.state IN ('queued','unknown') AND x.not_before<=v_now"),
      async f => {
        const id = await f.queueNow([await ready(f)]);
        await f.claim(); await f.begin(id); await f.settle(id, 'unknown');
        try { return (await f.claim()).items.length === 0; } catch { return false; }
      }],
    ['enqueue defers to the end of quiet hours', mutate(enqueue, 'v_not_before:=app_private.task_reminder_quiet_end_v1(c.organization_id,u.user_id,v_now);', 'v_not_before:=v_now;'),
      async f => {
        await f.enable(); await f.job('JOB-A', USER, DUE);
        await f.db.query('INSERT INTO app_private.notification_org_config(organization_id,quiet_start,quiet_end) VALUES($1,21,9)', [ORG]);
        await f.enqueue(AT);
        return iso((await f.outbox())[0].not_before) === iso('2026-10-23 09:00:00+07');
      }],
    ['begin re-checks that jobs are still open', mutate(begin, "IF NOT FOUND THEN v_skip:='jobs_closed'; END IF;", 'NULL;'),
      async f => {
        const a = await ready(f);
        const id = await f.queueNow([a]);
        await f.claim();
        await f.db.query("UPDATE public.jobs SET status='COMPLETED' WHERE id=$1", [a]);
        try { return (await f.begin(id)).reason === 'jobs_closed'; } catch { return false; }
      }],
  ];
  for (const [label, mutant, probe] of probes) {
    await t.test(label, async () => {
      assert.equal(await probe(await setupReminders(t)), true, 'bản gốc chặn');
      const f = await setupReminders(t);
      await f.db.exec(mutant);
      assert.equal(await probe(f), false, 'đột biến lọt ⇒ test không rỗng');
    });
  }
});

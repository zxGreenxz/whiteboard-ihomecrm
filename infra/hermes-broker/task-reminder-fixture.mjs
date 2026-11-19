import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fixture as zaloFixture, ORG, USER, ACCOUNT, INSTANCE, BINDING, ASSISTANT, FOREIGN, GENERATION } from '../hermes-zalo-router/private-command-fixture.mjs';

// Công việc Mốc 6 (CONG-VIEC-THAO-TAC-GHI.md mục 6, 23): fixture PGlite cho hàng đợi nhắc việc Zalo. Nền là fixture lệnh riêng Zalo
// (migration THẬT của trợ lý / phiên / liên kết Zalo + nick bot + lease worker), thêm bảng jobs / buildings / rooms tối thiểu, bảng giờ
// yên công ty như production, công tắc E4 giả (fixture_gate) và múi giờ Việt Nam. Hai migration Mốc 6 chạy hai lượt (idempotent).
// Chứng minh logic hàng đợi + ACL; không chứng minh worker thật, Zalo thật hay pg_cron.
export { ORG, USER, ACCOUNT, INSTANCE, BINDING, FOREIGN };
const migration = slug => { const found = readdirSync('supabase/migrations').filter(name => new RegExp(`^\\d{14}_${slug}\\.sql$`).test(name));
  assert.equal(found.length, 1, slug); return readFileSync(`supabase/migrations/${found[0]}`, 'utf8').replaceAll('\r\n', '\n'); };
export const REMINDER_SQL = migration('task_reminder_v1');
export const WORKER_SQL = migration('zalo_worker_task_reminder_v1');
const u = n => `00000000-0000-4000-8000-0000000006${n}`;
export const STAFF = u('01'), SUSPENDED = u('02'), BUILDING = u('10'), ROOM = u('11'), OTHER_INSTANCE = u('20');

const BASE = `
  CREATE TABLE public.buildings(id uuid PRIMARY KEY,organization_id uuid,name text);
  CREATE TABLE public.rooms(id uuid PRIMARY KEY,building_id uuid,name text);
  CREATE TABLE public.jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,code text NOT NULL,title text NOT NULL,
    building_id uuid,room_id uuid,assignee_id uuid,deadline timestamptz,status text NOT NULL DEFAULT 'IN_PROGRESS' CHECK(status IN ('IN_PROGRESS','COMPLETED')));
  CREATE TABLE app_private.notification_org_config(organization_id uuid PRIMARY KEY,events jsonb NOT NULL DEFAULT '{}',
    quiet_start smallint NOT NULL DEFAULT 21 CHECK(quiet_start BETWEEN 0 AND 23),quiet_end smallint NOT NULL DEFAULT 7 CHECK(quiet_end BETWEEN 0 AND 23));
  -- Công tắc E4 giả, giữ đúng tật của hàm thật: người chưa có dòng sở thích ⇒ (NULL, NULL) (SELECT INTO không thấy dòng), nơi gọi
  -- phải coi NULL là bật. Tầng 2 TEST 23/10 bắt được bản đầu coi NULL là tắt.
  CREATE TABLE public.fixture_gate(user_id uuid PRIMARY KEY,in_app boolean,push boolean);
  CREATE FUNCTION app_private.notify_gate_v1(p_user uuid,p_org uuid,p_event text,p_amount numeric DEFAULT NULL)
    RETURNS TABLE(g_in_app boolean,g_push boolean) LANGUAGE sql STABLE AS $$
    SELECT (SELECT in_app FROM public.fixture_gate WHERE user_id=p_user),(SELECT push FROM public.fixture_gate WHERE user_id=p_user) $$;
  CREATE FUNCTION app_private.org_timezone_v1(p_org uuid) RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'Asia/Ho_Chi_Minh'::text $$;
  INSERT INTO public.buildings VALUES('${BUILDING}','${ORG}','111PVC');
  INSERT INTO public.rooms VALUES('${ROOM}','${BUILDING}','101');`;

// Liên kết Zalo cho một người nữa: trợ lý, phiên, kết nối, hội thoại + tin mã liên kết, challenge đã xác nhận, liên kết ACTIVE.
// n = hai chữ số hex riêng cho mỗi người (id + digest không trùng).
export async function bindUser(db, user, n, sender) {
  assert.match(n, /^[0-9a-f]{2}$/);
  const id = k => `00000000-0000-4000-8000-000000007${n}${k}`;
  const digest = n.repeat(32);
  await db.exec(`
    INSERT INTO auth.users VALUES('${user}') ON CONFLICT DO NOTHING;
    INSERT INTO app_private.hermes_assistants(id,organization_id,user_id) VALUES('${id(1)}','${ORG}','${user}');
    INSERT INTO app_private.hermes_sessions(id,assistant_id,organization_id,user_id,provider_session_id,state,envelope,expires_at)
      VALUES('${id(2)}','${id(1)}','${ORG}','${user}','${id(2)}','ACTIVE','{}',clock_timestamp()+interval '1 hour');
    INSERT INTO app_private.hermes_connections(id,assistant_id,organization_id,user_id,state,credential_ref,intent_digest,intent_expires_at,activation_operation_id)
      VALUES('${id(3)}','${id(1)}','${ORG}','${user}','ACTIVE','${id(2)}','${digest}',clock_timestamp()+interval '1 hour','${id(3)}');
    -- Hội thoại + tin mã liên kết là dữ liệu dựng sẵn (fixture gốc chèn trước khi guard hộp thư chung tồn tại): bỏ qua trigger.
    BEGIN; SET LOCAL session_replication_role=replica;
    INSERT INTO public.zalo_conversations VALUES('${id(4)}','${ACCOUNT}','${ORG}','user','${sender}','${sender}',null,0);
    INSERT INTO public.zalo_messages(id,account_id,organization_id,conversation_id,direction,msg_type,body,zalo_msg_id,zalo_raw,created_at)
      VALUES('${id(5)}','${ACCOUNT}','${ORG}','${id(4)}','in','text','[Hermes link - hidden]','link-${n}','{}',clock_timestamp());
    COMMIT;
    INSERT INTO app_private.hermes_zalo_link_challenges(id,user_id,organization_id,assistant_id,connection_id,connection_epoch,account_id,bot_version,
      challenge_digest,created_at,expires_at,state,candidate_version,sender_uid,conversation_id,message_id,ingress_generation)
      VALUES('${id(6)}','${user}','${ORG}','${id(1)}','${id(3)}',1,'${ACCOUNT}',1,'${digest}',clock_timestamp(),clock_timestamp()+interval '1 minute',
      'CONFIRMED',1,'${sender}','${id(4)}','${id(5)}','${GENERATION}');
    INSERT INTO app_private.hermes_zalo_bindings(id,user_id,organization_id,assistant_id,connection_id,connection_epoch,account_id,bot_version,sender_uid,conversation_id,challenge_id)
      VALUES('${id(7)}','${user}','${ORG}','${id(1)}','${id(3)}',1,'${ACCOUNT}',1,'${sender}','${id(4)}','${id(6)}');`);
  return id(7);
}

export async function setupReminders(t, { reminder = REMINDER_SQL, worker = WORKER_SQL, database } = {}) {
  const f = await zaloFixture(t, { database });
  const { db } = f;
  await db.exec(BASE);
  await db.exec(`INSERT INTO auth.users VALUES('${STAFF}'),('${SUSPENDED}') ON CONFLICT DO NOTHING;
    INSERT INTO public.organization_memberships(id,user_id,organization_id,status) VALUES('${STAFF}','${STAFF}','${ORG}','ACTIVE'),
      ('${SUSPENDED}','${SUSPENDED}','${ORG}','ACTIVE');`);
  for (const [label, sql] of [['20261023063140', reminder], ['20261023063142', worker]]) {
    if (!sql) continue;
    try { await db.exec(sql); await db.exec(sql); } catch (error) { error.message = `${label}: ${error.message}`; throw error; }
  }
  const job = (code, assignee, deadline, extra = {}) => db.query(
    'INSERT INTO public.jobs(organization_id,code,title,building_id,room_id,assignee_id,deadline,status) VALUES($1,$2,$3,$4,$5,$6,$7::timestamptz,$8) RETURNING id',
    [extra.org ?? ORG, code, extra.title ?? `việc ${code}`, BUILDING, extra.room === false ? null : ROOM, assignee, deadline, extra.status ?? 'IN_PROGRESS'])
    .then(result => result.rows[0].id);
  const enable = (cfg = {}) => db.query(`INSERT INTO app_private.task_reminder_config(organization_id,enabled,due_hour,overdue_hour,overdue_days,daily_cap,send_until_hour,app_base_url)
    VALUES($1,true,$2,$3,$4,$5,$6,$7) ON CONFLICT(organization_id) DO UPDATE SET enabled=true,due_hour=excluded.due_hour,overdue_hour=excluded.overdue_hour,
    overdue_days=excluded.overdue_days,daily_cap=excluded.daily_cap,send_until_hour=excluded.send_until_hour,app_base_url=excluded.app_base_url`,
    [ORG, cfg.due ?? 8, cfg.overdue ?? 8, cfg.days ?? 3, cfg.cap ?? 2, cfg.until ?? 11, cfg.url ?? null]);
  const enqueue = at => db.query('SELECT app_private.task_reminder_enqueue_v1($1::timestamptz) r', [at]).then(result => result.rows[0].r);
  const outbox = () => db.query(`SELECT id,user_id,binding_id,kind,reminder_date::text,job_ids,job_total,body,state,attempts,error_code,instance_id,
    not_before,provider_started_at IS NOT NULL started,sent_at IS NOT NULL sent FROM app_private.task_reminder_outbox ORDER BY user_id,kind`).then(result => result.rows);
  // Worker gọi dưới service_role (như supabase-js với khoá service), không JWT người dùng.
  const asRole = async (sql, args, role = 'service_role') => {
    await db.exec('BEGIN'); await db.exec(`SET LOCAL ROLE ${role}`);
    try { const value = (await db.query(sql, args)).rows[0]; await db.exec('COMMIT'); return value; }
    catch (error) { await db.exec('ROLLBACK'); throw error; }
  };
  const claim = (instance = INSTANCE, limit = 5, role) => asRole('SELECT public.zalo_worker_claim_task_reminders_v1($1,$2) r', [instance, limit], role).then(row => row.r);
  const begin = (id, instance = INSTANCE) => asRole('SELECT public.zalo_worker_begin_task_reminder_v1($1,$2) r', [id, instance]).then(row => row.r);
  const settle = (id, outcome, code = null, instance = INSTANCE) =>
    asRole('SELECT public.zalo_worker_settle_task_reminder_v1($1,$2,$3,$4) r', [id, instance, outcome, code]).then(row => row.r);
  // Tin đến giờ ngay bây giờ cho USER (worker test không phụ thuộc giờ chạy test: đi thẳng vào hàng đợi, ngày = hôm nay giờ VN).
  const queueNow = async (jobIds, kind = 'due_today', user = USER, binding = BINDING) => (await db.query(`INSERT INTO app_private.task_reminder_outbox
    (organization_id,user_id,binding_id,kind,reminder_date,job_ids,job_total,body,not_before)
    VALUES($1,$2,$3,$4,(clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,$5::uuid[],$6,'nháp',clock_timestamp()-interval '1 second') RETURNING id`,
    [ORG, user, binding, kind, jobIds, jobIds.length])).rows[0].id;
  return { ...f, db, job, enable, enqueue, outbox, asRole, claim, begin, settle, queueNow };
}

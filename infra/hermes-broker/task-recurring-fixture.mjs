import { readFileSync } from 'node:fs';
import { setupTaskActions, migration, binding, ORG, USER, BUILDING, OTHER_BUILDING, ROOM, MANAGER, STAFF, TYPE_SUA } from './task-action-fixture.mjs';

// Công việc Mốc 5 (CONG-VIEC-THAO-TAC-GHI.md mục 5, 22): fixture PGlite cho việc định kỳ = fixture trang Công việc (RLS jobs production,
// chuỗi 031548 → 065634 → 074741 → 164201) + bảng/hàm CRM dùng chung (20261023042424) + bộ sinh (20261023042431) + bốn thao tác
// (20261023042436), mỗi file chạy hai lượt (idempotent). Migration KHÔNG chèn dòng chính sách (khoá để TẮT): fixture chèn bốn dòng như
// migration bật của phiên chính sẽ làm.
export const RECURRENCE_SQL = migration('job_recurrence_v1');
export const GENERATE_SQL = migration('hermes_task_recurrence_generate_v1');
export const RECURRING_SQL = migration('hermes_task_recurring_v1');
export const ENABLE_POLICIES = `INSERT INTO app_private.hermes_action_policies(action,capability,crm_permission,action_class,confirm,private_only) VALUES
  ('task.recurring_create','tasks.create','tasks.create','reversible','always',true),('task.recurring_update','tasks.edit','tasks.edit','reversible','always',true),
  ('task.recurring_pause','tasks.edit','tasks.edit','reversible','always',true),('task.recurring_delete','tasks.delete','tasks.delete','reversible','always',true)
  ON CONFLICT(action) DO NOTHING;`;
const SUPPORT = `CREATE OR REPLACE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $f$
    SELECT COALESCE(ARRAY(SELECT m.organization_id FROM public.organization_memberships m WHERE m.user_id=auth.uid() AND m.status='ACTIVE'),'{}') $f$;
  GRANT EXECUTE ON FUNCTION public.my_org_ids() TO authenticated;
  ALTER TABLE public.organization_memberships ADD COLUMN IF NOT EXISTS revoked_at timestamptz,ADD COLUMN IF NOT EXISTS valid_from timestamptz,
    ADD COLUMN IF NOT EXISTS valid_to timestamptz;`;
// Thân THẬT của helper thành viên (20261014094913: đòi JWT authenticated) thay stub của fixture Công việc. Bộ sinh chạy từ cron, không
// có JWT, nên không được dựa vào helper này (bản đầu của 042431 tạm dừng mọi quy tắc với membership_lost; phát hiện 23/10).
export const MEMBER_SQL = readFileSync('supabase/migrations/20261014094913_hermes_assistant_capabilities_v5.sql', 'utf8').replaceAll('\r\n', '\n')
  .match(/CREATE OR REPLACE FUNCTION app_private\.hermes_task_assignee_member_v1[\s\S]*?\$fn\$;/)[0];
export { binding, ORG, USER, BUILDING, OTHER_BUILDING, ROOM, MANAGER, STAFF, TYPE_SUA };

export async function setupRecurring(t, { recurrence = RECURRENCE_SQL, generate = GENERATE_SQL, recurring = RECURRING_SQL, enable = true, database } = {}) {
  const f = await setupTaskActions(t, { database });
  const { db } = f;
  await db.exec(SUPPORT);
  await db.exec(MEMBER_SQL);
  for (const [label, sql] of [['20261023042424', recurrence], ['20261023042431', generate], ['20261023042436', recurring]]) {
    if (!sql) continue;
    try { await db.exec(sql); await db.exec(sql); } catch (error) { error.message = `${label}: ${error.message}`; throw error; }
  }
  if (enable) await db.exec(ENABLE_POLICIES);
  // Hermes chạy lệnh dưới vai authenticated với JWT người hỏi (như vỏ thật).
  const run = (action, phase, requestId, params, extra = {}, b = binding) => f.call(
    'SELECT public.hermes_task_action_v1($1::jsonb,$2,$3,$4::uuid,$5::jsonb,$6::jsonb,$7) result',
    [JSON.stringify(b), action, phase, requestId, JSON.stringify(params), extra.resolved ? JSON.stringify(extra.resolved) : null, extra.basis ?? null]);
  const rules = async () => (await db.query(`SELECT id,code,title,building_id,room_id,job_type_id,assignee_id,priority,frequency,every,weekdays,month_day,
    start_date::text,end_date::text,due_days,created_by,version,paused_at IS NOT NULL paused,paused_reason,deleted_at IS NOT NULL deleted,
    last_generated_date::text FROM public.job_recurrence_rules ORDER BY code`)).rows;
  const generate_ = async today => (await db.query('SELECT app_private.hermes_task_recurrence_generate_v1($1::date) r', [today])).rows[0].r;
  return { ...f, db, run, rules, generate: generate_ };
}

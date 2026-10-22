import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { setup as financeSetup, binding, BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, SCOPE, ORG, USER, UNSELECTED_ORG_SCOPE } from './finance-fixture.mjs';
export { binding, BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, SCOPE, ORG, USER, UNSELECTED_ORG_SCOPE };

// Đợt 2b Công việc (CONG-VIEC-THAO-TAC-GHI.md mục 3, 8.2): fixture PGlite cho RPC trang Công việc. Nền là fixture Hermes của thu
// chi (binding/phiên/kết nối/chính sách công ty thật của các migration Hermes; quyền CRM của người hỏi qua fixture_acl) + M5/M1
// của nền chung. Bảng jobs dựng từ migration thật (cột, CHECK trạng thái, trigger mã việc / người tạo / giờ hoàn thành) với policy
// RLS production (đọc 22/10 bằng db:query); đồ thị quyền sau các helper (buildings_for_v3, authorize_tenant_action_v3,
// accessible_building_ids) là port: người hỏi theo fixture_acl, người khác theo fixture_member_acl. Chứng minh logic Hermes + RLS
// policy thật, không chứng minh đồ thị quyền CRM thật hay JWT sống.
export const MANAGER = '00000000-0000-4000-8000-0000000000c1';
export const STAFF = '00000000-0000-4000-8000-0000000000c2';
export const CO_OWNER = '00000000-0000-4000-8000-0000000000c3';
export const OUTSIDER = '00000000-0000-4000-8000-0000000000c4';
// Thành viên tên chứa 'Minh' (review Mốc 2, chặn 1): 'Minh'/'mình' phải giao cho người này qua xem trước, không thành tự giao.
export const MINH = '00000000-0000-4000-8000-0000000000c5';
export const VIRTUAL = '00000000-0000-4000-8000-0000000000d1';
export const ROOM_A201 = '00000000-0000-4000-8000-0000000000d2';
export const VIRTUAL_ROOM = '00000000-0000-4000-8000-0000000000d4';
export const TYPE_SUA = '00000000-0000-4000-8000-0000000000e1';
export const TYPE_VE = '00000000-0000-4000-8000-0000000000e2';
export const TYPE_VE_SINH = '00000000-0000-4000-8000-0000000000e3';
export const TYPE_OFF = '00000000-0000-4000-8000-0000000000e4';
export const TYPE_CHECK = '00000000-0000-4000-8000-0000000000e5';
export const migration = slug => { const found = readdirSync('supabase/migrations').filter(name => new RegExp(`^\\d{14}_${slug}\\.sql$`).test(name));
  assert.equal(found.length, 1, slug); return readFileSync(`supabase/migrations/${found[0]}`, 'utf8').replaceAll('\r\n', '\n'); };
const source = name => readFileSync(`supabase/migrations/${name}.sql`, 'utf8').replaceAll('\r\n', '\n');
const extract = (src, name) => src.match(new RegExp(`CREATE OR REPLACE FUNCTION ${name.replaceAll('.', '\\.')}[\\s\\S]*?\\$(?:fn)?\\$;`, 'i'))[0];
export const CREATE_SQL = migration('hermes_task_action_create_v1');
// Mốc 2c: thay thân lõi giải tên + bước chuẩn bị của CREATE_SQL (suy loại việc khi jobType không khớp). Chuỗi như production.
export const TYPE_INFER_SQL = migration('hermes_task_type_infer_v1');
// Mốc 3: task.update + task.cancel trên cùng vỏ (thay bốn tầng, thêm hai hàm DEFINER).
export const EDIT_SQL = migration('hermes_task_action_edit_v1');

const SUPPORT = `CREATE TABLE IF NOT EXISTS public.building_common_names(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,building_id uuid,name text);
  CREATE TABLE IF NOT EXISTS public.job_types(id uuid PRIMARY KEY,organization_id uuid,name text,is_active boolean);
  CREATE TABLE IF NOT EXISTS public.profiles(id uuid PRIMARY KEY,full_name text);
  CREATE TABLE IF NOT EXISTS public.material_usages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid);
  ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS code text;
  REVOKE USAGE ON SCHEMA app_private FROM authenticated, PUBLIC;
  GRANT SELECT ON public.building_common_names,public.job_types,public.profiles,public.buildings,public.rooms TO authenticated;
  ALTER TABLE public.organization_memberships ADD COLUMN IF NOT EXISTS member_type text;
  -- Đồ thị quyền: người hỏi (USER) theo fixture_acl như nền chung; người khác theo fixture_member_acl.
  CREATE TABLE IF NOT EXISTS public.fixture_member_acl(user_id uuid,permission text,building_ids uuid[],PRIMARY KEY(user_id,permission));
  CREATE TABLE IF NOT EXISTS public.fixture_rls(id int PRIMARY KEY DEFAULT 1,deny_insert boolean NOT NULL DEFAULT false);
  INSERT INTO public.fixture_rls(id,deny_insert) VALUES(1,false) ON CONFLICT DO NOTHING;
  CREATE OR REPLACE FUNCTION app_private.fixture_perm_buildings_v1(p_user uuid,p_permission text) RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path=pg_catalog,public AS $f$
    SELECT CASE WHEN p_user='${USER}'::uuid THEN (SELECT CASE WHEN a.org_wide THEN ARRAY(SELECT b.id FROM public.buildings b WHERE b.organization_id='${ORG}')
        ELSE COALESCE(a.building_ids,'{}') END FROM public.fixture_acl a WHERE a.permission=p_permission AND a.allowed)
      ELSE (SELECT m.building_ids FROM public.fixture_member_acl m WHERE m.user_id=p_user AND m.permission=p_permission) END $f$;
  CREATE OR REPLACE FUNCTION app_private.authorize_tenant_action_v3(p_user uuid,p_org uuid,p_permission text,p_building uuid,p_cashbook uuid)
    RETURNS TABLE(allowed boolean,authorization_version bigint,nearest_deadline timestamptz) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $f$
    SELECT COALESCE(p_org='${ORG}'::uuid AND p_building=ANY(app_private.fixture_perm_buildings_v1(p_user,p_permission)),false),1::bigint,NULL::timestamptz $f$;
  CREATE OR REPLACE FUNCTION app_private.buildings_for_v3(p_permission text) RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $f$
    SELECT CASE WHEN p_permission='tasks.create' AND (SELECT deny_insert FROM public.fixture_rls) THEN '{}'::uuid[]
      ELSE COALESCE(app_private.fixture_perm_buildings_v1(auth.uid(),p_permission),'{}') END $f$;
  CREATE OR REPLACE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $f$
    SELECT EXISTS(SELECT 1 FROM public.super_admins WHERE user_id=auth.uid()) $f$;
  CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $f$ SELECT public.is_super_admin() $f$;
  CREATE OR REPLACE FUNCTION public.has_full_building_scope() RETURNS boolean LANGUAGE sql STABLE AS $f$ SELECT false $f$;
  CREATE OR REPLACE FUNCTION public.can_access_org_entity(text,text) RETURNS boolean LANGUAGE sql STABLE AS $f$ SELECT false $f$;
  CREATE OR REPLACE FUNCTION public.accessible_building_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $f$
    SELECT unnest(app_private.buildings_for_v3('buildings.view')) $f$;
  CREATE OR REPLACE FUNCTION app_private.org_timezone_v1(p_org uuid) RETURNS text LANGUAGE sql STABLE AS $f$ SELECT 'Asia/Ho_Chi_Minh'::text $f$;
  CREATE OR REPLACE FUNCTION public.org_today_v1(p_org uuid DEFAULT NULL) RETURNS date LANGUAGE sql STABLE AS $f$
    SELECT (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date $f$;
  CREATE OR REPLACE FUNCTION app_private.hermes_task_assignee_member_v1(p_user uuid,p_org uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path=pg_catalog,public AS $f$ SELECT EXISTS(SELECT 1 FROM public.organization_memberships m WHERE m.user_id=p_user AND m.organization_id=p_org
      AND m.status='ACTIVE' AND m.revoked_at IS NULL) $f$;
  GRANT EXECUTE ON FUNCTION app_private.hermes_task_assignee_member_v1(uuid,uuid) TO authenticated;
  -- Tập toà web (20261021170452, PR #261) như production trừ nhánh siêu quản trị.
  CREATE OR REPLACE FUNCTION app_private.hermes_web_building_ids_v1(p_org uuid) RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path=pg_catalog,public,app_private AS $f$
    SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) FROM public.buildings b
      CROSS JOIN LATERAL (SELECT COALESCE(bool_or(s.org_wide),false) org_wide,COALESCE(array_agg(x),'{}'::uuid[]) ids
        FROM app_private.authorized_scope_v3('buildings.view',p_org) s LEFT JOIN LATERAL unnest(s.building_ids) x ON true) scope
      WHERE p_org IS NOT NULL AND auth.uid() IS NOT NULL AND b.organization_id=p_org AND b.deleted_at IS NULL AND (scope.org_wide OR b.id=ANY(scope.ids)) $f$;
  REVOKE ALL ON FUNCTION app_private.hermes_web_building_ids_v1(uuid) FROM PUBLIC,authenticated;
  CREATE TABLE IF NOT EXISTS public.beds(id uuid PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS public.job_groups(id uuid PRIMARY KEY);
  CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN NEW.updated_at=now(); RETURN NEW; END $f$;`;

// Bảng jobs: cột, CHECK, trigger mã/người tạo/giờ hoàn thành từ migration thật; policy select/insert/update/delete như production.
async function createJobs(db) {
  const jobs = source('20251121000001_create_jobs_table');
  await db.exec(jobs.slice(0, jobs.indexOf('-- 6. SUPABASE STORAGE BUCKET')));
  await db.exec(source('20260516000053_jobs_simplify_status'));
  await db.exec(['organization_id uuid', 'assignee_name text', 'completion_attachments jsonb', 'completion_description text', 'completion_captured_at timestamptz',
    'completion_lat double precision', 'completion_lng double precision', 'completion_distance_m double precision', 'completion_geofence_status text',
    'completion_address text', 'visible_to_customer boolean DEFAULT false'].map(column => `ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS ${column};`).join('\n'));
  await db.exec(extract(source('20260527000001_fix_generate_job_code_rls'), 'public.generate_job_code'));
  await db.exec(extract(source('20260527000006_rbac_phase2_trigger_auto_user_id'), 'public.set_user_id_from_auth'));
  await db.exec(extract(source('20260720181000_jobs_completion_time_integrity'), 'public.jobs_stamp_completion_time'));
  await db.exec(`CREATE TRIGGER jobs_set_user_id_audit BEFORE INSERT ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
    CREATE TRIGGER trigger_jobs_stamp_completion_time BEFORE INSERT OR UPDATE ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.jobs_stamp_completion_time();
    DROP POLICY "Users can view own jobs" ON public.jobs;DROP POLICY "Users can create own jobs" ON public.jobs;
    DROP POLICY "Users can update own jobs" ON public.jobs;DROP POLICY "Users can delete own jobs" ON public.jobs;
    CREATE POLICY jobs_select_rbac ON public.jobs FOR SELECT USING ((( SELECT public.is_super_admin() AS is_super_admin) OR ( SELECT public.is_admin() AS is_admin)
      OR ((building_id IS NOT NULL) AND (( SELECT public.has_full_building_scope() AS has_full_building_scope) OR (building_id IN ( SELECT public.accessible_building_ids() AS accessible_building_ids))))
      OR ((building_id IS NULL) AND ( SELECT public.can_access_org_entity('tasks'::text, 'view'::text) AS can_access_org_entity))));
    CREATE POLICY jobs_insert_rbac ON public.jobs FOR INSERT WITH CHECK ((( SELECT public.is_super_admin() AS is_super_admin)
      OR ((building_id IS NOT NULL) AND (building_id = ANY (app_private.buildings_for_v3('tasks.create'::text))))
      OR ((building_id IS NULL) AND public.can_access_org_entity('tasks'::text, 'create'::text))));
    CREATE POLICY jobs_update_rbac ON public.jobs FOR UPDATE USING ((( SELECT public.is_super_admin() AS is_super_admin)
      OR ((building_id IS NOT NULL) AND (building_id = ANY (app_private.buildings_for_v3('tasks.edit'::text))))
      OR ((building_id IS NULL) AND public.can_access_org_entity('tasks'::text, 'edit'::text))))
      WITH CHECK ((( SELECT public.is_super_admin() AS is_super_admin)
      OR ((building_id IS NOT NULL) AND (building_id = ANY (app_private.buildings_for_v3('tasks.edit'::text))))
      OR ((building_id IS NULL) AND public.can_access_org_entity('tasks'::text, 'edit'::text))));
    CREATE POLICY jobs_delete_rbac ON public.jobs FOR DELETE USING ((( SELECT public.is_super_admin() AS is_super_admin)
      OR ((building_id IS NOT NULL) AND (building_id = ANY (app_private.buildings_for_v3('tasks.delete'::text))))
      OR ((building_id IS NULL) AND public.can_access_org_entity('tasks'::text, 'delete'::text))));
    GRANT SELECT,INSERT,UPDATE,DELETE ON public.jobs TO authenticated;`);
}

/** Fixture đầy đủ: nền chung (M5 + M1) + jobs + migration Công việc (chạy hai lượt: idempotent) + Mốc 2c. `extra` = migration chạy sau. */
export async function setupTaskActions(t, { sql = CREATE_SQL, infer = TYPE_INFER_SQL, edit = EDIT_SQL, extra = [], database } = {}) {
  const f = await financeSetup(t, { action: `${SUPPORT}\n${migration('hermes_write_name_resolve_v1')}`, database });
  const { db } = f;
  await db.exec(migration('hermes_action_foundation_v1'));
  await createJobs(db);
  await db.exec(`INSERT INTO auth.users VALUES('${MANAGER}'),('${STAFF}'),('${CO_OWNER}'),('${OUTSIDER}'),('${MINH}') ON CONFLICT DO NOTHING;
    UPDATE public.organization_memberships SET member_type='OWNER' WHERE user_id='${USER}';
    INSERT INTO public.organization_memberships(id,user_id,organization_id,status,member_type) VALUES
      ('${MANAGER}','${MANAGER}','${ORG}','ACTIVE','STAFF'),('${STAFF}','${STAFF}','${ORG}','ACTIVE','STAFF'),
      ('${CO_OWNER}','${CO_OWNER}','${ORG}','ACTIVE','OWNER'),('${MINH}','${MINH}','${ORG}','ACTIVE','STAFF'),('${OUTSIDER}','${OUTSIDER}','00000000-0000-4000-8000-00000000f0f0','ACTIVE','STAFF');
    INSERT INTO public.profiles VALUES('${USER}','Chủ Thử'),('${MANAGER}','Nathan Quản Lý'),('${STAFF}','Huy Nhân Viên'),('${CO_OWNER}','Chủ Hai'),('${OUTSIDER}','Người Ngoài'),('${MINH}','Nguyễn Văn Minh')
      ON CONFLICT (id) DO UPDATE SET full_name=excluded.full_name;
    INSERT INTO public.buildings VALUES('${VIRTUAL}','${ORG}','Kho Văn Phòng Chung',true,null,'KHO');
    INSERT INTO public.rooms(id,organization_id,building_id,name,status,deleted_at) VALUES('${ROOM_A201}','${ORG}','${BUILDING}','201','OCCUPIED',null),('${VIRTUAL_ROOM}','${ORG}','${VIRTUAL}','K1','AVAILABLE',null);
    INSERT INTO public.job_types VALUES('${TYPE_SUA}','${ORG}','sửa',true),('${TYPE_VE}','${ORG}','vệ',true),('${TYPE_VE_SINH}','${ORG}','vệ sinh',true),
      ('${TYPE_OFF}','${ORG}','bảo trì cũ',false),('${TYPE_CHECK}','${ORG}','checkin',true);
    -- Nathan quản lý toà A (tasks.edit + buildings.view); Huy chỉ xem toà B.
    INSERT INTO public.fixture_member_acl VALUES('${MANAGER}','tasks.edit','{${BUILDING}}'),('${MANAGER}','buildings.view','{${BUILDING}}'),
      ('${STAFF}','buildings.view','{${OTHER_BUILDING}}'),('${CO_OWNER}','tasks.edit','{${BUILDING},${OTHER_BUILDING}}'),
      ('${CO_OWNER}','buildings.view','{${BUILDING},${OTHER_BUILDING}}');
    INSERT INTO app_private.hermes_capabilities(capability,mode,enabled) VALUES('tasks.create','action',true),('tasks.edit','action',true),('tasks.delete','action',true)
      ON CONFLICT(capability) DO UPDATE SET enabled=true;`);
  for (const permission of ['tasks.create', 'tasks.edit', 'tasks.view', 'buildings.view'])
    await db.query('INSERT INTO public.fixture_acl(permission,building_ids) VALUES($1,$2) ON CONFLICT(permission) DO UPDATE SET building_ids=excluded.building_ids,allowed=true',
      [permission, [BUILDING, OTHER_BUILDING]]);
  // Kết nối + trần công ty giữ khoá tasks.create; overlay Toàn tổ chức (cả hai toà).
  await db.query('UPDATE app_private.hermes_org_policies SET action_capabilities=array_append(action_capabilities,$1),scope_ids=$2', ['tasks.create', [SCOPE, UNSELECTED_ORG_SCOPE]]);
  await db.query('UPDATE app_private.hermes_connections SET action_capabilities=array_append(action_capabilities,$1),scope_ids=$2', ['tasks.create', [SCOPE, UNSELECTED_ORG_SCOPE]]);
  await db.exec(sql); await db.exec(sql);
  if (infer) { await db.exec(infer); await db.exec(infer); }
  if (edit) { await db.exec(edit); await db.exec(edit); }
  for (const file of extra) { await db.exec(file); await db.exec(file); }
  const action = (phase, requestId, params, extraArgs = {}, b = binding, options) => f.call(
    'SELECT public.hermes_task_action_v1($1::jsonb,$2,$3,$4::uuid,$5::jsonb,$6::jsonb,$7) result',
    [JSON.stringify(b), 'task.create', phase, requestId, JSON.stringify(params), extraArgs.resolved ? JSON.stringify(extraArgs.resolved) : null, extraArgs.basis ?? null], options);
  const jobs = async () => (await db.query('SELECT id,code,title,description,building_id,room_id,job_type_id,assignee_id,priority,status,user_id,' +
    "to_char(deadline AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY-MM-DD HH24:MI:SS.MS') local_deadline FROM public.jobs ORDER BY created_at,id")).rows;
  const receipts = async () => (await db.query('SELECT request_id,action,state,sqlstate FROM app_private.hermes_action_receipts ORDER BY created_at,request_id')).rows;
  const ledger = async () => (await db.query('SELECT job_id,actor_id,assignee_id,action,source FROM app_private.hermes_task_jobs ORDER BY created_at')).rows;
  return { ...f, db, action, jobs, receipts, ledger };
}

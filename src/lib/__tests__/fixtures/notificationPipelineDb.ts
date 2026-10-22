// Fixture PGlite cho pipeline thông báo phía database (gói B, plan 2026-10-21-realtime-thong-bao-toi-uu.md).
//
// Chạy THẬT các migration gói B trên PostgreSQL nhúng, theo đúng thứ tự áp production:
//   lane lifecycle gốc 20260928024843 → 20261021171249 (pipeline v2) → 20261021171250 (chưa đọc/CANCELLED)
//   → 20261021171251 (nhắc server). Mỗi migration chạy HAI lượt liền (idempotent).
// Bảng/hàm nền tối thiểu theo hình dạng production 22/10 (enum notification_type/status/channel, cột push_*,
// cột GENERATED remaining_amount…); quyền tenant giả bằng bảng test_permissions (building_id NULL = cả công ty).
// auth.uid() đọc GUC test.uid; đồng hồ ngày công ty đọc bảng test_clock (giờ yên dùng đồng hồ thật + múi giờ UTC).
//
// Ghim thân ($requires$): migration đòi thân đang chạy khớp md5 production. Hàm có THÂN THẬT ở fixture (lane lifecycle
// gốc, inbox Hermes + feed Copilot trích từ file nguồn) được kiểm đúng như production. Hàm chỉ có THÂN GIẢ ở fixture
// (THAN_GIA) thì apHaiLuot thay md5 cũ của đúng bộ đó bằng md5 thân giả cho lượt 1; lượt 2 luôn kiểm md5 thân MỚI của
// file như production (trừ hàm test cố ý sửa thân — VA_THAN). Phép "thân lạ ⇒ dừng" có ca riêng trong test.

import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

export const MIGRATION = {
  lifecycleBase: 'supabase/migrations/20260928024843_lifecycle_reminders.sql',
  pipeline: 'supabase/migrations/20261021171249_notify_pipeline_v2.sql',
  unread: 'supabase/migrations/20261021171250_thong_bao_chua_doc_bo_cancelled_v1.sql',
  lifecycle: 'supabase/migrations/20261021171251_nhac_viec_server_lifecycle_v1.sql',
} as const;

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const ID = {
  org: u(1),
  orgKhac: u(2),
  chu: u(10),
  nhanVien: u(11),
  nguoiNgoai: u(12),
  toa: u(20),
  toaKhac: u(21),
  phong: u(30),
} as const;

/** Thay biểu thức giờ địa phương của sweep bằng đồng hồ thử (như reminders.test.ts). */
export const DONG_HO_SWEEP = 'clock_timestamp() AT TIME ZONE app_private.org_timezone_v1(v_org.id)';

const NEN = `
  CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
  CREATE SCHEMA auth; CREATE SCHEMA app_private;
  GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role;
  CREATE TABLE auth.users(id uuid PRIMARY KEY);
  INSERT INTO auth.users VALUES ('${ID.chu}'), ('${ID.nhanVien}'), ('${ID.nguoiNgoai}');
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;

  CREATE TYPE public.notification_type AS ENUM ('NEW_INVOICE','PAYMENT_REMINDER','OVERDUE_INVOICE','CONTRACT_EXPIRING',
    'ISSUE_RESOLVED','GENERAL_ANNOUNCEMENT','CUSTOM','DEPOSIT_SHORTFALL','SALARY_BONUS','ACTION_REQUIRED','APPROVAL_RESULT');
  CREATE TYPE public.notification_status AS ENUM ('PENDING','SENT','FAILED','CANCELLED','READ');
  CREATE TYPE public.notification_channel AS ENUM ('IN_APP','EMAIL','SMS','ZALO','PUSH');

  CREATE TABLE public.organizations(id uuid PRIMARY KEY, name text, status text, is_demo boolean DEFAULT false,
    authorization_version bigint NOT NULL DEFAULT 1);
  INSERT INTO public.organizations VALUES ('${ID.org}', 'Công ty A', 'ACTIVE', false), ('${ID.orgKhac}', 'Công ty B', 'ACTIVE', true);
  CREATE TABLE public.organization_memberships(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, user_id uuid,
    status text, valid_from timestamptz, valid_to timestamptz, revoked_at timestamptz);
  INSERT INTO public.organization_memberships(organization_id, user_id, status) VALUES
    ('${ID.org}', '${ID.chu}', 'ACTIVE'), ('${ID.org}', '${ID.nhanVien}', 'ACTIVE'), ('${ID.orgKhac}', '${ID.chu}', 'ACTIVE');
  CREATE TABLE public.super_admins(user_id uuid);
  CREATE FUNCTION public.demo_user_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT '{}'::uuid[] $$;
  CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT '{}'::uuid[] $$;
  CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
  CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT coalesce(array_agg(m.organization_id), '{}'::uuid[]) FROM public.organization_memberships m
     WHERE m.user_id = auth.uid() AND m.status = 'ACTIVE' $$;

  CREATE TABLE public.buildings(id uuid PRIMARY KEY, organization_id uuid, user_id uuid, name text, deleted_at timestamptz);
  INSERT INTO public.buildings VALUES ('${ID.toa}', '${ID.org}', '${ID.chu}', 'Toà 1', null), ('${ID.toaKhac}', '${ID.org}', '${ID.chu}', 'Toà 2', null);
  CREATE TABLE public.rooms(id uuid PRIMARY KEY, organization_id uuid, building_id uuid, status text, deleted_at timestamptz);
  INSERT INTO public.rooms VALUES ('${ID.phong}', '${ID.org}', '${ID.toa}', 'AVAILABLE', null);
  CREATE TABLE public.contracts(id uuid PRIMARY KEY, organization_id uuid, room_id uuid, status text, actual_end_date date,
    expected_move_out_date date, end_date date, deposit_remaining numeric DEFAULT 0, deposit_debt_mode text,
    deleted_at timestamptz, updated_at timestamptz DEFAULT now());
  CREATE TABLE public.invoices(id uuid PRIMARY KEY, organization_id uuid, building_id uuid, room_id uuid, status text,
    due_date date, total_amount numeric NOT NULL DEFAULT 0, paid_amount numeric NOT NULL DEFAULT 0,
    remaining_amount numeric GENERATED ALWAYS AS (total_amount - coalesce(paid_amount, 0)) STORED,
    deleted_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.room_turnovers(id uuid PRIMARY KEY, organization_id uuid, room_id uuid, status text, expected_ready_on date,
    version bigint, epoch integer);
  CREATE TABLE public.contract_exit_cases(id uuid PRIMARY KEY, organization_id uuid, building_id uuid, state text, version bigint);

  CREATE TABLE public.notifications(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, type public.notification_type NOT NULL,
    channel public.notification_channel NOT NULL, subject text, content text NOT NULL, invoice_id uuid, contract_id uuid,
    job_id uuid, sent_at timestamptz, status public.notification_status DEFAULT 'PENDING', error_message text,
    created_at timestamptz NOT NULL DEFAULT now(), metadata jsonb NOT NULL DEFAULT '{}'::jsonb, organization_id uuid,
    push_state text, push_attempts smallint NOT NULL DEFAULT 0, push_leased_at timestamptz, push_idem_key text);
  CREATE UNIQUE INDEX uq_notif_ie_pending_open ON public.notifications (user_id, organization_id)
    WHERE (metadata->>'kind') = 'ie_pending' AND status IS DISTINCT FROM 'READ';
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications TO authenticated;
  -- Như a90_autofill_org / trg_autofill_org_strict production: dòng không có công ty ⇒ 23502. Guard a00 phải bắn TRƯỚC
  -- (thứ tự tên) để nhắc legacy của bản web cũ bị bỏ êm thay vì ném lỗi.
  CREATE FUNCTION app_private.test_autofill_org_strict() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.organization_id IS NULL THEN RAISE EXCEPTION 'organization_id bắt buộc' USING ERRCODE = '23502'; END IF;
    RETURN NEW; END $$;
  CREATE TRIGGER a90_autofill_org BEFORE INSERT ON public.notifications
    FOR EACH ROW EXECUTE FUNCTION app_private.test_autofill_org_strict();

  CREATE TABLE public.push_subscriptions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, endpoint text,
    is_active boolean NOT NULL DEFAULT true, organization_id uuid);
  CREATE TABLE public.push_send_log(idempotency_key text PRIMARY KEY, user_id uuid, outcome text, sent integer,
    created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.notification_preferences(user_id uuid, organization_id uuid, event_key text,
    in_app boolean NOT NULL DEFAULT true, push boolean NOT NULL DEFAULT true, cadence text NOT NULL DEFAULT 'IMMEDIATE',
    updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, organization_id, event_key),
    CONSTRAINT notification_preferences_event_key_ck CHECK (event_key IN ('E1','E2','E3','E4','E5','E6')));
  CREATE TABLE public.notification_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE public.notification_templates(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  GRANT ALL ON public.push_subscriptions, public.notification_logs, public.notification_templates TO anon, authenticated;
  CREATE TABLE public.cash_handovers(id uuid PRIMARY KEY, status text, organization_id uuid, from_account_id uuid,
    confirmed_at timestamptz);
  CREATE TABLE public.accounts(id uuid PRIMARY KEY, organization_id uuid, name text, is_virtual boolean DEFAULT false,
    deleted_at timestamptz, lock_date date);
  CREATE TABLE app_private.cashbook_closures(cashbook_id uuid, closed_through date);
  -- Bản production 22/10 (pg_get_functiondef, md5 a726dfac…).
  CREATE FUNCTION app_private.cashbook_closed_through_v1(p_cashbook uuid) RETURNS date LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app_private', 'public' AS $function$
  SELECT CASE
    WHEN COALESCE(current_setting('app_private.demo_reset', true), '') = 'on' THEN NULL
    ELSE GREATEST(
      (SELECT max(c.closed_through) FROM app_private.cashbook_closures c
        WHERE c.cashbook_id = p_cashbook),
      (SELECT a.lock_date FROM public.accounts a WHERE a.id = p_cashbook)
    )
  END;
$function$;
  CREATE TABLE public.income_expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, building_id uuid,
    deleted_at timestamptz, approval_status text, review_state text, total_amount numeric, created_at timestamptz DEFAULT clock_timestamp());
  CREATE TABLE public.approval_requests(subject_type text, subject_id uuid, state text);

  CREATE TABLE app_private.notification_org_config(organization_id uuid PRIMARY KEY, events jsonb NOT NULL DEFAULT '{}'::jsonb,
    quiet_start smallint NOT NULL DEFAULT 21, quiet_end smallint NOT NULL DEFAULT 7, updated_by uuid,
    updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE app_private.notification_no_recipient_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid,
    event_key text, subject_kind text, subject_id uuid, building_id uuid, actor_id uuid, reason text,
    created_at timestamptz NOT NULL DEFAULT now());

  CREATE TABLE test_tz(organization_id uuid PRIMARY KEY, tz text);
  CREATE FUNCTION app_private.org_timezone_v1(uuid) RETURNS text LANGUAGE sql STABLE AS $$
    SELECT coalesce((SELECT t.tz FROM test_tz t WHERE t.organization_id = $1), 'UTC') $$;
  CREATE TABLE test_clock(local_now timestamp);
  INSERT INTO test_clock VALUES (date_trunc('day', now()) + interval '9 hours');
  CREATE FUNCTION public.org_today_v1(uuid) RETURNS date LANGUAGE sql STABLE AS $$ SELECT local_now::date FROM test_clock $$;
  CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN RETURN 0; END $$;
  CREATE TABLE test_permissions(user_id uuid, organization_id uuid, building_id uuid, permission text, allowed boolean);
  CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid, uuid, text, uuid, uuid) RETURNS TABLE(allowed boolean) LANGUAGE sql AS $$
    SELECT coalesce((SELECT bool_or(p.allowed) FROM test_permissions p
                      WHERE p.user_id = $1 AND p.organization_id = $2 AND p.permission = $3
                        AND (p.building_id IS NULL OR p.building_id IS NOT DISTINCT FROM $4)), false) $$;
  CREATE FUNCTION app_private.authorized_scope_v3(text, uuid) RETURNS TABLE(org_wide boolean, building_ids uuid[], cashbook_ids uuid[])
    LANGUAGE sql STABLE AS $$ SELECT coalesce((SELECT bool_or(p.allowed) FROM test_permissions p
      WHERE p.user_id = auth.uid() AND p.organization_id = $2 AND p.permission = $1 AND p.building_id IS NULL), false),
      '{}'::uuid[], '{}'::uuid[] $$;
  CREATE FUNCTION public.can_access_org_entity(text, text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (SELECT 1 FROM public.test_permissions p WHERE p.user_id = auth.uid() AND p.permission = $1 || '.' || $2 AND p.allowed) $$;
  GRANT EXECUTE ON FUNCTION public.can_access_org_entity(text, text) TO authenticated;
  CREATE FUNCTION app_private.copilot_page_flag_allows_v1(text, uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;

  -- Bản production của hai cổng quyền dùng chung.
  CREATE FUNCTION app_private.require_perm_v1(p_org uuid, p_permission_key text, p_viec text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'app_private' AS $$
  declare v_ok boolean;
  begin
    if (select auth.uid()) is null then raise exception 'Bạn chưa đăng nhập.' using errcode = '42501'; end if;
    perform app_private.lock_org_for_decision_v1(p_org);
    select a.allowed into v_ok from app_private.authorize_tenant_action_v3((select auth.uid()), p_org, p_permission_key, null, null) a;
    if not coalesce(v_ok, false) then raise exception 'Bạn không có quyền %.', p_viec using errcode = '42501'; end if;
  end $$;
  CREATE FUNCTION app_private.assert_notification_membership_v1(p_org uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'app_private', 'public' AS $$
  declare v_uid uuid; v_now timestamptz := clock_timestamp(); v_ok boolean;
  begin
    v_uid := (select auth.uid());
    if v_uid is null then raise exception 'Bạn chưa đăng nhập.' using errcode = '42501'; end if;
    if p_org is null then raise exception 'Thiếu tổ chức.' using errcode = '22023'; end if;
    select exists (select 1 from public.organization_memberships m join public.organizations o on o.id = m.organization_id and o.status = 'ACTIVE'
      where m.organization_id = p_org and m.user_id = v_uid and m.status = 'ACTIVE'
        and coalesce(m.valid_from, '-infinity'::timestamptz) <= v_now and (m.valid_to is null or m.valid_to > v_now)) into v_ok;
    if not v_ok then raise exception 'Bạn không thuộc tổ chức này.' using errcode = '42501'; end if;
  end $$;

  -- Hàm sẽ bị migration thay (chỉ cần tồn tại cho điều kiện tiên quyết / mẫu vá của 20260928024843).
  CREATE FUNCTION app_private.notify_gate_v1(uuid, uuid, text, numeric DEFAULT NULL) RETURNS TABLE(g_in_app boolean, g_push boolean)
    LANGUAGE sql AS $$ SELECT true, true $$;
  CREATE FUNCTION app_private.notify_ie_pending_refresh_v1(uuid, uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
  CREATE FUNCTION app_private.notification_events_normalize_v1(jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE k text[] := array['E1','E2','E3','E4','E5','E6']; BEGIN RETURN $1; END $$;
  CREATE FUNCTION app_private.notification_prefs_normalize_v1(jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE k text[] := array['E1','E2','E3','E4','E5','E6']; BEGIN RETURN $1; END $$;
  CREATE FUNCTION app_private.notification_prefs_read_v1(uuid, uuid) RETURNS jsonb LANGUAGE sql AS $$
    SELECT jsonb_agg(k) FROM (values ('E1'),('E2'),('E3'),('E4'),('E5'),('E6')) k $$;
  CREATE FUNCTION app_private.notify_claim_push_batch_v1(p_limit integer DEFAULT 100)
    RETURNS TABLE(notification_ids uuid[], user_id uuid, idem_key text, title text, body text, url text, tag text)
    LANGUAGE sql AS $$ SELECT NULL::uuid[], NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text WHERE false $$;
  CREATE FUNCTION app_private.notify_settle_push_batch_v1(p_results jsonb) RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$;
`;

/** Hàm 20261021171249 thay mà fixture chỉ có thân GIẢ (production: md5 ghim trong $requires$ của file). */
export const THAN_GIA_PIPELINE = [
  'app_private.notification_events_normalize_v1(jsonb)',
  'app_private.notification_prefs_normalize_v1(jsonb)',
  'app_private.notification_prefs_read_v1(uuid,uuid)',
  'app_private.notify_gate_v1(uuid,uuid,text,numeric)',
  'app_private.notify_ie_pending_refresh_v1(uuid,uuid)',
  'app_private.notify_claim_push_batch_v1(integer)',
  'app_private.notify_settle_push_batch_v1(jsonb)',
];

/** Thân hiện hành của hai hàm 20261021171250 thay — trích NGUYÊN VĂN từ file nguồn (md5 = production 22/10). */
const NGUON_171250 = [
  ['supabase/migrations/20261018080000_hermes_w2z_shared_fixes_v1.sql', 'public.notifications_inbox_v1'],
  ['supabase/migrations/20260908105446_copilot_notification_feed_v1.sql', 'public.copilot_notification_feed_v1'],
] as const;

export function docMigration(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

/** Câu CREATE OR REPLACE FUNCTION cuối cùng của `ten` trong file, tới hết dollar-quote đóng thân. */
export function trichHam(file: string, ten: string): string {
  const src = docMigration(file);
  const start = src.lastIndexOf(`CREATE OR REPLACE FUNCTION ${ten}(`);
  if (start < 0) throw new Error(`không thấy ${ten} trong ${file}`);
  const as = /\bAS\s+(\$[A-Za-z0-9_]*\$)/.exec(src.slice(start))!;
  const bodyStart = start + as.index + as[0].length;
  const end = src.indexOf(as[1], bodyStart) + as[1].length;
  return `${src.slice(start, end)};`;
}

type Ghim = { dong: string; sig: string; cu: string; moi: string };
/** Các bộ ('chữ ký', 'md5 cũ', 'md5 mới') trong khối $requires$ của migration. */
export function docGhim(sql: string): Ghim[] {
  const out: Ghim[] = [];
  for (const m of sql.matchAll(/\('([a-z_]+\.[a-z0-9_]+\([^']*\))', '([0-9a-f]{32}|)', '([0-9a-f]{32})'\)/g)) {
    out.push({ dong: m[0], sig: m[1], cu: m[2], moi: m[3] });
  }
  return out;
}

/** md5 thân đang chạy, đúng phép tính của $requires$ (bỏ CR; 20261021171253 chuẩn hoá thêm URL dự án). */
export async function md5Than(db: PGlite, sig: string): Promise<string | null> {
  const r = await db.query<{ m: string | null }>(
    `SELECT (SELECT md5(regexp_replace(replace(p.prosrc, chr(13), ''), 'https://[a-z0-9]{20}\\.supabase\\.co',
                                       'https://<ref>.supabase.co', 'g'))
               FROM pg_proc p WHERE p.oid = to_regprocedure($1)) m`, [sig]);
  return r.rows[0].m;
}

/**
 * Áp migration hai lượt như lane. `thanGia`: hàm fixture chỉ có thân giả ⇒ lượt 1 thay md5 cũ của đúng bộ đó bằng md5
 * thân giả. `vaThan`: hàm test sửa thân (đồng hồ thử) hoặc migration VÁ trên thân giả ⇒ lượt 2 thay md5 mới bằng md5
 * sau lượt 1. Mọi hàm khác kiểm y như production. Ném nếu chữ ký khai không có trong khối $requires$.
 */
export async function apHaiLuot(db: PGlite, sql: string, thanGia: string[] = [], vaThan: string[] = []): Promise<void> {
  const ghim = docGhim(sql);
  for (const sig of [...thanGia, ...vaThan]) {
    if (!ghim.some((g) => g.sig === sig)) throw new Error(`${sig} không có trong $requires$`);
  }
  let lan1 = sql;
  for (const g of ghim.filter((x) => thanGia.includes(x.sig))) {
    const m = await md5Than(db, g.sig);
    if (!m) throw new Error(`fixture thiếu thân giả của ${g.sig}`);
    lan1 = lan1.replace(g.dong, `('${g.sig}', '${m}', '${g.moi}')`);
  }
  await db.exec(lan1);
  let lan2 = lan1;
  for (const g of docGhim(lan1).filter((x) => vaThan.includes(x.sig))) {
    lan2 = lan2.replace(g.dong, `('${g.sig}', '${g.cu}', '${await md5Than(db, g.sig)}')`);
  }
  await db.exec(lan2);
}

/** Dựng database thử và áp các migration gói B (mỗi file hai lượt). */
export async function taoDbThongBao(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(NEN);
  await db.exec(docMigration(MIGRATION.lifecycleBase));
  await apHaiLuot(db, docMigration(MIGRATION.pipeline), THAN_GIA_PIPELINE);
  for (const [file, ten] of NGUON_171250) await db.exec(trichHam(file, ten));
  await apHaiLuot(db, docMigration(MIGRATION.unread));
  // Sweep đọc đồng hồ thử thay cho giờ thật ⇒ thân sweep khác file ⇒ lượt 2 ghim md5 của thân đã thay.
  const lifecycle = docMigration(MIGRATION.lifecycle).split(DONG_HO_SWEEP).join('(SELECT test_clock.local_now FROM test_clock)');
  await apHaiLuot(db, lifecycle, [], ['public.lifecycle_reminder_sweep_v1(uuid)']);
  return db;
}

/** Chạy fn dưới vai `vai` với auth.uid() = uid (NULL nếu không truyền). Luôn trả về vai postgres sau đó. */
export async function voiVai<T>(db: PGlite, vai: 'authenticated' | 'service_role' | 'anon', uid: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('test.uid', $1, false)", [uid ?? '']);
  await db.exec(`SET ROLE ${vai}`);
  try {
    return await fn();
  } finally {
    await db.exec('RESET ROLE');
    await db.query("SELECT set_config('test.uid', '', false)");
  }
}

/** Chạy fn với auth.uid() = uid dưới vai postgres (gọi RPC SECURITY DEFINER như người dùng đó). */
export async function voiNguoi<T>(db: PGlite, uid: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('test.uid', $1, false)", [uid ?? '']);
  try {
    return await fn();
  } finally {
    await db.query("SELECT set_config('test.uid', '', false)");
  }
}

/** Mã lỗi Postgres của một promise bị từ chối (null nếu thành công). */
export async function maLoi(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? 'khong-ma';
  }
}

/** Giờ UTC hiện tại — giờ yên trong test tính theo múi giờ UTC (test_tz rỗng). */
export function gioHienTai(): number {
  return new Date().getUTCHours();
}

/** Khung [giờ-1, giờ+2) theo UTC — chứa "bây giờ" kể cả khi test chạy sát mép giờ. */
export function khungChuaBayGio(): { start: number; end: number } {
  const h = gioHienTai();
  return { start: (h + 23) % 24, end: (h + 2) % 24 };
}

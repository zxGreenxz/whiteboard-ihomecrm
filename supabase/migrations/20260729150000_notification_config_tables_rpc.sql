-- PR-4a — LƯU CẤU HÌNH THÔNG BÁO (đặc tả §C).
--
-- Tạo hai chỗ cất cấu hình + bốn RPC. KHÔNG bật sự kiện nào, KHÔNG đụng bảng notifications.
--
--   app_private.notification_org_config  — khoá mở cấp TỔ CHỨC (chủ bật/tắt từng họ sự kiện,
--                                          đặt giờ yên). Nằm trong app_private nên PostgREST
--                                          KHÔNG expose; chỉ vào được qua 2 RPC dưới.
--   public.notification_preferences      — sở thích CÁ NHÂN (mỗi người tự chỉnh, own-row).
--
-- BỐN RPC:
--   public.set_notification_org_config_v1(p_events, p_quiet_start, p_quiet_end)  settings.edit
--   public.get_notification_org_config_v1()                                      settings.view
--   public.set_my_notification_preferences_v1(p_organization_id, p_prefs)        membership ACTIVE
--   public.get_my_notification_preferences_v1(p_organization_id)                 membership ACTIVE
--
-- CỔNG QUYỀN — vì sao viết như dưới đây chứ không chép hàng xóm:
--   * Hai hàm cấp tổ chức dùng app_private.current_admin_org_v1() + app_private.require_perm_v1(),
--     tức là đi qua authorize_tenant_action_v3 — có đủ DENY > ALLOW, scope, role_bindings.valid_from/
--     valid_to, member_permission_overrides.expires_at và emergency-deny.
--   * 🚫 KHÔNG chép set_ie_auto_approve_threshold_v1: hàm đó chọn org bằng min(organization_id::text),
--     so TÊN CHUỖI role 'Chủ sở hữu tổ chức', không kiểm scope, không kiểm valid_to.
--   * 🚫 KHÔNG chép get_acceptance_geofence_config: hàm đó neo staff_assignments (đã bị
--     20260725210000_cutover_helper_bodies.sql bỏ khỏi staff_can), LIMIT 1 không ORDER BY, và
--     GRANT EXECUTE cho anon.
--   * Hai hàm cá nhân CHỈ kiểm membership ACTIVE (sở thích của chính mình, không phải hành vi quản trị).
--
-- NỀN ĐÃ ĐO (29/07/2026, chạy thật trên prod trong begin…rollback):
--   settings.edit / settings.view: permission_domain=TENANT, is_active, required_dimensions={},
--   scope_kinds={ORGANIZATION}, requires_cashbook_possession=false ⇒ require_perm_v1 truyền
--   building=NULL vẫn duyệt được (REQUIRED_DIMENSION_MISSING không xảy ra).
--   demo.chunha  → settings.edit/view/users.view = ROLE_ALLOW  (org DEMO)
--   nathan       → cả ba = DEFAULT_DENY          (org THẬT)  ⇒ current_admin_org_v1() trả NULL.
--
-- BẪY ACL ĐÃ TRÁNH: schema public có DEFAULT PRIVILEGES cấp arwdDxtm cho anon/authenticated/
-- service_role trên MỌI bảng mới và EXECUTE cho anon/service_role trên MỌI hàm mới. Không revoke
-- tường minh thì notification_preferences sẽ mở toang cho anon ngay lúc tạo.
-- (Schema app_private KHÔNG có default privileges ⇒ bảng ở đó chỉ owner đụng được; vẫn revoke cho rõ.)

begin;

-- ============================================================================
-- 1) BẢNG CẤU HÌNH CẤP TỔ CHỨC (app_private — không lộ ra PostgREST)
-- ============================================================================

create table if not exists app_private.notification_org_config (
  organization_id uuid primary key
    references public.organizations(id) on delete cascade,
  events      jsonb    not null default '{}'::jsonb,
  quiet_start smallint not null default 21
    constraint notification_org_config_quiet_start_ck check (quiet_start between 0 and 23),
  quiet_end   smallint not null default 7
    constraint notification_org_config_quiet_end_ck   check (quiet_end   between 0 and 23),
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);

alter table app_private.notification_org_config enable row level security;
-- KHÔNG policy nào — và đó là chủ ý. nspacl của app_private = {postgres=UC, ie_canonical_writer=U}
-- nên anon/authenticated không có USAGE, PostgREST không expose. Hai RPC dưới là cửa duy nhất.

revoke all on table app_private.notification_org_config from public;
revoke all on table app_private.notification_org_config from anon;
revoke all on table app_private.notification_org_config from authenticated;
revoke all on table app_private.notification_org_config from service_role;

comment on table app_private.notification_org_config is
  'Khoá mở thông báo cấp tổ chức. events = {"E1":{"enabled":bool,"min_amount":numeric|null},…E5}. '
  'Chỉ vào được qua public.get/set_notification_org_config_v1.';
comment on column app_private.notification_org_config.quiet_start is
  'GIỜ VN (Asia/Ho_Chi_Minh), 0..23. Người tiêu thụ phải so bằng '
  'extract(hour from (now() at time zone ''Asia/Ho_Chi_Minh'')) — KHÔNG phải UTC (cron.timezone=GMT).';
comment on column app_private.notification_org_config.quiet_end is
  'GIỜ VN (Asia/Ho_Chi_Minh), 0..23. Khoảng yên là [quiet_start, quiet_end), cho phép vắt qua nửa '
  'đêm (21→7). quiet_start = quiet_end nghĩa là KHÔNG có giờ yên.';
comment on column app_private.notification_org_config.events is
  'min_amount NULL = không lọc theo tiền (mặc định). Đã đo: nâng ngưỡng 300k→3tr chỉ hạ đỉnh từ 15 '
  'xuống 14 thông báo/ngày ⇒ ngưỡng tiền gần như vô dụng làm cơ chế chống ồn.';

-- ============================================================================
-- 2) BẢNG SỞ THÍCH CÁ NHÂN (public — own-row + ranh giới tổ chức)
-- ============================================================================

create table if not exists public.notification_preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_key text not null
    constraint notification_preferences_event_key_ck check (event_key in ('E1','E2','E3','E4','E5')),
  in_app boolean not null default true,
  push   boolean not null default true,
  cadence text not null default 'IMMEDIATE'
    constraint notification_preferences_cadence_ck check (cadence in ('IMMEDIATE','DIGEST','OFF')),
  updated_at timestamptz not null default now(),
  primary key (user_id, organization_id, event_key)
);

alter table public.notification_preferences enable row level security;

-- Own-row: sở thích là của riêng mình. KHÔNG nhánh super-admin — xem hộ sở thích người khác vô nghĩa,
-- và mọi trigger đọc bảng này đều SECURITY DEFINER owner=postgres nên bypass RLS sẵn.
drop policy if exists np_own on public.notification_preferences;
create policy np_own on public.notification_preferences
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- RESTRICTIVE org boundary. KHÔNG escape "IS NULL" vì cột NOT NULL (khác 29 bảng kia).
drop policy if exists np_org_boundary on public.notification_preferences;
create policy np_org_boundary on public.notification_preferences
  as restrictive for all to authenticated
  using (organization_id in (select unnest(public.my_org_ids())))
  with check (organization_id in (select unnest(public.my_org_ids())));

revoke all on table public.notification_preferences from public;
revoke all on table public.notification_preferences from anon;
revoke all on table public.notification_preferences from authenticated;
revoke all on table public.notification_preferences from service_role;
grant select, insert, update, delete on table public.notification_preferences to authenticated;

comment on table public.notification_preferences is
  'Sở thích thông báo của từng người theo từng tổ chức. event_key là 5 HỌ sự kiện (E1..E5); '
  'metadata.event có 7 nhánh (E1,E2,E2b,E2c,E3,E4,E5) nên MỌI chỗ tra bảng này phải ánh xạ trước: '
  'case when (metadata->>''event'') like ''E2%'' then ''E2'' else metadata->>''event'' end.';
comment on column public.notification_preferences.cadence is
  'IMMEDIATE | DIGEST | OFF. DIGEST hoãn sang đợt 2 — đợt 1 chỉ dùng IMMEDIATE/OFF.';

-- ============================================================================
-- 3) HÀM PHỤ TRỢ (app_private) — chuẩn hoá & kiểm thành viên
-- ============================================================================

-- 3a) Chuẩn hoá + kiểm tra `events`. LUÔN trả đủ 5 khoá E1..E5 để phía đọc không phải coalesce.
drop function if exists app_private.notification_events_normalize_v1(jsonb);
create or replace function app_private.notification_events_normalize_v1(p_events jsonb)
returns jsonb
language plpgsql
immutable
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
declare
  v_keys constant text[] := array['E1','E2','E3','E4','E5'];
  v_out  jsonb := '{}'::jsonb;
  v_src  jsonb;
  k       text;
  v       jsonb;
  v_on    boolean;
  v_min   numeric;
begin
  v_src := p_events;
  if v_src is null or jsonb_typeof(v_src) = 'null' then
    v_src := '{}'::jsonb;
  end if;
  if jsonb_typeof(v_src) <> 'object' then
    raise exception 'Cấu hình sự kiện phải là một object JSON.' using errcode = '22023';
  end if;

  -- Khoá lạ là lỗi, không im lặng bỏ qua: im lặng = người dùng tưởng đã tắt mà thực ra chưa.
  for k in select jsonb_object_keys(v_src) loop
    if not (k = any (v_keys)) then
      raise exception 'Sự kiện không hợp lệ: %. Chỉ nhận E1, E2, E3, E4, E5.', k using errcode = '22023';
    end if;
  end loop;

  foreach k in array v_keys loop
    v := v_src -> k;
    if v is null or jsonb_typeof(v) = 'null' then
      v_out := v_out || jsonb_build_object(k, jsonb_build_object('enabled', true, 'min_amount', null));
      continue;
    end if;
    if jsonb_typeof(v) <> 'object' then
      raise exception 'Cấu hình sự kiện % phải là object JSON.', k using errcode = '22023';
    end if;

    if jsonb_exists(v, 'enabled') and jsonb_typeof(v -> 'enabled') <> 'boolean' then
      raise exception 'events.%.enabled phải là true hoặc false.', k using errcode = '22023';
    end if;
    v_on := coalesce((v ->> 'enabled')::boolean, true);

    if jsonb_exists(v, 'min_amount') and jsonb_typeof(v -> 'min_amount') not in ('null', 'number') then
      raise exception 'events.%.min_amount phải là số hoặc null.', k using errcode = '22023';
    end if;
    if jsonb_exists(v, 'min_amount') and jsonb_typeof(v -> 'min_amount') = 'number' then
      v_min := (v ->> 'min_amount')::numeric;
      if v_min < 0 then
        raise exception 'events.%.min_amount không được âm.', k using errcode = '22023';
      end if;
    else
      v_min := null;
    end if;

    v_out := v_out || jsonb_build_object(k, jsonb_build_object('enabled', v_on, 'min_amount', v_min));
  end loop;

  return v_out;
end
$fn$;

revoke all on function app_private.notification_events_normalize_v1(jsonb) from public;
revoke all on function app_private.notification_events_normalize_v1(jsonb) from anon;
revoke all on function app_private.notification_events_normalize_v1(jsonb) from authenticated;
revoke all on function app_private.notification_events_normalize_v1(jsonb) from service_role;

-- 3b) Chuẩn hoá + kiểm tra `prefs`. CHỈ trả những khoá người dùng gửi lên (cho phép sửa từng phần).
drop function if exists app_private.notification_prefs_normalize_v1(jsonb);
create or replace function app_private.notification_prefs_normalize_v1(p_prefs jsonb)
returns jsonb
language plpgsql
immutable
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
declare
  v_keys      constant text[] := array['E1','E2','E3','E4','E5'];
  v_cadences  constant text[] := array['IMMEDIATE','DIGEST','OFF'];
  v_out jsonb := '{}'::jsonb;
  k     text;
  v     jsonb;
  v_cad text;
begin
  if p_prefs is null or jsonb_typeof(p_prefs) = 'null' then
    raise exception 'Thiếu dữ liệu sở thích thông báo.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_prefs) <> 'object' then
    raise exception 'Sở thích thông báo phải là một object JSON.' using errcode = '22023';
  end if;

  for k in select jsonb_object_keys(p_prefs) loop
    if not (k = any (v_keys)) then
      raise exception 'Sự kiện không hợp lệ: %. Chỉ nhận E1, E2, E3, E4, E5.', k using errcode = '22023';
    end if;
    v := p_prefs -> k;
    if jsonb_typeof(v) <> 'object' then
      raise exception 'Sở thích của % phải là object JSON.', k using errcode = '22023';
    end if;
    if jsonb_exists(v, 'in_app') and jsonb_typeof(v -> 'in_app') <> 'boolean' then
      raise exception '%.in_app phải là true hoặc false.', k using errcode = '22023';
    end if;
    if jsonb_exists(v, 'push') and jsonb_typeof(v -> 'push') <> 'boolean' then
      raise exception '%.push phải là true hoặc false.', k using errcode = '22023';
    end if;

    -- 🔴 FIELD VẮNG ⇒ PHÁT JSON `null`, KHÔNG phát mặc định `true/IMMEDIATE`.
    -- Bản nháp điền cứng true/true/IMMEDIATE cho field vắng rồi setter `do update set` ghi đè hết
    -- ⇒ gửi {"E1":{"in_app":false}} là BẬT LẠI push mà người dùng vừa tắt, im lặng, không lỗi.
    -- (Đã đo: {"E1":{"in_app":true,"push":false}} → push=false ✓ ; {"E1":{"in_app":false}} → push=TRUE ✗.)
    -- Setter dưới dùng coalesce(excluded.x, table.x) nên `null` = "giữ nguyên giá trị cũ".
    if jsonb_exists(v, 'cadence') then
      v_cad := upper(v ->> 'cadence');
      if not (v_cad = any (v_cadences)) then
        raise exception 'Nhịp gửi không hợp lệ: %. Chỉ nhận IMMEDIATE, DIGEST, OFF.', v_cad
          using errcode = '22023';
      end if;
    else
      v_cad := null;
    end if;

    v_out := v_out || jsonb_build_object(k, jsonb_build_object(
      'in_app',  case when jsonb_exists(v, 'in_app')  then (v ->> 'in_app')::boolean  else null end,
      'push',    case when jsonb_exists(v, 'push')    then (v ->> 'push')::boolean    else null end,
      'cadence', v_cad));
  end loop;

  if v_out = '{}'::jsonb then
    raise exception 'Không có sự kiện nào để lưu.' using errcode = '22023';
  end if;
  return v_out;
end
$fn$;

revoke all on function app_private.notification_prefs_normalize_v1(jsonb) from public;
revoke all on function app_private.notification_prefs_normalize_v1(jsonb) from anon;
revoke all on function app_private.notification_prefs_normalize_v1(jsonb) from authenticated;
revoke all on function app_private.notification_prefs_normalize_v1(jsonb) from service_role;

-- 3c) Kiểm thành viên ACTIVE. Chép ĐÚNG cửa sổ hiệu lực của authorize_tenant_action_v3
-- (status ACTIVE + valid_from/valid_to + tổ chức ACTIVE) để hai đường không lệch nhau.
drop function if exists app_private.assert_notification_membership_v1(uuid);
create or replace function app_private.assert_notification_membership_v1(p_org uuid)
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
declare
  v_uid uuid;
  v_now timestamptz := clock_timestamp();
  v_ok  boolean;
begin
  v_uid := (select auth.uid());
  if v_uid is null then
    raise exception 'Bạn chưa đăng nhập.' using errcode = '42501';
  end if;
  if p_org is null then
    raise exception 'Thiếu tổ chức.' using errcode = '22023';
  end if;

  select exists (
    select 1
      from public.organization_memberships m
      join public.organizations o
        on o.id = m.organization_id and o.status = 'ACTIVE'
     where m.organization_id = p_org
       and m.user_id = v_uid
       and m.status = 'ACTIVE'
       and coalesce(m.valid_from, '-infinity'::timestamptz) <= v_now
       and (m.valid_to is null or m.valid_to > v_now)
  ) into v_ok;

  if not v_ok then
    raise exception 'Bạn không thuộc tổ chức này.' using errcode = '42501';
  end if;
end
$fn$;

revoke all on function app_private.assert_notification_membership_v1(uuid) from public;
revoke all on function app_private.assert_notification_membership_v1(uuid) from anon;
revoke all on function app_private.assert_notification_membership_v1(uuid) from authenticated;
revoke all on function app_private.assert_notification_membership_v1(uuid) from service_role;

-- 3d) Gộp sở thích đã lưu với mặc định, LUÔN trả đủ 5 họ. Một nguồn sự thật cho cả getter lẫn setter.
drop function if exists app_private.notification_prefs_read_v1(uuid, uuid);
create or replace function app_private.notification_prefs_read_v1(p_user uuid, p_org uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
  select coalesce(jsonb_object_agg(k.event_key, jsonb_build_object(
           'in_app',  coalesce(np.in_app, true),
           'push',    coalesce(np.push, true),
           'cadence', coalesce(np.cadence, 'IMMEDIATE'),
           'updated_at', np.updated_at)), '{}'::jsonb)
    from (values ('E1'),('E2'),('E3'),('E4'),('E5')) as k(event_key)
    left join public.notification_preferences np
      on np.user_id = p_user
     and np.organization_id = p_org
     and np.event_key = k.event_key;
$fn$;

revoke all on function app_private.notification_prefs_read_v1(uuid, uuid) from public;
revoke all on function app_private.notification_prefs_read_v1(uuid, uuid) from anon;
revoke all on function app_private.notification_prefs_read_v1(uuid, uuid) from authenticated;
revoke all on function app_private.notification_prefs_read_v1(uuid, uuid) from service_role;

-- ============================================================================
-- 4) RPC CẤP TỔ CHỨC — settings.view / settings.edit
-- ============================================================================

drop function if exists public.get_notification_org_config_v1();
create or replace function public.get_notification_org_config_v1()
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
declare
  v_org uuid;
  v_row app_private.notification_org_config%rowtype;
begin
  if (select auth.uid()) is null then
    raise exception 'Bạn chưa đăng nhập.' using errcode = '42501';
  end if;

  v_org := app_private.current_admin_org_v1();
  if v_org is null then
    -- current_admin_org_v1() trả NULL khi không có users.view và không phải super admin.
    raise exception 'Không xác định được tổ chức quản trị. current_admin_org_v1() cần quyền users.view '
      '(hoặc super admin) — settings.view một mình là chưa đủ.' using errcode = '42501';
  end if;
  perform app_private.require_perm_v1(v_org, 'settings.view', 'xem cấu hình thông báo của tổ chức');

  select * into v_row
    from app_private.notification_org_config
   where organization_id = v_org;

  if not found then
    return jsonb_build_object(
      'organization_id', v_org,
      'configured',      false,
      'events',          app_private.notification_events_normalize_v1(null),
      'quiet_start',     21,
      'quiet_end',       7,
      'quiet_timezone',  'Asia/Ho_Chi_Minh',
      'updated_by',      null,
      'updated_at',      null);
  end if;

  return jsonb_build_object(
    'organization_id', v_row.organization_id,
    'configured',      true,
    'events',          app_private.notification_events_normalize_v1(v_row.events),
    'quiet_start',     v_row.quiet_start,
    'quiet_end',       v_row.quiet_end,
    'quiet_timezone',  'Asia/Ho_Chi_Minh',
    'updated_by',      v_row.updated_by,
    'updated_at',      v_row.updated_at);
end
$fn$;

revoke all on function public.get_notification_org_config_v1() from public;
revoke all on function public.get_notification_org_config_v1() from anon;
revoke all on function public.get_notification_org_config_v1() from authenticated;
revoke all on function public.get_notification_org_config_v1() from service_role;
grant execute on function public.get_notification_org_config_v1() to authenticated;

comment on function public.get_notification_org_config_v1() is
  'Đọc khoá mở thông báo của tổ chức quản trị hiện tại. Cổng: settings.view qua require_perm_v1. '
  'quiet_start/quiet_end là GIỜ VN (Asia/Ho_Chi_Minh).';

drop function if exists public.set_notification_org_config_v1(jsonb, integer, integer);
create or replace function public.set_notification_org_config_v1(
  p_events      jsonb   default null,
  p_quiet_start integer default null,
  p_quiet_end   integer default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
declare
  v_uid    uuid;
  v_org    uuid;
  v_cur    app_private.notification_org_config%rowtype;
  v_events jsonb;
  v_merged jsonb;
  v_k      text;
  v_start  smallint;
  v_end    smallint;
  v_row    app_private.notification_org_config%rowtype;
begin
  v_uid := (select auth.uid());
  if v_uid is null then
    raise exception 'Bạn chưa đăng nhập.' using errcode = '42501';
  end if;

  v_org := app_private.current_admin_org_v1();
  if v_org is null then
    raise exception 'Không xác định được tổ chức quản trị. current_admin_org_v1() cần quyền users.view '
      '(hoặc super admin) — settings.edit một mình là chưa đủ.' using errcode = '42501';
  end if;
  perform app_private.require_perm_v1(v_org, 'settings.edit', 'sửa cấu hình thông báo của tổ chức');

  select * into v_cur
    from app_private.notification_org_config
   where organization_id = v_org
   for update;

  -- NULL = "giữ nguyên", không phải "đặt lại mặc định".
  -- 🔴 GHI ĐÈ THEO HỌ, KHÔNG THAY CẢ CỤM. Bản nháp normalize p_events rồi ghi đè toàn bộ cột
  -- `events` ⇒ chủ gạt một công tắc là 4 họ kia bị lên đạn lại về mặc định và min_amount bị xoá,
  -- không lỗi, không cảnh báo. Đo thật: {"E5":{"enabled":false}} → E5 off ✓ ;
  -- rồi {"E1":{"enabled":false}} → E5 QUAY LẠI enabled=true, min_amount của E1 → null.
  -- Nay: chuẩn hoá cấu hình HIỆN TẠI làm nền, rồi merge nông từng họ được gửi lên đè lên nền đó.
  -- ⚠ normalize() LUÔN điền đủ 5 họ (foreach trên v_keys), nên merge SAU khi chuẩn hoá là vô nghĩa.
  -- Phải merge trên JSON THÔ rồi mới chuẩn hoá một lần ở cuối.
  if p_events is null then
    v_events := app_private.notification_events_normalize_v1(v_cur.events);
  else
    -- (1) validate hình dạng + khoá lạ của p_events, ném lỗi tiếng Việt nếu sai.
    perform app_private.notification_events_normalize_v1(p_events);
    -- (2) merge SÂU tới cấp field: họ không gửi lên thì giữ nguyên; trong một họ, field không gửi
    --     lên cũng giữ nguyên (vd gửi {"E1":{"enabled":false}} KHÔNG xoá min_amount của E1).
    v_merged := coalesce(v_cur.events, '{}'::jsonb);
    for v_k in select jsonb_object_keys(p_events) loop
      v_merged := jsonb_set(
                    v_merged, array[v_k],
                    coalesce(v_merged -> v_k, '{}'::jsonb) || (p_events -> v_k),
                    true);
    end loop;
    v_events := app_private.notification_events_normalize_v1(v_merged);
  end if;

  v_start := coalesce(p_quiet_start, v_cur.quiet_start, 21)::smallint;
  v_end   := coalesce(p_quiet_end,   v_cur.quiet_end,   7)::smallint;

  -- Kiểm trước CHECK để lỗi ra tiếng Việt thay vì 23514 khó hiểu.
  if v_start < 0 or v_start > 23 then
    raise exception 'Giờ bắt đầu yên phải trong khoảng 0..23 (giờ VN).' using errcode = '22023';
  end if;
  if v_end < 0 or v_end > 23 then
    raise exception 'Giờ kết thúc yên phải trong khoảng 0..23 (giờ VN).' using errcode = '22023';
  end if;

  insert into app_private.notification_org_config
    (organization_id, events, quiet_start, quiet_end, updated_by, updated_at)
  values
    (v_org, v_events, v_start, v_end, v_uid, now())
  on conflict (organization_id) do update
    set events      = excluded.events,
        quiet_start = excluded.quiet_start,
        quiet_end   = excluded.quiet_end,
        updated_by  = excluded.updated_by,
        updated_at  = now()
  returning * into v_row;

  return jsonb_build_object(
    'organization_id', v_row.organization_id,
    'configured',      true,
    'events',          v_row.events,
    'quiet_start',     v_row.quiet_start,
    'quiet_end',       v_row.quiet_end,
    'quiet_timezone',  'Asia/Ho_Chi_Minh',
    'updated_by',      v_row.updated_by,
    'updated_at',      v_row.updated_at);
end
$fn$;

revoke all on function public.set_notification_org_config_v1(jsonb, integer, integer) from public;
revoke all on function public.set_notification_org_config_v1(jsonb, integer, integer) from anon;
revoke all on function public.set_notification_org_config_v1(jsonb, integer, integer) from authenticated;
revoke all on function public.set_notification_org_config_v1(jsonb, integer, integer) from service_role;
grant execute on function public.set_notification_org_config_v1(jsonb, integer, integer) to authenticated;

comment on function public.set_notification_org_config_v1(jsonb, integer, integer) is
  'Lưu khoá mở thông báo của tổ chức quản trị hiện tại. Cổng: settings.edit qua require_perm_v1. '
  'Tham số NULL = giữ nguyên giá trị cũ. quiet_start/quiet_end là GIỜ VN (Asia/Ho_Chi_Minh).';

-- ============================================================================
-- 5) RPC CÁ NHÂN — chỉ kiểm membership ACTIVE
-- ============================================================================

drop function if exists public.get_my_notification_preferences_v1(uuid);
create or replace function public.get_my_notification_preferences_v1(p_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
declare
  v_uid uuid;
begin
  v_uid := (select auth.uid());
  if v_uid is null then
    raise exception 'Bạn chưa đăng nhập.' using errcode = '42501';
  end if;
  perform app_private.assert_notification_membership_v1(p_organization_id);

  return jsonb_build_object(
    'organization_id', p_organization_id,
    'user_id',         v_uid,
    'preferences',     app_private.notification_prefs_read_v1(v_uid, p_organization_id));
end
$fn$;

revoke all on function public.get_my_notification_preferences_v1(uuid) from public;
revoke all on function public.get_my_notification_preferences_v1(uuid) from anon;
revoke all on function public.get_my_notification_preferences_v1(uuid) from authenticated;
revoke all on function public.get_my_notification_preferences_v1(uuid) from service_role;
grant execute on function public.get_my_notification_preferences_v1(uuid) to authenticated;

comment on function public.get_my_notification_preferences_v1(uuid) is
  'Sở thích thông báo của CHÍNH MÌNH trong một tổ chức. Luôn trả đủ 5 họ E1..E5 (mặc định '
  'in_app/push = true, cadence = IMMEDIATE). Cổng: membership ACTIVE.';

drop function if exists public.set_my_notification_preferences_v1(uuid, jsonb);
create or replace function public.set_my_notification_preferences_v1(
  p_organization_id uuid,
  p_prefs           jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
declare
  v_uid   uuid;
  v_norm  jsonb;
  k       text;
  v       jsonb;
begin
  v_uid := (select auth.uid());
  if v_uid is null then
    raise exception 'Bạn chưa đăng nhập.' using errcode = '42501';
  end if;
  perform app_private.assert_notification_membership_v1(p_organization_id);

  v_norm := app_private.notification_prefs_normalize_v1(p_prefs);

  for k in select jsonb_object_keys(v_norm) loop
    v := v_norm -> k;
    -- Field vắng ⇒ normalize phát `null` ⇒ INSERT lấy mặc định cột, UPDATE GIỮ NGUYÊN giá trị cũ.
    -- Không có coalesce ở đây thì `{"E1":{"in_app":false}}` sẽ set push=NULL rồi vi phạm NOT NULL,
    -- hoặc (bản nháp) ghi đè push=true — bật lại thứ người dùng vừa tắt.
    insert into public.notification_preferences
      (user_id, organization_id, event_key, in_app, push, cadence, updated_at)
    values
      (v_uid, p_organization_id, k,
       coalesce((v ->> 'in_app')::boolean, true),
       coalesce((v ->> 'push')::boolean, true),
       coalesce(v ->> 'cadence', 'IMMEDIATE'),
       now())
    -- ⚠ Dùng THẲNG biến plpgsql `v`, KHÔNG dùng `excluded.*`: mệnh đề VALUES ở trên đã coalesce
    -- nên `excluded.in_app` không bao giờ NULL và vế coalesce sẽ vô hiệu. `v` giữ đúng JSON gốc,
    -- nên `(v->>'in_app')::boolean` là NULL khi client KHÔNG gửi field đó.
    on conflict (user_id, organization_id, event_key) do update
      set in_app     = coalesce((v ->> 'in_app')::boolean, public.notification_preferences.in_app),
          push       = coalesce((v ->> 'push')::boolean,   public.notification_preferences.push),
          cadence    = coalesce(v ->> 'cadence',           public.notification_preferences.cadence),
          updated_at = now();
  end loop;

  return jsonb_build_object(
    'organization_id', p_organization_id,
    'user_id',         v_uid,
    'preferences',     app_private.notification_prefs_read_v1(v_uid, p_organization_id));
end
$fn$;

revoke all on function public.set_my_notification_preferences_v1(uuid, jsonb) from public;
revoke all on function public.set_my_notification_preferences_v1(uuid, jsonb) from anon;
revoke all on function public.set_my_notification_preferences_v1(uuid, jsonb) from authenticated;
revoke all on function public.set_my_notification_preferences_v1(uuid, jsonb) from service_role;
grant execute on function public.set_my_notification_preferences_v1(uuid, jsonb) to authenticated;

comment on function public.set_my_notification_preferences_v1(uuid, jsonb) is
  'Lưu sở thích thông báo của CHÍNH MÌNH. p_prefs = {"E1":{"in_app":bool,"push":bool,'
  '"cadence":"IMMEDIATE|DIGEST|OFF"},…}; chỉ những họ được gửi lên mới bị ghi đè. Cổng: membership ACTIVE.';

notify pgrst, 'reload schema';

commit;

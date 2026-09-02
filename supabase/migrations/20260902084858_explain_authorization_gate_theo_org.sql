-- =============================================================================
-- FR020-C02 (P2) — re-anchor bảo mật 02/09/2026: explain_authorization_v1 gate
-- quyền xem người khác bằng app_private.can_v3('users.view') — hàm này hợp nhất
-- MỌI org của actor (authorized_scope_all_v3), nên actor có users.view ở org A
-- đọc được giải thích phân quyền của thành viên org B.
--
-- Vá: CREATE OR REPLACE cùng chữ ký, chỉ đổi gate ở đúng một chỗ: quyết định
-- bằng authorize_tenant_action_v3(v_actor, v_org, 'users.view') — org của
-- THÀNH VIÊN ĐANG XEM (đã derive từ membership + đã khoá). Ai cũng vẫn tự xem
-- được quyền của chính mình. Phần còn lại nguyên văn 20260725190000.
-- =============================================================================

create or replace function public.explain_authorization_v1(
  p_membership       uuid,
  p_permission_keys  text[] default null,
  p_building         uuid   default null,
  p_cashbook         uuid   default null
)
returns table (
  permission_key text,
  resource       text,
  action         text,
  sensitivity    text,
  duoc_phep      boolean,
  ly_do_ma       text,
  ly_do          text,
  nguon          text
)
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid;
  v_user  uuid;
  v_hong  text;
  v_xem_nguoi_khac boolean;
begin
  if v_actor is null then
    raise exception 'Bạn chưa đăng nhập.' using errcode = '42501';
  end if;
  if p_membership is null then
    raise exception 'Thiếu thành viên cần xem quyền.' using errcode = '22023';
  end if;

  select m.organization_id, m.user_id into v_org, v_user
    from public.organization_memberships m
   where m.id = p_membership;
  if v_org is null then
    raise exception 'Không tìm thấy thành viên này.' using errcode = 'P0002';
  end if;

  -- Hợp đồng writer của evaluator (điểm 4 ở header): khoá tổ chức ở statement trước.
  perform app_private.lock_org_for_decision_v1(v_org);

  -- Quyền xem: phải có users.view TRONG ĐÚNG TỔ CHỨC của thành viên đang xem
  -- (FR020-C02: can_v3 không org hợp nhất mọi org của actor → lộ chéo org).
  -- Ai cũng được tự xem quyền của CHÍNH MÌNH (rất hữu ích: "vì sao tôi không bấm
  -- được nút này"), nhưng KHÔNG kèm lý do ngoại lệ của người khác.
  if v_user <> v_actor then
    select d.allowed into v_xem_nguoi_khac
      from app_private.authorize_tenant_action_v3(v_actor, v_org, 'users.view', null, null) d;
    if not coalesce(v_xem_nguoi_khac, false) then
      raise exception 'Bạn không có quyền xem phân quyền của người khác.'
        using errcode = '42501';
    end if;
  end if;

  -- Mục tiêu phải cùng tổ chức, nếu không cả 219 dòng đều nói "khác tổ chức".
  if p_building is not null and not exists (
       select 1 from public.buildings b
        where b.id = p_building and b.organization_id = v_org and b.deleted_at is null) then
    raise exception 'Toà nhà không thuộc tổ chức của thành viên này.' using errcode = '22023';
  end if;
  if p_cashbook is not null and not exists (
       select 1 from public.accounts a
        where a.id = p_cashbook and a.organization_id = v_org and a.deleted_at is null) then
    raise exception 'Sổ quỹ không thuộc tổ chức của thành viên này.' using errcode = '22023';
  end if;

  -- Điểm 5 ở header: ngoại lệ hỏng làm evaluator RAISE và giết cả bảng kết quả.
  -- Bắt trước, báo bằng tiếng Việt chỉ đúng chỗ hỏng.
  select string_agg(distinct o.permission_key, ', ')
    into v_hong
    from public.member_permission_overrides o
   where o.membership_id = p_membership
     and o.revoked_at is null
     and (o.expires_at is null or o.expires_at > now())
     and not exists (select 1 from public.member_override_scopes s where s.override_id = o.id);
  if v_hong is not null then
    raise exception 'Dữ liệu phân quyền của thành viên này bị hỏng: ngoại lệ "%" không có phạm vi nào. Hãy sửa hoặc gỡ ngoại lệ đó trước.', v_hong
      using errcode = '23514';
  end if;

  return query
  with keys as (
    select pd.key, pd.resource, pd.action, pd.sensitivity
      from public.permission_definitions pd
     where pd.permission_domain = 'TENANT'
       and pd.is_active
       and (p_permission_keys is null or pd.key = any(p_permission_keys))
  ),
  quyet_dinh as (
    select k.*, d.allowed, d.decision_reason
      from keys k
      cross join lateral app_private.authorize_tenant_action_v3(
        v_user, v_org, k.key, p_building, p_cashbook) d
  )
  select
    q.key, q.resource, q.action, q.sensitivity, q.allowed, q.decision_reason,
    case q.decision_reason
      when 'ORGANIZATION_INACTIVE_OR_MISSING' then 'Tổ chức đang không hoạt động'
      when 'PERMISSION_INACTIVE_OR_MISSING'   then 'Quyền này không còn được dùng'
      when 'REQUIRED_DIMENSION_MISSING'       then 'Chưa chọn toà nhà hoặc sổ quỹ nên chưa xét được'
      when 'MEMBERSHIP_INACTIVE_OR_MISSING'   then 'Người này không còn là thành viên đang hoạt động'
      when 'TARGET_CROSS_ORG_OR_MISSING'      then 'Toà nhà hoặc sổ quỹ không thuộc tổ chức này'
      when 'EMERGENCY_DENY'                   then 'Đang bị lệnh cấm khẩn cấp của tổ chức'
      when 'MEMBER_DENY'                      then 'Bị chặn bởi ngoại lệ riêng của người này'
      when 'ROLE_DENY'                        then 'Bị chặn bởi vai trò đang gán'
      when 'POSSESSION_MISSING'               then 'Không giữ sổ quỹ này nên không thao tác được'
      when 'MEMBER_ALLOW'                     then 'Được phép nhờ ngoại lệ riêng'
      when 'ROLE_ALLOW'                       then 'Được phép nhờ vai trò'
      else                                         'Không có vai trò hay ngoại lệ nào cấp quyền này'
    end,
    -- Nguồn cụ thể: chỉ tra khi có ý nghĩa, và chỉ cho người có users.view.
    case
      when q.decision_reason = 'ROLE_ALLOW' then coalesce((
        select 'Vai trò: ' || string_agg(distinct r.name, ', ')
          from public.role_bindings rb
          join public.organization_roles r on r.id = rb.role_id
          join public.role_permissions rp
            on rp.role_id = rb.role_id and rp.organization_id = rb.organization_id
           and rp.permission_key = q.key and rp.effect = 'ALLOW'
         where rb.membership_id = p_membership and rb.valid_to is null), 'Vai trò')
      when q.decision_reason = 'ROLE_DENY' then coalesce((
        select 'Vai trò chặn: ' || string_agg(distinct r.name, ', ')
          from public.role_bindings rb
          join public.organization_roles r on r.id = rb.role_id
          join public.role_permissions rp
            on rp.role_id = rb.role_id and rp.organization_id = rb.organization_id
           and rp.permission_key = q.key and rp.effect = 'DENY'
         where rb.membership_id = p_membership and rb.valid_to is null), 'Vai trò')
      when q.decision_reason in ('MEMBER_ALLOW','MEMBER_DENY') then coalesce((
        select 'Ngoại lệ riêng' ||
               case when v_user = v_actor then ''
                    else coalesce(' — lý do: ' || nullif(btrim(o.reason), ''), '') end
          from public.member_permission_overrides o
         where o.membership_id = p_membership and o.permission_key = q.key
           and o.revoked_at is null and (o.expires_at is null or o.expires_at > now())
         limit 1), 'Ngoại lệ riêng')
      when q.decision_reason = 'POSSESSION_MISSING' then 'Cần được giao giữ sổ quỹ'
      else null
    end
  from quyet_dinh q
  order by q.resource, q.action;
end
$fn$;

comment on function public.explain_authorization_v1(uuid, text[], uuid, uuid) is
  'Giải thích quyền hiệu lực của một thành viên kèm NGUỒN quyết định. Ruột của tab "Quyền hiệu lực". Ai cũng tự xem được của mình; xem người khác cần users.view TRONG ĐÚNG tổ chức của thành viên đó (FR020-C02, 02/09/2026).';

revoke all on function public.explain_authorization_v1(uuid, text[], uuid, uuid) from public, anon;
grant execute on function public.explain_authorization_v1(uuid, text[], uuid, uuid) to authenticated;

-- Nghiệm thu: gate phải đi qua authorize_tenant_action_v3 có org, hết can_v3 không org.
do $$
declare v_src text;
begin
  select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'explain_authorization_v1';
  if v_src is null
     or v_src not like '%authorize_tenant_action_v3(v_actor, v_org, ''users.view'', null, null)%'
     or v_src like '%can_v3(%' then
    raise exception 'explain_authorization_v1 chưa gate theo org. DỪNG.';
  end if;
  if has_function_privilege('anon', 'public.explain_authorization_v1(uuid,text[],uuid,uuid)', 'EXECUTE') then
    raise exception 'anon vẫn EXECUTE được explain_authorization_v1. DỪNG.';
  end if;
end $$;

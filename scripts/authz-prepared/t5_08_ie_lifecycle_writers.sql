-- t5_08_ie_lifecycle_writers.sql — Vòng đời phiếu thu/chi canonical (Phương án A)
--
-- QUYẾT ĐỊNH OWNER 2026-07-18: immutable-on-create. Phiếu canonical bất biến từ
-- lúc tạo (create_income_expense_v1 claim ngay); "sửa" = Huỷ + Tạo bản sao (nút
-- Copy trên UI prefill toàn bộ, kể cả hình ảnh). Vì vậy KHÔNG có update-payload
-- writer. Tranche này bổ sung 3 writer vòng đời còn thiếu để phiếu canonical
-- không bị kẹt terminal: Duyệt / Huỷ / Kiểm.
--
-- Nguyên tắc (đối chiếu docs/authorization/TRANCHE-INCOME-EXPENSE-FINDINGS-2026-07-18.md):
--  • Writer CHỈ nhận row flow-owned. Row legacy → raise 55000 có marker
--    'chưa thuộc luồng canonical' = tín hiệu fallback cho hook (client dùng
--    isIeLifecycleFallbackSignal, KHÔNG coi 42501 là fallback ở lifecycle).
--  • Permission PARITY với legacy (không rộng hơn, không hẹp hơn):
--      approve → user_id=actor OR is_super_admin OR can_do_on_building(approve)
--                (mirror public.approve_voucher)
--      cancel  → mirror RLS UPDATE: (super OR admin OR full-scope edit OR
--                building∈permitted(edit) OR owner+all_buildings(edit))
--                AND restricted-item rule (RESTRICTIVE policy)
--      verify  → mirror public.verify_income_expense (can-see + toggle rule)
--  • Freeze guard: allowlist mở rộng thêm approved_by/approved_at/verified_*
--    (metadata vòng đời, KHÔNG phải payload tài chính — amount/items/name/
--    building/account_id vẫn đóng băng vĩnh viễn).
--  • Audit: append_income_expense_event_v1 (hash-chain, ghi vào
--    public.income_expense_audit_log — bảng UI history đang đọc → hiển thị ngay).
--    KHÔNG gọi thêm log_income_expense_action (tránh double-entry).
--  • Idempotent: duyệt phiếu đã duyệt / huỷ phiếu đã huỷ = no-op thành công
--    (retry an toàn, không cần ledger vì status-flip không tạo bản ghi tiền mới).
--  • payment_id: create canonical không bao giờ set → cancel canonical assert
--    payment_id IS NULL (defensive; phiếu mirror thanh toán vẫn thuộc domain
--    payment, hoàn qua reverse_invoice_payment_v3).

begin;

-- =========================================================================
-- 1) Widen freeze allowlist: thêm cột metadata vòng đời được phép đổi KHI có
--    transition token. Payload tài chính giữ nguyên đóng băng.
--    (CREATE OR REPLACE giữ nguyên toàn bộ logic, chỉ mở rộng 2 mảng cột.)
-- =========================================================================
CREATE OR REPLACE FUNCTION app_private.guard_income_expense_owned_payload()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private'
AS $function$
declare
  v_authorized boolean;
begin
  if tg_op = 'DELETE' then
    if app_private.is_income_expense_flow_owned(old.id) then
      raise exception 'canonical income expense % is frozen (delete rejected)', old.id
        using errcode = '55000';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if not app_private.is_income_expense_flow_owned(old.id)
       and not (new.id is distinct from old.id
                and app_private.is_income_expense_flow_owned(new.id)) then
      return new; -- unmarked legacy row: unchanged behavior
    end if;

    -- canonical row: check for a live transition token in THIS transaction
    select exists (
      select 1 from app_private.ie_transition_authorization t
       where t.income_expense_id = old.id and t.xid = pg_current_xact_id()
    ) into v_authorized;

    if not v_authorized then
      raise exception 'canonical income expense % is frozen (update rejected)', old.id
        using errcode = '55000';
    end if;

    -- ALLOWLIST, not denylist. t5_08 widened: lifecycle metadata
    -- (approved_by/approved_at, verified_*) joins the original lifecycle
    -- columns. EVERY other column must be NOT DISTINCT FROM its old value.
    if (to_jsonb(old) - array['approval_status','posting_id','posted_at_v2',
                              'reversed_by_posting_id','updated_at',
                              'approved_by','approved_at',
                              'verified_at','verified_by','verified_by_name',
                              'verified_note'])
       is distinct from
       (to_jsonb(new) - array['approval_status','posting_id','posted_at_v2',
                              'reversed_by_posting_id','updated_at',
                              'approved_by','approved_at',
                              'verified_at','verified_by','verified_by_name',
                              'verified_note']) then
      raise exception 'authorized transition may only change lifecycle columns of %', old.id
        using errcode = '55000';
    end if;
    return new;
  end if;

  return new;
end;
$function$;

-- =========================================================================
-- 2) approve_income_expense_v1 — Duyệt phiếu canonical (UNAPPROVED → APPROVED)
-- =========================================================================
create or replace function public.approve_income_expense_v1(p_voucher_id uuid)
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_row public.income_expenses%rowtype;
  v_rows integer;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;

  select * into v_row from public.income_expenses
   where id = p_voucher_id and deleted_at is null
   for update;
  if not found then
    raise exception 'Không thể duyệt phiếu: phiếu không tồn tại hoặc bạn không có quyền duyệt phiếu này'
      using errcode = '42501';
  end if;

  -- Row legacy → tín hiệu fallback (hook chuyển sang approve_voucher legacy).
  if not app_private.is_income_expense_flow_owned(v_row.id) then
    raise exception 'Phiếu chưa thuộc luồng canonical — dùng đường legacy'
      using errcode = '55000';
  end if;

  if v_row.approval_status = 'APPROVED' then
    return; -- idempotent no-op
  end if;
  if v_row.approval_status = 'CANCELLED' then
    -- Phương án A: phiếu huỷ là terminal — dùng nút "Tạo bản sao".
    raise exception 'Phiếu đã huỷ — không thể duyệt. Hãy dùng "Tạo bản sao" để lập phiếu mới.';
  end if;

  -- Parity legacy: phải có sổ quỹ trước khi duyệt.
  if v_row.account_id is null then
    raise exception 'Phiếu chưa có sổ quỹ — phiếu canonical không sửa được: Huỷ phiếu rồi Tạo bản sao kèm sổ quỹ.';
  end if;

  -- Permission parity với public.approve_voucher.
  if not (
    v_row.user_id = v_actor
    or public.is_super_admin()
    or (v_row.building_id is not null
        and public.can_do_on_building('income_expenses', 'approve', v_row.building_id))
  ) then
    raise exception 'Không thể duyệt phiếu: phiếu không tồn tại hoặc bạn không có quyền duyệt phiếu này'
      using errcode = '42501';
  end if;

  v_actor_name := app_private.ie_actor_display_name_v1(v_actor);

  -- Transition token (cùng giao thức với transition_canonical_income_expense_v1):
  -- guard chỉ cho UPDATE khi có token trong đúng transaction này.
  insert into app_private.ie_transition_authorization (income_expense_id, xid, purpose)
  values (v_row.id, pg_current_xact_id(), 'APPROVED');

  update public.income_expenses
     set approval_status = 'APPROVED',
         approved_by = v_actor,
         approved_at = now()
   where id = v_row.id;
  get diagnostics v_rows = row_count;

  delete from app_private.ie_transition_authorization
   where income_expense_id = v_row.id and xid = pg_current_xact_id();

  if v_rows <> 1 then
    raise exception 'approve transition affected % rows (expected 1)', v_rows
      using errcode = '55000';
  end if;

  perform app_private.append_income_expense_event_v1(
    v_row.organization_id, v_row.id, 'APPROVED', v_actor, v_actor_name,
    v_row.approval_status, 'APPROVED', 'Duyệt qua approve_income_expense_v1');
end;
$$;

revoke all on function public.approve_income_expense_v1(uuid) from public;
revoke all on function public.approve_income_expense_v1(uuid) from anon;
grant execute on function public.approve_income_expense_v1(uuid) to authenticated;

-- =========================================================================
-- 3) cancel_income_expense_v1 — Huỷ phiếu canonical (UNAPPROVED/APPROVED → CANCELLED)
-- =========================================================================
create or replace function public.cancel_income_expense_v1(
  p_voucher_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_row public.income_expenses%rowtype;
  v_allowed boolean;
  v_rows integer;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;

  select * into v_row from public.income_expenses
   where id = p_voucher_id and deleted_at is null
   for update;
  if not found then
    raise exception 'Không tìm thấy phiếu';
  end if;

  if not app_private.is_income_expense_flow_owned(v_row.id) then
    raise exception 'Phiếu chưa thuộc luồng canonical — dùng đường legacy'
      using errcode = '55000';
  end if;

  -- Defensive: create canonical không bao giờ gắn payment. Nếu có → thuộc domain
  -- payment (hoàn qua reverse_invoice_payment_v3), tuyệt đối không huỷ ở đây.
  if v_row.payment_id is not null then
    raise exception 'Phiếu gắn thanh toán hoá đơn — hãy hoàn tiền qua chức năng hoàn thanh toán';
  end if;

  if v_row.approval_status = 'CANCELLED' then
    return; -- idempotent no-op
  end if;

  -- Permission parity với RLS UPDATE legacy:
  --  PERMISSIVE (một trong): super_admin | update_rbac (admin/full-scope/building
  --  permitted 'edit') | owner + all_buildings('edit')
  --  RESTRICTIVE (bắt buộc): restricted-item rule.
  v_allowed :=
    public.is_super_admin()
    or public.is_admin()
    or public.has_perm_full_scope('income_expenses', 'edit')
    or (v_row.building_id is not null and v_row.building_id in
          (select public.permitted_building_ids('income_expenses', 'edit')))
    or (v_row.user_id = v_actor and v_row.building_id in
          (select public.ie_all_buildings_action_ids('edit')));
  if v_allowed and v_row.has_restricted_item then
    v_allowed := (v_row.user_id = v_actor)
      or public.can_view_restricted_ie()
      or public.is_super_admin();
  end if;
  if not v_allowed then
    raise exception 'Không có quyền huỷ phiếu này' using errcode = '42501';
  end if;

  v_actor_name := app_private.ie_actor_display_name_v1(v_actor);

  insert into app_private.ie_transition_authorization (income_expense_id, xid, purpose)
  values (v_row.id, pg_current_xact_id(), 'CANCELLED');

  update public.income_expenses
     set approval_status = 'CANCELLED'
   where id = v_row.id;
  get diagnostics v_rows = row_count;

  delete from app_private.ie_transition_authorization
   where income_expense_id = v_row.id and xid = pg_current_xact_id();

  if v_rows <> 1 then
    raise exception 'cancel transition affected % rows (expected 1)', v_rows
      using errcode = '55000';
  end if;

  perform app_private.append_income_expense_event_v1(
    v_row.organization_id, v_row.id, 'CANCELLED', v_actor, v_actor_name,
    v_row.approval_status, 'CANCELLED',
    nullif(btrim(coalesce(p_reason, '')), ''));
end;
$$;

revoke all on function public.cancel_income_expense_v1(uuid, text) from public;
revoke all on function public.cancel_income_expense_v1(uuid, text) from anon;
grant execute on function public.cancel_income_expense_v1(uuid, text) to authenticated;

-- =========================================================================
-- 4) verify_income_expense_v1 — Toggle "đã kiểm" cho phiếu canonical
--    (mirror đầy đủ public.verify_income_expense, chỉ khác: token-wrapped)
-- =========================================================================
create or replace function public.verify_income_expense_v1(
  p_id uuid,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $$
declare
  v_actor uuid := auth.uid();
  v_row public.income_expenses%rowtype;
  v_can_see boolean;
  v_full_name text;
  v_rows integer;
begin
  if v_actor is null then
    raise exception 'Phải đăng nhập' using errcode = '42501';
  end if;

  select * into v_row from public.income_expenses
   where id = p_id
   for update;
  if not found then
    raise exception 'Không tìm thấy phiếu';
  end if;

  if not app_private.is_income_expense_flow_owned(v_row.id) then
    raise exception 'Phiếu chưa thuộc luồng canonical — dùng đường legacy'
      using errcode = '55000';
  end if;

  -- Parity verify legacy: caller phải có quyền xem phiếu.
  select (
    public.is_super_admin()
    or public.is_admin()
    or (v_row.building_id is not null and public.can_access_building(v_row.building_id))
    or public.is_account_shared_with_me(v_row.account_id)
  ) into v_can_see;
  if not v_can_see then
    raise exception 'Không có quyền xem phiếu này' using errcode = '42501';
  end if;

  if v_row.verified_at is not null then
    -- toggle bỏ kiểm: chỉ chủ kiểm hoặc super admin (parity legacy).
    if v_row.verified_by = v_actor or public.is_super_admin() then
      insert into app_private.ie_transition_authorization (income_expense_id, xid, purpose)
      values (v_row.id, pg_current_xact_id(), 'UNVERIFY');

      update public.income_expenses
         set verified_at = null, verified_by = null,
             verified_by_name = null, verified_note = null
       where id = v_row.id;
      get diagnostics v_rows = row_count;

      delete from app_private.ie_transition_authorization
       where income_expense_id = v_row.id and xid = pg_current_xact_id();

      if v_rows <> 1 then
        raise exception 'unverify affected % rows (expected 1)', v_rows using errcode = '55000';
      end if;

      perform app_private.append_income_expense_event_v1(
        v_row.organization_id, v_row.id, 'UNVERIFIED', v_actor,
        app_private.ie_actor_display_name_v1(v_actor),
        v_row.approval_status, v_row.approval_status, null);
      return;
    else
      raise exception 'Phiếu đã được % kiểm — chỉ super admin hoặc người kiểm mới bỏ được',
        coalesce(v_row.verified_by_name, 'người khác');
    end if;
  end if;

  select coalesce(full_name, email, 'Người dùng') into v_full_name
    from public.profiles where id = v_actor;

  insert into app_private.ie_transition_authorization (income_expense_id, xid, purpose)
  values (v_row.id, pg_current_xact_id(), 'VERIFY');

  update public.income_expenses
     set verified_at = now(), verified_by = v_actor,
         verified_by_name = v_full_name,
         verified_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = v_row.id;
  get diagnostics v_rows = row_count;

  delete from app_private.ie_transition_authorization
   where income_expense_id = v_row.id and xid = pg_current_xact_id();

  if v_rows <> 1 then
    raise exception 'verify affected % rows (expected 1)', v_rows using errcode = '55000';
  end if;

  perform app_private.append_income_expense_event_v1(
    v_row.organization_id, v_row.id, 'VERIFIED', v_actor,
    coalesce(v_full_name, 'Người dùng'),
    v_row.approval_status, v_row.approval_status,
    nullif(btrim(coalesce(p_note, '')), ''));
end;
$$;

revoke all on function public.verify_income_expense_v1(uuid, text) from public;
revoke all on function public.verify_income_expense_v1(uuid, text) from anon;
grant execute on function public.verify_income_expense_v1(uuid, text) to authenticated;

commit;

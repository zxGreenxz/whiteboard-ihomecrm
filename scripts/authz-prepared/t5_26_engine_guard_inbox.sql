-- t5_26 — P0-1 + P0-2 sau tổng kiểm 2026-07-19:
-- (P0-1) BỊT LỖ maker tự duyệt phiếu engine: mọi đường duyệt/huỷ-duyệt phiếu
--   (approve_voucher, unapprove_voucher legacy + approve_income_expense_v1
--   canonical) TỪ CHỐI phiếu đang có approval_request PENDING/POSTED — phiếu
--   lương/lợi nhuận chỉ được quyết qua engine (maker-checker owner đã chốt).
-- (P0-2) Bề mặt sản phẩm cho engine:
--   - list_my_pending_approvals_v1(): danh sách yêu cầu chờ TÔI duyệt
--   - decide_financial_request_v2(request, decision, reason): người trong danh
--     sách ứng viên bấm Duyệt/Từ chối (engine tự re-check đủ điều kiện + CAS)
--   - withdraw_financial_request_v1(request, reason): maker rút yêu cầu
--   - cancel_income_expense_v1: huỷ phiếu → TỰ ĐÓNG request đang mở (hết kẹt
--     one-open-subject như case 5e263908)

begin;

-- ========== P0-1: guard chung ==========
create or replace function app_private.assert_no_engine_request_v1(p_voucher_id uuid)
returns void
language plpgsql stable
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
begin
  if exists (
    select 1 from public.approval_requests ar
     where ar.subject_type = 'FINANCIAL_VOUCHER'
       and ar.subject_id = p_voucher_id
       and ar.state in ('PENDING_APPROVAL', 'POSTED')
  ) then
    raise exception 'Phiếu thuộc luồng duyệt engine (lương/lợi nhuận/chi cần duyệt) — xử lý tại màn hình "Chờ duyệt", không duyệt/huỷ duyệt trực tiếp'
      using errcode = '55000';
  end if;
end;
$fn$;

-- legacy approve_voucher + guard
CREATE OR REPLACE FUNCTION public.approve_voucher(voucher_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private'
AS $function$
DECLARE
  v_rows integer;
  v_account uuid;
  v_exists boolean;
BEGIN
  -- t5_26: phiếu thuộc engine → chỉ duyệt qua màn Chờ duyệt
  PERFORM app_private.assert_no_engine_request_v1(voucher_id);

  SELECT ie.account_id, true INTO v_account, v_exists
  FROM income_expenses ie
  WHERE ie.id = voucher_id AND ie.deleted_at IS NULL;

  IF v_exists AND v_account IS NULL THEN
    RAISE EXCEPTION 'Phiếu chưa có sổ quỹ — bấm Sửa phiếu, chọn sổ quỹ chi tiền rồi mới duyệt được'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE income_expenses ie
  SET
    approval_status = 'APPROVED',
    approved_by = auth.uid(),
    approved_at = NOW()
  WHERE ie.id = voucher_id
    AND ie.deleted_at IS NULL
    AND (
      ie.user_id = auth.uid()
      OR public.is_super_admin()
      OR (
        ie.building_id IS NOT NULL
        AND public.can_do_on_building('income_expenses', 'approve', ie.building_id)
      )
    );
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'Không thể duyệt phiếu: phiếu không tồn tại hoặc bạn không có quyền duyệt phiếu này'
      USING ERRCODE = '42501';
  END IF;
END;
$function$;

-- legacy unapprove_voucher + guard
CREATE OR REPLACE FUNCTION public.unapprove_voucher(voucher_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private'
AS $function$
DECLARE
  v_rows integer;
BEGIN
  -- t5_26: phiếu thuộc engine → không lùi trạng thái ngoài engine
  PERFORM app_private.assert_no_engine_request_v1(voucher_id);

  UPDATE income_expenses ie
  SET
    approval_status = 'UNAPPROVED',
    approved_by = NULL,
    approved_at = NULL
  WHERE ie.id = voucher_id
    AND ie.deleted_at IS NULL
    AND (
      ie.user_id = auth.uid()
      OR public.is_super_admin()
      OR (
        ie.building_id IS NOT NULL
        AND public.can_do_on_building('income_expenses', 'approve', ie.building_id)
      )
    );
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'Không thể huỷ duyệt phiếu: phiếu không tồn tại hoặc bạn không có quyền'
      USING ERRCODE = '42501';
  END IF;
END;
$function$;

-- canonical approve + guard (đặt SAU no-op idempotent để replay không lỗi)
CREATE OR REPLACE FUNCTION public.approve_income_expense_v1(p_voucher_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
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

  -- t5_26: phiếu đang chờ engine → chỉ quyết qua màn Chờ duyệt
  perform app_private.assert_no_engine_request_v1(v_row.id);

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
$function$;

-- canonical cancel + auto-close request mở
CREATE OR REPLACE FUNCTION public.cancel_income_expense_v1(p_voucher_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
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

  -- t5_26: phiếu ĐÃ POSTED qua engine không huỷ trực tiếp (dùng reversal);
  -- request đang PENDING sẽ được TỰ ĐÓNG bên dưới sau khi huỷ phiếu.
  if exists (select 1 from public.approval_requests ar
              where ar.subject_type='FINANCIAL_VOUCHER' and ar.subject_id = v_row.id
                and ar.state = 'POSTED') then
    raise exception 'Phiếu đã được duyệt qua engine — dùng bút toán hoàn/đảo, không huỷ trực tiếp'
      using errcode = '55000';
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

  -- t5_26: tự đóng approval_request đang mở của phiếu (giải one-open-subject).
  update public.approval_requests ar
     set state = 'CANCELLED', version = ar.version + 1
   where ar.subject_type = 'FINANCIAL_VOUCHER'
     and ar.subject_id = v_row.id
     and ar.state = 'PENDING_APPROVAL';

  perform app_private.append_income_expense_event_v1(
    v_row.organization_id, v_row.id, 'CANCELLED', v_actor, v_actor_name,
    v_row.approval_status, 'CANCELLED',
    nullif(btrim(coalesce(p_reason, '')), ''));
end;
$function$;

-- ========== P0-2: bề mặt sản phẩm cho engine ==========

create or replace function public.list_my_pending_approvals_v1()
returns table (
  request_id uuid, submission_no bigint, submitted_at timestamptz,
  amount numeric, voucher_id uuid, voucher_code text, voucher_name text,
  voucher_type text, maker_name text, step_no int, request_version bigint
)
language sql stable security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
  select ar.id, ar.submission_no, ar.submitted_at,
         ar.amount, ie.id, ie.code, ie.name, ie.type::text,
         coalesce(ie.creator_name, '—'), s.step_no, ar.version
    from public.approval_requests ar
    join public.approval_request_steps s
      on s.request_id = ar.id and s.status = 'PENDING'
    join public.approval_request_step_candidates c
      on c.request_step_id = s.id
     and c.generation = s.current_generation
     and c.valid_to is null
    join public.organization_memberships m
      on m.id = c.membership_id and m.status = 'ACTIVE'
    left join public.income_expenses ie on ie.id = ar.subject_id
   where ar.state = 'PENDING_APPROVAL'
     and ar.subject_type = 'FINANCIAL_VOUCHER'
     and m.user_id = auth.uid()
   order by ar.submitted_at asc;
$fn$;

create or replace function public.decide_financial_request_v2(
  p_request_id uuid, p_decision text, p_reason text default null)
returns json
language plpgsql security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_actor uuid := auth.uid();
  v_memb uuid; v_ver bigint; v_state text;
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  if p_decision not in ('APPROVE','REJECT') then
    raise exception 'Quyết định không hợp lệ (APPROVE/REJECT)' using errcode='22023';
  end if;

  -- Tôi phải là ỨNG VIÊN hiện hành của bước PENDING (engine sẽ re-check lần nữa).
  select c.membership_id, ar.version into v_memb, v_ver
    from public.approval_requests ar
    join public.approval_request_steps s
      on s.request_id = ar.id and s.status = 'PENDING'
    join public.approval_request_step_candidates c
      on c.request_step_id = s.id
     and c.generation = s.current_generation
     and c.valid_to is null
    join public.organization_memberships m
      on m.id = c.membership_id and m.status = 'ACTIVE' and m.user_id = v_actor
   where ar.id = p_request_id and ar.state = 'PENDING_APPROVAL'
   limit 1;
  if v_memb is null then
    raise exception 'Bạn không nằm trong danh sách người duyệt của yêu cầu này'
      using errcode = '42501';
  end if;

  perform app_private.decide_financial_request_v1(
    p_request_id, v_ver, v_memb, v_actor, p_decision,
    nullif(btrim(coalesce(p_reason,'')),''));

  select ar.state into v_state from public.approval_requests ar where ar.id = p_request_id;
  return json_build_object('request_id', p_request_id, 'state', v_state);
end;
$fn$;

create or replace function public.withdraw_financial_request_v1(
  p_request_id uuid, p_reason text default null)
returns json
language plpgsql security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_actor uuid := auth.uid();
  v_req public.approval_requests%rowtype;
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  select * into v_req from public.approval_requests
   where id = p_request_id for update;
  if not found then raise exception 'Không tìm thấy yêu cầu duyệt'; end if;
  if v_req.state <> 'PENDING_APPROVAL' then
    raise exception 'Yêu cầu không còn ở trạng thái chờ duyệt (%).', v_req.state;
  end if;
  if not (v_req.maker_user_id = v_actor or public.is_super_admin()) then
    raise exception 'Chỉ người lập (hoặc super admin) được rút yêu cầu' using errcode='42501';
  end if;

  update public.approval_requests
     set state = 'CANCELLED', version = version + 1
   where id = p_request_id;

  return json_build_object('request_id', p_request_id, 'state', 'CANCELLED');
end;
$fn$;

-- grants: authenticated dùng; cắt PUBLIC/anon (tránh default-PUBLIC như t5_25)
revoke execute on function public.list_my_pending_approvals_v1() from public, anon;
revoke execute on function public.decide_financial_request_v2(uuid, text, text) from public, anon;
revoke execute on function public.withdraw_financial_request_v1(uuid, text) from public, anon;
revoke execute on function app_private.assert_no_engine_request_v1(uuid) from public, anon;
grant execute on function public.list_my_pending_approvals_v1() to authenticated;
grant execute on function public.decide_financial_request_v2(uuid, text, text) to authenticated;
grant execute on function public.withdraw_financial_request_v1(uuid, text) to authenticated;

commit;

-- t5_26b: auto-close request khi phiếu bị huỷ qua BẤT KỲ đường nào (kể cả legacy)
create or replace function app_private.ie_cancel_close_request_v1()
returns trigger
language plpgsql security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
begin
  update public.approval_requests ar
     set state = 'CANCELLED', version = ar.version + 1
   where ar.subject_type = 'FINANCIAL_VOUCHER'
     and ar.subject_id = new.id
     and ar.state = 'PENDING_APPROVAL';
  return null;
end;
$fn$;
drop trigger if exists a75_ie_cancel_close_request on public.income_expenses;
create trigger a75_ie_cancel_close_request
  after update of approval_status on public.income_expenses
  for each row
  when (new.approval_status = 'CANCELLED' and old.approval_status is distinct from 'CANCELLED')
  execute function app_private.ie_cancel_close_request_v1();

-- t5_09_invoice_status_writers.sql — 8 writer vòng đời trạng thái hoá đơn
--
-- Phạm vi NHỊP 1 domain invoice: chỉ status-flip (approve/unapprove/bulk-approve/
-- cancel/restore/soft-delete/bulk-delete/overdue-sweep). KHÔNG đụng create/update
-- (nhịp 2 — cần parity phức tạp: đánh số client, credit spend, làm tròn).
-- KHÔNG đụng super_admin_force_cancel_invoice (RPC legacy có sẵn, hard-delete
-- payments — đã flag ở hồ sơ, xử lý ở tranche riêng).
--
-- Nguyên tắc (giống meter t5_06 — writer active ngay, không flag):
--  • Permission PARITY với RLS UPDATE invoices:
--      is_super_admin() OR is_admin() OR has_perm_full_scope('invoices','edit')
--      OR building_id ∈ permitted_building_ids('invoices','edit')
--    (= biểu thức policy invoices_update_rbac, nguyên văn — không rộng/hẹp hơn)
--  • State-guard mirror đúng legacy hook:
--      approve:   DRAFT → APPROVED (+approved_by/at); APPROVED = no-op
--      unapprove: APPROVED → DRAFT (clear approved_*); DRAFT = no-op
--      cancel:    mọi trạng thái → CANCELLED (mirror useCancelInvoice không guard);
--                 CANCELLED = no-op. KHÔNG đụng payments (chỉ force-cancel legacy làm).
--      restore:   CANCELLED → APPROVED (+stamp); 23505 unique HĐ/kỳ bong lên
--                 nguyên trạng (client hiển thị friendly, KHÔNG phải fallback signal)
--      delete:    soft-delete; mirror canDeleteInvoice user thường:
--                 (DRAFT|APPROVED) AND paid_amount=0
--      bulk-delete: chỉ DRAFT (mirror .eq status DRAFT), skip phần còn lại
--      bulk-approve: chỉ DRAFT, skip không đủ quyền/sai trạng thái, trả số lượng
--      overdue-sweep: (APPROVED|PARTIAL_PAID) + due_date < hôm nay → OVERDUE
--                 trong phạm vi toà được phép, trả số lượng
--  • Trigger nghiệp vụ (settle_previous_debt, audit, updated_at, autofill_org)
--    vẫn nổ y hệt đường legacy — không đổi hành vi.
--  • Row không tồn tại/không quyền → 42501 (coexistence: client fallback legacy,
--    RLS legacy vẫn là authority cuối).

begin;

-- Helper nội bộ: quyền edit hoá đơn theo đúng policy invoices_update_rbac.
create or replace function app_private.can_edit_invoice_building_v1(p_building_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $$
  select is_super_admin()
      or is_admin()
      or has_perm_full_scope('invoices', 'edit')
      or (p_building_id is not null
          and p_building_id in (select permitted_building_ids('invoices', 'edit')));
$$;
revoke all on function app_private.can_edit_invoice_building_v1(uuid) from public;
revoke all on function app_private.can_edit_invoice_building_v1(uuid) from anon;
revoke all on function app_private.can_edit_invoice_building_v1(uuid) from authenticated;

-- =========================================================================
-- 1) approve_invoice_v1 — DRAFT → APPROVED
-- =========================================================================
create or replace function public.approve_invoice_v1(p_invoice_id uuid)
returns public.invoices
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $$
declare
  v_actor uuid := auth.uid();
  v_row public.invoices%rowtype;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;
  select * into v_row from public.invoices
   where id = p_invoice_id and deleted_at is null for update;
  if not found then
    raise exception 'Không tìm thấy hoá đơn hoặc bạn không có quyền' using errcode = '42501';
  end if;
  if not app_private.can_edit_invoice_building_v1(v_row.building_id) then
    raise exception 'Không có quyền duyệt hoá đơn này' using errcode = '42501';
  end if;
  if v_row.status = 'APPROVED' then
    return v_row; -- idempotent no-op
  end if;
  if v_row.status <> 'DRAFT' then
    raise exception 'Chỉ duyệt được hoá đơn Nháp (trạng thái hiện tại: %)', v_row.status;
  end if;
  update public.invoices
     set status = 'APPROVED', approved_at = now(), approved_by = v_actor
   where id = v_row.id
   returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.approve_invoice_v1(uuid) from public;
revoke all on function public.approve_invoice_v1(uuid) from anon;
grant execute on function public.approve_invoice_v1(uuid) to authenticated;

-- =========================================================================
-- 2) unapprove_invoice_v1 — APPROVED → DRAFT
-- =========================================================================
create or replace function public.unapprove_invoice_v1(p_invoice_id uuid)
returns public.invoices
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $$
declare
  v_actor uuid := auth.uid();
  v_row public.invoices%rowtype;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;
  select * into v_row from public.invoices
   where id = p_invoice_id and deleted_at is null for update;
  if not found then
    raise exception 'Không tìm thấy hoá đơn hoặc bạn không có quyền' using errcode = '42501';
  end if;
  if not app_private.can_edit_invoice_building_v1(v_row.building_id) then
    raise exception 'Không có quyền bỏ duyệt hoá đơn này' using errcode = '42501';
  end if;
  if v_row.status = 'DRAFT' then
    return v_row; -- idempotent no-op
  end if;
  if v_row.status <> 'APPROVED' then
    raise exception 'Chỉ bỏ duyệt được hoá đơn Đã duyệt (trạng thái hiện tại: %)', v_row.status;
  end if;
  update public.invoices
     set status = 'DRAFT', approved_at = null, approved_by = null
   where id = v_row.id
   returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.unapprove_invoice_v1(uuid) from public;
revoke all on function public.unapprove_invoice_v1(uuid) from anon;
grant execute on function public.unapprove_invoice_v1(uuid) to authenticated;

-- =========================================================================
-- 3) bulk_approve_invoices_v1 — duyệt loạt DRAFT, skip không đủ quyền/sai
--    trạng thái (mirror RLS-silent-filter), trả số hoá đơn đã duyệt
-- =========================================================================
create or replace function public.bulk_approve_invoices_v1(p_invoice_ids uuid[])
returns integer
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $$
declare
  v_actor uuid := auth.uid();
  v_count integer;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;
  if p_invoice_ids is null or array_length(p_invoice_ids, 1) is null then
    return 0;
  end if;
  update public.invoices i
     set status = 'APPROVED', approved_at = now(), approved_by = v_actor
   where i.id = any (p_invoice_ids)
     and i.deleted_at is null
     and i.status = 'DRAFT'
     and app_private.can_edit_invoice_building_v1(i.building_id);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.bulk_approve_invoices_v1(uuid[]) from public;
revoke all on function public.bulk_approve_invoices_v1(uuid[]) from anon;
grant execute on function public.bulk_approve_invoices_v1(uuid[]) to authenticated;

-- =========================================================================
-- 4) cancel_invoice_v1 — → CANCELLED (mirror legacy: không guard trạng thái,
--    KHÔNG đụng payments)
-- =========================================================================
create or replace function public.cancel_invoice_v1(p_invoice_id uuid)
returns public.invoices
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $$
declare
  v_actor uuid := auth.uid();
  v_row public.invoices%rowtype;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;
  select * into v_row from public.invoices
   where id = p_invoice_id and deleted_at is null for update;
  if not found then
    raise exception 'Không tìm thấy hoá đơn hoặc bạn không có quyền' using errcode = '42501';
  end if;
  if not app_private.can_edit_invoice_building_v1(v_row.building_id) then
    raise exception 'Không có quyền huỷ hoá đơn này' using errcode = '42501';
  end if;
  if v_row.status = 'CANCELLED' then
    return v_row; -- idempotent no-op
  end if;
  update public.invoices
     set status = 'CANCELLED'
   where id = v_row.id
   returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.cancel_invoice_v1(uuid) from public;
revoke all on function public.cancel_invoice_v1(uuid) from anon;
grant execute on function public.cancel_invoice_v1(uuid) to authenticated;

-- =========================================================================
-- 5) restore_invoice_v1 — CANCELLED → APPROVED (+stamp). Đụng unique
--    HĐ/hợp-đồng/kỳ → 23505 bong nguyên trạng cho client hiển thị.
-- =========================================================================
create or replace function public.restore_invoice_v1(p_invoice_id uuid)
returns public.invoices
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $$
declare
  v_actor uuid := auth.uid();
  v_row public.invoices%rowtype;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;
  select * into v_row from public.invoices
   where id = p_invoice_id and deleted_at is null for update;
  if not found then
    raise exception 'Không tìm thấy hoá đơn hoặc bạn không có quyền' using errcode = '42501';
  end if;
  if not app_private.can_edit_invoice_building_v1(v_row.building_id) then
    raise exception 'Không có quyền phục hồi hoá đơn này' using errcode = '42501';
  end if;
  if v_row.status <> 'CANCELLED' then
    raise exception 'Chỉ phục hồi được hoá đơn Đã huỷ (trạng thái hiện tại: %)', v_row.status;
  end if;
  update public.invoices
     set status = 'APPROVED', approved_at = now(), approved_by = v_actor
   where id = v_row.id
   returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.restore_invoice_v1(uuid) from public;
revoke all on function public.restore_invoice_v1(uuid) from anon;
grant execute on function public.restore_invoice_v1(uuid) to authenticated;

-- =========================================================================
-- 6) soft_delete_invoice_v1 — mirror canDeleteInvoice user thường:
--    (DRAFT|APPROVED) AND paid_amount = 0
-- =========================================================================
create or replace function public.soft_delete_invoice_v1(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $$
declare
  v_actor uuid := auth.uid();
  v_row public.invoices%rowtype;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;
  select * into v_row from public.invoices
   where id = p_invoice_id and deleted_at is null for update;
  if not found then
    raise exception 'Không tìm thấy hoá đơn hoặc bạn không có quyền' using errcode = '42501';
  end if;
  if not app_private.can_edit_invoice_building_v1(v_row.building_id) then
    raise exception 'Không có quyền xoá hoá đơn này' using errcode = '42501';
  end if;
  if v_row.status not in ('DRAFT', 'APPROVED') or coalesce(v_row.paid_amount, 0) <> 0 then
    raise exception 'Không thể xoá hoá đơn ở trạng thái này';
  end if;
  update public.invoices
     set deleted_at = now()
   where id = v_row.id;
end;
$$;
revoke all on function public.soft_delete_invoice_v1(uuid) from public;
revoke all on function public.soft_delete_invoice_v1(uuid) from anon;
grant execute on function public.soft_delete_invoice_v1(uuid) to authenticated;

-- =========================================================================
-- 7) bulk_soft_delete_invoices_v1 — chỉ DRAFT (mirror legacy), trả số lượng
-- =========================================================================
create or replace function public.bulk_soft_delete_invoices_v1(p_invoice_ids uuid[])
returns integer
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $$
declare
  v_actor uuid := auth.uid();
  v_count integer;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;
  if p_invoice_ids is null or array_length(p_invoice_ids, 1) is null then
    return 0;
  end if;
  update public.invoices i
     set deleted_at = now()
   where i.id = any (p_invoice_ids)
     and i.deleted_at is null
     and i.status = 'DRAFT'
     and app_private.can_edit_invoice_building_v1(i.building_id);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.bulk_soft_delete_invoices_v1(uuid[]) from public;
revoke all on function public.bulk_soft_delete_invoices_v1(uuid[]) from anon;
grant execute on function public.bulk_soft_delete_invoices_v1(uuid[]) to authenticated;

-- =========================================================================
-- 8) mark_overdue_invoices_v1 — sweep quá hạn trong phạm vi toà được phép
-- =========================================================================
create or replace function public.mark_overdue_invoices_v1()
returns integer
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $$
declare
  v_actor uuid := auth.uid();
  v_count integer;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;
  update public.invoices i
     set status = 'OVERDUE'
   where i.deleted_at is null
     and i.status in ('APPROVED', 'PARTIAL_PAID')
     and i.due_date < current_date
     and app_private.can_edit_invoice_building_v1(i.building_id);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.mark_overdue_invoices_v1() from public;
revoke all on function public.mark_overdue_invoices_v1() from anon;
grant execute on function public.mark_overdue_invoices_v1() to authenticated;

commit;

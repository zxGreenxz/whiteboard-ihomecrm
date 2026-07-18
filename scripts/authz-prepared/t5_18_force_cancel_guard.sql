-- t5_18_force_cancel_guard.sql — Huỷ hoá đơn (super-admin) theo LUẬT OWNER (D3, 2026-07-19)
--
-- OWNER: "Hoá đơn chỉ được huỷ khi toàn bộ phiếu thu của hoá đơn đó bị huỷ chứ?"
-- → v2 KHÔNG tự xoá/tự hoàn gì cả. Chỉ KIỂM: còn payment hiệu lực (chưa bị
-- reverse) → TỪ CHỐI kèm hướng dẫn; sạch payment → CANCELLED. Lịch sử tiền
-- nguyên vẹn tuyệt đối. Thay thế super_admin_force_cancel_invoice v1
-- (hard-DELETE payments + excess_amounts — vi phạm nguyên tắc giữ lịch sử).
-- v1 giữ nguyên trong DB (không ai gọi sau khi wire) để rollback được.
--
-- "Payment hiệu lực" = payments của hoá đơn CHƯA có bản ghi hoàn đối ứng trong
-- payment_reversals (nếu bảng tồn tại) — fallback: mọi payment còn row = hiệu lực.

begin;

create or replace function public.super_admin_force_cancel_invoice_v2(p_invoice_id uuid)
returns json
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $$
declare
  v_actor uuid := auth.uid();
  v_inv public.invoices%rowtype;
  v_active_payments int;
  v_has_reversals boolean;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;
  if not public.is_super_admin() then
    raise exception 'Chỉ super admin được phép huỷ hoá đơn ở trạng thái này' using errcode = '42501';
  end if;

  select * into v_inv from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'Hoá đơn không tồn tại';
  end if;
  if v_inv.deleted_at is not null then
    raise exception 'Hoá đơn đã bị xoá trước đó';
  end if;
  if v_inv.status = 'CANCELLED' then
    return json_build_object('invoice_id', v_inv.id, 'status', 'CANCELLED', 'noop', true);
  end if;

  -- LUẬT OWNER: mọi phiếu thu phải được huỷ/hoàn TRƯỚC.
  select to_regclass('public.payment_reversals') is not null into v_has_reversals;
  if v_has_reversals then
    execute
      'select count(*) from public.payments p
        where p.invoice_id = $1
          and not exists (select 1 from public.payment_reversals r
                           where r.original_payment_id = p.id)'
      into v_active_payments using p_invoice_id;
  else
    select count(*) into v_active_payments from public.payments p
     where p.invoice_id = p_invoice_id;
  end if;

  if v_active_payments > 0 then
    raise exception 'Hoá đơn còn % phiếu thu hiệu lực — hãy huỷ/hoàn từng phiếu thu trước rồi mới huỷ hoá đơn', v_active_payments;
  end if;

  -- Sạch phiếu thu: xoá credit gốc sinh TỪ hoá đơn này (không phải từ payment —
  -- các dòng đó thuộc vòng đời payment/reversal), rồi huỷ.
  delete from public.excess_amounts
   where source_invoice_id = p_invoice_id and source_payment_id is null;

  update public.invoices set status = 'CANCELLED' where id = p_invoice_id;

  return json_build_object('invoice_id', v_inv.id, 'status', 'CANCELLED', 'noop', false);
end;
$$;

revoke all on function public.super_admin_force_cancel_invoice_v2(uuid) from public;
revoke all on function public.super_admin_force_cancel_invoice_v2(uuid) from anon;
grant execute on function public.super_admin_force_cancel_invoice_v2(uuid) to authenticated;

commit;

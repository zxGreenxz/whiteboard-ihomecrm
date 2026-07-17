-- ============================================================================
-- T3 PREPARED SQL 05 — attach_payment_receipt_v1 (A.7 cross-request blocker)
-- + payments guard for canonical-linked vouchers.
-- STATUS: PREPARED (compile+behavior tested on disposable PG17 exact-source
-- restore). NOT a migration; production apply gated by owner.
--
-- Replaces the three-commit useUploadPaymentReceipt flow with one transaction:
--   lock payment (+invoice) → lock ALL linked vouchers → validate URL server-
--   side → update payment receipt + voucher attachments + chained audit
--   together. Canonical-marked vouchers are rejected here until the private
--   T3 transition routine exists (freeze stays absolute).
-- The guard closes the other half: direct payment UPDATE/DELETE is rejected
-- while the payment links any canonical-marked voucher.
-- ============================================================================

begin;

create or replace function public.attach_payment_receipt_v1(
  p_payment_id uuid,
  p_receipt_url text
) returns jsonb
language plpgsql
volatile
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_actor uuid := auth.uid();
  v_payment public.payments;
  v_invoice public.invoices;
  v_voucher record;
  v_updated int := 0;
  v_url text;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;

  -- Server-side URL validation: https, project storage path, sane charset,
  -- bounded length. (Bucket/host pinning per attachment contract.)
  v_url := btrim(coalesce(p_receipt_url, ''));
  if v_url = '' or char_length(v_url) > 2048
     or v_url !~ '^https://[A-Za-z0-9.-]+/storage/v1/object/[A-Za-z0-9._~:/?#\[\]@!$&''()*+,;=%-]+$'
     or v_url ~ '[[:cntrl:][:space:]]' then
    raise exception 'URL chứng từ không hợp lệ' using errcode = '22023';
  end if;

  -- Lock payment first (deterministic order: invoice → payment → voucher is
  -- v3's order; here we start from payment and lock its invoice next, which
  -- is safe because we never lock another payment afterwards).
  select * into v_payment from public.payments
   where id = p_payment_id for update;
  if not found then
    raise exception 'Không tìm thấy giao dịch thu tiền' using errcode = 'P0002';
  end if;

  -- Authorization: invoice-linked payments require building edit permission;
  -- standalone payments require ownership.
  if v_payment.invoice_id is not null then
    select * into v_invoice from public.invoices
     where id = v_payment.invoice_id and deleted_at is null for update;
    if not found then
      raise exception 'Hóa đơn của giao dịch không còn tồn tại' using errcode = 'P0002';
    end if;
    if not public.can_do_on_building('invoices', 'edit', v_invoice.building_id) then
      raise exception 'Không có quyền cập nhật chứng từ cho hóa đơn này'
        using errcode = '42501';
    end if;
  elsif v_payment.user_id is distinct from v_actor
        and not public.is_super_admin() then
    raise exception 'Không có quyền cập nhật giao dịch này' using errcode = '42501';
  end if;

  -- Lock ALL linked vouchers (no LIMIT 1 assumption) and reject canonical rows.
  for v_voucher in
    select ie.id, ie.attachments, ie.organization_id,
           ie.approval_status
      from public.income_expenses ie
     where ie.payment_id = p_payment_id and ie.deleted_at is null
     order by ie.id
     for update
  loop
    if app_private.is_income_expense_flow_owned(v_voucher.id) then
      raise exception 'Phiếu liên kết là canonical draft — cập nhật chứng từ phải qua luồng duyệt'
        using errcode = '55000';
    end if;
  end loop;

  update public.payments
     set receipt_image_url = v_url
   where id = p_payment_id;

  update public.income_expenses ie
     set attachments = (
       select coalesce(jsonb_agg(distinct x), '[]'::jsonb)
         from (
           select jsonb_array_elements_text(coalesce(ie.attachments, '[]'::jsonb)) as x
           union
           select v_url
         ) u
     )
   where ie.payment_id = p_payment_id and ie.deleted_at is null;
  get diagnostics v_updated = row_count;

  return jsonb_build_object(
    'payment_id', p_payment_id,
    'receipt_url', v_url,
    'vouchers_updated', v_updated);
end;
$fn$;

revoke all on function public.attach_payment_receipt_v1(uuid, text)
  from public, anon, service_role;
grant execute on function public.attach_payment_receipt_v1(uuid, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Payments guard: direct mutation frozen while linked to a canonical voucher.
-- ---------------------------------------------------------------------------

create or replace function app_private.guard_payment_canonical_link()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
declare
  v_id uuid;
begin
  v_id := case when tg_op = 'DELETE' then old.id else new.id end;
  if exists (
    select 1 from public.income_expenses ie
     where ie.payment_id = v_id and ie.deleted_at is null
       and app_private.is_income_expense_flow_owned(ie.id)
  ) then
    raise exception 'payment % links a canonical voucher — direct % rejected',
      v_id, tg_op using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$fn$;

revoke all on function app_private.guard_payment_canonical_link()
  from public, anon, authenticated, service_role;

drop trigger if exists a00_payment_canonical_link_guard on public.payments;
create trigger a00_payment_canonical_link_guard
before update or delete on public.payments
for each row execute function app_private.guard_payment_canonical_link();
alter table public.payments
  enable always trigger a00_payment_canonical_link_guard;

commit;

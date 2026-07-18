-- t5_14_invoice_create_parity_DRAFT.sql — NHỊP 2 domain invoice: create/update parity
--
-- ⚠️ DRAFT — CHƯA APPLY PROD. Chờ review. Nền tảng khảo sát:
--    docs/authorization/TRANCHE-INVOICE-N2-SURVEY-2026-07-18.md (mục 1).
--
-- BỐI CẢNH: create_invoice_v1 hiện hành (13 args) GIỮ kiến trúc engine chuẩn
--   (ledger 'invoice.create.v1' + route flag + authorize_tenant_action_v3) NHƯNG
--   DROP một loạt field client set → không wireable nguyên trạng. useCreateInvoice
--   (src/hooks/useInvoices.ts:574-704) + GenerateInvoiceDialog còn set thêm:
--     • invoices: prepaid_amount, discount_notes, electricity_prev_overridden,
--       previous_debt_sources (jsonb), notes, template_id, creator_name
--     • bước tiêu credit: insert excess_amounts ÂM khi applied_credit>0 (cùng tx)
--     • items: service_id, coefficient, previous_reading, current_reading,
--       from_date, to_date, sort_order (writer cũ chỉ giữ type/desc/price/qty/amount)
--     • client tự SINH invoice_number + tự LÀM TRÒN (roundInvoiceTotal)
--
-- VIỆC FILE NÀY (parity-extend, mẫu như cashbook t5_1x):
--   1) DROP+recreate public.create_invoice_v1 — GIỮ NGUYÊN kiến trúc (idempotency
--      qua canonical_write_operations, route 'invoice.create.v1', authorize
--      'invoices.create' building-scoped, auto-approve từ organization_invoice_settings)
--      và THÊM 8 tham số parity (gồm p_applied_credit) + items whitelist 12 field.
--   2) Số hoá đơn: BỎ client-gen — writer KHÔNG set invoice_number → trigger DB
--      generate_invoice_number_v2 (BEFORE INSERT) tự sinh (nguồn sự thật duy nhất).
--   3) Làm tròn SERVER mirror roundInvoiceTotal (<900 xuống, ≥900 lên bội 1000) qua
--      helper app_private.round_invoice_total_v1, TRÊN p_subtotal client gửi, + ASSERT
--      khớp p_total_amount (lệch → error rõ, KHÔNG phải fallback signal). KHÔNG re-sum
--      items làm nguồn subtotal (tránh phá caller nội bộ create_contract_v1 — xem [R7]).
--   4) update_invoice_v1 MỚI (nhẹ như cancel_invoice_v1 — KHÔNG route flag): guard
--      SERVER mirror canEditInvoice ((DRAFT|APPROVED) AND paid_amount=0), replace
--      items, KHÔNG cho đổi invoice_number/status/approved_by/paid_amount/kind.
--
-- WIRING/FLAG:
--   • Flag server_feature_flags 'invoice.create.v1' đang mode=OFF (verified prod) →
--     evaluate_feature_route trả 'LEGACY' → writer raise 55000 "…chưa bật…" →
--     isCanonicalFallbackSignal=true → client fallback legacy insert. Cutover chỉ
--     cần bật flag (KHÔNG sửa client). File này KHÔNG đụng flag.
--   • create_invoice_v1 prod HIỆN chỉ grant EXECUTE cho postgres → client
--     authenticated gọi sẽ 42501 (vẫn là fallback signal, nhưng flag ON cũng vô
--     dụng vì thiếu grant). File này GRANT authenticated để cutover-by-flag khả thi.
--   • update_invoice_v1 KHÔNG có flag: fallback chỉ khi PGRST202 (chưa deploy) /
--     42501 (coexistence). Guard trạng thái dùng errcode mặc định (P0001) → KHÔNG
--     fallback, lỗi hiện thẳng (server là authority của guard, y hệt legacy hook).
--
-- KHÔNG đụng: super_admin_force_cancel_invoice (→ t5_15), 8 status-writer (t5_09 —
--   nhịp 1, đã VERIFIED), GenerateInvoiceDialog bulk-generate (khảo sát riêng khi build).

begin;

-- ============================================================================
-- 0) Helper: làm tròn tổng hoá đơn — mirror BÍT-ĐỐI-BÍT src/lib/invoiceUtils.ts
--    roundInvoiceTotal() (đã verify read-only trên prod với 9 case):
--      total<=0 (hoặc null) → giữ nguyên
--      remainder = total % 1000; ==0 → giữ; >=900 → ceil bội 1000; else floor bội 1000
--    Dùng chung cho create_invoice_v1 + update_invoice_v1 (một nguồn, không lệch).
-- ============================================================================
create or replace function app_private.round_invoice_total_v1(p_total numeric)
returns numeric
language sql
immutable
set search_path to 'pg_catalog'
as $$
  select case
    when p_total is null or p_total <= 0 then p_total
    when mod(p_total, 1000) = 0          then p_total
    when mod(p_total, 1000) >= 900       then ceil(p_total / 1000.0) * 1000
    else                                      floor(p_total / 1000.0) * 1000
  end;
$$;
revoke all on function app_private.round_invoice_total_v1(numeric) from public;
revoke all on function app_private.round_invoice_total_v1(numeric) from anon;

-- ============================================================================
-- 1) create_invoice_v1 — DROP chữ ký cũ (13 args) rồi recreate parity (21 args).
--    Tham số parity thêm ở CUỐI + có DEFAULT → caller positional 13-arg cũ vẫn khớp
--    (QUAN TRỌNG: create_contract_v1 gọi create_invoice_v1 bằng 13 arg positional để
--    sinh HĐ tháng đầu — xem [R7]). Client gọi bằng NAMED params (supabase.rpc).
-- ============================================================================
drop function if exists public.create_invoice_v1(
  uuid, uuid, uuid, text, date, date, text, numeric, numeric, numeric, numeric, jsonb, text
);

create or replace function public.create_invoice_v1(
  p_contract_id                 uuid,
  p_building_id                 uuid,
  p_room_id                     uuid,
  p_billing_month               text,
  p_issue_date                  date,
  p_due_date                    date,
  p_kind                        text,
  p_subtotal                    numeric,
  p_discount_amount             numeric,
  p_total_amount                numeric,
  p_previous_debt               numeric,
  p_items                       jsonb,
  p_idempotency_key             text,
  -- ---- parity thêm (nhịp 2) ----
  p_prepaid_amount              numeric  default 0,
  p_discount_notes              text     default null,
  p_electricity_prev_overridden boolean  default false,
  p_previous_debt_sources       jsonb    default '[]'::jsonb,
  p_template_id                 uuid     default null,
  p_notes                       text     default null,
  p_applied_credit              numeric  default 0,
  -- creator_name: khảo sát liệt kê là field client set nhưng danh sách tham số
  -- nhịp-2 KHÔNG nêu → thêm optional để KHÔNG regress parity. Xem TODO-REVIEW [R1].
  p_creator_name                text     default null
)
returns json
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $function$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_authz boolean;
  v_auto boolean;
  v_status text;
  v_key text; v_hash text;
  v_op app_private.canonical_write_operations%rowtype;
  v_route text;
  v_invoice uuid;
  v_invoice_number text;
  v_resp json;
  it jsonb; v_idx int := 0;
  v_total_calc numeric(15,2);
  v_applied numeric(15,2);
  c_op constant text := 'invoice.create.v1';
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  v_key := btrim(coalesce(p_idempotency_key,''));
  if char_length(v_key) < 8 or char_length(v_key) > 200
     or v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;
  if p_total_amount is null or p_total_amount < 0 then raise exception 'Tổng tiền không hợp lệ'; end if;
  if p_items is not null and jsonb_typeof(p_items) <> 'array' then
    raise exception 'p_items phải là JSON array'; end if;

  -- derive + lock: building → org; contract same-org; room same-building/org.
  select b.organization_id into v_org from public.buildings b
    join public.organizations o on o.id=b.organization_id and o.status='ACTIVE'
   where b.id=p_building_id and b.deleted_at is null for share of o,b;
  if not found or v_org is null then
    raise exception 'Toà nhà không thuộc tổ chức đang hoạt động' using errcode='42501'; end if;
  -- contracts link to a building via their room, not a direct building_id column.
  perform 1 from public.contracts c where c.id=p_contract_id and c.deleted_at is null
    and c.organization_id=v_org for share;
  if not found then raise exception 'Hợp đồng không thuộc tổ chức' using errcode='42501'; end if;
  if p_room_id is not null then
    perform 1 from public.rooms r where r.id=p_room_id and r.deleted_at is null
      and r.building_id=p_building_id and r.organization_id=v_org for share;
    if not found then raise exception 'Phòng không thuộc toà/tổ chức' using errcode='42501'; end if;
  end if;

  -- exact permission invoices.create, building-scoped.
  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'invoices.create', p_building_id, null);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền tạo hoá đơn (invoices.create)' using errcode='42501'; end if;

  -- server decides APPROVED vs DRAFT from org settings; missing row = abort.
  select auto_approve_invoice into v_auto from public.organization_invoice_settings
   where organization_id = v_org;
  if v_auto is null then
    raise exception 'Thiếu cấu hình auto_approve_invoice cho tổ chức' using errcode='55000'; end if;
  v_status := case when v_auto then 'APPROVED' else 'DRAFT' end;

  v_hash := md5(jsonb_build_object('contract',p_contract_id,'month',p_billing_month,
    'total',p_total_amount,'org',v_org)::text);
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, c_op, p_contract_id::text || '|' || p_billing_month, v_actor, v_key, v_hash)
  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;
  select * into v_op from app_private.canonical_write_operations o
   where o.organization_id=v_org and o.operation=c_op
     and o.subject_scope=p_contract_id::text || '|' || p_billing_month
     and o.actor_id=v_actor and o.idempotency_key=v_key for update;
  if v_op.payload_hash <> v_hash then
    raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;
  if v_op.completed_at is not null then return v_op.response_payload::json; end if;

  v_route := app_private.evaluate_feature_route(c_op, v_org);
  if v_route <> 'CANONICAL' then
    raise exception 'Writer hoá đơn chưa bật cho tổ chức này' using errcode='55000'; end if;

  -- ---- PARITY: làm tròn server mirror roundInvoiceTotal + ASSERT khớp total ----
  -- total = round(p_subtotal − discount + nợ cũ) TRÊN SUBTOTAL CLIENT GỬI (KHÔNG
  -- re-sum items — giữ giả định item-shape của mọi caller, gồm create_contract_v1).
  -- KHÔNG clamp ≥0 (mirror useCreateInvoice; KHÁC clamp hiển thị Math.max(0,…) của
  -- GenerateInvoiceDialog). Guard p_total_amount<0 ở trên vẫn chặn tổng âm.
  v_total_calc := app_private.round_invoice_total_v1(
    coalesce(p_subtotal,0) - coalesce(p_discount_amount,0) + coalesce(p_previous_debt,0));

  if v_total_calc is distinct from p_total_amount then
    raise exception
      'Tổng tiền client (%) khác tổng server làm tròn (%) [subtotal=%, discount=%, nợ cũ=%]',
      p_total_amount, v_total_calc, coalesce(p_subtotal,0),
      coalesce(p_discount_amount,0), coalesce(p_previous_debt,0)
      using errcode='22000';
  end if;

  -- create the invoice; the live partial-unique (contract_id, billing_month)
  -- WHERE deleted_at IS NULL AND status<>'CANCELLED' AND kind='MONTHLY'
  -- enforces one-per-period. invoice_number BỎ TRỐNG → trigger
  -- generate_invoice_number_v2 (BEFORE INSERT) tự sinh.
  insert into public.invoices
    (user_id, organization_id, contract_id, building_id, room_id, billing_month,
     issue_date, due_date, kind, status, subtotal, discount_amount, discount_notes,
     electricity_prev_overridden, total_amount, prepaid_amount, paid_amount,
     previous_debt, previous_debt_sources, notes, template_id, creator_name,
     approved_by, approved_at)
  values
    (v_actor, v_org, p_contract_id, p_building_id, p_room_id, p_billing_month,
     p_issue_date, p_due_date, coalesce(p_kind,'MONTHLY'), v_status::invoice_status,
     coalesce(p_subtotal,0), coalesce(p_discount_amount,0), p_discount_notes,
     coalesce(p_electricity_prev_overridden,false), p_total_amount,
     coalesce(p_prepaid_amount,0), 0,
     coalesce(p_previous_debt,0),
     coalesce(p_previous_debt_sources,'[]'::jsonb), p_notes, p_template_id,
     p_creator_name,
     case when v_auto then v_actor else null end,
     case when v_auto then now() else null end)
  returning id, invoice_number into v_invoice, v_invoice_number;

  -- ---- PARITY: bước tiêu credit (mirror useCreateInvoice:639-652) ----
  -- Áp credit vào Giảm trừ HĐ → ghi excess_amounts ÂM CÙNG TX. amount đã cộng vào
  -- discount_amount ở client nên KHÔNG trừ 2 lần; row âm chỉ hạ số dư credit HĐ.
  v_applied := coalesce(p_applied_credit,0);
  if v_applied > 0 and p_contract_id is not null then
    insert into public.excess_amounts
      (user_id, organization_id, contract_id, amount, description,
       source_invoice_id, source_payment_id)
    values
      (v_actor, v_org, p_contract_id, -v_applied,
       'Áp credit vào Giảm trừ HĐ ' || coalesce(v_invoice_number, v_invoice::text),
       v_invoice, null);
  end if;

  -- ---- PARITY: items whitelist 12 field client ----
  -- amount = amount client gửi (1 trong 12 field, giữ hành vi writer cũ), fallback
  -- tính unit_price*quantity*coefficient nếu vắng. sort_order lấy client, fallback
  -- thứ tự xuất hiện.
  if p_items is not null then
    for it in select value from jsonb_array_elements(p_items) loop
      v_idx := v_idx + 1;
      insert into public.invoice_items
        (invoice_id, organization_id, service_id, type, description, unit_price,
         quantity, coefficient, amount, previous_reading, current_reading,
         from_date, to_date, sort_order)
      values (
        v_invoice, v_org,
        nullif(it->>'service_id','')::uuid,
        coalesce(nullif(it->>'type','')::invoice_item_type, 'OTHER'::invoice_item_type),
        it->>'description',
        coalesce((it->>'unit_price')::numeric,0),
        coalesce((it->>'quantity')::numeric,1),
        coalesce((it->>'coefficient')::numeric,1),
        coalesce((it->>'amount')::numeric,
          coalesce((it->>'unit_price')::numeric,0)
          * coalesce((it->>'quantity')::numeric,1)
          * coalesce((it->>'coefficient')::numeric,1)),
        nullif(it->>'previous_reading','')::numeric,
        nullif(it->>'current_reading','')::numeric,
        nullif(it->>'from_date','')::date,
        nullif(it->>'to_date','')::date,
        coalesce((it->>'sort_order')::int, v_idx)
      );
    end loop;
  end if;

  v_resp := json_build_object('invoice_id', v_invoice, 'status', v_status,
                              'invoice_number', v_invoice_number);
  update app_private.canonical_write_operations
     set subject_id=v_invoice, response_payload=to_jsonb(v_resp), completed_at=now()
   where organization_id=v_org and operation=c_op
     and subject_scope=p_contract_id::text || '|' || p_billing_month
     and actor_id=v_actor and idempotency_key=v_key;
  return v_resp;
end;
$function$;

revoke all on function public.create_invoice_v1(
  uuid, uuid, uuid, text, date, date, text, numeric, numeric, numeric, numeric, jsonb, text,
  numeric, text, boolean, jsonb, uuid, text, numeric, text
) from public;
revoke all on function public.create_invoice_v1(
  uuid, uuid, uuid, text, date, date, text, numeric, numeric, numeric, numeric, jsonb, text,
  numeric, text, boolean, jsonb, uuid, text, numeric, text
) from anon;
grant execute on function public.create_invoice_v1(
  uuid, uuid, uuid, text, date, date, text, numeric, numeric, numeric, numeric, jsonb, text,
  numeric, text, boolean, jsonb, uuid, text, numeric, text
) to authenticated;

-- ============================================================================
-- 2) update_invoice_v1 — MỚI. Mirror useUpdateInvoice (useInvoices.ts:711-825):
--    guard canEditInvoice server-side, recalc total (làm tròn), replace toàn bộ
--    items. KHÔNG đổi invoice_number/status/approved_*/paid_amount/kind. Nhẹ như
--    cancel_invoice_v1: KHÔNG idempotency/route flag. Quyền:
--    app_private.can_edit_invoice_building_v1 (= policy invoices_update_rbac, dùng
--    chung với 8 status-writer t5_09). KHÔNG có caller nội bộ (chỉ FE gọi).
-- ============================================================================
create or replace function public.update_invoice_v1(
  p_invoice_id                  uuid,
  p_contract_id                 uuid,
  p_building_id                 uuid,
  p_room_id                     uuid,
  p_billing_month               text,
  p_issue_date                  date,
  p_due_date                    date,
  p_subtotal                    numeric,
  p_discount_amount             numeric,
  p_total_amount                numeric,
  p_previous_debt               numeric,
  p_items                       jsonb,
  p_prepaid_amount              numeric  default 0,
  p_discount_notes              text     default null,
  p_electricity_prev_overridden boolean  default false,
  p_previous_debt_sources       jsonb    default '[]'::jsonb,
  p_template_id                 uuid     default null,
  p_notes                       text     default null
)
returns public.invoices
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $function$
declare
  v_actor uuid := auth.uid();
  v_row public.invoices%rowtype;
  v_org uuid;
  it jsonb; v_idx int := 0;
  v_total_calc numeric(15,2);
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  if p_items is not null and jsonb_typeof(p_items) <> 'array' then
    raise exception 'p_items phải là JSON array'; end if;

  select * into v_row from public.invoices
   where id = p_invoice_id and deleted_at is null for update;
  if not found then
    raise exception 'Không tìm thấy hoá đơn hoặc bạn không có quyền' using errcode='42501'; end if;
  v_org := v_row.organization_id;

  -- SERVER mirror canEditInvoice: (DRAFT|APPROVED) AND paid_amount=0. Dùng errcode
  -- mặc định (P0001, KHÔNG fallback) → lỗi hiện thẳng như legacy hook, không rơi
  -- xuống đường legacy để lách guard.
  if v_row.status not in ('DRAFT'::invoice_status, 'APPROVED'::invoice_status)
     or coalesce(v_row.paid_amount,0) <> 0 then
    raise exception 'Không thể chỉnh sửa hoá đơn ở trạng thái này';
  end if;

  -- quyền edit theo toà HIỆN TẠI của hoá đơn.
  if not app_private.can_edit_invoice_building_v1(v_row.building_id) then
    raise exception 'Không có quyền chỉnh sửa hoá đơn này' using errcode='42501'; end if;

  -- Nếu ĐỔI toà → chặn cross-org + đòi quyền edit trên toà đích. (Đổi phòng cũng
  -- verify thuộc toà đích/cùng org, mirror ràng buộc create.)
  if p_building_id is distinct from v_row.building_id then
    perform 1 from public.buildings b
     where b.id=p_building_id and b.deleted_at is null and b.organization_id=v_org;
    if not found then
      raise exception 'Toà đích không thuộc tổ chức của hoá đơn' using errcode='42501'; end if;
    if not app_private.can_edit_invoice_building_v1(p_building_id) then
      raise exception 'Không có quyền chỉnh sửa sang toà này' using errcode='42501'; end if;
  end if;
  if p_room_id is not null then
    perform 1 from public.rooms r
     where r.id=p_room_id and r.deleted_at is null
       and r.building_id=p_building_id and r.organization_id=v_org;
    if not found then
      raise exception 'Phòng không thuộc toà/tổ chức' using errcode='42501'; end if;
  end if;

  -- recalc total + assert (làm tròn trên p_subtotal, giống create).
  v_total_calc := app_private.round_invoice_total_v1(
    coalesce(p_subtotal,0) - coalesce(p_discount_amount,0) + coalesce(p_previous_debt,0));

  if v_total_calc is distinct from p_total_amount then
    raise exception
      'Tổng tiền client (%) khác tổng server làm tròn (%) [subtotal=%, discount=%, nợ cũ=%]',
      p_total_amount, v_total_calc, coalesce(p_subtotal,0),
      coalesce(p_discount_amount,0), coalesce(p_previous_debt,0)
      using errcode='22000';
  end if;

  update public.invoices
     set contract_id                 = p_contract_id,
         building_id                 = p_building_id,
         room_id                     = p_room_id,
         billing_month               = p_billing_month,
         issue_date                  = p_issue_date,
         due_date                    = p_due_date,
         subtotal                    = coalesce(p_subtotal,0),
         discount_amount             = coalesce(p_discount_amount,0),
         discount_notes              = p_discount_notes,
         electricity_prev_overridden = coalesce(p_electricity_prev_overridden,false),
         total_amount                = p_total_amount,
         prepaid_amount              = coalesce(p_prepaid_amount,0),
         previous_debt               = coalesce(p_previous_debt,0),
         previous_debt_sources       = coalesce(p_previous_debt_sources,'[]'::jsonb),
         notes                       = p_notes,
         template_id                 = p_template_id
   where id = p_invoice_id
   returning * into v_row;

  -- replace items (delete-all rồi insert lại, mirror legacy).
  delete from public.invoice_items where invoice_id = p_invoice_id;
  if p_items is not null then
    for it in select value from jsonb_array_elements(p_items) loop
      v_idx := v_idx + 1;
      insert into public.invoice_items
        (invoice_id, organization_id, service_id, type, description, unit_price,
         quantity, coefficient, amount, previous_reading, current_reading,
         from_date, to_date, sort_order)
      values (
        p_invoice_id, v_org,
        nullif(it->>'service_id','')::uuid,
        coalesce(nullif(it->>'type','')::invoice_item_type, 'OTHER'::invoice_item_type),
        it->>'description',
        coalesce((it->>'unit_price')::numeric,0),
        coalesce((it->>'quantity')::numeric,1),
        coalesce((it->>'coefficient')::numeric,1),
        coalesce((it->>'amount')::numeric,
          coalesce((it->>'unit_price')::numeric,0)
          * coalesce((it->>'quantity')::numeric,1)
          * coalesce((it->>'coefficient')::numeric,1)),
        nullif(it->>'previous_reading','')::numeric,
        nullif(it->>'current_reading','')::numeric,
        nullif(it->>'from_date','')::date,
        nullif(it->>'to_date','')::date,
        coalesce((it->>'sort_order')::int, v_idx)
      );
    end loop;
  end if;

  return v_row;
end;
$function$;

revoke all on function public.update_invoice_v1(
  uuid, uuid, uuid, uuid, text, date, date, numeric, numeric, numeric, numeric, jsonb,
  numeric, text, boolean, jsonb, uuid, text
) from public;
revoke all on function public.update_invoice_v1(
  uuid, uuid, uuid, uuid, text, date, date, numeric, numeric, numeric, numeric, jsonb,
  numeric, text, boolean, jsonb, uuid, text
) from anon;
grant execute on function public.update_invoice_v1(
  uuid, uuid, uuid, uuid, text, date, date, numeric, numeric, numeric, numeric, jsonb,
  numeric, text, boolean, jsonb, uuid, text
) to authenticated;

commit;

-- ============================================================================
-- TODO-REVIEW (chốt trước khi apply)
-- ----------------------------------------------------------------------------
-- [R1] p_creator_name: khảo sát nhịp-2 KHÔNG liệt kê trong danh sách tham số parity
--      nhưng creator_name LÀ field client set (useInvoices:631) → thêm optional để
--      không regress. Nếu owner muốn derive server-side (từ profiles/auth metadata)
--      hoặc bỏ hẳn → xoá tham số + cột trong INSERT. Hiện client phải TỰ truyền
--      p_creator_name khi wire (writer không đọc user_metadata được như FE).
--
-- [R2] Grant EXECUTE cho authenticated: prod hiện chỉ grant postgres → nếu KHÔNG
--      thêm grant này thì bật flag 'invoice.create.v1'=ON vẫn 42501. Đã theo mẫu
--      t5_09 (revoke public/anon, grant authenticated). Xác nhận đúng chủ đích.
--
-- [R3] ASSERT total dùng "is distinct from" trên numeric (so sánh theo GIÁ TRỊ:
--      3157500 = 3157500.00). Client VND nguyên → khớp tuyệt đối (đã verify công
--      thức làm tròn read-only, 9 case khớp roundInvoiceTotal). Nếu tương lai FE đổi
--      cách tính (round từng dòng…) làm p_total_amount ≠ round(p_subtotal) → assert
--      raise 22000 (không phải fallback, lỗi hiện thẳng). Chủ đích: bắt lệch sớm.
--
-- [R4] Writer KHÔNG clamp total về ≥0 (mirror useCreateInvoice). Guard cũ
--      "p_total_amount < 0 → lỗi" giữ nguyên → tổng âm (discount > subtotal+nợ) bị
--      CHẶN ở server dù client roundInvoiceTotal trả âm (GenerateInvoiceDialog đã
--      Math.max(0,…) ở HIỂN THỊ nhưng useCreateInvoice thì KHÔNG). Đây là writer
--      NGHIÊM hơn legacy insert (legacy cho tổng âm). Xác nhận muốn chặn tổng âm.
--
-- [R5] update_invoice_v1 CHO đổi building/room (mirror form edit). Đã chặn cross-org
--      + đòi quyền trên toà đích. Nếu chính sách là "không cho đổi toà khi sửa" →
--      thêm guard p_building_id = OLD.building_id. Cân nhắc.
--
-- [R6] subtotal LƯU = coalesce(p_subtotal,0) (giữ hành vi writer cũ, KHÔNG re-sum
--      items). total assert TRÊN cùng p_subtotal ⇒ subtotal/total tự nhất quán. Nếu
--      muốn server là nguồn sự thật của subtotal → thêm re-sum items + assert
--      p_subtotal, NHƯNG phải bảo đảm mọi item gửi kèm coefficient/amount đúng (xem
--      [R7] create_contract_v1). Hiện KHÔNG re-sum để an toàn.
--
-- [R7] ⚠️ COUPLING create_contract_v1: hàm này gọi create_invoice_v1 bằng 13 arg
--      POSITIONAL (v_contract, v_building, room, month, issue, due, 'MONTHLY',
--      subtotal, 0, total_amount, 0, items, key||'-inv') để sinh HĐ tháng đầu.
--      • Chữ ký mới (13 required + 8 default) → call 13-arg VẪN resolve (default lấp).
--      • NHƯNG assert MỚI đòi total_amount == round(subtotal). p_first_invoice do FE
--        (useContracts) dựng — PHẢI verify nó set total_amount = roundInvoiceTotal(
--        subtotal), nếu không create_contract_v1 sẽ vỡ ở bước sinh HĐ.
--      • Hiện flag 'contract.create.v1' = OFF (verified) ⇒ đường này ĐANG DORMANT
--        (client fallback legacy tạo HĐ, không qua create_invoice_v1). Rủi ro là
--        LATENT: kích hoạt khi BẬT ĐỒNG THỜI cả 2 flag. → Trước cutover: kiểm
--        payload p_first_invoice, hoặc cho create_contract_v1 tự làm tròn total
--        trước khi gọi.
-- ============================================================================

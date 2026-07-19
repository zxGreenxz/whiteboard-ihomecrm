-- t5_12_salary_payout_extend_DRAFT.sql — Chi lương + gạch nợ tiền phòng (P1)  [DRAFT]
--
-- ⚠️ DRAFT — CHƯA APPLY LÊN PROD. Chờ review. Điểm chưa chắc → "-- TODO-REVIEW:".
--
-- BỐI CẢNH (survey §1,§2,§4): useSalaryPayout (useManagerSalary.ts:769) là cascade
--   client 5-6 bước KHÔNG atomic trên 3 bảng tiền:
--     insert income_expenses(EXPENSE)+items  → nếu gạch nợ tiền phòng:
--     insert payments(CT) + income_expenses(INCOME)+items  → update salary_monthly
--     (paid, payout_voucher_id).
--   Bypass IE-create + payment-writer + a00_payment_canonical_link_guard. Đứt giữa
--   chừng: payment mồ côi / hoá đơn ĐÃ-THU thiếu phiếu đối ứng / lệch paid.
--
-- QUYẾT ĐỊNH OWNER 2026-07-18 (fork CHỐT):
--   • Payout đi qua ENGINE DUYỆT: submit_financial_request_v1 → phiếu chi lương
--     UNAPPROVED, state PENDING_APPROVAL (KHÔNG "chi & ghi paid ngay" như UX cũ).
--   • Rent-offset mở rộng IN-WRITER (PHƯƠNG ÁN A): thêm p_rent_invoice_id +
--     p_rent_amount → khi có, gọi record_invoice_payment_v3 (chữ ký THẬT — gạch nợ
--     tiền phòng: tạo payment CT + phiếu THU INCOME đối ứng, cập nhật hoá đơn) TRONG
--     CÙNG TRANSACTION với phiếu chi lương.
--
-- GIỮ NGUYÊN kiến trúc salary_payout_v1 hiện có (verified read-only prod):
--   authorize_tenant_action_v3('salary.distribute') + lock_org_for_decision_v1 +
--   canonical_write_operations (ledger idempotency) + submit_financial_request_v1.
--
-- THÊM so với bản hiện tại:
--   (a) p_rent_invoice_id uuid default null, p_rent_amount numeric default null.
--   (b) Khi có rent & còn nợ: phiếu chi lương TÁCH 2 dòng item (thực nhận + tiền
--       phòng) ⇒ tổng phiếu chi = GROSS. Dòng #2 thêm TRƯỚC submit để snapshot
--       amount của engine = gross (submit đọc income_expenses.total_amount). Sau đó
--       gọi record_invoice_payment_v3 tạo phiếu THU đối ứng ⇒ net sổ quỹ = thực
--       nhận (mirror ý đồ legacy: chi gross − thu tiền phòng).
--   (c) salary_monthly: stamp payout_voucher_id = phiếu chi vừa tạo (link xác định,
--       biết ngay tại submit). paid: XEM TODO-REVIEW P3 (KHÔNG đoán).
--
-- ═══════════════ TODO-REVIEW (đọc kỹ trước khi apply) ═══════════════
--  P1. STAMP paid/payout_voucher_id "khi POST": ĐÃ ĐỌC KỸ WRITER + ENGINE.
--      - salary_payout_v1 hiện tại KHÔNG stamp paid/payout_voucher_id (chỉ ensure
--        salary_monthly DRAFT tồn tại; comment "accrual on post").
--      - Engine POST app_private.post_financial_request_v1 (verified dump) CHỈ
--        chuyển income_expenses→APPROVED + approval_requests→POSTED. KHÔNG hề đụng
--        salary_monthly. KHÔNG có function nào trong DB stamp payout_voucher_id
--        (query pg_proc: 0 kết quả). ⇒ Ở luồng canonical, paid/payout_voucher_id
--        HIỆN KHÔNG được ghi ở đâu cả — đây là KHE HỞ THẬT, không phải chỗ tôi bỏ
--        sót. KHÔNG bịa hook POST. Draft này: stamp payout_voucher_id NGAY tại
--        submit (id phiếu đã biết, deterministic) + KHÔNG đụng paid. Cần OWNER chọn
--        cơ chế accrual `paid` khi phiếu chi lương THỰC SỰ được duyệt (POSTED):
--          (a) TRIGGER trên income_expenses AFTER UPDATE khi salary_staff_id NOT
--              NULL và approval_status→APPROVED ⇒ salary_monthly.paid += tiền thực
--              nhận (item 'Tiền thực nhận', KHÔNG gồm dòng tiền phòng);
--          (b) mở rộng post_financial_request_v1 nhận biết voucher lương;
--          (c) BỎ cột paid, tính paid qua VIEW từ các phiếu lương đã duyệt.
--      → Quyết định kiến trúc, để owner chốt; draft KHÔNG chọn thay.
--  P2. payout_voucher_id stamp tại submit (không phải post): nếu phiếu bị DENIED
--      sau đó, payout_voucher_id trỏ tới phiếu không-post (FK ON DELETE SET NULL,
--      không vỡ). Reviewer xác nhận chấp nhận, hay dời stamp sang cơ chế P1.
--  P3. BẤT ĐỐI XỨNG rent vs salary: record_invoice_payment_v3 tạo phiếu THU
--      APPROVED + gạch nợ hoá đơn NGAY (nó là payment-writer post-liền), trong khi
--      phiếu CHI lương chỉ PENDING_APPROVAL. Nếu payout sau đó bị từ chối, tiền
--      phòng ĐÃ thu (đã commit). Owner đã chốt "rent-offset in-writer A" ⇒ chấp
--      nhận; nhưng cần xác nhận vận hành (không có bước hoàn khi payout bị deny).
--  P4. QUYỀN record_invoice_payment_v3: nó check can_do_on_building('invoices',
--      'edit', building_of_invoice) cho ACTOR (auth.uid()). Actor chi lương phải
--      ĐỒNG THỜI có quyền sửa hoá đơn tiền phòng. Legacy insert payment thẳng dưới
--      RLS (user_id=chủ hoá đơn). ⇒ parity CHẶT hơn. Xác nhận actor luôn đủ quyền,
--      hoặc chấp nhận fail-closed.
--  P5. CLAMP tiền phòng: legacy clamp rentCollect = min(amount, remaining). Draft
--      clamp v_rent_collect = least(round(p_rent_amount,2), remaining) để KHÔNG tạo
--      excess_amounts ngoài ý muốn (record_invoice_payment_v3 KHÔNG tự clamp — vượt
--      remaining sẽ ghi excess). remaining<=0 ⇒ bỏ offset. Xác nhận đúng ý.
--  P6. LOẠI THU đối ứng: resolve income (non-deposit) type theo ORG CỦA HOÁ ĐƠN
--      (invoices.organization_id), ưu tiên is_default → tên 'Thu tiền hoá đơn' →
--      bản cũ nhất (mirror legacy revenueTypes). Không có ⇒ ABORT. Xác nhận thứ tự
--      ưu tiên + phạm vi org (không phải org lương).
--  P7. p_take_home = TIỀN THỰC NHẬN (net). Dòng tiền phòng CỘNG THÊM để phiếu chi =
--      gross. Nếu caller đã truyền p_take_home = gross thì SAI (double count). Xác
--      nhận hợp đồng tham số với hook.
--  P8. Feature-flag: dùng lại 'salary.payout.v1' (đã có row, đang OFF theo survey
--      §2). KHÔNG cần seed key mới. Bật canary như payout gốc.

begin;

-- DROP bản 7-tham-số hiện tại rồi tạo lại 9-tham-số (thêm 2 optional).
drop function if exists public.salary_payout_v1(uuid, date, numeric, uuid, date, text, text);

create or replace function public.salary_payout_v1(
  p_staff_id uuid,
  p_period_month date,
  p_take_home numeric,
  p_account_id uuid,
  p_voucher_date date,
  p_note text,
  p_idempotency_key text,
  p_rent_invoice_id uuid default null,
  p_rent_amount numeric default null
)
returns json
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $function$
declare
  v_actor uuid := auth.uid();
  v_org uuid; v_building uuid; v_type uuid; v_membership uuid;
  v_authz boolean; v_key text; v_hash text;
  v_op app_private.canonical_write_operations%rowtype; v_route text;
  v_voucher uuid; v_req uuid; v_resp json;
  -- rent-offset locals
  v_rent_collect numeric := 0;
  v_inv record;
  v_income_type uuid;
  v_rent_res json := null;
  c_op constant text := 'salary.payout.v1';
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  v_key := btrim(coalesce(p_idempotency_key,''));
  if v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;
  if p_take_home is null or p_take_home <= 0 or round(p_take_home,2) <> p_take_home then
    raise exception 'Số tiền thực nhận không hợp lệ'; end if;
  if p_period_month is null then raise exception 'Kỳ lương trống'; end if;
  if p_rent_amount is not null and round(p_rent_amount,2) <> p_rent_amount then
    raise exception 'Tiền phòng khấu trừ không hợp lệ'; end if;

  -- R3-FIX (đồng bộ t5_11): org SUBJECT-DERIVED từ nhân viên nhận lương —
  -- KHÔNG global-scan toà ảo (đa tenant sẽ trỏ nhầm org). Toà ảo lấy TRONG org đó.
  select organization_id into v_org from public.manager_salary_config
   where staff_id = p_staff_id and organization_id is not null
   order by is_active desc, created_at desc limit 1;
  if v_org is null then
    select organization_id into v_org from public.organization_memberships
     where user_id = p_staff_id and status='ACTIVE' limit 1;
  end if;
  if v_org is null then raise exception 'Không xác định được tổ chức của nhân viên' using errcode='42501'; end if;
  select b.id into v_building
    from public.buildings b
    join public.organizations o on o.id=b.organization_id and o.status='ACTIVE'
   where b.organization_id = v_org and b.is_virtual=true and b.deleted_at is null
   order by b.created_at limit 1 for share of o,b;
  if v_building is null then raise exception 'Tổ chức chưa có toà ảo (Chung) để hạch toán phiếu lương' using errcode='55000'; end if;

  -- exact permission salary.distribute; require actor membership.
  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'salary.distribute', v_building, p_account_id);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền chi lương (salary.distribute)' using errcode='42501'; end if;
  select m.id into v_membership from public.organization_memberships m
   where m.user_id=v_actor and m.organization_id=v_org and m.status='ACTIVE' limit 1 for share;
  if v_membership is null then raise exception 'Không còn là thành viên tổ chức' using errcode='42501'; end if;

  -- idempotency (mở rộng hash: gồm cả rent để không nhầm "same key khác nội dung").
  v_hash := md5(jsonb_build_object('staff',p_staff_id,'period',p_period_month,
    'take_home',round(p_take_home,2),'org',v_org,
    'rent_invoice',p_rent_invoice_id,'rent_amount',round(coalesce(p_rent_amount,0),2))::text);
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, c_op, p_staff_id::text || '|' || p_period_month::text, v_actor, v_key, v_hash)
  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;
  select * into v_op from app_private.canonical_write_operations o
   where o.organization_id=v_org and o.operation=c_op
     and o.subject_scope=p_staff_id::text || '|' || p_period_month::text
     and o.actor_id=v_actor and o.idempotency_key=v_key for update;
  if v_op.payload_hash <> v_hash then raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;
  if v_op.completed_at is not null then return v_op.response_payload::json; end if;

  v_route := app_private.evaluate_feature_route(c_op, v_org);
  if v_route <> 'CANONICAL' then raise exception 'Writer chi lương chưa bật' using errcode='55000'; end if;

  -- org-scoped "Lương quản lý" expense type.
  select id into v_type from public.income_expense_types
   where organization_id=v_org and lower(type)='expense' and name='Lương quản lý' limit 1;
  if v_type is null then
    insert into public.income_expense_types (organization_id, name, type)
    values (v_org, 'Lương quản lý', 'expense') returning id into v_type; end if;

  -- create the salary EXPENSE voucher UNAPPROVED (force-approval — never self-approve).
  insert into public.income_expenses
    (user_id, organization_id, type, name, building_id, account_id, salary_staff_id,
     voucher_date, approval_status, business_result_accounting, notes, source_payload_hash)
  values (v_actor, v_org, 'EXPENSE', 'Chi lương', v_building, p_account_id, p_staff_id,
          p_voucher_date, 'UNAPPROVED', false, coalesce(p_note,'Chi lương'), v_hash)
  returning id into v_voucher;

  -- item #1: tiền thực nhận (net).
  insert into public.income_expense_items
    (income_expense_id, organization_id, income_expense_type_id, description, quantity, unit_price)
  values (v_voucher, v_org, v_type, 'Tiền thực nhận', 1, round(p_take_home,2));

  -- ── RENT-OFFSET (phương án A) — chuẩn bị + thêm dòng #2 TRƯỚC khi submit ──
  -- (submit_financial_request_v1 chốt snapshot = income_expenses.total_amount, nên
  --  dòng tiền phòng phải có trước để engine thấy đúng GROSS.)
  if p_rent_invoice_id is not null and coalesce(p_rent_amount,0) > 0 then
    -- đọc hoá đơn (record_invoice_payment_v3 sẽ tự re-lock + check quyền — xem P4).
    select id, organization_id, user_id, building_id, total_amount,
           coalesce(remaining_amount, total_amount) as remaining
      into v_inv
      from public.invoices
     where id = p_rent_invoice_id and deleted_at is null;
    if not found then
      raise exception 'Hoá đơn tiền phòng không tồn tại' using errcode='42501'; end if;

    -- P5: clamp về phần còn nợ (mirror legacy; tránh excess ngoài ý muốn).
    v_rent_collect := least(round(p_rent_amount,2), coalesce(v_inv.remaining,0));
    if v_rent_collect <= 0 then
      v_rent_collect := 0;  -- hết nợ → bỏ offset, phiếu chi = net như thường.
    else
      -- item #2: dòng tiền phòng khấu trừ ⇒ phiếu chi = gross.
      insert into public.income_expense_items
        (income_expense_id, organization_id, income_expense_type_id, description, quantity, unit_price)
      values (v_voucher, v_org, v_type, 'Tiền phòng (khấu trừ)', 1, v_rent_collect);
    end if;
  end if;

  -- submit to the approval engine as FORCE-APPROVAL: submit_financial_request_v1
  -- classifies + routes; a salary voucher is never AUTO_POST. It is left PENDING
  -- for a checker to decide (this writer does not approve). Submit fails closed
  -- if no ACTIVE rule set exists — that is a real configuration error, surface it.
  v_req := app_private.submit_financial_request_v1(v_voucher, v_membership, v_actor, v_key || '-sub');

  -- ── RENT-OFFSET: ghi phiếu THU đối ứng qua record_invoice_payment_v3 (chữ ký THẬT).
  -- Nó tạo payments(CT) + income_expenses(INCOME, APPROVED) + cập nhật hoá đơn. Chạy
  -- SAU submit, CÙNG transaction. Xem P3 (bất đối xứng) / P4 (quyền) / P6 (loại thu).
  if v_rent_collect > 0 then
    -- P6: loại thu (không phải cọc) theo ORG CỦA HOÁ ĐƠN.
    select t.id into v_income_type
      from public.income_expense_types t
     where t.organization_id = v_inv.organization_id
       and lower(t.type) = 'income'
       and coalesce(t.is_deposit,false) = false
     order by
       (t.is_default is true) desc,
       (public.nrm_vn(t.name) = 'thu tien hoa don') desc,   -- nrm_vn: đã verify tồn tại (dùng trong submit_financial_request_v1). TODO-REVIEW P6: xác nhận CHUỖI tên loại thu chuẩn của org.
       t.created_at
     limit 1;
    if v_income_type is null then
      raise exception 'Org hoá đơn chưa có loại thu (không phải cọc) cho phiếu đối ứng tiền phòng'
        using errcode='55000'; end if;

    v_rent_res := public.record_invoice_payment_v3(
      p_invoice_id       => p_rent_invoice_id,
      p_amount           => v_rent_collect,
      p_payment_method   => 'CT'::public.payment_method,
      p_payment_date     => p_voucher_date,
      p_idempotency_key  => v_key || '-rent',
      p_account_id       => p_account_id,
      p_notes            => 'Cấn trừ tiền phòng vào lương',
      p_receipt_image_url=> null,
      p_voucher          => jsonb_build_object(
                              'name', 'Thu tiền phòng (khấu trừ lương)',
                              'payer_name', 'Khấu trừ lương',
                              'notes', 'Cấn trừ tiền phòng vào lương',
                              'creator_name', 'Chi lương'),
      p_items            => jsonb_build_array(jsonb_build_object(
                              'income_expense_type_id', v_income_type,
                              'description', 'Thu tiền phòng (khấu trừ lương)',
                              'quantity', 1,
                              'unit_price', v_rent_collect,
                              'start_date', p_voucher_date::text,
                              'end_date', p_voucher_date::text)),
      p_receipt_number   => null,
      p_voucher_owner_id => v_inv.user_id   -- phải = chủ hoá đơn (writer tự assert).
    );
  end if;

  -- salary_monthly bookkeeping.
  --  • ensure row tồn tại (như bản gốc).
  --  • STAMP payout_voucher_id = phiếu chi vừa tạo (link xác định — xem P2).
  --  • paid: KHÔNG đụng ở đây (tiền chưa POST). Cơ chế accrual paid khi POST chưa
  --    tồn tại trong engine — xem P1. KHÔNG bịa.
  insert into public.salary_monthly (user_id, staff_id, period_month, payout_voucher_id, organization_id)
  values (v_actor, p_staff_id, p_period_month, v_voucher, v_org)
  on conflict (staff_id, period_month) do update set
    payout_voucher_id = excluded.payout_voucher_id,
    organization_id   = coalesce(public.salary_monthly.organization_id, excluded.organization_id);

  v_resp := json_build_object('salary_voucher_id', v_voucher, 'approval_request_id', v_req,
    'state', 'PENDING_APPROVAL',
    'rent_offset', case when v_rent_collect > 0
                        then json_build_object('collected', v_rent_collect, 'result', v_rent_res)
                        else null end);
  update app_private.canonical_write_operations
     set subject_id=v_voucher, response_payload=to_jsonb(v_resp), completed_at=now()
   where organization_id=v_org and operation=c_op
     and subject_scope=p_staff_id::text || '|' || p_period_month::text
     and actor_id=v_actor and idempotency_key=v_key;
  return v_resp;
end;
$function$;

revoke all on function public.salary_payout_v1(uuid, date, numeric, uuid, date, text, text, uuid, numeric) from public;
revoke all on function public.salary_payout_v1(uuid, date, numeric, uuid, date, text, text, uuid, numeric) from anon;
grant execute on function public.salary_payout_v1(uuid, date, numeric, uuid, date, text, text, uuid, numeric) to authenticated;

commit;

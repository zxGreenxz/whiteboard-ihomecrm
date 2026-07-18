-- t5_13_profit_money_writers_DRAFT.sql — Chi tiền domain PROFIT qua ENGINE DUYỆT (P1)
--
-- ⚠️ DRAFT — CHƯA APPLY PROD. Chờ review. Nền tảng: TRANCHE-PROFIT-SURVEY-2026-07-18.
--
-- BỐI CẢNH: 2 hook client còn "trần" (insert income_expenses trực tiếp, KHÔNG
-- idempotency → double-submit = double phiếu chi cổ đông/quản lý):
--   • useCreateProfitDistribution  (src/hooks/income-expenses/specialized.ts:10)
--   • useCreateManagerSalaryPayout  (specialized.ts:126)
-- Cả hai: EXPENSE trên toà ảo "Chung", business_result_accounting=false, 1 item →
-- trigger tính total_amount. Money-path CHƯA TỪNG chạy (0 phiếu) ⇒ canary rủi ro ~0.
--
-- OWNER ĐÃ CHỐT 2 FORK (survey mục "2 FORK cần owner"):
--   • FORK A: phiếu chi cổ đông/quản lý ÉP QUA submit_financial_request_v1 →
--     PENDING_APPROVAL (KHÔNG approved-ngay). Giống hệt salary_payout_v1.
--   • FORK B: TẠO PERMISSION MỚI 'shareholder_profit.pay_manager' (ELEVATED) cho
--     đường chi lương quản lý — KHÔNG reuse shareholder_profit.distribute, KHÔNG
--     mượn salary.distribute. Perm mới mirror cách 'shareholder_profit.distribute'
--     được khai; gán ALLOW cho MỌI role hiện có distribute ở CẢ 2 org (SELECT-derive).
--
-- KIẾN TRÚC (sibling của public.salary_payout_v1 — thế hệ org-model):
--   auth.uid() → resolve org → lock_org_for_decision_v1 → authorize_tenant_action_v3
--   → membership check → canonical_write_operations (idempotency) →
--   evaluate_feature_route (INERT tới khi bật flag) → tạo phiếu EXPENSE UNAPPROVED
--   → submit_financial_request_v1 → trả {state:'PENDING_APPROVAL'}.
--
-- KHÁC salary_payout_v1 CÓ CHỦ ĐÍCH (xem TODO-REVIEW ở cuối file):
--   [D1] Org resolve từ SUBJECT (shareholders/profit_managers.organization_id — prod
--        đo được org_null=0, tin cậy) rồi tìm toà ảo TRONG org đó. salary_payout_v1
--        quét toà ảo GLOBAL (RLS bypass trong SECURITY DEFINER) rồi lấy limit-1 →
--        vì chỉ org aaaa có toà ảo, salary_payout_v1 chỉ chạy được cho aaaa; org dddd
--        (có perm + 2 cổ đông) sẽ misroute/fail-closed. Subject-derived vá đúng chỗ
--        này + đa-tenant chuẩn (subject quyết org, actor phải có quyền TRONG org đó).
--   [D2] Vá latent bug của salary_payout_v1: nhánh tạo income_expense_types thiếu
--        user_id (cột NOT NULL, không default) → INSERT sẽ vỡ. Ở đây stamp user_id.
--   [D3] Không chạm profit_monthly/allocations (cash-out tách rời allocation, survey).
--
-- MIRROR PAYLOAD CLIENT (đọc kỹ 2 hook): voucher name suy từ note; NOTE nằm ở ITEM
-- description (KHÔNG phải voucher.notes); attachments=[], repeat_*=NONE/false/0;
-- item quantity=1, unit_price=amount, start/end=voucher_date. Bổ sung so với client
-- (canonical hardening): organization_id + source_payload_hash được stamp server-side.
--
-- INERT KÉP tới khi bật:
--   (1) evaluate_feature_route trả 'LEGACY' khi CHƯA có row server_feature_flags cho
--       operation-key → writer raise 'chưa bật'. File này KHÔNG tạo flag (để OFF).
--   (2) [TÙY REVIEW] có thể bỏ grant execute để inert kép như salary_payout_v1.

begin;

-- ============================================================================
-- 1) PERMISSION MỚI: shareholder_profit.pay_manager (FORK B)
--    Mirror y hệt cách 'shareholder_profit.distribute' được khai (ELEVATED,
--    TENANT, scope ORGANIZATION, ANY_MATCH, không cashbook-possession).
-- ============================================================================

insert into public.permission_definitions (
  key, resource, action, sensitivity,
  permission_domain, scope_kinds, is_active, scope_match_mode,
  requires_cashbook_possession, accepted_possession_kinds, required_dimensions
) values (
  'shareholder_profit.pay_manager', 'shareholder_profit', 'pay_manager', 'ELEVATED',
  'TENANT', array['ORGANIZATION']::text[], true, 'ANY_MATCH',
  false, array[]::text[], array[]::text[]
)
on conflict (key) do nothing;
-- Ghi chú: UNIQUE(resource, action) = ('shareholder_profit','pay_manager') là cặp
-- mới → không đụng constraint permission_definitions_resource_action_key.

-- Gán ALLOW cho MỌI (org, role) đang có 'shareholder_profit.distribute' — SELECT-derive,
-- KHÔNG hardcode role_id. Prod hiện: 2 org × 1 role/org = 2 grant. PK role_permissions
-- = (organization_id, role_id, permission_key) → on conflict do nothing (idempotent).
insert into public.role_permissions (organization_id, role_id, permission_key, effect)
select rp.organization_id, rp.role_id, 'shareholder_profit.pay_manager', 'ALLOW'
  from public.role_permissions rp
 where rp.permission_key = 'shareholder_profit.distribute'
   and rp.effect = 'ALLOW'
on conflict (organization_id, role_id, permission_key) do nothing;

-- ============================================================================
-- 2) distribute_shareholder_profit_v1 — CHI CHIA LỢI NHUẬN CỔ ĐÔNG
--    Quyền: shareholder_profit.distribute · flag-key: shareholder_profit.distribute.v1
-- ============================================================================

create or replace function public.distribute_shareholder_profit_v1(
  p_shareholder_id uuid,
  p_amount         numeric,
  p_account_id     uuid,
  p_voucher_date   date,
  p_note           text,
  p_idempotency_key text
)
returns json
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_org uuid; v_building uuid; v_type uuid; v_membership uuid;
  v_subject_name text;
  v_authz boolean; v_key text; v_hash text;
  v_op app_private.canonical_write_operations%rowtype; v_route text;
  v_voucher uuid; v_req uuid; v_name text; v_resp json;
  c_op constant text := 'shareholder_profit.distribute.v1';
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;

  -- Validate idempotency key + số tiền (mirror salary_payout_v1).
  v_key := btrim(coalesce(p_idempotency_key,''));
  if v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;
  if p_amount is null or p_amount <= 0 or round(p_amount,2) <> p_amount then
    raise exception 'Số tiền chia lợi nhuận không hợp lệ'; end if;
  -- Phiếu chi phải có sổ quỹ nguồn (money-movement). Chặt hơn salary_payout_v1.
  if p_account_id is null then
    raise exception 'Thiếu sổ quỹ để chi chia lợi nhuận' using errcode='42501'; end if;

  -- [D1] Org resolve từ SUBJECT (cổ đông). shareholders.organization_id prod đo được
  -- org_null=0 → tin cậy. RLS bị bypass trong SECURITY DEFINER nên PHẢI tự chốt org.
  select s.organization_id, coalesce(nullif(btrim(s.name),''), 'Cổ đông')
    into v_org, v_subject_name
    from public.shareholders s
   where s.id = p_shareholder_id and s.deleted_at is null
   for share;
  if not found or v_org is null then
    raise exception 'Không tìm thấy cổ đông hoặc cổ đông chưa gán tổ chức' using errcode='42501';
  end if;

  -- Toà ảo "Chung" TRONG org (org phải ACTIVE). Org chưa có toà ảo (vd dddd) → báo rõ,
  -- KHÔNG misroute sang org khác như global-scan của salary_payout_v1.
  select b.id into v_building
    from public.buildings b
    join public.organizations o on o.id = b.organization_id and o.status = 'ACTIVE'
   where b.organization_id = v_org and b.is_virtual = true and b.deleted_at is null
   order by b.created_at limit 1
   for share of o, b;
  if v_building is null then
    raise exception 'Tổ chức chưa có toà ảo (Chung) để hạch toán phiếu chia lợi nhuận' using errcode='55000';
  end if;

  -- Quyền chính xác shareholder_profit.distribute + membership ACTIVE của actor.
  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'shareholder_profit.distribute', v_building, p_account_id);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền chia lợi nhuận (shareholder_profit.distribute)' using errcode='42501'; end if;
  select m.id into v_membership from public.organization_memberships m
   where m.user_id=v_actor and m.organization_id=v_org and m.status='ACTIVE' limit 1 for share;
  if v_membership is null then raise exception 'Không còn là thành viên tổ chức' using errcode='42501'; end if;

  -- Idempotency: subject_scope = cổ đông (owner có thể chia nhiều lần → key phân biệt).
  v_hash := md5(jsonb_build_object(
    'shareholder', p_shareholder_id, 'amount', round(p_amount,2),
    'account', p_account_id, 'voucher_date', p_voucher_date, 'org', v_org)::text);
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, c_op, p_shareholder_id::text, v_actor, v_key, v_hash)
  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;
  select * into v_op from app_private.canonical_write_operations o
   where o.organization_id=v_org and o.operation=c_op and o.subject_scope=p_shareholder_id::text
     and o.actor_id=v_actor and o.idempotency_key=v_key for update;
  if v_op.payload_hash <> v_hash then
    raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;
  if v_op.completed_at is not null then return v_op.response_payload::json; end if;

  -- Gate flag (INERT tới khi có row server_feature_flags cho c_op).
  v_route := app_private.evaluate_feature_route(c_op, v_org);
  if v_route <> 'CANONICAL' then raise exception 'Writer chia lợi nhuận chưa bật' using errcode='55000'; end if;

  -- Tên người tạo (mirror creatorName client: full_name || email || 'Người dùng').
  select coalesce(nullif(btrim(full_name),''), nullif(btrim(email),''), 'Người dùng')
    into v_actor_name from public.profiles where id = v_actor;

  -- Hạng mục 'Chia lợi nhuận cổ đông' resolve/tạo THEO ORG. [D2] stamp user_id (vá
  -- latent bug salary_payout_v1). category='Chia lợi nhuận' mirror client hook.
  select id into v_type from public.income_expense_types
   where organization_id = v_org and lower(type) = 'expense' and name = 'Chia lợi nhuận cổ đông'
   order by created_at limit 1;
  if v_type is null then
    insert into public.income_expense_types
      (user_id, organization_id, name, type, category, is_default, is_deposit)
    values (v_actor, v_org, 'Chia lợi nhuận cổ đông', 'expense', 'Chia lợi nhuận', false, false)
    returning id into v_type;
  end if;

  -- Voucher name mirror client fallback-chain: note?.trim() || 'Chia lợi nhuận: <tên>'.
  v_name := coalesce(nullif(btrim(coalesce(p_note,'')),''), 'Chia lợi nhuận: ' || v_subject_name);

  -- Phiếu EXPENSE UNAPPROVED (KQKD=false, gắn shareholder_id). NOTE đi vào ITEM
  -- description (mirror client) — voucher.notes để null. source_payload_hash link op.
  insert into public.income_expenses (
    user_id, organization_id, creator_name, type, name,
    building_id, account_id, shareholder_id,
    business_result_accounting, approval_status, voucher_date,
    attachments, repeat_cycle, repeat_infinity, repeat_count, repeat_remaining,
    source_payload_hash
  ) values (
    v_actor, v_org, coalesce(v_actor_name,'Người dùng'), 'EXPENSE', v_name,
    v_building, p_account_id, p_shareholder_id,
    false, 'UNAPPROVED', p_voucher_date,
    '[]'::jsonb, 'NONE', false, 0, 0,
    v_hash
  ) returning id into v_voucher;

  -- 1 item → trigger tính amount = quantity*unit_price + total_amount trên phiếu.
  insert into public.income_expense_items (
    income_expense_id, organization_id, income_expense_type_id,
    description, quantity, unit_price, start_date, end_date
  ) values (
    v_voucher, v_org, v_type,
    nullif(btrim(coalesce(p_note,'')),''), 1, round(p_amount,2), p_voucher_date, p_voucher_date
  );

  -- FORK A: đẩy vào engine duyệt (FORCE-APPROVAL). Writer KHÔNG tự duyệt. submit_*
  -- fail-closed nếu org chưa có ACTIVE rule-set (lỗi cấu hình thật — để nổi).
  v_req := app_private.submit_financial_request_v1(v_voucher, v_membership, v_actor, v_key || '-sub');

  v_resp := json_build_object(
    'profit_voucher_id', v_voucher, 'approval_request_id', v_req,
    'shareholder_id', p_shareholder_id, 'state', 'PENDING_APPROVAL');
  update app_private.canonical_write_operations
     set subject_id=v_voucher, response_payload=to_jsonb(v_resp), completed_at=now()
   where organization_id=v_org and operation=c_op and subject_scope=p_shareholder_id::text
     and actor_id=v_actor and idempotency_key=v_key;
  return v_resp;
end;
$$;

revoke all on function public.distribute_shareholder_profit_v1(uuid, numeric, uuid, date, text, text) from public;
revoke all on function public.distribute_shareholder_profit_v1(uuid, numeric, uuid, date, text, text) from anon;
grant execute on function public.distribute_shareholder_profit_v1(uuid, numeric, uuid, date, text, text) to authenticated;

-- ============================================================================
-- 3) manager_salary_payout_v1 — CHI LƯƠNG QUẢN LÝ ĐIỀU HÀNH (sinh đôi #2)
--    Đường profit_manager_id · hạng mục 'Lương điều hành'
--    Quyền: shareholder_profit.pay_manager (FORK B) · flag: shareholder_profit.pay_manager.v1
-- ============================================================================

create or replace function public.manager_salary_payout_v1(
  p_manager_id     uuid,
  p_amount         numeric,
  p_account_id     uuid,
  p_voucher_date   date,
  p_note           text,
  p_idempotency_key text
)
returns json
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_org uuid; v_building uuid; v_type uuid; v_membership uuid;
  v_subject_name text;
  v_authz boolean; v_key text; v_hash text;
  v_op app_private.canonical_write_operations%rowtype; v_route text;
  v_voucher uuid; v_req uuid; v_name text; v_resp json;
  c_op constant text := 'shareholder_profit.pay_manager.v1';
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;

  v_key := btrim(coalesce(p_idempotency_key,''));
  if v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;
  if p_amount is null or p_amount <= 0 or round(p_amount,2) <> p_amount then
    raise exception 'Số tiền lương điều hành không hợp lệ'; end if;
  if p_account_id is null then
    raise exception 'Thiếu sổ quỹ để chi lương điều hành' using errcode='42501'; end if;

  -- [D1] Org resolve từ SUBJECT (quản lý). profit_managers.organization_id org_null=0.
  select m.organization_id, coalesce(nullif(btrim(m.name),''), 'Quản lý')
    into v_org, v_subject_name
    from public.profit_managers m
   where m.id = p_manager_id and m.deleted_at is null
   for share;
  if not found or v_org is null then
    raise exception 'Không tìm thấy quản lý hoặc quản lý chưa gán tổ chức' using errcode='42501';
  end if;

  select b.id into v_building
    from public.buildings b
    join public.organizations o on o.id = b.organization_id and o.status = 'ACTIVE'
   where b.organization_id = v_org and b.is_virtual = true and b.deleted_at is null
   order by b.created_at limit 1
   for share of o, b;
  if v_building is null then
    raise exception 'Tổ chức chưa có toà ảo (Chung) để hạch toán phiếu lương điều hành' using errcode='55000';
  end if;

  -- FORK B: quyền RIÊNG shareholder_profit.pay_manager.
  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'shareholder_profit.pay_manager', v_building, p_account_id);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền chi lương quản lý (shareholder_profit.pay_manager)' using errcode='42501'; end if;
  select m.id into v_membership from public.organization_memberships m
   where m.user_id=v_actor and m.organization_id=v_org and m.status='ACTIVE' limit 1 for share;
  if v_membership is null then raise exception 'Không còn là thành viên tổ chức' using errcode='42501'; end if;

  v_hash := md5(jsonb_build_object(
    'manager', p_manager_id, 'amount', round(p_amount,2),
    'account', p_account_id, 'voucher_date', p_voucher_date, 'org', v_org)::text);
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, c_op, p_manager_id::text, v_actor, v_key, v_hash)
  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;
  select * into v_op from app_private.canonical_write_operations o
   where o.organization_id=v_org and o.operation=c_op and o.subject_scope=p_manager_id::text
     and o.actor_id=v_actor and o.idempotency_key=v_key for update;
  if v_op.payload_hash <> v_hash then
    raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;
  if v_op.completed_at is not null then return v_op.response_payload::json; end if;

  v_route := app_private.evaluate_feature_route(c_op, v_org);
  if v_route <> 'CANONICAL' then raise exception 'Writer lương điều hành chưa bật' using errcode='55000'; end if;

  select coalesce(nullif(btrim(full_name),''), nullif(btrim(email),''), 'Người dùng')
    into v_actor_name from public.profiles where id = v_actor;

  -- Hạng mục 'Lương điều hành' (category 'Chia lợi nhuận' — mirror client hook).
  select id into v_type from public.income_expense_types
   where organization_id = v_org and lower(type) = 'expense' and name = 'Lương điều hành'
   order by created_at limit 1;
  if v_type is null then
    insert into public.income_expense_types
      (user_id, organization_id, name, type, category, is_default, is_deposit)
    values (v_actor, v_org, 'Lương điều hành', 'expense', 'Chia lợi nhuận', false, false)
    returning id into v_type;
  end if;

  v_name := coalesce(nullif(btrim(coalesce(p_note,'')),''), 'Lương điều hành: ' || v_subject_name);

  insert into public.income_expenses (
    user_id, organization_id, creator_name, type, name,
    building_id, account_id, profit_manager_id,
    business_result_accounting, approval_status, voucher_date,
    attachments, repeat_cycle, repeat_infinity, repeat_count, repeat_remaining,
    source_payload_hash
  ) values (
    v_actor, v_org, coalesce(v_actor_name,'Người dùng'), 'EXPENSE', v_name,
    v_building, p_account_id, p_manager_id,
    false, 'UNAPPROVED', p_voucher_date,
    '[]'::jsonb, 'NONE', false, 0, 0,
    v_hash
  ) returning id into v_voucher;

  insert into public.income_expense_items (
    income_expense_id, organization_id, income_expense_type_id,
    description, quantity, unit_price, start_date, end_date
  ) values (
    v_voucher, v_org, v_type,
    nullif(btrim(coalesce(p_note,'')),''), 1, round(p_amount,2), p_voucher_date, p_voucher_date
  );

  v_req := app_private.submit_financial_request_v1(v_voucher, v_membership, v_actor, v_key || '-sub');

  v_resp := json_build_object(
    'manager_salary_voucher_id', v_voucher, 'approval_request_id', v_req,
    'manager_id', p_manager_id, 'state', 'PENDING_APPROVAL');
  update app_private.canonical_write_operations
     set subject_id=v_voucher, response_payload=to_jsonb(v_resp), completed_at=now()
   where organization_id=v_org and operation=c_op and subject_scope=p_manager_id::text
     and actor_id=v_actor and idempotency_key=v_key;
  return v_resp;
end;
$$;

revoke all on function public.manager_salary_payout_v1(uuid, numeric, uuid, date, text, text) from public;
revoke all on function public.manager_salary_payout_v1(uuid, numeric, uuid, date, text, text) from anon;
grant execute on function public.manager_salary_payout_v1(uuid, numeric, uuid, date, text, text) to authenticated;

commit;

-- ============================================================================
-- TODO-REVIEW (chốt trước khi apply)
-- ============================================================================
-- [TR-1] ORG RESOLUTION (D1): file này derive org từ SUBJECT (shareholder/manager)
--        thay vì global virtual-building scan như salary_payout_v1. Lý do: prod chỉ
--        org aaaa có toà ảo, org dddd KHÔNG (đo được virt_buildings=0) nhưng dddd có
--        2 cổ đông + đã được ALLOW distribute. Global-scan sẽ khiến dddd bất khả
--        dụng/misroute. Owner xác nhận subject-derived là hướng đúng; NẾU muốn đồng
--        bộ tuyệt đối với salary_payout_v1 thì phải (a) đảm bảo MỖI org có 1 toà ảo,
--        và (b) cân nhắc vá salary_payout_v1 theo cùng subject/membership-derived.
-- [TR-2] TOÀ ẢO dddd: org dddd hiện raise '...chưa có toà ảo...'. Cần tạo toà ảo
--        "Chung" cho dddd (seed) TRƯỚC khi bật flag cho org đó, nếu không dddd không
--        chi được. (aaaa đã có 1 toà ảo → chạy được ngay.)
-- [TR-3] FEATURE FLAG (inert): CHƯA tạo row server_feature_flags cho
--        'shareholder_profit.distribute.v1' và 'shareholder_profit.pay_manager.v1'
--        → evaluate_feature_route trả LEGACY → writer raise 'chưa bật'. Khi build
--        nhịp bật: INSERT 2 flag (mode='OFF' ban đầu) + canary_orgs, mirror
--        salary.payout.v1. (Ngoài scope file quyền+writer này.)
-- [TR-4] GRANT vs INERT KÉP: file grant execute→authenticated (chuẩn như t5_10).
--        salary_payout_v1 cố tình CHƯA grant (inert kép). Nếu muốn cùng mức an toàn,
--        bỏ 2 dòng `grant execute ... to authenticated` — flag-gate vẫn chặn, nhưng
--        thêm 1 lớp. Owner chọn.
-- [TR-5] p_account_id BẮT BUỘC (chặt hơn salary_payout_v1 vốn không null-check).
--        Phiếu chi tiền phải có sổ quỹ nguồn. Nếu UX cho phép "chi phiếu nháp chưa
--        chọn sổ" (kiểu termination) thì nới thành nullable + bỏ authz possession.
-- [TR-6] VALIDATE SUBJECT: chỉ chặn deleted_at (không chặn is_active=false) — cho
--        phép chi tất toán cổ đông/quản lý đã ngừng hoạt động. Nếu nghiệp vụ cấm,
--        thêm `and is_active` vào 2 SELECT subject.
-- [TR-7] IDEMPOTENCY subject_scope = shareholder/manager id (KHÔNG kèm kỳ như salary
--        staff|period) vì profit chi nhiều lần/kỳ; mỗi lần chi hợp lệ phải truyền
--        idempotency_key MỚI. Client (wire sau) cần sinh key ổn định-per-intent
--        (vd hash amount+date+account+subject) để chống double-submit đúng nghĩa.
-- [TR-8] submit_financial_request_v1 fail-closed nếu org chưa có ACTIVE rule-set.
--        Survey nói rule-set ACTIVE cả 2 org (từ khảo sát salary) — verify lại cho
--        domain profit trước canary, để không vỡ ở bước submit.
-- [TR-9] GATE 0 PARITY: chạy audit authorize_tenant_action_v3('shareholder_profit
--        .distribute' & '.pay_manager') cho actor THẬT ở cả 2 org (authority-graph
--        có thể hẹp hơn RLS — bài học IE/salary) trước canary real-org.

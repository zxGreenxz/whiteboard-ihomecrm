-- t5_11_salary_lock_writers_DRAFT.sql — Chốt / Mở khoá lương tháng (P1/P2)  [DRAFT]
--
-- ⚠️ DRAFT — CHƯA APPLY LÊN PROD. Chờ review. Mọi điểm chưa chắc chắn được đánh
--    dấu "-- TODO-REVIEW:" ngay tại chỗ (KHÔNG bịa hành vi/tên cột).
--
-- BỐI CẢNH (khảo sát docs/authorization/TRANCHE-SALARY-SURVEY-2026-07-18.md §1,§4):
--   useLockSalaryMonth (useManagerSalary.ts:635) là cascade client KHÔNG atomic:
--     (1) bulk RAW UPDATE income_expenses.approval_status='APPROVED' cho phiếu hoa
--         hồng CHƯA DUYỆT (bỏ qua approve_income_expense_v1/approve_voucher — không
--         qua permission-per-voucher, không audit, sẽ VỠ khi hoa hồng lên canonical
--         vì guard freeze chặn raw UPDATE),
--     (2) upsert salary_monthly LOCKED (đóng băng con số),
--     (3) snapshot salary_work_ledger_snapshot (đóng băng bảng kê).
--   Đứt giữa chừng: phiếu đã duyệt nhưng tháng chưa chốt (hoặc ngược lại).
--   useUnlockSalaryMonth (:725): xoá snapshot + salary_monthly→DRAFT; KHÔNG hoàn
--   tác duyệt hoa hồng (bất đối xứng — xem ghi chú unlock bên dưới).
--
-- QUYẾT ĐỊNH OWNER 2026-07-18 (fork domain salary đã chốt): payout đi qua ENGINE
--   DUYỆT (t5_12); lock/unlock KHÔNG dính engine duyệt — chỉ là "đóng băng / mở
--   băng" bảng lương + đồng bộ trạng thái duyệt của phiếu hoa hồng đang tính.
--
-- THIẾT KẾ lock_salary_month_v1 (atomic, all-or-nothing trong 1 transaction):
--   • Quyền: authorize_tenant_action_v3(actor, org, 'salary.lock', …) — org suy từ
--     toà ảo "chung" GIỐNG salary_payout_v1 (salary là quyết định cấp tổ chức).
--   • Duyệt phiếu hoa hồng QUA WRITER, KHÔNG raw UPDATE:
--       - Thử public.approve_income_expense_v1(id) (đường canonical, có audit +
--         transition-token + permission-per-voucher).
--       - Nếu phiếu là row LEGACY (chưa flow-owned) → approve_income_expense_v1 ném
--         55000 'chưa thuộc luồng canonical' → BẮT và fallback nội-bộ sang
--         public.approve_voucher(id) (đường legacy). Đây là hành vi ĐÚNG cho 68
--         phiếu hoa hồng legacy hiện tại (survey §3).
--   • Đóng băng: upsert salary_monthly LOCKED + xoá/ghi lại snapshot bảng kê.
--   • Guard DRAFT→LOCKED: staff đã LOCKED cho kỳ → bỏ qua (idempotent no-op).
--   • Idempotency toàn-mẻ qua app_private.canonical_write_operations (mirror
--     salary_payout_v1) → retry an toàn.
--   • Feature-route gate 'salary.lock.v1' (mirror payout): flag OFF → ném 55000
--     'chưa bật' để hook fallback sang lock legacy (isCanonicalFallbackSignal).
--
-- unlock_salary_month_v1 (đối xứng): quyền 'salary.unlock'; xoá snapshot +
--   salary_monthly LOCKED→DRAFT (locked_at/by=null). CỐ Ý KHÔNG hoàn tác duyệt
--   hoa hồng: khi chốt, phiếu hoa hồng đã đi qua ENGINE DUYỆT / approve_voucher —
--   trở thành trạng thái tiền THẬT (đã duyệt = đã tính vào sổ). "Mở khoá" chỉ là
--   MỞ LẠI phần tính-toán lương để sửa, KHÔNG phải rollback kế toán; đảo ngược
--   duyệt phải qua writer reverse/hủy chuyên biệt + quyết định kế toán riêng.
--   → giữ nguyên bất đối xứng của legacy, có chủ đích (ghi rõ ở đây).
--
-- MIRROR CỘT (đọc thẳng hook — schema verified read-only prod):
--   salary_monthly(upsert): user_id, staff_id, period_month, status, base_salary,
--     work_bonus, contract_bonus, commission_total, investment_profit,
--     adjustments_total, advances_total, room_rent, gross_total, take_home, paid,
--     locked_at, locked_by  [onConflict (staff_id,period_month)].
--   salary_work_ledger_snapshot(insert): user_id, salary_monthly_id, staff_id,
--     item_type, source_id, occurred_date, day_label, content, place,
--     job_type_name, is_repair, is_contract, base_amount, weekend_amount,
--     after_amount, cash_amount, has_photo, bonus_amount, reason.
--
-- TODO-REVIEW (tổng hợp — đọc kỹ trước khi apply):
--  R1. TIN SỐ CLIENT: các con số lương (base_salary…take_home) + rows bảng kê do
--      CLIENT tính (lib/managerSalary salCalc, phụ thuộc engine legacy/v5, bonus
--      rules…). Writer KHÔNG tính lại (logic ở TS, không port sang SQL trong nhịp
--      này). Lock là thao tác "đóng băng snapshot" (salary_* không có guard tiền
--      thật — tiền thật ở income_expenses/payments). Chốt an toàn nếu owner chấp
--      nhận writer đóng-băng-số-client + gate quyền. Reviewer xác nhận có chấp nhận
--      không, hay cần server-side recompute.
--  R2. OWNER (salary_monthly.user_id): derive server-side từ manager_salary_config
--      .user_id của staff (mirror hook ownerId=configs[0].user_id). Fallback
--      super_admins nếu không có config → xác nhận fallback đúng?
--  R3. ORG resolution qua toà ảo "chung" limit 1 (mirror salary_payout_v1): nếu
--      quản lý trải NHIỀU org, cần resolve org theo từng staff. Population=2 hiện
--      tại an toàn.
--  R4. PARITY duyệt hoa hồng CHẶT HƠN legacy: approve_income_expense_v1 &
--      approve_voucher đều ĐÒI account_id (sổ quỹ) + permission-per-voucher. Raw
--      UPDATE legacy KHÔNG đòi. ⇒ phiếu hoa hồng CHƯA có sổ quỹ sẽ làm LOCK FAIL
--      (trước đây chạy). Đây là hardening có chủ đích nhưng cần owner xác nhận
--      (có thể cần bước gán sổ quỹ cho phiếu hoa hồng trước khi chốt).
--  R5. LEGACY resurrect CANCELLED: raw UPDATE legacy dùng .neq('APPROVED') nên vô
--      tình DUYỆT LẠI cả phiếu CANCELLED. Writer CỐ Ý bỏ qua CANCELLED (chỉ duyệt
--      UNAPPROVED). Xác nhận divergence này đúng (không hồi sinh phiếu đã huỷ).
--  R6. organization_id trên salary_monthly & snapshot: legacy để NULL; writer set
--      = v_org (forward-compat org-scope). Xác nhận không phá RLS *_owner_all /
--      *_self_select (survey §3: scope theo user_id, chưa org-scoped).
--  R7. paid trên upsert: mirror hook (ghi đè bằng số client). Rủi ro CLOBBER nếu
--      payout (t5_12) vừa tăng paid rồi lock ghi đè lại số cũ. Cân nhắc: lock KHÔNG
--      đụng paid (giữ nguyên giá trị đang có). Chờ owner.
--  R8. Feature-flag rows: cần SEED app_private.server_feature_flags +
--      server_feature_flag_operations cho 'salary.lock.v1'/'salary.unlock.v1'
--      TRƯỚC khi bật (đây là DATA, không nằm trong DDL này). Chưa seed → writer
--      luôn ném 'chưa bật' → hook chạy legacy (an toàn, đúng ý đồ canary).
--  R9. GRANT: writer nhận MỌI grant authenticated (như lifecycle IE); authority
--      thật do authorize_tenant_action_v3 quyết. Audit parity salary.lock/unlock
--      cho actor thật (survey §5 GATE 0) làm trước khi canary real-org.
--  R10. v5_apply_lock_adjustments (engine v5) là MẢNG KHÁC (ghi salary_adjustments
--      ATTEND_V5/STREAK_V5, KHÔNG set LOCKED/snapshot/duyệt HH). Writer này KHÔNG
--      gọi nó (lock legacy cũng không). Xác nhận không cần orchestrate chung.

begin;

-- =========================================================================
-- lock_salary_month_v1 — Chốt lương tháng (DRAFT→LOCKED), atomic
--   p_managers: JSON array, mỗi phần tử = 1 quản lý:
--     {
--       "staff_id": uuid,
--       "base_salary": num, "work_bonus": num, "contract_bonus": num,
--       "commission_total": num, "investment_profit": num,
--       "adjustments_total": num, "advances_total": num, "room_rent": num,
--       "gross_total": num, "take_home": num, "paid": num,
--       "commission_voucher_ids": [uuid, …],   -- phiếu hoa hồng cần duyệt khi chốt
--       "ledger": [ { item_type, source_id, occurred_date, day_label, content,
--                     place, job_type_name, is_repair, is_contract, base_amount,
--                     weekend_amount, after_amount, cash_amount, has_photo,
--                     bonus_amount, reason }, … ]   -- rows đóng băng bảng kê
--     }
-- =========================================================================
create or replace function public.lock_salary_month_v1(
  p_period_month date,
  p_managers jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_building uuid;
  v_authz boolean;
  v_key text;
  v_hash text;
  v_op app_private.canonical_write_operations%rowtype;
  v_route text;
  c_op constant text := 'salary.lock.v1';
  v_now timestamptz := now();
  v_mgr jsonb;
  v_staff uuid;
  v_owner uuid;
  v_monthly_id uuid;
  v_cur_status text;
  v_ledger jsonb;
  v_vid uuid;
  v_v_status text;
  v_v_owned boolean;
  v_locked_count int := 0;
  v_approved_count int := 0;
  v_resp json;
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;

  v_key := btrim(coalesce(p_idempotency_key,''));
  if v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;
  if p_period_month is null then raise exception 'Kỳ lương trống'; end if;
  if p_managers is null or jsonb_typeof(p_managers) <> 'array' then
    raise exception 'p_managers phải là JSON array'; end if;

  -- R3-FIX: org SUBJECT-DERIVED (không global-scan toà ảo — sai đa tenant). Org =
  -- tổ chức của nhân viên ĐẦU TIÊN trong p_managers (qua manager_salary_config →
  -- fallback organization_memberships); MỌI nhân viên phải cùng org đó.
  declare
    v_first_staff uuid := nullif(p_managers->0->>'staff_id','')::uuid;
  begin
    if v_first_staff is null then raise exception 'p_managers rỗng hoặc thiếu staff_id'; end if;
    select organization_id into v_org from public.manager_salary_config
     where staff_id = v_first_staff and organization_id is not null
     order by is_active desc, created_at desc limit 1;
    if v_org is null then
      select organization_id into v_org from public.organization_memberships
       where user_id = v_first_staff and status='ACTIVE' limit 1;
    end if;
    if v_org is null then raise exception 'Không xác định được tổ chức của nhân viên'; end if;
    -- mọi staff còn lại phải cùng org
    if exists (
      select 1 from jsonb_array_elements(p_managers) mg
      where nullif(mg->>'staff_id','')::uuid is not null
        and not exists (
          select 1 from public.organization_memberships m2
           where m2.user_id = (mg->>'staff_id')::uuid and m2.organization_id = v_org and m2.status='ACTIVE')
    ) then
      raise exception 'Danh sách nhân viên chứa người khác tổ chức' using errcode='42501';
    end if;
  end;
  -- toà ảo của CHÍNH org đó (tham số scope cho authorize)
  select b.id into v_building
    from public.buildings b join public.organizations o on o.id=b.organization_id and o.status='ACTIVE'
   where b.organization_id = v_org and b.is_virtual=true and b.deleted_at is null
   order by b.created_at limit 1 for share of o,b;

  perform app_private.lock_org_for_decision_v1(v_org);

  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'salary.lock', v_building, null);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền chốt lương (salary.lock)' using errcode='42501'; end if;

  -- idempotency toàn-mẻ (mirror salary_payout_v1)
  v_hash := md5(jsonb_build_object('period',p_period_month,'org',v_org,'managers',p_managers)::text);
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, c_op, p_period_month::text, v_actor, v_key, v_hash)
  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;
  select * into v_op from app_private.canonical_write_operations o
   where o.organization_id=v_org and o.operation=c_op and o.subject_scope=p_period_month::text
     and o.actor_id=v_actor and o.idempotency_key=v_key for update;
  if v_op.payload_hash <> v_hash then
    raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;
  if v_op.completed_at is not null then return v_op.response_payload::json; end if;

  v_route := app_private.evaluate_feature_route(c_op, v_org);
  if v_route <> 'CANONICAL' then
    raise exception 'Writer chốt lương chưa bật' using errcode='55000'; end if;

  -- ═══ D2b — GUARD 1: LỢI NHUẬN THÁNG PHẢI CHỐT TRƯỚC (insight owner) ═══
  -- Phần "đầu tư" trong lương lấy từ chốt lợi nhuận tháng; nếu tháng đó còn
  -- profit_monthly ở DRAFT thì số đầu tư chưa chuẩn → CHẶN, buộc chốt LN trước.
  -- Chỉ áp khi org CÓ dữ liệu lợi nhuận cho kỳ (không có → bỏ qua, org không dùng).
  if exists (
    select 1 from public.profit_monthly pm
     where pm.organization_id = v_org
       and pm.period_month = p_period_month
       and pm.status <> 'LOCKED'
  ) then
    raise exception 'Phải CHỐT LỢI NHUẬN tháng % trước khi chốt lương (phần đầu tư trong lương lấy từ đó)',
      to_char(p_period_month, 'MM/YYYY') using errcode = '55000';
  end if;

  -- ═══ D2b — GUARD 2: PHIẾU HOA HỒNG THIẾU SỔ QUỸ (liệt kê rõ) ═══
  -- Duyệt hoa hồng qua writer chuẩn ĐÒI sổ quỹ. Thay vì fail giữa chừng khó hiểu,
  -- quét trước MỌI phiếu HH sẽ-được-duyệt còn thiếu account_id → báo danh sách mã
  -- phiếu để kế toán bổ sung, KHÔNG chốt tới khi đủ.
  declare
    v_missing text;
  begin
    select string_agg(coalesce(ie.code, left(ie.id::text,8)), ', ' order by ie.code)
      into v_missing
      from public.income_expenses ie
     where ie.deleted_at is null
       and ie.approval_status = 'UNAPPROVED'
       and ie.account_id is null
       and ie.id in (
         select e.value::uuid
           from jsonb_array_elements(p_managers) as mgr(value)
                cross join lateral
                  jsonb_array_elements_text(coalesce(mgr.value->'commission_voucher_ids','[]'::jsonb)) as e(value)
         where e.value is not null and e.value <> ''
       );
    if v_missing is not null then
      raise exception 'Các phiếu hoa hồng sau CHƯA CHỌN SỔ QUỸ — bổ sung rồi mới chốt được: %', v_missing
        using errcode = '55000';
    end if;
  end;

  -- 1) Duyệt phiếu hoa hồng (dedupe toàn bộ managers) — QUA writer, KHÔNG raw UPDATE.
  for v_vid in
    select distinct e.value::uuid
      from jsonb_array_elements(p_managers) as mgr(value)
           cross join lateral
             jsonb_array_elements_text(coalesce(mgr.value->'commission_voucher_ids','[]'::jsonb)) as e(value)
  loop
    if v_vid is null then continue; end if;
    select ie.approval_status, app_private.is_income_expense_flow_owned(ie.id)
      into v_v_status, v_v_owned
      from public.income_expenses ie
     where ie.id = v_vid and ie.deleted_at is null;
    if not found then
      -- TODO-REVIEW R5: phiếu không tồn tại/đã xoá → bỏ qua (legacy .in() cũng no-op).
      continue;
    end if;
    if v_v_status in ('APPROVED','CANCELLED') then
      continue; -- chỉ duyệt UNAPPROVED (bỏ qua đã duyệt / đã huỷ — xem R5)
    end if;

    -- Branch theo CHÍNH predicate mà approve_income_expense_v1 dùng nội bộ
    -- (is_income_expense_flow_owned) — deterministic, không dựa vào so khớp chuỗi
    -- thông báo lỗi. Row canonical → writer canonical; row legacy → approve_voucher.
    -- Mọi lỗi quyền/sổ-quỹ từ 2 writer con đều PROPAGATE (fail-closed) — xem R4.
    if v_v_owned then
      perform public.approve_income_expense_v1(v_vid);
    else
      perform public.approve_voucher(v_vid);
    end if;
    v_approved_count := v_approved_count + 1;
  end loop;

  -- 2) Đóng băng từng quản lý: guard DRAFT→LOCKED, upsert LOCKED, re-snapshot.
  for v_mgr in select value from jsonb_array_elements(p_managers) loop
    v_staff := nullif(v_mgr->>'staff_id','')::uuid;
    if v_staff is null then raise exception 'Thiếu staff_id trong p_managers'; end if;

    -- owner (mirror hook ownerId). TODO-REVIEW R2.
    select user_id into v_owner
      from public.manager_salary_config
     where staff_id = v_staff and is_active = true
       and effective_from <= p_period_month
       and (effective_to is null or effective_to >= p_period_month)
     order by created_at limit 1;
    if v_owner is null then
      select user_id into v_owner from public.super_admins order by created_at limit 1;
    end if;
    if v_owner is null then
      raise exception 'Không xác định được chủ bảng lương cho nhân viên %', v_staff; end if;

    -- guard DRAFT→LOCKED (idempotent: đã LOCKED → bỏ qua)
    select id, status into v_monthly_id, v_cur_status
      from public.salary_monthly
     where staff_id = v_staff and period_month = p_period_month
     for update;
    if v_cur_status = 'LOCKED' then
      continue; -- TODO-REVIEW: re-lock có cần re-snapshot lại không? Hiện no-op.
    end if;

    -- upsert LOCKED — MIRROR cột hook (R1: tin số client; R7: paid clobber; R6: org).
    insert into public.salary_monthly (
      user_id, staff_id, period_month, status, base_salary, work_bonus,
      contract_bonus, commission_total, investment_profit, adjustments_total,
      advances_total, room_rent, gross_total, take_home, paid,
      locked_at, locked_by, organization_id
    ) values (
      v_owner, v_staff, p_period_month, 'LOCKED',
      coalesce((v_mgr->>'base_salary')::numeric, 0),
      coalesce((v_mgr->>'work_bonus')::numeric, 0),
      coalesce((v_mgr->>'contract_bonus')::numeric, 0),
      coalesce((v_mgr->>'commission_total')::numeric, 0),
      coalesce((v_mgr->>'investment_profit')::numeric, 0),
      coalesce((v_mgr->>'adjustments_total')::numeric, 0),
      coalesce((v_mgr->>'advances_total')::numeric, 0),
      coalesce((v_mgr->>'room_rent')::numeric, 0),
      coalesce((v_mgr->>'gross_total')::numeric, 0),
      coalesce((v_mgr->>'take_home')::numeric, 0),
      coalesce((v_mgr->>'paid')::numeric, 0),
      v_now, v_actor, v_org
    )
    on conflict (staff_id, period_month) do update set
      user_id           = excluded.user_id,
      status            = 'LOCKED',
      base_salary       = excluded.base_salary,
      work_bonus        = excluded.work_bonus,
      contract_bonus    = excluded.contract_bonus,
      commission_total  = excluded.commission_total,
      investment_profit = excluded.investment_profit,
      adjustments_total = excluded.adjustments_total,
      advances_total    = excluded.advances_total,
      room_rent         = excluded.room_rent,
      gross_total       = excluded.gross_total,
      take_home         = excluded.take_home,
      paid              = excluded.paid,   -- TODO-REVIEW R7
      locked_at         = v_now,
      locked_by         = v_actor,
      organization_id   = coalesce(public.salary_monthly.organization_id, excluded.organization_id)
    returning id into v_monthly_id;

    -- re-snapshot bảng kê (xoá cũ + ghi lại) — MIRROR cột hook.
    delete from public.salary_work_ledger_snapshot where salary_monthly_id = v_monthly_id;
    v_ledger := coalesce(v_mgr->'ledger', '[]'::jsonb);
    if jsonb_typeof(v_ledger) = 'array' and jsonb_array_length(v_ledger) > 0 then
      insert into public.salary_work_ledger_snapshot (
        user_id, salary_monthly_id, staff_id, item_type, source_id, occurred_date,
        day_label, content, place, job_type_name, is_repair, is_contract,
        base_amount, weekend_amount, after_amount, cash_amount, has_photo,
        bonus_amount, reason, organization_id
      )
      select
        v_owner, v_monthly_id, v_staff,
        r->>'item_type',                              -- NOT NULL: client luôn cấp (R1)
        nullif(r->>'source_id','')::uuid,
        nullif(r->>'occurred_date','')::date,
        r->>'day_label', r->>'content', r->>'place', r->>'job_type_name',
        (r->>'is_repair')::boolean, (r->>'is_contract')::boolean,
        nullif(r->>'base_amount','')::numeric,
        nullif(r->>'weekend_amount','')::numeric,
        nullif(r->>'after_amount','')::numeric,
        nullif(r->>'cash_amount','')::numeric,
        (r->>'has_photo')::boolean,
        nullif(r->>'bonus_amount','')::numeric,
        r->>'reason', v_org
      from jsonb_array_elements(v_ledger) as t(r);
    end if;

    v_locked_count := v_locked_count + 1;
  end loop;

  v_resp := json_build_object(
    'period_month', p_period_month,
    'locked_count', v_locked_count,
    'commission_approved', v_approved_count,
    'state', 'LOCKED');
  -- Ledger-guard đòi set subject_id+response_payload+completed_at CÙNG LÚC.
  -- subject_id = bản ghi lương cuối cùng đã khoá (đại diện; luôn ≥1 do guard).
  update app_private.canonical_write_operations
     set subject_id = coalesce(v_monthly_id, v_actor),
         response_payload = to_jsonb(v_resp), completed_at = now()
   where organization_id=v_org and operation=c_op and subject_scope=p_period_month::text
     and actor_id=v_actor and idempotency_key=v_key;
  return v_resp;
end;
$$;

revoke all on function public.lock_salary_month_v1(date, jsonb, text) from public;
revoke all on function public.lock_salary_month_v1(date, jsonb, text) from anon;
grant execute on function public.lock_salary_month_v1(date, jsonb, text) to authenticated;

-- =========================================================================
-- unlock_salary_month_v1 — Mở khoá lương tháng (LOCKED→DRAFT), đối xứng.
--   CỐ Ý KHÔNG hoàn tác duyệt hoa hồng (xem header). Quyền salary.unlock.
-- =========================================================================
create or replace function public.unlock_salary_month_v1(
  p_period_month date,
  p_staff_ids uuid[],
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_building uuid;
  v_authz boolean;
  v_key text;
  v_hash text;
  v_op app_private.canonical_write_operations%rowtype;
  v_route text;
  c_op constant text := 'salary.unlock.v1';
  v_ids uuid[];
  v_unlocked_count int := 0;
  v_resp json;
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;

  v_key := btrim(coalesce(p_idempotency_key,''));
  if v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;
  if p_period_month is null then raise exception 'Kỳ lương trống'; end if;
  if p_staff_ids is null or array_length(p_staff_ids,1) is null then
    raise exception 'Danh sách nhân viên trống'; end if;

  -- R3-FIX: org subject-derived từ nhân viên đầu tiên (đồng bộ lock).
  select organization_id into v_org from public.organization_memberships
   where user_id = p_staff_ids[1] and status='ACTIVE' limit 1;
  if v_org is null then
    select organization_id into v_org from public.manager_salary_config
     where staff_id = p_staff_ids[1] and organization_id is not null order by created_at desc limit 1;
  end if;
  if v_org is null then raise exception 'Không xác định được tổ chức của nhân viên'; end if;
  select b.id into v_building from public.buildings b
    join public.organizations o on o.id=b.organization_id and o.status='ACTIVE'
   where b.organization_id = v_org and b.is_virtual=true and b.deleted_at is null
   order by b.created_at limit 1 for share of o,b;

  perform app_private.lock_org_for_decision_v1(v_org);

  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'salary.unlock', v_building, null);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền mở khoá lương (salary.unlock)' using errcode='42501'; end if;

  v_hash := md5(jsonb_build_object('period',p_period_month,'org',v_org,
                                   'staff', to_jsonb(p_staff_ids))::text);
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, c_op, p_period_month::text, v_actor, v_key, v_hash)
  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;
  select * into v_op from app_private.canonical_write_operations o
   where o.organization_id=v_org and o.operation=c_op and o.subject_scope=p_period_month::text
     and o.actor_id=v_actor and o.idempotency_key=v_key for update;
  if v_op.payload_hash <> v_hash then
    raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;
  if v_op.completed_at is not null then return v_op.response_payload::json; end if;

  v_route := app_private.evaluate_feature_route(c_op, v_org);
  if v_route <> 'CANONICAL' then
    raise exception 'Writer mở khoá lương chưa bật' using errcode='55000'; end if;

  -- Chỉ mở các dòng đang LOCKED cho (kỳ, staff_ids) — guard LOCKED→DRAFT.
  -- (array_agg + FOR UPDATE không đi cùng → lock rows ở statement riêng trước.)
  perform 1 from public.salary_monthly
   where period_month = p_period_month and staff_id = any(p_staff_ids) and status = 'LOCKED'
   for update;
  select array_agg(id) into v_ids
    from public.salary_monthly
   where period_month = p_period_month
     and staff_id = any(p_staff_ids)
     and status = 'LOCKED';

  if v_ids is not null and array_length(v_ids,1) is not null then
    delete from public.salary_work_ledger_snapshot where salary_monthly_id = any(v_ids);
    update public.salary_monthly
       set status = 'DRAFT', locked_at = null, locked_by = null
     where id = any(v_ids);
    v_unlocked_count := array_length(v_ids,1);
  end if;
  -- CỐ Ý: KHÔNG đảo ngược duyệt hoa hồng (xem header). Không đụng income_expenses.

  v_resp := json_build_object(
    'period_month', p_period_month,
    'unlocked_count', v_unlocked_count,
    'state', 'DRAFT');
  update app_private.canonical_write_operations
     set subject_id = coalesce(v_ids[1], v_actor),
         response_payload = to_jsonb(v_resp), completed_at = now()
   where organization_id=v_org and operation=c_op and subject_scope=p_period_month::text
     and actor_id=v_actor and idempotency_key=v_key;
  return v_resp;
end;
$$;

revoke all on function public.unlock_salary_month_v1(date, uuid[], text) from public;
revoke all on function public.unlock_salary_month_v1(date, uuid[], text) from anon;
grant execute on function public.unlock_salary_month_v1(date, uuid[], text) to authenticated;

commit;

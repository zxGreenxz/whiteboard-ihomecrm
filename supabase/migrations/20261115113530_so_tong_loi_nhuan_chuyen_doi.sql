-- =============================================================================
-- Sổ tổng lợi nhuận cổ đông — ĐỢT 3a: CHUYỂN ĐỔI DỮ LIỆU (chạy được khi web còn bản Đợt 2).
--
-- VÌ SAO
--   Đợt 1 (20261115063149 … 20261115084108) dựng sổ tổng nhưng để công tắc
--   shareholder_profit.ledger_payout.v1 ở OFF. Trước khi bật chi theo sổ tổng (Đợt 3b) phải đưa
--   lịch sử về đúng sổ: phần lợi nhuận đã trả kèm phiếu lương cũ, bốn phiếu chia lợi nhuận cũ đang
--   bị tính là chi phí, lệnh chi lợi nhuận kiểu cũ, và mốc "đã trả đủ" theo quyết định của chủ.
--
-- LÀM GÌ (theo thứ tự; cả file là MỘT giao dịch — hỏng ở đâu cũng lùi sạch)
--   0. Tiền kiểm: nền Đợt 1 có đủ; khoá công ty (thứ tự G v2: công ty trước); chọn người ghi = tài
--      khoản có vai TENANT_OWNER kích hoạt sớm nhất (organization_memberships.activated_at) và phải
--      đang có quyền shareholder_profit.distribute + pay_manager; dấu vân tay đầu vào số dư (phân bổ
--      đã chốt + phiếu chi còn sống của từng chủ thể) phải khớp số đã đo ngoài Git.
--   X1. Công tắc OFF → SHADOW qua app_private.set_feature_route_v1 (CAS theo config_version đọc lúc
--      chạy; SHADOW không cần danh tính phát hành). Ở SHADOW chủ đặt được mốc, xem sổ; chưa ai chi
--      được theo sổ tổng.
--   X2. Ghi bù phần lợi nhuận đầu tư đã trả kèm phiếu lương ĐÃ DUYỆT của nhân viên là cổ đông
--      (app_private.profit_ledger_luong_backfill_v1). Số lấy từ chính phiếu lương: bảng lương LOCKED ⇒
--      salary_monthly.investment_profit; bảng nháp ⇒ phân bổ của các toà đã chốt TRƯỚC giờ lập phiếu
--      (salary_investment_profit_v1(…, created_at)); trừ phần các phiếu trước cùng tháng đã ghi; kẹp
--      bởi tổng tiền phiếu ("tiền thực nhận" = income_expenses.total_amount). Trừ tạm ứng = 0. Phiếu
--      lương còn chờ duyệt KHÔNG ghi bù (quyết định chủ 15/11/2026) — tập chờ duyệt cũng được ghim.
--   X3. Bốn phiếu chia lợi nhuận cũ ở toà ảo → business_result_accounting = false (ra khỏi KQKD).
--      Tiền và bút toán không đổi. Tạm tắt ĐÍCH DANH a02_ie_profit_lock_upd và
--      a00_ie_owned_payload_freeze trong giao dịch rồi bật lại ngay (không dùng
--      session_replication_role). recompute_ie_business_result tính lại has_restricted_item của hai
--      phiếu từ false sang true (hạng mục "chia lợi nhuận" là hạng mục hạn chế) — hậu kiểm cho phép
--      đúng giá trị tính lại đó, không cột nào khác.
--   X4. REVOKE EXECUTE public.distribute_shareholder_profit_v1 khỏi authenticated (đóng lệnh chi cũ).
--   Mốc. "Đã trả đủ" bằng app_private.profit_ledger_tao_set_marker_v1 (actor = người ghi ở bước 0):
--      hai cổ đông qua 2026-09, hai người nhận lương điều hành có số dư qua 2026-05; xác nhận xoá tạm
--      ứng = false (mốc nào xoá dấu tạm ứng thì migration dừng).
--   Z. Hậu kiểm số dư: chủ thể có mốc chỉ còn phần sau mốc (hiện là 0); mọi chủ thể khác không đổi.
--
-- ĐIỀU KIỆN ÁP (người điều phối kiểm — migration không tự đo được):
--   - Web production đã là bản Đợt 2, KHÔNG còn gọi distribute_shareholder_profit_v1
--     (src/hooks/income-expenses/specialized.ts). Trước đó X4 làm nút chi cũ trả 42501 thay vì 55000.
--   - Đo lại các dấu vân tay ngay trước khi áp (truy vấn chỉ đọc; DETAIL của lỗi 55000 có md5 expected/actual,
--     không có số tiền). Lệch ⇒ migration tự dừng chứ không ghi sai; cho chủ xác nhận số mới, sửa hằng số,
--     sinh lại provenance.
--
-- GHIM DỮ LIỆU (repo công khai): chỉ UUID phiếu, md5 id chủ thể và md5 dấu vân tay; số tiền, tên
--   người, uuid tài khoản thật nằm ngoài Git (biên nhận). Mã phiếu KHÔNG duy nhất trong công ty nên
--   mọi phiếu ghim theo UUID.
-- AN TOÀN CHẠY LẠI (lane dán hai lượt trong một giao dịch): X1 thấy SHADOW thì bỏ qua; X2 gọi lại hàm
--   ghi bù với cùng số ⇒ hàm trả "already"; X3 thấy cả bốn phiếu đã false (và các cột khác vẫn đúng
--   dấu vân tay) thì bỏ qua; X4 là REVOKE; mốc gọi lại cùng khoá idempotency ⇒ trả kết quả cũ.
--   Công ty thật vắng (Restore Drill) ⇒ mọi khối dữ liệu bỏ qua; REVOKE vẫn chạy.
-- LÙI: bản lùi R1–R5 (văn bản trong PR, đã thử trên TEST); không chạy ngược file này.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';

-- 0. Tiền kiểm chung + người ghi + ảnh chụp số dư.
DO $truoc$
DECLARE
  c_org             constant uuid := 'aaaa0000-0000-4000-8000-000000000001';
  c_khoa            constant text := 'shareholder_profit.ledger_payout.v1';
  -- md5(string_agg(kind|id|phân bổ đã chốt|phiếu đã duyệt|phiếu chờ, ',' ORDER BY kind, id)) — đo ngoài Git.
  c_van_tay_dau_vao constant text := 'b723ab755df14f7d124c0339dccf7b2d';
  v_thieu   text;
  v_actor   uuid;
  v_ok_chia boolean;
  v_ok_luong boolean;
  v_van_tay text;
  v_so_du   jsonb;
BEGIN
  PERFORM set_config('ihomecrm.d3a_bo_qua', 'off', true);
  PERFORM set_config('ihomecrm.d3a_actor', '', true);
  PERFORM set_config('ihomecrm.d3a_so_du_truoc', '', true);

  SELECT string_agg(f.ten, ', ' ORDER BY f.ten) INTO v_thieu
    FROM unnest(ARRAY[
      'app_private.set_feature_route_v1(text,bigint,text,timestamptz,timestamptz,integer,numeric,numeric,text,text,text,text,uuid,text)',
      'app_private.evaluate_feature_route(text,uuid)',
      'app_private.lock_org_for_decision_v1(uuid)',
      'app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid)',
      'app_private.profit_ledger_balance_v1(uuid,text,uuid,uuid,date)',
      'app_private.profit_ledger_balance_core_v1(uuid,text,uuid,date,bigint,timestamptz,uuid,date)',
      'app_private.profit_ledger_active_marker_v1(uuid,text,uuid)',
      'app_private.profit_ledger_voucher_live_v1(uuid)',
      'app_private.profit_ledger_luong_backfill_v1(uuid,numeric,numeric,text,uuid,date)',
      'app_private.salary_investment_profit_v1(uuid,uuid,date,timestamptz)',
      'app_private.profit_ledger_tao_set_marker_v1(uuid,text,uuid,date,text,uuid,boolean,text,uuid)',
      'app_private.append_income_expense_event_v1(uuid,uuid,text,uuid,text,text,text,text)',
      'app_private.cashbook_closed_through_v1(uuid)',
      'public.recompute_ie_business_result(uuid)',
      'public.distribute_shareholder_profit_v1(uuid,numeric,uuid,date,text,text)'
    ]) AS f(ten)
   WHERE to_regprocedure(f.ten) IS NULL;
  SELECT concat_ws(', ', v_thieu, string_agg(t.ten, ', ' ORDER BY t.ten)) INTO v_thieu
    FROM unnest(ARRAY[
      'app_private.profit_ledger_markers', 'app_private.profit_ledger_payouts',
      'app_private.profit_ledger_salary_settlements', 'app_private.profit_ledger_salary_settlement_vouchers',
      'app_private.profit_ledger_events', 'app_private.profit_ledger_write_contexts'
    ]) AS t(ten)
   WHERE to_regclass(t.ten) IS NULL;
  IF COALESCE(v_thieu, '') <> '' THEN
    RAISE EXCEPTION 'D3A_NEN: thiếu nền Đợt 1 — áp đủ năm migration Đợt 1 trước: %', v_thieu USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.server_feature_flags f WHERE f.feature_key = c_khoa) THEN
    RAISE EXCEPTION 'D3A_NEN: thiếu công tắc % (Đợt 1 chưa áp)', c_khoa USING ERRCODE = '55000';
  END IF;
  -- Hai hàm ghi của Đợt 1 mà file này gọi phải đúng bản đã rà (md5 prosrc bỏ CR): ghi bù lương (M3) và
  -- đặt mốc (M2-tạo). Đợt 1 đổi thân hàm ⇒ rà lại D3a rồi mới sửa hai số này.
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_catalog.pg_proc p
       WHERE p.oid = to_regprocedure('app_private.profit_ledger_luong_backfill_v1(uuid,numeric,numeric,text,uuid,date)'))
       IS DISTINCT FROM '7ce5d543f3cb2937a2322fb44d664690'
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_catalog.pg_proc p
          WHERE p.oid = to_regprocedure('app_private.profit_ledger_tao_set_marker_v1(uuid,text,uuid,date,text,uuid,boolean,text,uuid)'))
       IS DISTINCT FROM '6f68c04a7496dc5b63c0618c9a93f5bb' THEN
    RAISE EXCEPTION 'D3A_NEN: hàm ghi bù lương / đặt mốc của Đợt 1 khác bản đã rà' USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = c_org) THEN
    PERFORM set_config('ihomecrm.d3a_bo_qua', 'on', true);
    RAISE NOTICE 'D3a: không có công ty thật (database dùng một lần) — bỏ qua mọi khối dữ liệu';
    RETURN;
  END IF;

  -- Thứ tự khoá G v2: khoá công ty TRƯỚC mọi khoá dòng khác; giữ tới hết giao dịch (chặn mọi writer
  -- của công ty trong lúc chuyển đổi).
  IF app_private.lock_org_for_decision_v1(c_org) IS NULL THEN
    RAISE EXCEPTION 'D3A_ORG: công ty không còn hoạt động' USING ERRCODE = '55000';
  END IF;

  -- Người ghi: vai TENANT_OWNER, thành viên ACTIVE, kích hoạt sớm nhất (hoà thì user_id nhỏ hơn).
  SELECT m.user_id INTO v_actor
    FROM public.organization_memberships m
    JOIN public.role_bindings rb ON rb.membership_id = m.id
    JOIN public.organization_roles r ON r.id = rb.role_id AND r.organization_id = m.organization_id
   WHERE m.organization_id = c_org
     AND m.status = 'ACTIVE'
     AND m.activated_at IS NOT NULL
     AND (m.valid_to IS NULL OR m.valid_to > now())
     AND (rb.valid_from IS NULL OR rb.valid_from <= now())
     AND (rb.valid_to IS NULL OR rb.valid_to > now())
     AND r.system_key = 'TENANT_OWNER'
     AND r.status = 'ACTIVE'
   ORDER BY m.activated_at, m.user_id
   LIMIT 1;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'D3A_ACTOR: không tìm thấy tài khoản chủ (vai TENANT_OWNER, đã kích hoạt)' USING ERRCODE = '55000';
  END IF;
  SELECT a.allowed INTO v_ok_chia
    FROM app_private.authorize_tenant_action_v3(v_actor, c_org, 'shareholder_profit.distribute', NULL, NULL) a;
  SELECT a.allowed INTO v_ok_luong
    FROM app_private.authorize_tenant_action_v3(v_actor, c_org, 'shareholder_profit.pay_manager', NULL, NULL) a;
  IF NOT COALESCE(v_ok_chia, false) OR NOT COALESCE(v_ok_luong, false) THEN
    RAISE EXCEPTION 'D3A_ACTOR: tài khoản chủ được chọn không có quyền shareholder_profit.distribute / pay_manager'
      USING ERRCODE = '55000';
  END IF;

  -- Đầu vào số dư (không mốc): phân bổ đã chốt và phiếu chi còn sống — D3a không đổi các số này, nên
  -- dấu vân tay giống nhau ở cả hai lượt. Lệch ⇒ số chủ đã xem không còn đúng: dừng, đo lại.
  WITH chu_the AS (
    SELECT 'SHAREHOLDER'::text AS kind, s.id FROM public.shareholders s WHERE s.organization_id = c_org
    UNION ALL
    SELECT 'MANAGER'::text, m.id FROM public.profit_managers m WHERE m.organization_id = c_org
  ), sd AS (
    SELECT c.kind, c.id,
           app_private.profit_ledger_balance_core_v1(c_org, c.kind, c.id, NULL, NULL, NULL) AS khong_moc,
           app_private.profit_ledger_balance_v1(c_org, c.kind, c.id) AS hien_hanh
      FROM chu_the c
  )
  SELECT md5(string_agg(sd.kind || '|' || sd.id || '|' || round((sd.khong_moc ->> 'allocated')::numeric, 2)::text
                        || '|' || round((sd.khong_moc ->> 'payouts_approved')::numeric, 2)::text
                        || '|' || round((sd.khong_moc ->> 'payouts_pending')::numeric, 2)::text,
                        ',' ORDER BY sd.kind, sd.id)),
         jsonb_object_agg(sd.kind || ':' || sd.id, (sd.hien_hanh ->> 'balance')::numeric)
    INTO v_van_tay, v_so_du
    FROM sd;
  IF v_van_tay IS DISTINCT FROM c_van_tay_dau_vao THEN
    RAISE EXCEPTION 'D3A_VAN_TAY_SO_DU: phân bổ đã chốt / phiếu chi đã khác lúc đo — đo lại và cho chủ xác nhận số mới'
      USING ERRCODE = '55000', DETAIL = jsonb_build_object('expected', c_van_tay_dau_vao, 'actual', v_van_tay)::text;
  END IF;

  PERFORM set_config('ihomecrm.d3a_actor', v_actor::text, true);
  PERFORM set_config('ihomecrm.d3a_so_du_truoc', v_so_du::text, true);
END
$truoc$;

-- X1. OFF → SHADOW.
DO $x1$
DECLARE
  c_org   constant uuid := 'aaaa0000-0000-4000-8000-000000000001';
  c_khoa  constant text := 'shareholder_profit.ledger_payout.v1';
  v_actor uuid := nullif(current_setting('ihomecrm.d3a_actor', true), '')::uuid;
  f       app_private.server_feature_flags%ROWTYPE;
  v_ver   bigint;
BEGIN
  IF current_setting('ihomecrm.d3a_bo_qua', true) = 'on' THEN
    RETURN;
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'D3A_ACTOR: khối tiền kiểm chưa chạy trong giao dịch này' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO f FROM app_private.server_feature_flags WHERE feature_key = c_khoa FOR UPDATE;
  IF f.force_freeze THEN
    RAISE EXCEPTION 'D3A_X1: công tắc đang đóng băng — gỡ đóng băng có chủ đích rồi mới chuyển đổi' USING ERRCODE = '55000';
  END IF;
  IF f.mode = 'SHADOW' THEN
    RETURN;  -- lượt hai (hoặc đã chuyển ở lần trước)
  END IF;
  IF f.mode <> 'OFF' THEN
    RAISE EXCEPTION 'D3A_X1: công tắc đang %, không phải OFF/SHADOW — D3a chỉ chạy trước khi bật', f.mode
      USING ERRCODE = '55000';
  END IF;
  -- Chưa có tiền nào chi theo sổ tổng (phiếu sổ tổng còn sống).
  IF EXISTS (SELECT 1 FROM app_private.profit_ledger_payouts p
              WHERE p.organization_id = c_org AND app_private.profit_ledger_voucher_live_v1(p.voucher_id)) THEN
    RAISE EXCEPTION 'D3A_X1: đã có phiếu chi theo sổ tổng còn sống trước khi chuyển đổi' USING ERRCODE = '55000';
  END IF;

  v_ver := app_private.set_feature_route_v1(c_khoa, f.config_version, 'SHADOW', NULL, NULL, 0, 0, 0,
             NULL, NULL, NULL, NULL, v_actor,
             'Đợt 3a (20261115113530): chế độ chuẩn bị — đặt mốc, xem sổ; chưa chi theo sổ tổng');

  IF v_ver IS DISTINCT FROM f.config_version + 1
     OR app_private.evaluate_feature_route(c_khoa, c_org) <> 'SHADOW'
     OR (SELECT count(*) FROM app_private.server_feature_flag_events e
          WHERE e.feature_key = c_khoa AND e.event_type = 'ROUTE_CHANGED'
            AND e.before_mode = 'OFF' AND e.after_mode = 'SHADOW' AND e.after_version = v_ver) <> 1 THEN
    RAISE EXCEPTION 'D3A_X1: hậu kiểm công tắc SHADOW sai' USING ERRCODE = '55000';
  END IF;
END
$x1$;

-- X2. Ghi bù phần lợi nhuận đã trả kèm phiếu lương đã duyệt.
DO $x2$
DECLARE
  c_org        constant uuid := 'aaaa0000-0000-4000-8000-000000000001';
  c_khoa       constant text := 'shareholder_profit.ledger_payout.v1';
  -- Phiếu lương ĐÃ DUYỆT cần ghi bù và phiếu lương CHỜ DUYỆT được bỏ qua (đo ngoài Git; sắp theo uuid).
  c_phieu      constant uuid[] := ARRAY['05ac6ab0-c040-4b07-bcc3-a71b33487620',
                                        '3190c381-3105-47a9-8909-0e9ad8eac7db',
                                        '9368677b-2f85-4afe-8954-ff9b440c805b']::uuid[];
  c_cho_duyet  constant uuid[] := ARRAY['212c16f8-67b3-49a9-b2d3-094d509328a3']::uuid[];
  -- md5(string_agg(phiếu|cổ đông|kỳ|tổng phiếu|phần đầu tư, ',' ORDER BY phiếu)).
  c_van_tay    constant text := '60d7896b431a2bd36c10b83d27a0c0e3';
  c_ly_do      constant text := 'Đợt 3a (migration 20261115113530): ghi bù phần lợi nhuận đầu tư đã trả kèm phiếu lương lập trước sổ tổng';
  v_actor      uuid := nullif(current_setting('ihomecrm.d3a_actor', true), '')::uuid;
  v_nguon      jsonb;
  v_ke_hoach   jsonb := '[]'::jsonb;
  v_da_ganh    jsonb := '{}'::jsonb;
  v_khoa_thang text;
  v_y_thang    numeric;
  v_y_ngoai    numeric;
  v_y          numeric;
  v_ids        uuid[];
  v_cho        uuid[];
  v_van_tay    text;
  v_anh_truoc  text;
  v_anh_sau    text;
  v_kq         jsonb;
  v_moi        integer := 0;
  v_cu         integer := 0;
  r            record;
BEGIN
  IF current_setting('ihomecrm.d3a_bo_qua', true) = 'on' THEN
    RETURN;
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'D3A_ACTOR: khối tiền kiểm chưa chạy trong giao dịch này' USING ERRCODE = '55000';
  END IF;
  IF app_private.evaluate_feature_route(c_khoa, c_org) <> 'SHADOW' THEN
    RAISE EXCEPTION 'D3A_X2: công tắc phải ở SHADOW (X1) trước khi ghi bù' USING ERRCODE = '55000';
  END IF;

  -- Khoá theo thứ tự G v2 (công ty đã giữ ở khối tiền kiểm): phiếu → bảng lương, theo id.
  PERFORM 1 FROM public.income_expenses ie WHERE ie.id = ANY (c_phieu || c_cho_duyet) ORDER BY ie.id FOR SHARE;
  PERFORM 1 FROM public.salary_monthly sm
   WHERE sm.payout_voucher_id = ANY (c_phieu || c_cho_duyet)
      OR (sm.staff_id, sm.period_month) IN (
           SELECT ie.salary_staff_id,
                  CASE WHEN split_part(o.subject_scope, '|', 2) ~ '^\d{4}-\d{2}-01$'
                       THEN to_date(split_part(o.subject_scope, '|', 2), 'YYYY-MM-DD') END
             FROM public.income_expenses ie
             JOIN app_private.canonical_write_operations o
               ON o.organization_id = ie.organization_id AND o.operation = 'salary.payout.v1' AND o.subject_id = ie.id
            WHERE ie.id = ANY (c_phieu))
   ORDER BY sm.id FOR SHARE;

  -- Tập nguồn ĐỘNG: phiếu lương (EXPENSE, chưa xoá, không phải ứng lương) của nhân viên là cổ đông
  -- (chưa xoá) cùng công ty, ĐÃ DUYỆT, chưa có dòng sổ nào ngoài dòng ghi bù của chính file này.
  WITH v AS (
    SELECT ie.id, ie.created_at, round(ie.total_amount, 2) AS tong, s.id AS sh, s.auth_user_id AS staff,
           (SELECT CASE WHEN split_part(o.subject_scope, '|', 2) ~ '^\d{4}-\d{2}-01$'
                        THEN to_date(split_part(o.subject_scope, '|', 2), 'YYYY-MM-DD') END
              FROM app_private.canonical_write_operations o
             WHERE o.organization_id = ie.organization_id AND o.operation = 'salary.payout.v1' AND o.subject_id = ie.id
               AND split_part(o.subject_scope, '|', 1) = s.auth_user_id::text
               AND split_part(o.subject_scope, '|', 2) ~ '^\d{4}-\d{2}-01$'
             ORDER BY o.completed_at DESC NULLS LAST LIMIT 1) AS ky_lenh,
           (SELECT CASE WHEN count(*) = 1 THEN min(sm.period_month) END
              FROM public.salary_monthly sm WHERE sm.payout_voucher_id = ie.id AND sm.staff_id = s.auth_user_id) AS ky_bang
      FROM public.income_expenses ie
      JOIN public.shareholders s
        ON s.organization_id = ie.organization_id AND s.auth_user_id = ie.salary_staff_id AND s.deleted_at IS NULL
     WHERE ie.organization_id = c_org AND ie.type = 'EXPENSE' AND ie.deleted_at IS NULL
       AND COALESCE(ie.salary_role, '') <> 'ADVANCE' AND ie.approval_status = 'APPROVED'
       AND NOT EXISTS (SELECT 1 FROM app_private.profit_ledger_salary_settlement_vouchers l
                        WHERE l.salary_voucher_id = ie.id AND l.source <> 'BACKFILL')
  ), v2 AS (
    SELECT v.*, COALESCE(v.ky_lenh, v.ky_bang) AS ky,
           (v.ky_lenh IS NOT NULL AND v.ky_bang IS NOT NULL AND v.ky_lenh <> v.ky_bang) AS ky_lech
      FROM v
  ), v3 AS (
    SELECT v2.*, sm.status AS bang, sm.investment_profit
      FROM v2
      LEFT JOIN public.salary_monthly sm
        ON sm.staff_id = v2.staff AND sm.period_month = v2.ky AND (sm.organization_id IS NULL OR sm.organization_id = c_org)
  )
  SELECT jsonb_agg(jsonb_build_object(
           'id', v3.id, 'sh', v3.sh, 'staff', v3.staff, 'ky', v3.ky, 'ky_lech', v3.ky_lech, 'tong', v3.tong,
           'created_at', v3.created_at, 'bang', v3.bang, 'inv', v3.investment_profit) ORDER BY v3.ky, v3.created_at, v3.id),
         array_agg(v3.id ORDER BY v3.id)
    INTO v_nguon, v_ids
    FROM v3;

  SELECT array_agg(ie.id ORDER BY ie.id) INTO v_cho
    FROM public.income_expenses ie
    JOIN public.shareholders s
      ON s.organization_id = ie.organization_id AND s.auth_user_id = ie.salary_staff_id AND s.deleted_at IS NULL
   WHERE ie.organization_id = c_org AND ie.type = 'EXPENSE' AND ie.deleted_at IS NULL
     AND COALESCE(ie.salary_role, '') <> 'ADVANCE' AND ie.approval_status = 'UNAPPROVED'
     AND app_private.profit_ledger_voucher_live_v1(ie.id)
     AND NOT EXISTS (SELECT 1 FROM app_private.profit_ledger_salary_settlement_vouchers l WHERE l.salary_voucher_id = ie.id);

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_nguon) x WHERE (x ->> 'ky') IS NULL OR (x ->> 'ky_lech')::boolean) THEN
    RAISE EXCEPTION 'D3A_X2: không suy được kỳ lương (hoặc hai nguồn kỳ lệch nhau) cho một phiếu lương cần ghi bù'
      USING ERRCODE = '55000',
            DETAIL = (SELECT jsonb_agg(x -> 'id') FROM jsonb_array_elements(v_nguon) x
                       WHERE (x ->> 'ky') IS NULL OR (x ->> 'ky_lech')::boolean)::text;
  END IF;
  -- Số ghi bù, tính TUẦN TỰ theo (kỳ, giờ lập, id) TRƯỚC khi ghi — giống nhau ở cả hai lượt:
  --   Y = least(phần đầu tư của tháng − phần các phiếu TRƯỚC cùng cổ đông / tháng đã gánh, tổng phiếu).
  --   Phần đã gánh = dòng sổ LINKED không phải ghi bù (F3 / báo giá / chủ xác nhận) của phiếu trước còn sống
  --   + Y đã tính cho các phiếu trước trong chính tập này (lượt hai: dòng ghi bù của lượt một bị bỏ qua ở vế
  --   đầu nên không đếm hai lần).
  FOR r IN SELECT t.x FROM jsonb_array_elements(v_nguon) WITH ORDINALITY AS t(x, n) ORDER BY t.n LOOP
    v_y_thang := CASE WHEN r.x ->> 'bang' = 'LOCKED' THEN (r.x ->> 'inv')::numeric
                      ELSE (app_private.salary_investment_profit_v1(c_org, (r.x ->> 'staff')::uuid, (r.x ->> 'ky')::date,
                              (r.x ->> 'created_at')::timestamptz) ->> 'investment')::numeric END;
    SELECT COALESCE(sum(l.investment_amount), 0) INTO v_y_ngoai
      FROM app_private.profit_ledger_salary_settlement_vouchers l
      JOIN public.income_expenses p ON p.id = l.salary_voucher_id
     WHERE l.organization_id = c_org AND l.shareholder_id = (r.x ->> 'sh')::uuid AND l.period_month = (r.x ->> 'ky')::date
       AND l.state = 'LINKED' AND l.source <> 'BACKFILL'
       AND app_private.profit_ledger_voucher_live_v1(l.salary_voucher_id)
       AND (p.created_at, p.id) < ((r.x ->> 'created_at')::timestamptz, (r.x ->> 'id')::uuid);
    v_khoa_thang := (r.x ->> 'sh') || '|' || (r.x ->> 'ky');
    v_y := round(least(v_y_thang - v_y_ngoai - COALESCE((v_da_ganh ->> v_khoa_thang)::numeric, 0), (r.x ->> 'tong')::numeric), 2);
    IF v_y IS NULL THEN
      RAISE EXCEPTION 'D3A_X2: không tính được phần đầu tư của phiếu %', r.x ->> 'id' USING ERRCODE = '55000';
    END IF;
    v_da_ganh := v_da_ganh || jsonb_build_object(v_khoa_thang, COALESCE((v_da_ganh ->> v_khoa_thang)::numeric, 0) + v_y);
    v_ke_hoach := v_ke_hoach || jsonb_build_array(r.x || jsonb_build_object('y', v_y));
  END LOOP;
  SELECT md5(string_agg((x ->> 'id') || '|' || (x ->> 'sh') || '|' || (x ->> 'ky') || '|' || round((x ->> 'tong')::numeric, 2)::text
                        || '|' || round((x ->> 'y')::numeric, 2)::text, ',' ORDER BY (x ->> 'id')::uuid))
    INTO v_van_tay FROM jsonb_array_elements(v_ke_hoach) x;

  IF COALESCE(v_ids, '{}') <> c_phieu OR COALESCE(v_cho, '{}') <> c_cho_duyet OR v_van_tay IS DISTINCT FROM c_van_tay THEN
    RAISE EXCEPTION 'D3A_VAN_TAY_X2: tập phiếu lương cần ghi bù / chờ duyệt hoặc số đầu tư đã khác lúc đo — đo lại'
      USING ERRCODE = '55000',
            DETAIL = jsonb_build_object('expected', c_van_tay, 'actual', v_van_tay, 'ids', to_jsonb(v_ids),
                                        'pending', to_jsonb(v_cho))::text;
  END IF;

  -- Ảnh chụp phiếu và bảng lương liên quan: ghi bù không được đổi một dòng nào ở hai bảng này.
  SELECT md5(COALESCE(string_agg(x.j, ',' ORDER BY x.j), '')) INTO v_anh_truoc
    FROM (SELECT to_jsonb(ie)::text AS j FROM public.income_expenses ie WHERE ie.id = ANY (c_phieu)
          UNION ALL
          SELECT to_jsonb(sm)::text FROM public.salary_monthly sm WHERE sm.payout_voucher_id = ANY (c_phieu)) x;

  FOR r IN SELECT t.x FROM jsonb_array_elements(v_ke_hoach) WITH ORDINALITY AS t(x, n) ORDER BY t.n LOOP
    v_kq := app_private.profit_ledger_luong_backfill_v1((r.x ->> 'id')::uuid, (r.x ->> 'y')::numeric, 0, c_ly_do, v_actor,
                                                        (r.x ->> 'ky')::date);
    IF (v_kq ->> 'already')::boolean THEN
      v_cu := v_cu + 1;
    ELSE
      v_moi := v_moi + 1;
    END IF;
  END LOOP;

  -- Hậu kiểm X2.
  SELECT md5(COALESCE(string_agg(x.j, ',' ORDER BY x.j), '')) INTO v_anh_sau
    FROM (SELECT to_jsonb(ie)::text AS j FROM public.income_expenses ie WHERE ie.id = ANY (c_phieu)
          UNION ALL
          SELECT to_jsonb(sm)::text FROM public.salary_monthly sm WHERE sm.payout_voucher_id = ANY (c_phieu)) x;
  IF v_anh_sau IS DISTINCT FROM v_anh_truoc THEN
    RAISE EXCEPTION 'D3A_X2: ghi bù đã làm đổi phiếu lương hoặc bảng lương' USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM app_private.profit_ledger_salary_settlement_vouchers l
       WHERE l.salary_voucher_id = ANY (c_phieu) AND l.source = 'BACKFILL' AND l.state = 'LINKED'
         AND l.advance_offset_amount = 0 AND l.organization_id = c_org) <> cardinality(c_phieu)
     OR (SELECT md5(string_agg(l.salary_voucher_id || '|' || l.shareholder_id || '|' || l.period_month || '|'
                               || round(ie.total_amount, 2)::text || '|' || round(l.investment_amount, 2)::text,
                               ',' ORDER BY l.salary_voucher_id))
           FROM app_private.profit_ledger_salary_settlement_vouchers l
           JOIN public.income_expenses ie ON ie.id = l.salary_voucher_id
          WHERE l.salary_voucher_id = ANY (c_phieu)) IS DISTINCT FROM c_van_tay THEN
    RAISE EXCEPTION 'D3A_X2: hậu kiểm dòng sổ ghi bù không khớp dấu vân tay' USING ERRCODE = '55000';
  END IF;
  -- Bảng lương LOCKED của các phiếu ghi bù phải có bản đóng băng (C3) khớp bảng.
  IF EXISTS (
    SELECT 1 FROM app_private.profit_ledger_salary_settlement_vouchers l
      JOIN public.salary_monthly sm ON sm.staff_id = l.staff_id AND sm.period_month = l.period_month
                                   AND (sm.organization_id IS NULL OR sm.organization_id = c_org)
     WHERE l.salary_voucher_id = ANY (c_phieu) AND sm.status = 'LOCKED'
       AND NOT EXISTS (SELECT 1 FROM app_private.profit_ledger_salary_settlements c
                        WHERE c.id = l.settlement_id AND c.state = 'FROZEN'
                          AND c.investment_month = sm.investment_profit)) THEN
    RAISE EXCEPTION 'D3A_X2: thiếu bản đóng băng khớp bảng lương đã chốt' USING ERRCODE = '55000';
  END IF;
  RAISE NOTICE 'D3a X2: % phiếu lương ghi bù mới, % đã có từ lượt trước, % phiếu chờ duyệt bỏ qua',
    v_moi, v_cu, cardinality(c_cho_duyet);
END
$x2$;

-- X3. Bốn phiếu chia lợi nhuận cũ ra khỏi KQKD.
DO $x3$
DECLARE
  c_org       constant uuid := 'aaaa0000-0000-4000-8000-000000000001';
  c_phieu     constant uuid[] := ARRAY['2488536d-1a38-4f8e-840e-d27cb690629c',
                                       '33c8b388-079a-48d7-a7a7-ab0141b26eb8',
                                       'd66ba7f7-a7d9-4123-8ed0-4e3e53b6cd45',
                                       'e6bff80c-ec79-4073-9a8a-b7bb4256adba']::uuid[];
  -- md5(string_agg(id|mã|tổng|duyệt|ghi sổ|toà|sổ|bút toán|'null', ',' ORDER BY id)) — trạng thái TRƯỚC X3.
  c_van_tay   constant text := '134f6ac23c77677bbb901cc1c8100a00';
  c_cot_doi   constant text[] := ARRAY['business_result_accounting', 'kqkd_amount', 'counts_in_business_result',
                                       'updated_at', 'has_restricted_item'];
  v_actor     uuid := nullif(current_setting('ihomecrm.d3a_actor', true), '')::uuid;
  v_van_tay   text;
  v_null      integer;
  v_false     integer;
  v_truoc     jsonb;
  v_han_che   jsonb;
  v_so_quy    uuid[];
  v_tong_truoc numeric;
  v_tong_sau  numeric;
  v_but_toan_truoc jsonb;
  v_but_toan_sau jsonb;
  v_yeu_cau_truoc text;
  v_yeu_cau_sau text;
  v_bao_ve_truoc text;
  v_bao_ve_sau text;
  v_n         integer;
  r           record;
BEGIN
  IF current_setting('ihomecrm.d3a_bo_qua', true) = 'on' THEN
    RETURN;
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'D3A_ACTOR: khối tiền kiểm chưa chạy trong giao dịch này' USING ERRCODE = '55000';
  END IF;

  PERFORM 1 FROM public.income_expenses ie WHERE ie.id = ANY (c_phieu) ORDER BY ie.id FOR UPDATE;

  SELECT md5(string_agg(ie.id || '|' || ie.code || '|' || round(ie.total_amount, 2)::text || '|' || ie.approval_status || '|'
                        || ie.posting_status || '|' || ie.building_id || '|' || ie.account_id || '|'
                        || ie.active_posting_id_v2 || '|' || 'null', ',' ORDER BY ie.id)),
         count(*) FILTER (WHERE ie.business_result_accounting IS NULL),
         count(*) FILTER (WHERE ie.business_result_accounting IS FALSE)
    INTO v_van_tay, v_null, v_false
    FROM public.income_expenses ie
   WHERE ie.id = ANY (c_phieu) AND ie.organization_id = c_org;
  IF v_van_tay IS DISTINCT FROM c_van_tay THEN
    RAISE EXCEPTION 'D3A_VAN_TAY_X3: bốn phiếu đã khác lúc đo — đo lại' USING ERRCODE = '55000',
      DETAIL = jsonb_build_object('expected', c_van_tay, 'actual', v_van_tay)::text;
  END IF;
  IF v_false = cardinality(c_phieu) THEN
    -- Lượt hai: chỉ còn kiểm hình dạng sau X3.
    IF EXISTS (SELECT 1 FROM public.income_expenses ie WHERE ie.id = ANY (c_phieu)
                AND (ie.kqkd_amount <> 0 OR ie.counts_in_business_result)) THEN
      RAISE EXCEPTION 'D3A_X3: phiếu đã false nhưng KQKD chưa về 0' USING ERRCODE = '55000';
    END IF;
    RETURN;
  END IF;
  IF v_null <> cardinality(c_phieu) THEN
    RAISE EXCEPTION 'D3A_X3: bốn phiếu không cùng trạng thái KQKD tự động (null %, false %)', v_null, v_false
      USING ERRCODE = '55000';
  END IF;

  -- Tiền điều kiện từng phiếu: sống, không gắn cổ đông/quản lý/nguồn máy/bàn giao, đã ghi sổ, sổ chưa chốt.
  IF EXISTS (
    SELECT 1 FROM public.income_expenses ie
     WHERE ie.id = ANY (c_phieu)
       AND (ie.deleted_at IS NOT NULL OR ie.handover_id IS NOT NULL OR ie.shareholder_id IS NOT NULL
            OR ie.profit_manager_id IS NOT NULL OR ie.system_source IS NOT NULL OR ie.type <> 'EXPENSE'
            OR ie.approval_status <> 'APPROVED' OR ie.posting_status IS DISTINCT FROM 'POSTED'
            OR COALESCE(app_private.cashbook_closed_through_v1(ie.account_id) >= ie.voucher_date, false))) THEN
    RAISE EXCEPTION 'D3A_X3: một phiếu không còn đúng điều kiện (đã xoá / bàn giao / gắn người nhận / sổ đã chốt) — hỏi chủ'
      USING ERRCODE = '55000';
  END IF;

  -- Ảnh chụp trước.
  SELECT jsonb_object_agg(ie.id::text, to_jsonb(ie) - c_cot_doi), array_agg(DISTINCT ie.account_id)
    INTO v_truoc, v_so_quy
    FROM public.income_expenses ie WHERE ie.id = ANY (c_phieu);
  -- has_restricted_item sẽ được recompute_ie_business_result tính lại đúng theo công thức của nó.
  SELECT jsonb_object_agg(ie.id::text,
           (SELECT COALESCE(bool_or(t.is_restricted), false)
              FROM public.income_expense_items i
              LEFT JOIN public.income_expense_types t ON t.id = i.income_expense_type_id
             WHERE i.income_expense_id = ie.id))
    INTO v_han_che
    FROM public.income_expenses ie WHERE ie.id = ANY (c_phieu);
  SELECT COALESCE(sum(l.signed_amount), 0) INTO v_tong_truoc
    FROM public.income_expense_posting_lines l WHERE l.account_id = ANY (v_so_quy);
  SELECT jsonb_object_agg(x.id::text, x.n) INTO v_but_toan_truoc
    FROM (SELECT ie.id, (SELECT count(*) FROM public.income_expense_postings p WHERE p.voucher_id = ie.id) AS n
            FROM public.income_expenses ie WHERE ie.id = ANY (c_phieu)) x;
  SELECT md5(COALESCE(string_agg(to_jsonb(ar)::text, ',' ORDER BY ar.id), '')) INTO v_yeu_cau_truoc
    FROM public.approval_requests ar WHERE ar.subject_type = 'FINANCIAL_VOUCHER' AND ar.subject_id = ANY (c_phieu);
  -- Event trigger org_boundary_tu_dong chạy lại ensure_org_boundary_v1 sau mỗi ALTER TABLE: chụp
  -- policy, cờ RLS và trigger của bảng để chứng minh nó không đổi gì.
  SELECT md5(concat_ws('#',
           (SELECT string_agg(concat_ws('|', p.polname, p.polcmd::text, p.polpermissive::text, p.polroles::text,
                                        pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)),
                              ',' ORDER BY p.polname)
              FROM pg_policy p WHERE p.polrelid = 'public.income_expenses'::regclass),
           (SELECT c.relrowsecurity::text || c.relforcerowsecurity::text FROM pg_class c WHERE c.oid = 'public.income_expenses'::regclass),
           (SELECT string_agg(t.tgname || ':' || t.tgenabled::text || ':' || t.tgfoid::text, ',' ORDER BY t.tgname)
              FROM pg_trigger t WHERE t.tgrelid = 'public.income_expenses'::regclass AND NOT t.tgisinternal)))
    INTO v_bao_ve_truoc;

  -- Hai khoá chặn sửa phiếu (tháng đã chốt lợi nhuận / phiếu canonical niêm phong) tắt ĐÍCH DANH trong
  -- giao dịch này. ALTER TABLE giữ SHARE ROW EXCLUSIVE tới COMMIT: phiên khác ghi income_expenses phải
  -- đợi, và không phiên nào thấy hai trigger ở trạng thái tắt.
  ALTER TABLE public.income_expenses DISABLE TRIGGER a02_ie_profit_lock_upd;
  ALTER TABLE public.income_expenses DISABLE TRIGGER a00_ie_owned_payload_freeze;

  UPDATE public.income_expenses
     SET business_result_accounting = false,
         updated_at = now()
   WHERE id = ANY (c_phieu)
     AND business_result_accounting IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  ALTER TABLE public.income_expenses ENABLE TRIGGER a02_ie_profit_lock_upd;
  ALTER TABLE public.income_expenses ENABLE TRIGGER a00_ie_owned_payload_freeze;

  -- Hậu kiểm X3 (sai ⇒ RAISE, cả giao dịch cuộn lại — kể cả hai lệnh ALTER).
  IF v_n <> cardinality(c_phieu) THEN
    RAISE EXCEPTION 'D3A_X3: cập nhật % phiếu, phải là %', v_n, cardinality(c_phieu) USING ERRCODE = '55000';
  END IF;
  FOR r IN SELECT ie.* FROM public.income_expenses ie WHERE ie.id = ANY (c_phieu) LOOP
    IF (to_jsonb(r) - c_cot_doi) IS DISTINCT FROM (v_truoc -> r.id::text)
       OR r.business_result_accounting IS DISTINCT FROM false
       OR r.kqkd_amount <> 0
       OR r.counts_in_business_result
       OR r.has_restricted_item IS DISTINCT FROM (v_han_che ->> r.id::text)::boolean THEN
      RAISE EXCEPTION 'D3A_X3: phiếu % đổi ngoài các cột cho phép hoặc KQKD sai', r.id USING ERRCODE = '55000';
    END IF;
  END LOOP;
  SELECT COALESCE(sum(l.signed_amount), 0) INTO v_tong_sau
    FROM public.income_expense_posting_lines l WHERE l.account_id = ANY (v_so_quy);
  SELECT jsonb_object_agg(x.id::text, x.n) INTO v_but_toan_sau
    FROM (SELECT ie.id, (SELECT count(*) FROM public.income_expense_postings p WHERE p.voucher_id = ie.id) AS n
            FROM public.income_expenses ie WHERE ie.id = ANY (c_phieu)) x;
  SELECT md5(COALESCE(string_agg(to_jsonb(ar)::text, ',' ORDER BY ar.id), '')) INTO v_yeu_cau_sau
    FROM public.approval_requests ar WHERE ar.subject_type = 'FINANCIAL_VOUCHER' AND ar.subject_id = ANY (c_phieu);
  SELECT md5(concat_ws('#',
           (SELECT string_agg(concat_ws('|', p.polname, p.polcmd::text, p.polpermissive::text, p.polroles::text,
                                        pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)),
                              ',' ORDER BY p.polname)
              FROM pg_policy p WHERE p.polrelid = 'public.income_expenses'::regclass),
           (SELECT c.relrowsecurity::text || c.relforcerowsecurity::text FROM pg_class c WHERE c.oid = 'public.income_expenses'::regclass),
           (SELECT string_agg(t.tgname || ':' || t.tgenabled::text || ':' || t.tgfoid::text, ',' ORDER BY t.tgname)
              FROM pg_trigger t WHERE t.tgrelid = 'public.income_expenses'::regclass AND NOT t.tgisinternal)))
    INTO v_bao_ve_sau;
  IF v_tong_sau IS DISTINCT FROM v_tong_truoc OR v_but_toan_sau IS DISTINCT FROM v_but_toan_truoc
     OR v_yeu_cau_sau IS DISTINCT FROM v_yeu_cau_truoc THEN
    RAISE EXCEPTION 'D3A_X3: bút toán / số dư sổ quỹ / yêu cầu duyệt đã đổi' USING ERRCODE = '55000';
  END IF;
  IF v_bao_ve_sau IS DISTINCT FROM v_bao_ve_truoc
     OR (SELECT count(*) FROM pg_trigger t
          WHERE t.tgrelid = 'public.income_expenses'::regclass
            AND t.tgname IN ('a02_ie_profit_lock_upd', 'a00_ie_owned_payload_freeze') AND t.tgenabled = 'O') <> 2 THEN
    RAISE EXCEPTION 'D3A_X3: policy / RLS / trigger của income_expenses đã đổi hoặc chưa bật lại đúng' USING ERRCODE = '55000';
  END IF;

  FOR r IN SELECT ie.id FROM public.income_expenses ie WHERE ie.id = ANY (c_phieu) ORDER BY ie.id LOOP
    PERFORM app_private.append_income_expense_event_v1(
      c_org, r.id, 'KQKD_OVERRIDE', v_actor, 'Migration 20261115113530 theo quyết định chủ',
      'KQKD: tự động', 'KQKD: không', 'Chi chia lợi nhuận cổ đông không phải chi phí — quyết định chủ');
  END LOOP;
END
$x3$;

-- X4. Đóng lệnh chi lợi nhuận kiểu cũ.
--   ĐIỀU KIỆN NGOÀI CSDL (người điều phối kiểm trước khi áp, migration không đo được): web production đã là
--   bản Đợt 2 và không còn lời gọi distribute_shareholder_profit_v1. Khối dưới chỉ kiểm phần đo được trong
--   CSDL: đường cũ chưa từng để lại phiếu / yêu cầu duyệt / giữ chỗ nào.
DO $x4$
BEGIN
  IF EXISTS (SELECT 1 FROM public.income_expenses ie
              WHERE ie.shareholder_id IS NOT NULL AND ie.system_source IS DISTINCT FROM 'profit.ledger_payout') THEN
    RAISE EXCEPTION 'D3A_X4: có phiếu mang cổ đông ngoài nguồn sổ tổng — đường chi cũ đã được dùng, hỏi chủ'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.approval_requests ar WHERE ar.system_source = 'profit.distribution') THEN
    RAISE EXCEPTION 'D3A_X4: còn yêu cầu duyệt profit.distribution' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profit_payout_reservations) THEN
    RAISE EXCEPTION 'D3A_X4: còn giữ chỗ chi lợi nhuận kiểu cũ (profit_payout_reservations)' USING ERRCODE = '55000';
  END IF;
END
$x4$;

REVOKE EXECUTE ON FUNCTION public.distribute_shareholder_profit_v1(uuid, numeric, uuid, date, text, text) FROM PUBLIC, anon, authenticated;

DO $x4_sau$
BEGIN
  IF has_function_privilege('authenticated', 'public.distribute_shareholder_profit_v1(uuid,numeric,uuid,date,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.distribute_shareholder_profit_v1(uuid,numeric,uuid,date,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.create_profit_payout_compat_v1(text,uuid,numeric,uuid,date,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.create_profit_payout_compat_v1(text,uuid,numeric,uuid,date,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'D3A_X4: lệnh chi lợi nhuận cũ vẫn gọi được từ web' USING ERRCODE = '55000';
  END IF;
END
$x4_sau$;

-- Mốc "đã trả đủ đến hết tháng X" (quyết định chủ 14/11/2026).
DO $moc$
DECLARE
  c_org     constant uuid := 'aaaa0000-0000-4000-8000-000000000001';
  c_khoa    constant text := 'd3a-20261115113530-moc';
  v_actor   uuid := nullif(current_setting('ihomecrm.d3a_actor', true), '')::uuid;
  v_ids     uuid[];
  v_id      uuid;
  v_hien    uuid;
  v_kq      jsonb;
  v_sd      jsonb;
  r         record;
BEGIN
  IF current_setting('ihomecrm.d3a_bo_qua', true) = 'on' THEN
    RETURN;
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'D3A_ACTOR: khối tiền kiểm chưa chạy trong giao dịch này' USING ERRCODE = '55000';
  END IF;

  -- Chủ thể ghim bằng md5(id) — không đưa id/tên người vào repo.
  FOR r IN
    SELECT * FROM (VALUES
      ('SHAREHOLDER', '0568d869494cff82b3723d08ce7a7f93', DATE '2026-09-01',
       'Đã trả đủ lợi nhuận đến hết 09/2026 theo xác nhận của chủ ngày 14/11/2026 (migration 20261115113530)'),
      ('SHAREHOLDER', '7583daba684a285cf80f34d83f8f578c', DATE '2026-09-01',
       'Đã trả đủ lợi nhuận đến hết 09/2026 theo xác nhận của chủ ngày 14/11/2026, gồm cả 4 phiếu chi 162NVK cũ không gắn cổ đông (migration 20261115113530)'),
      ('MANAGER', '8ed6564e0e6a931a1b17829ebc824f7e', DATE '2026-05-01',
       'Lương điều hành đã trả đủ đến hết 05/2026 theo mặc định chủ uỷ quyền ngày 14/11/2026 (migration 20261115113530)'),
      ('MANAGER', 'faa25320f50b68402328d2ea2fffca9a', DATE '2026-05-01',
       'Lương điều hành đã trả đủ đến hết 05/2026 theo mặc định chủ uỷ quyền ngày 14/11/2026 (migration 20261115113530)')
    ) AS x(kind, md5_id, thang, ly_do)
    ORDER BY x.kind DESC, x.md5_id
  LOOP
    IF r.kind = 'SHAREHOLDER' THEN
      SELECT array_agg(s.id) INTO v_ids FROM public.shareholders s WHERE s.organization_id = c_org AND md5(s.id::text) = r.md5_id;
    ELSE
      SELECT array_agg(m.id) INTO v_ids FROM public.profit_managers m WHERE m.organization_id = c_org AND md5(m.id::text) = r.md5_id;
    END IF;
    IF cardinality(v_ids) IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'D3A_MOC: không tìm đúng một chủ thể % ghim %', r.kind, r.md5_id USING ERRCODE = '55000';
    END IF;
    v_id := v_ids[1];
    SELECT mk.marker_id INTO v_hien FROM app_private.profit_ledger_active_marker_v1(c_org, r.kind, v_id) mk;
    -- Xác nhận xoá tạm ứng = false: mốc nào xoá dấu một khoản tạm ứng thì hàm ném 22023, migration dừng.
    v_kq := app_private.profit_ledger_tao_set_marker_v1(c_org, r.kind, v_id, r.thang, r.ly_do, v_hien, false, c_khoa, v_actor);
    IF (v_kq ->> 'settled_through_month')::date IS DISTINCT FROM r.thang
       OR (v_kq ->> 'advance_erased')::numeric <> 0 THEN
      RAISE EXCEPTION 'D3A_MOC: kết quả đặt mốc lạ cho %', r.md5_id USING ERRCODE = '55000';
    END IF;

    -- Chủ thể có mốc chỉ còn phần SAU mốc: không phiếu chi, không dòng lương sau mốc; số dư = phân bổ đã
    -- chốt của các tháng sau mốc (hiện chưa có ⇒ 0).
    v_sd := app_private.profit_ledger_balance_v1(c_org, r.kind, v_id);
    IF (v_sd -> 'marker' ->> 'settled_through_month')::date IS DISTINCT FROM r.thang
       OR (v_sd ->> 'payouts_approved')::numeric <> 0 OR (v_sd ->> 'payouts_pending')::numeric <> 0
       OR (v_sd ->> 'salary_investment')::numeric <> 0 OR (v_sd ->> 'salary_advance_offset')::numeric <> 0
       OR (v_sd ->> 'balance')::numeric <> (v_sd ->> 'allocated')::numeric THEN
      RAISE EXCEPTION 'D3A_MOC: số dư sau mốc của % không chỉ còn phần sau mốc', r.md5_id USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$moc$;

-- Z. Hậu kiểm chung: công tắc SHADOW; chủ thể KHÔNG có mốc ở trên có số dư y như trước migration.
DO $sau$
DECLARE
  c_org    constant uuid := 'aaaa0000-0000-4000-8000-000000000001';
  c_khoa   constant text := 'shareholder_profit.ledger_payout.v1';
  c_co_moc constant text[] := ARRAY['0568d869494cff82b3723d08ce7a7f93', '7583daba684a285cf80f34d83f8f578c',
                                    '8ed6564e0e6a931a1b17829ebc824f7e', 'faa25320f50b68402328d2ea2fffca9a'];
  v_truoc  jsonb := nullif(current_setting('ihomecrm.d3a_so_du_truoc', true), '')::jsonb;
  v_lech   text;
BEGIN
  IF current_setting('ihomecrm.d3a_bo_qua', true) = 'on' THEN
    RETURN;
  END IF;
  IF v_truoc IS NULL THEN
    RAISE EXCEPTION 'D3A_SAU: thiếu ảnh chụp số dư của khối tiền kiểm' USING ERRCODE = '55000';
  END IF;
  IF app_private.evaluate_feature_route(c_khoa, c_org) <> 'SHADOW' THEN
    RAISE EXCEPTION 'D3A_SAU: công tắc không ở SHADOW' USING ERRCODE = '55000';
  END IF;
  WITH chu_the AS (
    SELECT 'SHAREHOLDER'::text AS kind, s.id FROM public.shareholders s WHERE s.organization_id = c_org
    UNION ALL
    SELECT 'MANAGER'::text, m.id FROM public.profit_managers m WHERE m.organization_id = c_org
  )
  SELECT string_agg(md5(c.id::text), ', ') INTO v_lech
    FROM chu_the c
   WHERE md5(c.id::text) <> ALL (c_co_moc)
     AND (app_private.profit_ledger_balance_v1(c_org, c.kind, c.id) ->> 'balance')::numeric
         IS DISTINCT FROM (v_truoc ->> (c.kind || ':' || c.id))::numeric;
  IF v_lech IS NOT NULL THEN
    RAISE EXCEPTION 'D3A_SAU: số dư của chủ thể không có mốc đã đổi: %', v_lech USING ERRCODE = '55000';
  END IF;
END
$sau$;

COMMIT;

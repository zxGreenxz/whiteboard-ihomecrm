-- =============================================================================
-- Sổ tổng lợi nhuận cổ đông — PHẦN LẬP (M2-tạo của "Chi chia lợi nhuận theo sổ tổng").
--
-- VÌ SAO
--   M1 (20261115063149) dựng bảng sổ và MỘT công thức số dư. Phần này thêm các lệnh
--   ghi vào sổ, đóng các cửa lập tay phiếu lợi nhuận, và đặt trần cho lương điều
--   hành khi sổ tổng được bật. Công tắc shareholder_profit.ledger_payout.v1 vẫn TẮT:
--   sau migration này lập phiếu chi lợi nhuận cổ đông trả 55000 cho tới Đợt 3.
--
-- LÀM GÌ
--   E4  public.shareholder_profit_payout_preview_v1   xem trước một lần chi (STABLE, không khoá).
--   E5  public.shareholder_profit_ledger_payout_v1    lập phiếu chi lợi nhuận theo sổ tổng: phiếu
--       UNAPPROVED + yêu cầu duyệt PENDING_APPROVAL; phần vượt số còn phải trả là TẠM ỨNG và
--       phải xác nhận; người có quyền tạm ứng chỉ chi cho chính mình từ sổ quỹ đang giữ.
--   E8  public.profit_ledger_marker_preview_v1        xem trước mốc "đã trả đủ đến hết tháng X".
--   E9  public.profit_ledger_set_marker_v1            đặt / đè / gỡ mốc (lý do, CAS, xác nhận khi
--       mốc xoá dấu một khoản tạm ứng; tháng X phải là tháng ĐÃ QUA — mốc ở tháng chưa kết thúc sẽ
--       lặng lẽ loại phân bổ của tháng đó khi chốt sau này); phần ghi ở app_private.profit_ledger_tao_set_marker_v1
--       (không cấp quyền cho vai nào) để migration chuyển đổi của Đợt 3 gọi với actor là chủ.
--   E11 public.manager_salary_payout_v1 — THAY THÂN, giữ chữ ký / DEFAULT / search_path / ACL:
--       sổ tổng TẮT hoặc SHADOW: hành vi cũ, chỉ mở quyền ghi chuỗi kế toán để qua F4 (kết quả
--       thêm khoá voucher_id); BẬT: có trần "được nhận − đã trả", dòng sổ, nhật ký; ĐÓNG BĂNG: 55000.
--   F4  app_private.guard_profit_payout_scope_compat_v1 (trigger a00_00_profit_payout_account_guard
--       giữ nguyên): nhận nguồn 'profit.ledger_payout'; INSERT phiếu mang nguồn 'profit.ledger_payout' /
--       'profit.manager_salary' phải có ngữ cảnh LẬP (C6 'CREATE') của chính phiếu, UNAPPROVED, chưa
--       POSTED, sai ⇒ 55000 PROFIT_LEDGER_CREATE_ONLY (F1 chỉ gác UPDATE / DELETE); INSERT có
--       shareholder_id / profit_manager_id hoặc UPDATE đổi hai cột đó phải có quyền ghi chuỗi kế toán,
--       thiếu ⇒ 42501.
--   D1.8 hạng mục chia_loi_nhuan / luong_dieu_hanh (mọi công ty): system_only, manual_hidden,
--       quick_entry_hidden = true, category 'Chia lợi nhuận' (force_approval, internal_transfer giữ
--       nguyên); public.ie_compat_insert_v2 lột thêm shareholder_id, profit_manager_id (còn lại giữ
--       từng byte so với 20261030100148); REVOKE public.create_profit_payout_compat_v1 khỏi authenticated.
--
-- KHÔNG LÀM: không đổi công tắc, không trigger mới trên income_expenses / approval_requests /
--   salary_monthly (F1, F2, F5 thuộc phần chặn; F3 thuộc phần lương), không sửa
--   distribute_shareholder_profit_v1, không đụng hàm hermes_*.
--   CHƯA đóng hết đường chi cũ (từ lúc áp tới Đợt 3): lệnh mới E5 trả 55000 PROFIT_LEDGER_ROUTE_OFF và
--   hai cửa lập tay (ie_compat_insert_v2, create_profit_payout_compat_v1) đóng, NHƯNG writer cũ
--   distribute_shareholder_profit_v1 vẫn còn và web vẫn gọi (src/hooks/income-expenses/specialized.ts)
--   tới khi Đợt 3 thu hồi (X4). Đo production 15/11: cờ shareholder_profit.distribute.v1 ON; hàm tự xét
--   shareholder_profit.distribute.v2 = SHADOW nên hiện trả 55000 — ai bật cờ đó thì phiếu
--   'profit.distribution' ra lại được và KHÔNG qua F1 / dòng sổ C2 (sổ tổng vẫn trừ vì phiếu mang
--   shareholder_id). Lương điều hành (E11) khi sổ tổng TẮT / SHADOW vẫn chạy thân cũ (pay_manager.v1 ON).
--
-- AN TOÀN CHẠY LẠI: khối ghim md5 chỉ nhận đúng hai thân cho mỗi hàm bị thay (thân production
--   đã rà, hoặc thân do chính file này ghi — lượt hai). Thân khác ⇒ dừng 55000, không ghi đè.
--   Mọi lệnh khác là CREATE OR REPLACE / UPDATE có điều kiện / REVOKE-GRANT.
-- LÙI (migration forward mới): CREATE OR REPLACE lại ba thân cũ đã ghim (manager_salary_payout_v1 và
--   guard_profit_payout_scope_compat_v1: supabase/baseline/schema.sql; ie_compat_insert_v2:
--   20261030100148), GRANT EXECUTE create_profit_payout_compat_v1 TO authenticated, trả cờ hai
--   hạng mục về (system_only=false, manual_hidden=false, category 'Nhân sự – sale'). Các RPC mới để
--   nguyên là vô hại khi công tắc tắt.
-- =============================================================================

BEGIN;

-- 0. Tiền kiểm: nền phải có; ba thân sắp thay phải đúng bản đã rà (md5 prosrc bỏ CR).
DO $truoc$
DECLARE
  v_thieu text;
  v_src   text;
BEGIN
  SELECT string_agg(f.ten, ', ' ORDER BY f.ten) INTO v_thieu
    FROM unnest(ARRAY[
      'app_private.profit_ledger_balance_v1(uuid,text,uuid,uuid,date)',
      'app_private.profit_ledger_balance_core_v1(uuid,text,uuid,date,bigint,timestamptz,uuid,date)',
      'app_private.profit_ledger_active_marker_v1(uuid,text,uuid)',
      'app_private.profit_ledger_voucher_live_v1(uuid)',
      'app_private.profit_ledger_lock_v1(uuid,text,uuid)',
      'app_private.profit_ledger_open_estimate_v1(uuid,uuid)',
      'app_private.profit_viewer_can_v1(uuid,text)',
      'app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid)',
      'app_private.lock_org_for_decision_v1(uuid)',
      'app_private.evaluate_feature_route(text,uuid)',
      'app_private.claim_feature_operation_v1(text,uuid,text,uuid,text,numeric)',
      'app_private.assert_cashbook_access_v2(uuid,uuid,text,uuid)',
      'app_private.submit_financial_request_v1(uuid,uuid,uuid,text)',
      'app_private.begin_accounting_chain_write_v1()',
      'app_private.end_accounting_chain_write_v1()',
      'app_private.profit_month_locked_v1(uuid,date)',
      'app_private.cashbook_closed_through_v1(uuid)',
      'public.org_today_v1(uuid)',
      'public.manager_salary_payout_v1(uuid,numeric,uuid,date,text,text)',
      'public.ie_compat_insert_v2(jsonb,jsonb)',
      'app_private.guard_profit_payout_scope_compat_v1()',
      'public.create_profit_payout_compat_v1(text,uuid,numeric,uuid,date,text,text)'
    ]) AS f(ten)
   WHERE to_regprocedure(f.ten) IS NULL;
  IF v_thieu IS NOT NULL THEN
    RAISE EXCEPTION 'Thiếu hàm nền: %', v_thieu USING ERRCODE = '55000';
  END IF;

  SELECT string_agg(x.rel || '.' || c.col, ', ' ORDER BY x.rel, c.col) INTO v_thieu
    FROM (VALUES
      ('public.income_expense_types', ARRAY['id', 'organization_id', 'name', 'type', 'category', 'rule_key', 'system_only',
         'manual_hidden', 'quick_entry_hidden', 'force_approval', 'internal_transfer', 'is_restricted', 'user_id']),
      ('public.income_expenses', ARRAY['id', 'organization_id', 'user_id', 'creator_name', 'type', 'name', 'building_id',
         'account_id', 'shareholder_id', 'profit_manager_id', 'total_amount', 'business_result_accounting', 'approval_status',
         'voucher_date', 'attachments', 'repeat_cycle', 'repeat_infinity', 'repeat_count', 'repeat_remaining',
         'source_payload_hash', 'system_source', 'idempotency_key', 'maker_user_id', 'maker_membership_id']),
      ('public.income_expense_items', ARRAY['income_expense_id', 'organization_id', 'income_expense_type_id', 'description',
         'quantity', 'unit_price', 'amount', 'start_date', 'end_date', 'accounting_class']),
      ('public.approval_requests', ARRAY['id', 'state']),
      ('public.shareholders', ARRAY['id', 'organization_id', 'auth_user_id', 'name', 'is_active', 'deleted_at']),
      ('public.profit_managers', ARRAY['id', 'organization_id', 'auth_user_id', 'name', 'deleted_at']),
      ('public.buildings', ARRAY['id', 'organization_id', 'user_id', 'is_virtual', 'deleted_at', 'created_at']),
      ('public.accounts', ARRAY['id', 'organization_id', 'is_virtual', 'deleted_at']),
      ('public.organization_memberships', ARRAY['id', 'user_id', 'organization_id', 'status', 'valid_from', 'valid_to']),
      ('app_private.canonical_write_operations', ARRAY['organization_id', 'operation', 'subject_scope', 'actor_id',
         'idempotency_key', 'payload_hash', 'subject_id', 'response_payload', 'completed_at', 'actor_membership_id']),
      ('app_private.accounting_chain_writer_xids', ARRAY['transaction_id', 'backend_pid']),
      ('app_private.profit_ledger_markers', ARRAY['id', 'advance_erased', 'supersedes_id', 'ledger_seq']),
      ('app_private.profit_ledger_payouts', ARRAY['voucher_id', 'payee_user_id', 'approval_request_id', 'ledger_seq']),
      ('app_private.profit_ledger_events', ARRAY['event_kind', 'payload']),
      ('app_private.profit_ledger_write_contexts', ARRAY['income_expense_id', 'purpose'])
    ) AS x(rel, cols)
    CROSS JOIN LATERAL unnest(x.cols) AS c(col)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = to_regclass(x.rel) AND a.attname = c.col AND a.attnum > 0 AND NOT a.attisdropped);
  IF v_thieu IS NOT NULL THEN
    RAISE EXCEPTION 'Thiếu bảng/cột nền: %', v_thieu USING ERRCODE = '55000';
  END IF;
  IF to_regclass('app_private.profit_ledger_seq') IS NULL
     OR NOT EXISTS (SELECT 1 FROM app_private.server_feature_flags f WHERE f.feature_key = 'shareholder_profit.ledger_payout.v1') THEN
    RAISE EXCEPTION 'Thiếu nền M1 (sequence profit_ledger_seq hoặc công tắc shareholder_profit.ledger_payout.v1)'
      USING ERRCODE = '55000';
  END IF;
  -- F4 giữ tên trigger: phải đang gắn đúng hàm.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
     WHERE t.tgrelid = 'public.income_expenses'::regclass
       AND t.tgname = 'a00_00_profit_payout_account_guard'
       AND t.tgfoid = 'app_private.guard_profit_payout_scope_compat_v1()'::regprocedure
       AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'Thiếu trigger a00_00_profit_payout_account_guard gắn guard_profit_payout_scope_compat_v1'
      USING ERRCODE = '55000';
  END IF;

  -- [thân production đã rà, thân của chính file này (lượt hai)]
  SELECT replace(p.prosrc, chr(13), '') INTO v_src FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.manager_salary_payout_v1(uuid,numeric,uuid,date,text,text)');
  IF md5(v_src) <> ALL (ARRAY['44af93a19bba496769bbc608f07976da', '7b364f53ecc3c11d6baeecfc638e270c']) THEN
    RAISE EXCEPTION 'manager_salary_payout_v1 đã đổi so với bản đã rà — chụp lại prosrc rồi rà lại' USING ERRCODE = '55000';
  END IF;
  SELECT replace(p.prosrc, chr(13), '') INTO v_src FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('app_private.guard_profit_payout_scope_compat_v1()');
  IF md5(v_src) <> ALL (ARRAY['6d949fed2a66e52bb49ee490146e1a85', 'e6f0764b2b9d4c8de8bf73c2331a4fbb']) THEN
    RAISE EXCEPTION 'guard_profit_payout_scope_compat_v1 đã đổi so với bản đã rà — chụp lại prosrc rồi rà lại' USING ERRCODE = '55000';
  END IF;
  SELECT replace(p.prosrc, chr(13), '') INTO v_src FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.ie_compat_insert_v2(jsonb,jsonb)');
  IF md5(v_src) <> ALL (ARRAY['7c73daff8de8848a8802bb548a6c7e87', '342adaf725191f931739db5ef8c54620']) THEN
    RAISE EXCEPTION 'ie_compat_insert_v2 đã đổi so với bản đã rà (20261030100148) — chụp lại prosrc rồi rà lại' USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- ── 1. Hàm phụ nội bộ (app_private, không cấp EXECUTE cho vai nào) ──────────

-- Công tắc sổ tổng phải ở một trong các route cho phép; trả route. Câu báo KHÔNG dùng
-- chữ "chưa bật" (web coi 55000 + "chưa bật" là tín hiệu rơi về đường cũ).
CREATE OR REPLACE FUNCTION app_private.profit_ledger_tao_assert_route_v1(p_organization_id uuid, p_allowed text[])
RETURNS text
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_route text := app_private.evaluate_feature_route('shareholder_profit.ledger_payout.v1', p_organization_id);
BEGIN
  IF v_route = ANY (p_allowed) THEN
    RETURN v_route;
  END IF;
  IF v_route = 'FROZEN' THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_FROZEN: sổ tổng lợi nhuận đang đóng băng — tạm dừng lập phiếu chi và đặt mốc (huỷ phiếu vẫn làm được)'
      USING ERRCODE = '55000', DETAIL = jsonb_build_object('route', v_route)::text;
  END IF;
  RAISE EXCEPTION 'PROFIT_LEDGER_ROUTE_OFF: sổ tổng lợi nhuận đang tắt ở công ty này — chưa dùng được lệnh này'
    USING ERRCODE = '55000', DETAIL = jsonb_build_object('route', v_route, 'allowed', to_jsonb(p_allowed))::text;
END
$fn$;

-- Cảnh báo của một lần chi (E4 và E5 dùng chung để xem trước khớp lúc lập):
--   ADVANCE                   có phần tạm ứng;
--   ADVANCE_EXCEEDS_ESTIMATE  tổng tạm ứng còn treo SAU lần chi này vượt lợi nhuận ước tính của các tháng
--                             chưa chốt (cảnh báo, không chặn);
--   NEEDS_OWNER_APPROVAL      mọi phiếu chi lợi nhuận đều phải có người thứ hai (chủ) duyệt.
CREATE OR REPLACE FUNCTION app_private.profit_ledger_tao_warnings_v1(
  p_advance numeric,
  p_outstanding_after numeric,
  p_open_estimate numeric
) RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $fn$
  SELECT CASE WHEN COALESCE(p_advance, 0) > 0 THEN
           jsonb_build_array(jsonb_build_object('code', 'ADVANCE', 'advance_amount', p_advance))
           || CASE WHEN COALESCE(p_outstanding_after, p_advance) > COALESCE(p_open_estimate, 0) THEN
                jsonb_build_array(jsonb_build_object('code', 'ADVANCE_EXCEEDS_ESTIMATE',
                  'outstanding_advance', COALESCE(p_outstanding_after, p_advance),
                  'open_estimate', p_open_estimate))
              ELSE '[]'::jsonb END
         ELSE '[]'::jsonb END
         || jsonb_build_array(jsonb_build_object('code', 'NEEDS_OWNER_APPROVAL'))
$fn$;

-- Tháng của mốc: NULL (gỡ mốc) hoặc ngày đầu của một tháng ĐÃ QUA (trước tháng hiện tại của công ty).
-- Mốc ở tháng hiện tại / tương lai sẽ lặng lẽ loại phân bổ của tháng đó khi tháng được chốt về sau.
CREATE OR REPLACE FUNCTION app_private.profit_ledger_tao_check_month_v1(p_org uuid, p_month date)
RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_this_month date;
BEGIN
  IF p_month IS NULL THEN
    RETURN;
  END IF;
  IF NOT isfinite(p_month) OR EXTRACT(DAY FROM p_month) <> 1 THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BAD_MONTH: tháng của mốc phải là ngày đầu tháng' USING ERRCODE = '22023';
  END IF;
  v_this_month := date_trunc('month', public.org_today_v1(p_org)::timestamp)::date;
  IF p_month >= v_this_month THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_MARKER_MONTH: chỉ đặt mốc cho tháng đã qua (trước tháng hiện tại)'
      USING ERRCODE = '22023',
            DETAIL = jsonb_build_object('settled_through_month', p_month, 'current_month', v_this_month)::text;
  END IF;
END
$fn$;

-- Phần tạm ứng mà mốc tháng p_month (đặt NGAY BÂY GIỜ) xoá dấu — E8 và E9 dùng chung:
--   greatest( Σ phần tạm ứng (C2) của mọi phiếu còn sống của chủ thể mà mốc này loại,
--             |min(số dư hiện tại, 0)| ).
-- Mốc giả định "đặt ngay bây giờ" loại MỌI phiếu đang có ⇒ vế đầu là Σ advance_amount của mọi dòng C2
-- còn sống (kể cả dòng đã bị mốc trước loại — đọc nguyên văn hợp đồng, nghiêng về đòi xác nhận).
-- Gỡ mốc (NULL) không loại phiếu nào ⇒ chỉ còn vế sau.
CREATE OR REPLACE FUNCTION app_private.profit_ledger_tao_advance_erased_v1(
  p_org uuid,
  p_kind text,
  p_subject uuid,
  p_settled_through_month date,
  p_balance_now numeric
) RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT GREATEST(
           CASE WHEN p_settled_through_month IS NULL THEN 0::numeric
                ELSE COALESCE((
                  SELECT sum(c.advance_amount)
                    FROM app_private.profit_ledger_payouts c
                   WHERE c.organization_id = p_org
                     AND c.subject_kind = p_kind
                     AND COALESCE(c.shareholder_id, c.manager_id) = p_subject
                     AND app_private.profit_ledger_voucher_live_v1(c.voucher_id)), 0)
           END,
           abs(LEAST(COALESCE(p_balance_now, 0), 0)))
$fn$;

-- ── 2. E4: xem trước một lần chi (STABLE, không khoá, không ghi) ────────────
CREATE OR REPLACE FUNCTION public.shareholder_profit_payout_preview_v1(
  p_shareholder_id uuid,
  p_amount numeric,
  p_account_id uuid
) RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_actor      uuid := auth.uid();
  v_sh         record;
  v_membership uuid;
  v_maker_kind text;
  v_route      text;
  v_bal        jsonb;
  v_balance    numeric;
  v_review     integer;
  v_estimate   numeric;
  v_within     numeric;
  v_advance    numeric;
  v_warnings   jsonb := '[]'::jsonb;
  v_blocked    text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NOT NULL
     AND (p_amount::text IN ('NaN', 'Infinity', '-Infinity') OR p_amount <= 0
          OR round(p_amount, 2) <> p_amount OR p_amount >= 10000000000000) THEN
    RAISE EXCEPTION 'Số tiền chi lợi nhuận không hợp lệ' USING ERRCODE = '22023';
  END IF;

  SELECT s.organization_id, s.auth_user_id, s.is_active, s.deleted_at
    INTO v_sh
    FROM public.shareholders s
   WHERE s.id = p_shareholder_id;
  IF NOT FOUND OR v_sh.organization_id IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy cổ đông trong tổ chức hợp lệ' USING ERRCODE = '42501';
  END IF;

  -- Người gọi phải đang là thành viên của công ty có cổ đông (mọi đường lập đều cần membership).
  SELECT m.id INTO v_membership
    FROM public.organization_memberships m
   WHERE m.user_id = v_actor
     AND m.organization_id = v_sh.organization_id
     AND m.status = 'ACTIVE'
     AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= clock_timestamp()
     AND (m.valid_to IS NULL OR m.valid_to > clock_timestamp())
   ORDER BY m.id
   LIMIT 1;
  IF v_membership IS NULL THEN
    RAISE EXCEPTION 'Không có quyền chi lợi nhuận cổ đông' USING ERRCODE = '42501';
  END IF;

  -- Quyền (không khoá dòng): chủ chi cho mọi cổ đông; người có quyền tạm ứng chỉ xem số của chính mình.
  IF app_private.profit_viewer_can_v1(v_sh.organization_id, 'shareholder_profit.distribute') THEN
    v_maker_kind := 'OWNER';
  ELSIF app_private.profit_viewer_can_v1(v_sh.organization_id, 'shareholder_profit.advance_own_cashbook') THEN
    IF NOT COALESCE(v_sh.auth_user_id = v_actor, false) THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_ADVANCE_SELF_ONLY: quyền tạm ứng chỉ chi cho chính mình' USING ERRCODE = '42501';
    END IF;
    v_maker_kind := 'CUSTODIAN_ADVANCE';
  ELSE
    RAISE EXCEPTION 'Không có quyền chi lợi nhuận cổ đông' USING ERRCODE = '42501';
  END IF;

  IF v_sh.deleted_at IS NOT NULL OR NOT v_sh.is_active THEN
    RAISE EXCEPTION 'Không tìm thấy cổ đông trong tổ chức hợp lệ' USING ERRCODE = '42501';
  END IF;

  IF p_account_id IS NOT NULL THEN
    PERFORM 1
      FROM public.accounts a
     WHERE a.id = p_account_id
       AND a.organization_id = v_sh.organization_id
       AND a.deleted_at IS NULL
       AND NOT a.is_virtual;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sổ quỹ tiền thật không hợp lệ hoặc không thuộc tổ chức' USING ERRCODE = '42501';
    END IF;
    IF v_maker_kind = 'CUSTODIAN_ADVANCE' THEN
      -- assert_cashbook_access_v2 chỉ đọc (không khoá dòng); mọi từ chối của nó là 42501.
      BEGIN
        PERFORM app_private.assert_cashbook_access_v2(v_sh.organization_id, p_account_id, 'CUSTODIAN', v_membership);
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE EXCEPTION 'PROFIT_LEDGER_ADVANCE_CASHBOOK: quyền tạm ứng chỉ chi từ sổ quỹ bạn đang giữ'
          USING ERRCODE = '42501';
      END;
    END IF;
  END IF;

  v_route := app_private.evaluate_feature_route('shareholder_profit.ledger_payout.v1', v_sh.organization_id);
  v_bal := app_private.profit_ledger_balance_v1(v_sh.organization_id, 'SHAREHOLDER', p_shareholder_id);
  v_balance := (v_bal ->> 'balance')::numeric;
  v_review := COALESCE((v_bal -> 'needs_review' ->> 'count')::integer, 0);
  v_estimate := app_private.profit_ledger_open_estimate_v1(v_sh.organization_id, p_shareholder_id);

  IF p_amount IS NOT NULL THEN
    v_within := LEAST(p_amount, GREATEST(v_balance, 0));
    v_advance := p_amount - v_within;
    v_warnings := app_private.profit_ledger_tao_warnings_v1(v_advance, GREATEST(p_amount - v_balance, 0), v_estimate);
  END IF;
  v_blocked := CASE WHEN v_route IS DISTINCT FROM 'CANONICAL' THEN 'ROUTE'
                    WHEN v_review > 0 THEN 'SALARY_REVIEW_PENDING' END;

  RETURN jsonb_build_object(
    'route', v_route,
    'shareholder_id', p_shareholder_id,
    'maker_kind', v_maker_kind,
    'payee_is_maker', COALESCE(v_sh.auth_user_id = v_actor, false),
    'balance_before', v_balance,
    'within_amount', v_within,
    'advance_amount', v_advance,
    'open_estimate', v_estimate,
    'warnings', v_warnings,
    'requires_owner_approval', true,
    'can_submit', v_blocked IS NULL AND p_amount IS NOT NULL AND p_account_id IS NOT NULL,
    'blocked_reason', v_blocked,
    'needs_review', v_bal -> 'needs_review');
END
$fn$;

-- ── 3. E5: lập phiếu chi lợi nhuận theo sổ tổng ─────────────────────────────
-- Thứ tự (hợp đồng v2 mục E + G): đầu vào → khoá công ty → FOR SHARE cổ đông / toà ảo / sổ quỹ /
-- thành viên → quyền → operation → công tắc + nhận lượt → hai khoá ngày → hạng mục → khoá sổ →
-- nextval → số dư, NEEDS_REVIEW, xác nhận tạm ứng → ngữ cảnh CREATE → phiếu + dòng → dòng sổ →
-- gửi duyệt (yêu cầu phải đang chờ duyệt) → nhật ký → dọn ngữ cảnh → chốt operation.
CREATE OR REPLACE FUNCTION public.shareholder_profit_ledger_payout_v1(
  p_shareholder_id uuid,
  p_amount numeric,
  p_account_id uuid,
  p_voucher_date date,
  p_note text,
  p_allow_advance boolean,
  p_idempotency_key text
) RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  c_operation    constant text := 'shareholder_profit.ledger_payout.v1';
  v_actor        uuid := auth.uid();
  v_key          text := btrim(COALESCE(p_idempotency_key, ''));
  v_note         text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_amount       numeric(15,2);
  v_org          uuid;
  v_scope        text;
  v_subject_name text;
  v_payee_user   uuid;
  v_building     uuid;
  v_owner        uuid;
  v_membership   uuid;
  v_authz        boolean;
  v_maker_kind   text;
  v_hash         text;
  v_operation    app_private.canonical_write_operations%ROWTYPE;
  v_closed       date;
  v_type         uuid;
  v_type_forced  boolean;
  v_seq          bigint;
  v_bal          jsonb;
  v_balance      numeric;
  v_within       numeric;
  v_advance      numeric;
  v_estimate     numeric;
  v_warnings     jsonb;
  v_actor_name   text;
  v_voucher      uuid := gen_random_uuid();
  v_request      uuid;
  v_state        text;
  v_response     jsonb;
BEGIN
  -- 1. Đầu vào.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'idempotency_key phải dài 8-200 ký tự ASCII an toàn' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_amount <= 0 OR round(p_amount, 2) <> p_amount OR p_amount >= 10000000000000 THEN
    RAISE EXCEPTION 'Số tiền chi lợi nhuận không hợp lệ' USING ERRCODE = '22023';
  END IF;
  v_amount := p_amount;
  IF p_account_id IS NULL OR p_voucher_date IS NULL THEN
    RAISE EXCEPTION 'Thiếu sổ quỹ hoặc ngày chi' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'Ghi chú dài quá 500 ký tự' USING ERRCODE = '22023';
  END IF;

  -- Công ty của cổ đông: đọc thường (chưa khoá). Người không phải thành viên công ty đó dừng ở đây,
  -- trước khi kịp khoá dòng công ty của người khác.
  SELECT s.organization_id INTO v_org FROM public.shareholders s WHERE s.id = p_shareholder_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy cổ đông trong tổ chức hợp lệ' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
     WHERE m.user_id = v_actor AND m.organization_id = v_org AND m.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'Không có quyền chi lợi nhuận cổ đông' USING ERRCODE = '42501';
  END IF;

  -- 2. Khoá công ty TRƯỚC, rồi mới FOR SHARE (không khoá dòng organizations lần nữa).
  IF app_private.lock_org_for_decision_v1(v_org) IS NULL THEN
    RAISE EXCEPTION 'Tổ chức không còn hoạt động' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(NULLIF(btrim(s.name), ''), 'Cổ đông'), s.auth_user_id
    INTO v_subject_name, v_payee_user
    FROM public.shareholders s
   WHERE s.id = p_shareholder_id
     AND s.organization_id = v_org
     AND s.deleted_at IS NULL
     AND s.is_active
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy cổ đông trong tổ chức hợp lệ' USING ERRCODE = '42501';
  END IF;

  SELECT b.id, b.user_id INTO v_building, v_owner
    FROM public.buildings b
   WHERE b.organization_id = v_org
     AND b.is_virtual
     AND b.deleted_at IS NULL
   ORDER BY b.created_at
   LIMIT 1
   FOR SHARE OF b;
  IF v_building IS NULL THEN
    RAISE EXCEPTION 'Tổ chức chưa có toà ảo để hạch toán chia lợi nhuận' USING ERRCODE = '55000';
  END IF;

  PERFORM 1 FROM public.accounts a
   WHERE a.id = p_account_id
     AND a.organization_id = v_org
     AND a.deleted_at IS NULL
     AND NOT a.is_virtual
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sổ quỹ tiền thật không hợp lệ hoặc không thuộc tổ chức' USING ERRCODE = '42501';
  END IF;

  SELECT m.id INTO v_membership
    FROM public.organization_memberships m
   WHERE m.user_id = v_actor
     AND m.organization_id = v_org
     AND m.status = 'ACTIVE'
     AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= clock_timestamp()
     AND (m.valid_to IS NULL OR m.valid_to > clock_timestamp())
   ORDER BY m.id
   LIMIT 1
   FOR SHARE;
  IF v_membership IS NULL THEN
    RAISE EXCEPTION 'Không còn là thành viên tổ chức' USING ERRCODE = '42501';
  END IF;

  -- 3. Quyền: chủ (distribute) chi cho mọi cổ đông; người được cấp quyền tạm ứng chỉ chi cho
  --    CHÍNH MÌNH, từ sổ quỹ đang GIỮ (CUSTODIAN).
  SELECT allowed INTO v_authz
    FROM app_private.authorize_tenant_action_v3(v_actor, v_org, 'shareholder_profit.distribute', v_building, p_account_id);
  IF COALESCE(v_authz, false) THEN
    v_maker_kind := 'OWNER';
  ELSE
    SELECT allowed INTO v_authz
      FROM app_private.authorize_tenant_action_v3(v_actor, v_org, 'shareholder_profit.advance_own_cashbook', v_building, p_account_id);
    IF NOT COALESCE(v_authz, false) THEN
      RAISE EXCEPTION 'Không có quyền chi lợi nhuận cổ đông' USING ERRCODE = '42501';
    END IF;
    IF v_payee_user IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_ADVANCE_SELF_ONLY: quyền tạm ứng chỉ chi cho chính mình' USING ERRCODE = '42501';
    END IF;
    BEGIN
      PERFORM app_private.assert_cashbook_access_v2(v_org, p_account_id, 'CUSTODIAN', v_membership);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_ADVANCE_CASHBOOK: quyền tạm ứng chỉ chi từ sổ quỹ bạn đang giữ'
        USING ERRCODE = '42501';
    END;
    v_maker_kind := 'CUSTODIAN_ADVANCE';
  END IF;

  -- 4. Idempotency (khoá dùng lại với nội dung khác ⇒ 23505; đã xong ⇒ trả kết quả cũ).
  v_scope := 'SHAREHOLDER:' || p_shareholder_id::text;
  v_hash := md5(jsonb_build_object(
    'shareholder_id', p_shareholder_id,
    'amount', round(p_amount, 2),
    'account_id', p_account_id,
    'voucher_date', p_voucher_date,
    'note', v_note,
    'organization_id', v_org
  )::text);
  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash, actor_membership_id
  ) VALUES (
    v_org, c_operation, v_scope, v_actor, v_key, v_hash, v_membership
  )
  ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key) DO NOTHING;

  SELECT * INTO v_operation
    FROM app_private.canonical_write_operations o
   WHERE o.organization_id = v_org
     AND o.operation = c_operation
     AND o.subject_scope = v_scope
     AND o.actor_id = v_actor
     AND o.idempotency_key = v_key
   FOR UPDATE;
  IF v_operation.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'idempotency_key đã dùng với nội dung khác' USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload;
  END IF;

  -- 5. Công tắc sổ tổng phải BẬT (CANONICAL); nhận lượt (CANARY đếm trần; ON chỉ giữ dòng cờ tới commit).
  PERFORM app_private.profit_ledger_tao_assert_route_v1(v_org, ARRAY['CANONICAL']);
  PERFORM app_private.claim_feature_operation_v1(c_operation, v_org, v_scope, v_actor, v_key, v_amount);

  -- 6. Hai khoá ngày (báo trước, dễ hiểu; trigger vẫn là chốt cuối).
  IF app_private.profit_month_locked_v1(v_building, p_voucher_date) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_PROFIT_MONTH_LOCKED: tháng % của toà ảo đã chốt lợi nhuận — chọn ngày chi khác hoặc mở chốt tháng đó',
      to_char(p_voucher_date, 'MM/YYYY')
      USING ERRCODE = '55000',
            DETAIL = jsonb_build_object('voucher_date', p_voucher_date, 'building_id', v_building)::text;
  END IF;
  v_closed := app_private.cashbook_closed_through_v1(p_account_id);
  IF v_closed IS NOT NULL AND p_voucher_date <= v_closed THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_CASHBOOK_CLOSED: sổ quỹ đã chốt tới ngày % — chọn ngày chi sau ngày đó', v_closed
      USING ERRCODE = '55000',
            DETAIL = jsonb_build_object('closed_through', v_closed, 'voucher_date', p_voucher_date)::text;
  END IF;

  -- Hạng mục chia lợi nhuận: theo rule_key (dự phòng theo tên); phải bắt buộc duyệt.
  SELECT t.id, t.force_approval INTO v_type, v_type_forced
    FROM public.income_expense_types t
   WHERE t.organization_id = v_org
     AND t.rule_key = 'chia_loi_nhuan'
     AND lower(btrim(t.type)) = 'expense'
   ORDER BY t.created_at
   LIMIT 1;
  IF v_type IS NULL THEN
    SELECT t.id, t.force_approval INTO v_type, v_type_forced
      FROM public.income_expense_types t
     WHERE t.organization_id = v_org
       AND t.name = 'Chia lợi nhuận cổ đông'
       AND lower(btrim(t.type)) = 'expense'
     ORDER BY t.created_at
     LIMIT 1;
  END IF;
  IF v_type IS NULL THEN
    INSERT INTO public.income_expense_types (
      user_id, organization_id, name, type, category, description,
      is_default, is_deposit, is_restricted, force_approval,
      system_only, manual_hidden, quick_entry_hidden, internal_transfer, rule_key
    ) VALUES (
      v_owner, v_org, 'Chia lợi nhuận cổ đông', 'expense', 'Chia lợi nhuận',
      'Chi lợi nhuận cổ đông theo sổ tổng; tiền nội bộ, không tính KQKD',
      false, false, true, true,
      true, true, true, true, 'chia_loi_nhuan'
    ) RETURNING id INTO v_type;
  ELSIF NOT COALESCE(v_type_forced, false) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_TYPE_NOT_FORCED: hạng mục "Chia lợi nhuận cổ đông" phải bật "Bắt buộc duyệt" mới lập được phiếu'
      USING ERRCODE = '55000', DETAIL = jsonb_build_object('income_expense_type_id', v_type)::text;
  END IF;

  -- 7. Khoá sổ của cổ đông → thứ tự sổ → số dư.
  PERFORM app_private.profit_ledger_lock_v1(v_org, 'SHAREHOLDER', p_shareholder_id);
  v_seq := nextval('app_private.profit_ledger_seq');
  v_bal := app_private.profit_ledger_balance_v1(v_org, 'SHAREHOLDER', p_shareholder_id);
  IF COALESCE((v_bal -> 'needs_review' ->> 'count')::integer, 0) > 0 THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SALARY_REVIEW_PENDING: cổ đông còn phiếu lương cần chủ xem lại — xác nhận số trước khi chi lợi nhuận'
      USING ERRCODE = '55000', DETAIL = (v_bal -> 'needs_review')::text;
  END IF;
  v_balance := (v_bal ->> 'balance')::numeric;
  v_within := LEAST(v_amount, GREATEST(v_balance, 0));
  v_advance := v_amount - v_within;
  IF v_advance > 0 AND NOT COALESCE(p_allow_advance, false) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_ADVANCE_CONFIRM: số tiền vượt số còn phải trả — phần vượt là tạm ứng lợi nhuận, cần xác nhận'
      USING ERRCODE = '22023',
            DETAIL = jsonb_build_object('balance', v_balance, 'within', v_within, 'advance', v_advance)::text;
  END IF;
  v_estimate := app_private.profit_ledger_open_estimate_v1(v_org, p_shareholder_id);
  v_warnings := app_private.profit_ledger_tao_warnings_v1(v_advance, GREATEST(v_amount - v_balance, 0), v_estimate);

  SELECT COALESCE(NULLIF(btrim(pr.full_name), ''), NULLIF(btrim(pr.email), ''), 'Người dùng')
    INTO v_actor_name
    FROM public.profiles pr
   WHERE pr.id = v_actor;

  -- 8. Ngữ cảnh CREATE → quyền ghi chuỗi kế toán → phiếu (id sinh trước) + dòng → dòng sổ C2.
  --    KHÔNG chèn income_expense_flow_ownership (phiếu flow-owned kiểu khác bị mọi RPC duyệt V2 từ chối).
  INSERT INTO app_private.profit_ledger_write_contexts (income_expense_id, purpose) VALUES (v_voucher, 'CREATE');
  PERFORM app_private.begin_accounting_chain_write_v1();

  INSERT INTO public.income_expenses (
    id, user_id, organization_id, creator_name, type, name,
    building_id, account_id, shareholder_id, total_amount,
    business_result_accounting, approval_status, voucher_date,
    attachments, repeat_cycle, repeat_infinity, repeat_count, repeat_remaining,
    source_payload_hash, system_source, idempotency_key, maker_user_id, maker_membership_id
  ) VALUES (
    v_voucher, v_owner, v_org, COALESCE(v_actor_name, 'Người dùng'), 'EXPENSE',
    COALESCE(v_note, 'Chia lợi nhuận: ' || v_subject_name),
    v_building, p_account_id, p_shareholder_id, v_amount,
    false, 'UNAPPROVED', p_voucher_date,
    '[]'::jsonb, 'NONE', false, 0, 0,
    v_hash, 'profit.ledger_payout', v_key, v_actor, v_membership
  );

  INSERT INTO public.income_expense_items (
    income_expense_id, organization_id, income_expense_type_id,
    description, quantity, unit_price, amount, start_date, end_date, accounting_class
  ) VALUES (
    v_voucher, v_org, v_type,
    v_note, 1, v_amount, v_amount, p_voucher_date, p_voucher_date, 'INTERNAL'
  );

  INSERT INTO app_private.profit_ledger_payouts (
    voucher_id, organization_id, subject_kind, shareholder_id, account_id, amount,
    balance_before, within_amount, advance_amount, open_estimate, warnings,
    maker_user_id, maker_membership_id, maker_kind, payee_is_maker, payee_user_id, ledger_seq
  ) VALUES (
    v_voucher, v_org, 'SHAREHOLDER', p_shareholder_id, p_account_id, v_amount,
    v_balance, v_within, v_advance, v_estimate, v_warnings,
    v_actor, v_membership, v_maker_kind, COALESCE(v_payee_user = v_actor, false), v_payee_user, v_seq
  );

  -- 9. Gửi duyệt rồi ĐỌC LẠI: khác PENDING_APPROVAL (luật DENY, AUTO_POST…) ⇒ huỷ cả lệnh.
  v_request := app_private.submit_financial_request_v1(v_voucher, v_membership, v_actor, v_key || '-sub');
  SELECT ar.state INTO v_state FROM public.approval_requests ar WHERE ar.id = v_request;
  IF v_state IS DISTINCT FROM 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_REQUEST_NOT_PENDING: luật duyệt không đưa phiếu chi lợi nhuận vào hàng chờ duyệt — không lập phiếu'
      USING ERRCODE = '55000',
            DETAIL = jsonb_build_object('approval_request_id', v_request, 'state', v_state)::text;
  END IF;
  UPDATE app_private.profit_ledger_payouts SET approval_request_id = v_request WHERE voucher_id = v_voucher;

  -- 10. Nhật ký, dọn ngữ cảnh, đóng quyền ghi chuỗi, chốt operation.
  INSERT INTO app_private.profit_ledger_events (
    organization_id, event_kind, subject_kind, shareholder_id, voucher_id,
    amount, balance_before, balance_after, actor_id, payload
  ) VALUES (
    v_org, 'PAYOUT_CREATED', 'SHAREHOLDER', p_shareholder_id, v_voucher,
    v_amount, v_balance, v_balance - v_amount, v_actor,
    jsonb_build_object(
      'within_amount', v_within, 'advance_amount', v_advance, 'maker_kind', v_maker_kind,
      'open_estimate', v_estimate, 'warnings', v_warnings, 'approval_request_id', v_request,
      'ledger_seq', v_seq, 'account_id', p_account_id, 'voucher_date', p_voucher_date)
  );
  DELETE FROM app_private.profit_ledger_write_contexts WHERE income_expense_id = v_voucher;
  PERFORM app_private.end_accounting_chain_write_v1();

  v_response := jsonb_build_object(
    'voucher_id', v_voucher,
    'approval_request_id', v_request,
    'shareholder_id', p_shareholder_id,
    'amount', v_amount,
    'within_amount', v_within,
    'advance_amount', v_advance,
    'balance_before', v_balance,
    'warnings', v_warnings,
    'maker_kind', v_maker_kind,
    'state', 'PENDING_APPROVAL'
  );
  UPDATE app_private.canonical_write_operations
     SET subject_id = v_voucher,
         response_payload = v_response,
         completed_at = clock_timestamp()
   WHERE organization_id = v_org
     AND operation = c_operation
     AND subject_scope = v_scope
     AND actor_id = v_actor
     AND idempotency_key = v_key;
  RETURN v_response;
END
$fn$;

-- ── 4. E8: xem trước mốc "đã trả đủ đến hết tháng X" (STABLE) ───────────────
CREATE OR REPLACE FUNCTION public.profit_ledger_marker_preview_v1(
  p_organization_id uuid,
  p_subject_kind text,
  p_subject_id uuid,
  p_settled_through_month date
) RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_actor  uuid := auth.uid();
  v_now    jsonb;
  v_after  jsonb;
  v_erased numeric;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL OR p_subject_id IS NULL OR p_subject_kind IS NULL
     OR p_subject_kind NOT IN ('SHAREHOLDER', 'MANAGER') THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BAD_SUBJECT: thiếu công ty/chủ thể hoặc loại chủ thể không hợp lệ' USING ERRCODE = '22023';
  END IF;
  IF NOT app_private.profit_viewer_can_v1(p_organization_id,
           CASE p_subject_kind WHEN 'SHAREHOLDER' THEN 'shareholder_profit.distribute' ELSE 'shareholder_profit.pay_manager' END) THEN
    RAISE EXCEPTION 'Không có quyền đặt mốc đã trả đủ cho chủ thể này' USING ERRCODE = '42501';
  END IF;
  PERFORM app_private.profit_ledger_tao_check_month_v1(p_organization_id, p_settled_through_month);

  v_now := app_private.profit_ledger_balance_v1(p_organization_id, p_subject_kind, p_subject_id);
  -- Quy ước mốc giả định "đặt ngay bây giờ" của M1: mọi phiếu hiện có nằm trước mốc.
  v_after := app_private.profit_ledger_balance_core_v1(p_organization_id, p_subject_kind, p_subject_id,
               p_settled_through_month, 9223372036854775807, 'infinity');
  v_erased := app_private.profit_ledger_tao_advance_erased_v1(p_organization_id, p_subject_kind, p_subject_id,
                p_settled_through_month, (v_now ->> 'balance')::numeric);

  RETURN jsonb_build_object(
    'route', app_private.evaluate_feature_route('shareholder_profit.ledger_payout.v1', p_organization_id),
    'subject_kind', p_subject_kind,
    'subject_id', p_subject_id,
    'settled_through_month', p_settled_through_month,
    'current_marker', v_now -> 'marker',
    'balance_now', (v_now ->> 'balance')::numeric,
    'balance_after', (v_after ->> 'balance')::numeric,
    'excluded', v_after -> 'excluded_before_marker',
    'advance_erased', v_erased,
    'requires_acknowledge', v_erased > 0);
END
$fn$;

-- ── 5. E9: đặt / đè / gỡ mốc ────────────────────────────────────────────────
-- Phần ghi: không cấp cho vai nào. Gọi được với actor tường minh (migration chuyển đổi Đợt 3);
-- vẫn tự kiểm quyền của actor, công tắc (SHADOW | CANONICAL), idempotency, CAS, xác nhận tạm ứng.
CREATE OR REPLACE FUNCTION app_private.profit_ledger_tao_set_marker_v1(
  p_organization_id uuid,
  p_subject_kind text,
  p_subject_id uuid,
  p_settled_through_month date,
  p_reason text,
  p_expected_marker_id uuid,
  p_acknowledge_advance_erase boolean,
  p_idempotency_key text,
  p_actor uuid
) RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  c_operation  constant text := 'shareholder_profit.ledger_marker.v1';
  v_key        text := btrim(COALESCE(p_idempotency_key, ''));
  v_reason     text := btrim(COALESCE(p_reason, ''));
  v_permission text;
  v_scope      text;
  v_hash       text;
  v_operation  app_private.canonical_write_operations%ROWTYPE;
  v_authz      boolean;
  v_route      text;
  v_seq        bigint;
  v_current    uuid;
  v_now        jsonb;
  v_after      jsonb;
  v_real       jsonb;
  v_erased     numeric;
  v_marker     uuid;
  v_response   jsonb;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'Thiếu người đặt mốc' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL OR p_subject_id IS NULL OR p_subject_kind IS NULL
     OR p_subject_kind NOT IN ('SHAREHOLDER', 'MANAGER') THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BAD_SUBJECT: thiếu công ty/chủ thể hoặc loại chủ thể không hợp lệ' USING ERRCODE = '22023';
  END IF;
  v_permission := CASE p_subject_kind WHEN 'SHAREHOLDER' THEN 'shareholder_profit.distribute'
                                      ELSE 'shareholder_profit.pay_manager' END;
  IF char_length(v_reason) NOT BETWEEN 8 AND 1000 THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BAD_REASON: lý do đặt mốc phải dài 8–1000 ký tự' USING ERRCODE = '22023';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'idempotency_key phải dài 8-200 ký tự ASCII an toàn' USING ERRCODE = '22023';
  END IF;
  PERFORM app_private.profit_ledger_tao_check_month_v1(p_organization_id, p_settled_through_month);

  -- Khoá công ty → quyền của người đặt mốc (cổ đông: distribute; lương điều hành: pay_manager).
  IF app_private.lock_org_for_decision_v1(p_organization_id) IS NULL THEN
    RAISE EXCEPTION 'Tổ chức không còn hoạt động' USING ERRCODE = '42501';
  END IF;
  SELECT allowed INTO v_authz
    FROM app_private.authorize_tenant_action_v3(p_actor, p_organization_id, v_permission, NULL, NULL);
  IF NOT COALESCE(v_authz, false) THEN
    RAISE EXCEPTION 'Không có quyền đặt mốc đã trả đủ (%)', v_permission USING ERRCODE = '42501';
  END IF;
  -- Chủ thể phải thuộc công ty (cổ đông / người nhận đã xoá vẫn đặt mốc được để khép sổ).
  IF p_subject_kind = 'SHAREHOLDER' THEN
    PERFORM 1 FROM public.shareholders s WHERE s.id = p_subject_id AND s.organization_id = p_organization_id;
  ELSE
    PERFORM 1 FROM public.profit_managers m WHERE m.id = p_subject_id AND m.organization_id = p_organization_id;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SUBJECT_NOT_FOUND: chủ thể không thuộc công ty này' USING ERRCODE = 'P0002';
  END IF;

  -- Idempotency: nội dung = (công ty, chủ thể, tháng, lý do). CAS và xác nhận là điều kiện, không phải nội dung.
  v_scope := p_subject_kind || ':' || p_subject_id::text;
  v_hash := md5(jsonb_build_object(
    'organization_id', p_organization_id,
    'subject_kind', p_subject_kind,
    'subject_id', p_subject_id,
    'settled_through_month', p_settled_through_month,
    'reason', v_reason
  )::text);
  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash
  ) VALUES (
    p_organization_id, c_operation, v_scope, p_actor, v_key, v_hash
  )
  ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key) DO NOTHING;
  SELECT * INTO v_operation
    FROM app_private.canonical_write_operations o
   WHERE o.organization_id = p_organization_id
     AND o.operation = c_operation
     AND o.subject_scope = v_scope
     AND o.actor_id = p_actor
     AND o.idempotency_key = v_key
   FOR UPDATE;
  IF v_operation.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'idempotency_key đã dùng với nội dung khác' USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload;
  END IF;

  -- Công tắc: SHADOW hoặc CANONICAL (LEGACY ⇒ tắt, FROZEN ⇒ đóng băng).
  v_route := app_private.profit_ledger_tao_assert_route_v1(p_organization_id, ARRAY['SHADOW', 'CANONICAL']);
  IF v_route = 'CANONICAL' THEN
    PERFORM app_private.claim_feature_operation_v1('shareholder_profit.ledger_payout.v1', p_organization_id,
      v_scope, p_actor, v_key, 0);
  END IF;

  -- Khoá sổ → thứ tự sổ → CAS → tính → xác nhận tạm ứng → ghi.
  PERFORM app_private.profit_ledger_lock_v1(p_organization_id, p_subject_kind, p_subject_id);
  v_seq := nextval('app_private.profit_ledger_seq');
  SELECT mk.marker_id INTO v_current
    FROM app_private.profit_ledger_active_marker_v1(p_organization_id, p_subject_kind, p_subject_id) mk;
  -- PT409 (PostgREST trả HTTP 409), KHÔNG dùng 40001: PostgREST tự chạy lại giao dịch khi gặp 40001
  -- ⇒ CAS sai là điều kiện cố định nên lặp không dừng (đo trên TEST 15/11: client treo rồi 504).
  IF v_current IS DISTINCT FROM p_expected_marker_id THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_MARKER_CHANGED: mốc vừa được người khác đổi — tải lại rồi xem trước lần nữa'
      USING ERRCODE = 'PT409',
            DETAIL = jsonb_build_object('current_marker_id', v_current, 'expected_marker_id', p_expected_marker_id)::text;
  END IF;

  v_now := app_private.profit_ledger_balance_v1(p_organization_id, p_subject_kind, p_subject_id);
  v_after := app_private.profit_ledger_balance_core_v1(p_organization_id, p_subject_kind, p_subject_id,
               p_settled_through_month, 9223372036854775807, 'infinity');
  v_erased := app_private.profit_ledger_tao_advance_erased_v1(p_organization_id, p_subject_kind, p_subject_id,
                p_settled_through_month, (v_now ->> 'balance')::numeric);
  IF v_erased > 0 AND NOT COALESCE(p_acknowledge_advance_erase, false) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_MARKER_ERASES_ADVANCE: mốc này xoá dấu một khoản tạm ứng — cần xác nhận riêng'
      USING ERRCODE = '22023',
            DETAIL = jsonb_build_object('advance_erased', v_erased,
                                        'balance_now', (v_now ->> 'balance')::numeric,
                                        'balance_after', (v_after ->> 'balance')::numeric)::text;
  END IF;

  INSERT INTO app_private.profit_ledger_markers (
    organization_id, subject_kind, shareholder_id, manager_id, settled_through_month,
    reason, supersedes_id, advance_erased, ledger_seq, created_by
  ) VALUES (
    p_organization_id, p_subject_kind,
    CASE WHEN p_subject_kind = 'SHAREHOLDER' THEN p_subject_id END,
    CASE WHEN p_subject_kind = 'MANAGER' THEN p_subject_id END,
    p_settled_through_month, v_reason, v_current, v_erased, v_seq, p_actor
  ) RETURNING id INTO v_marker;

  -- Bất biến: số dư thật ngay sau khi đặt mốc phải đúng số đã xem trước (đang giữ khoá sổ).
  v_real := app_private.profit_ledger_balance_v1(p_organization_id, p_subject_kind, p_subject_id);
  IF (v_real - 'marker') IS DISTINCT FROM (v_after - 'marker') THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_MARKER_MISMATCH: số dư sau khi đặt mốc khác số xem trước — dừng'
      USING ERRCODE = '55000',
            DETAIL = jsonb_build_object('preview', v_after - 'marker', 'actual', v_real - 'marker')::text;
  END IF;

  INSERT INTO app_private.profit_ledger_events (
    organization_id, event_kind, subject_kind, shareholder_id, manager_id, marker_id,
    balance_before, balance_after, actor_id, reason, payload
  ) VALUES (
    p_organization_id, 'MARKER_SET', p_subject_kind,
    CASE WHEN p_subject_kind = 'SHAREHOLDER' THEN p_subject_id END,
    CASE WHEN p_subject_kind = 'MANAGER' THEN p_subject_id END,
    v_marker, (v_now ->> 'balance')::numeric, (v_after ->> 'balance')::numeric, p_actor, v_reason,
    jsonb_build_object(
      'settled_through_month', p_settled_through_month, 'supersedes_id', v_current,
      'advance_erased', v_erased, 'excluded', v_after -> 'excluded_before_marker',
      'ledger_seq', v_seq, 'route', v_route)
  );

  v_response := jsonb_build_object(
    'marker_id', v_marker,
    'settled_through_month', p_settled_through_month,
    'supersedes_id', v_current,
    'balance_before', (v_now ->> 'balance')::numeric,
    'balance_after', (v_after ->> 'balance')::numeric,
    'advance_erased', v_erased
  );
  UPDATE app_private.canonical_write_operations
     SET subject_id = v_marker,
         response_payload = v_response,
         completed_at = clock_timestamp()
   WHERE organization_id = p_organization_id
     AND operation = c_operation
     AND subject_scope = v_scope
     AND actor_id = p_actor
     AND idempotency_key = v_key;
  RETURN v_response;
END
$fn$;

CREATE OR REPLACE FUNCTION public.profit_ledger_set_marker_v1(
  p_organization_id uuid,
  p_subject_kind text,
  p_subject_id uuid,
  p_settled_through_month date,
  p_reason text,
  p_expected_marker_id uuid,
  p_acknowledge_advance_erase boolean,
  p_idempotency_key text
) RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_authz boolean;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL OR p_subject_kind IS NULL OR p_subject_kind NOT IN ('SHAREHOLDER', 'MANAGER') THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BAD_SUBJECT: thiếu công ty hoặc loại chủ thể không hợp lệ' USING ERRCODE = '22023';
  END IF;
  -- Người ngoài công ty dừng trước khi kịp khoá dòng công ty.
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
     WHERE m.user_id = v_actor AND m.organization_id = p_organization_id AND m.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'Không có quyền đặt mốc đã trả đủ' USING ERRCODE = '42501';
  END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT allowed INTO v_authz
    FROM app_private.authorize_tenant_action_v3(v_actor, p_organization_id,
           CASE p_subject_kind WHEN 'SHAREHOLDER' THEN 'shareholder_profit.distribute'
                               ELSE 'shareholder_profit.pay_manager' END, NULL, NULL);
  IF NOT COALESCE(v_authz, false) THEN
    RAISE EXCEPTION 'Không có quyền đặt mốc đã trả đủ' USING ERRCODE = '42501';
  END IF;
  RETURN app_private.profit_ledger_tao_set_marker_v1(
    p_organization_id, p_subject_kind, p_subject_id, p_settled_through_month, p_reason,
    p_expected_marker_id, p_acknowledge_advance_erase, p_idempotency_key, v_actor);
END
$fn$;

-- ── 6. E11: lương điều hành — thay thân, giữ chữ ký / DEFAULT / search_path / ACL ──
-- Phần đầu (đầu vào, quản lý, toà ảo, quyền, thành viên, operation, cờ cũ pay_manager.v1) giữ câu báo
-- và mã lỗi cũ; thứ tự khoá theo G v2 (khoá công ty trước, không FOR SHARE dòng organizations).
-- Thêm: chặn NaN / vô cực ở số tiền (thân cũ lọt NaN); người ngoài công ty dừng trước khi khoá.
CREATE OR REPLACE FUNCTION public.manager_salary_payout_v1(p_manager_id uuid, p_amount numeric, p_account_id uuid, p_voucher_date date, p_note text, p_idempotency_key text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_org uuid; v_building uuid; v_type uuid; v_membership uuid;
  v_subject_name text;
  v_authz boolean; v_key text; v_hash text;
  v_op app_private.canonical_write_operations%rowtype; v_route text;
  v_voucher uuid; v_req uuid; v_name text; v_resp json;
  c_op constant text := 'shareholder_profit.pay_manager.v1';
  -- Sổ tổng lợi nhuận (15/11/2026).
  c_ledger_flag constant text := 'shareholder_profit.ledger_payout.v1';
  v_ledger_route text;
  v_payee_user uuid;
  v_type_forced boolean;
  v_closed date;
  v_seq bigint;
  v_bal jsonb;
  v_balance numeric;
  v_amount numeric(15,2);
  v_state text;
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;

  v_key := btrim(coalesce(p_idempotency_key,''));
  if v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;
  if p_amount is null or p_amount::text in ('NaN', 'Infinity', '-Infinity')
     or p_amount <= 0 or round(p_amount,2) <> p_amount then
    raise exception 'Số tiền lương điều hành không hợp lệ'; end if;
  if p_account_id is null then
    raise exception 'Thiếu sổ quỹ để chi lương điều hành' using errcode='42501'; end if;

  -- [D1] Org resolve từ SUBJECT (quản lý): đọc thường, chưa khoá.
  select m.organization_id into v_org
    from public.profit_managers m
   where m.id = p_manager_id and m.deleted_at is null;
  if not found or v_org is null then
    raise exception 'Không tìm thấy quản lý hoặc quản lý chưa gán tổ chức' using errcode='42501';
  end if;
  -- Người ngoài công ty dừng trước khi kịp khoá dòng công ty (cùng câu báo như khi thiếu quyền).
  if not exists (select 1 from public.organization_memberships mm
                  where mm.user_id = v_actor and mm.organization_id = v_org and mm.status = 'ACTIVE') then
    raise exception 'Không có quyền chi lương quản lý (shareholder_profit.pay_manager)' using errcode='42501';
  end if;

  -- Khoá công ty TRƯỚC, rồi mới FOR SHARE quản lý / toà ảo.
  perform app_private.lock_org_for_decision_v1(v_org);
  select coalesce(nullif(btrim(m.name),''), 'Quản lý'), m.auth_user_id
    into v_subject_name, v_payee_user
    from public.profit_managers m
   where m.id = p_manager_id and m.organization_id = v_org and m.deleted_at is null
   for share;
  if not found then
    raise exception 'Không tìm thấy quản lý hoặc quản lý chưa gán tổ chức' using errcode='42501';
  end if;

  select b.id into v_building
    from public.buildings b
    join public.organizations o on o.id = b.organization_id and o.status = 'ACTIVE'
   where b.organization_id = v_org and b.is_virtual = true and b.deleted_at is null
   order by b.created_at limit 1
   for share of b;
  if v_building is null then
    raise exception 'Tổ chức chưa có toà ảo (Chung) để hạch toán phiếu lương điều hành' using errcode='55000';
  end if;

  -- FORK B: quyền RIÊNG shareholder_profit.pay_manager.
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
  if v_op.completed_at is not null then
    -- Kết quả lưu trước 15/11/2026 chưa có khoá voucher_id: bổ sung khi trả lại.
    if v_op.response_payload ? 'voucher_id' then return v_op.response_payload::json; end if;
    return (v_op.response_payload
            || jsonb_build_object('voucher_id', v_op.response_payload -> 'manager_salary_voucher_id'))::json;
  end if;

  v_route := app_private.evaluate_feature_route(c_op, v_org);
  if v_route <> 'CANONICAL' then raise exception 'Writer lương điều hành chưa bật' using errcode='55000'; end if;

  -- Sổ tổng: ĐÓNG BĂNG ⇒ dừng; BẬT ⇒ nhánh có trần; TẮT / SHADOW ⇒ thân cũ.
  v_ledger_route := app_private.profit_ledger_tao_assert_route_v1(v_org, ARRAY['LEGACY', 'SHADOW', 'CANONICAL']);

  select coalesce(nullif(btrim(full_name),''), nullif(btrim(email),''), 'Người dùng')
    into v_actor_name from public.profiles where id = v_actor;

  if v_ledger_route <> 'CANONICAL' then
    -- ===== Sổ tổng TẮT / SHADOW: thân cũ, chỉ mở quyền ghi chuỗi kế toán để qua chốt F4 =====
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

    perform app_private.begin_accounting_chain_write_v1();
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
    perform app_private.end_accounting_chain_write_v1();

    v_resp := json_build_object(
      'manager_salary_voucher_id', v_voucher, 'approval_request_id', v_req,
      'manager_id', p_manager_id, 'state', 'PENDING_APPROVAL', 'voucher_id', v_voucher);
    update app_private.canonical_write_operations
       set subject_id=v_voucher, response_payload=to_jsonb(v_resp), completed_at=now()
     where organization_id=v_org and operation=c_op and subject_scope=p_manager_id::text
       and actor_id=v_actor and idempotency_key=v_key;
    return v_resp;
  end if;

  -- ===== Sổ tổng BẬT: sổ lương điều hành, không chi quá số còn lại, không tạm ứng =====
  v_amount := round(p_amount, 2);
  perform app_private.claim_feature_operation_v1(c_ledger_flag, v_org, 'MANAGER:' || p_manager_id::text,
    v_actor, v_key, v_amount);
  perform 1 from public.accounts a
   where a.id = p_account_id and a.organization_id = v_org and a.deleted_at is null and not a.is_virtual
   for share;
  if not found then
    raise exception 'Sổ quỹ tiền thật không hợp lệ hoặc không thuộc tổ chức' using errcode='42501';
  end if;
  if p_voucher_date is null then
    raise exception 'Thiếu ngày chi' using errcode='22023';
  end if;
  if app_private.profit_month_locked_v1(v_building, p_voucher_date) then
    raise exception 'PROFIT_LEDGER_PROFIT_MONTH_LOCKED: tháng % của toà ảo đã chốt lợi nhuận — chọn ngày chi khác hoặc mở chốt tháng đó',
      to_char(p_voucher_date, 'MM/YYYY')
      using errcode = '55000',
            detail = jsonb_build_object('voucher_date', p_voucher_date, 'building_id', v_building)::text;
  end if;
  v_closed := app_private.cashbook_closed_through_v1(p_account_id);
  if v_closed is not null and p_voucher_date <= v_closed then
    raise exception 'PROFIT_LEDGER_CASHBOOK_CLOSED: sổ quỹ đã chốt tới ngày % — chọn ngày chi sau ngày đó', v_closed
      using errcode = '55000',
            detail = jsonb_build_object('closed_through', v_closed, 'voucher_date', p_voucher_date)::text;
  end if;

  -- Hạng mục 'Lương điều hành' theo rule_key (dự phòng theo tên như thân cũ); phải bắt buộc duyệt.
  select t.id, t.force_approval into v_type, v_type_forced
    from public.income_expense_types t
   where t.organization_id = v_org and t.rule_key = 'luong_dieu_hanh' and lower(btrim(t.type)) = 'expense'
   order by t.created_at limit 1;
  if v_type is null then
    select t.id, t.force_approval into v_type, v_type_forced
      from public.income_expense_types t
     where t.organization_id = v_org and lower(t.type) = 'expense' and t.name = 'Lương điều hành'
     order by t.created_at limit 1;
  end if;
  if v_type is null then
    insert into public.income_expense_types
      (user_id, organization_id, name, type, category, is_default, is_deposit, is_restricted,
       force_approval, system_only, manual_hidden, quick_entry_hidden, rule_key)
    values (v_actor, v_org, 'Lương điều hành', 'expense', 'Chia lợi nhuận', false, false, true,
       true, true, true, true, 'luong_dieu_hanh')
    returning id into v_type;
  elsif not coalesce(v_type_forced, false) then
    raise exception 'PROFIT_LEDGER_TYPE_NOT_FORCED: hạng mục "Lương điều hành" phải bật "Bắt buộc duyệt" mới lập được phiếu'
      using errcode = '55000', detail = jsonb_build_object('income_expense_type_id', v_type)::text;
  end if;

  -- Khoá sổ MANAGER → thứ tự sổ → số dư; vượt số còn lại ⇒ 22023.
  perform app_private.profit_ledger_lock_v1(v_org, 'MANAGER', p_manager_id);
  v_seq := nextval('app_private.profit_ledger_seq');
  v_bal := app_private.profit_ledger_balance_v1(v_org, 'MANAGER', p_manager_id);
  v_balance := (v_bal ->> 'balance')::numeric;
  if v_amount > v_balance then
    raise exception 'PROFIT_MANAGER_LEDGER_OVERDRAW: số tiền vượt lương điều hành còn lại — không chi quá, không tạm ứng'
      using errcode = '22023',
            detail = jsonb_build_object('balance', v_balance, 'amount', v_amount, 'over', v_amount - v_balance)::text;
  end if;

  v_name := coalesce(nullif(btrim(coalesce(p_note,'')),''), 'Lương điều hành: ' || v_subject_name);
  v_voucher := gen_random_uuid();
  insert into app_private.profit_ledger_write_contexts (income_expense_id, purpose) values (v_voucher, 'CREATE');
  perform app_private.begin_accounting_chain_write_v1();
  insert into public.income_expenses (
    id, user_id, organization_id, creator_name, type, name,
    building_id, account_id, profit_manager_id, total_amount,
    business_result_accounting, approval_status, voucher_date,
    attachments, repeat_cycle, repeat_infinity, repeat_count, repeat_remaining,
    source_payload_hash, system_source, idempotency_key, maker_user_id, maker_membership_id
  ) values (
    v_voucher, v_actor, v_org, coalesce(v_actor_name,'Người dùng'), 'EXPENSE', v_name,
    v_building, p_account_id, p_manager_id, v_amount,
    false, 'UNAPPROVED', p_voucher_date,
    '[]'::jsonb, 'NONE', false, 0, 0,
    v_hash, 'profit.manager_salary', v_key, v_actor, v_membership
  );
  insert into public.income_expense_items (
    income_expense_id, organization_id, income_expense_type_id,
    description, quantity, unit_price, start_date, end_date
  ) values (
    v_voucher, v_org, v_type,
    nullif(btrim(coalesce(p_note,'')),''), 1, v_amount, p_voucher_date, p_voucher_date
  );
  insert into app_private.profit_ledger_payouts (
    voucher_id, organization_id, subject_kind, manager_id, account_id, amount,
    balance_before, within_amount, advance_amount, open_estimate, warnings,
    maker_user_id, maker_membership_id, maker_kind, payee_is_maker, payee_user_id, ledger_seq
  ) values (
    v_voucher, v_org, 'MANAGER', p_manager_id, p_account_id, v_amount,
    v_balance, v_amount, 0, null, '[]'::jsonb,
    v_actor, v_membership, 'OWNER', coalesce(v_payee_user = v_actor, false), v_payee_user, v_seq
  );

  v_req := app_private.submit_financial_request_v1(v_voucher, v_membership, v_actor, v_key || '-sub');
  select ar.state into v_state from public.approval_requests ar where ar.id = v_req;
  if v_state is distinct from 'PENDING_APPROVAL' then
    raise exception 'PROFIT_LEDGER_REQUEST_NOT_PENDING: luật duyệt không đưa phiếu lương điều hành vào hàng chờ duyệt — không lập phiếu'
      using errcode = '55000', detail = jsonb_build_object('approval_request_id', v_req, 'state', v_state)::text;
  end if;
  update app_private.profit_ledger_payouts set approval_request_id = v_req where voucher_id = v_voucher;

  insert into app_private.profit_ledger_events (
    organization_id, event_kind, subject_kind, manager_id, voucher_id,
    amount, balance_before, balance_after, actor_id, payload
  ) values (
    v_org, 'PAYOUT_CREATED', 'MANAGER', p_manager_id, v_voucher,
    v_amount, v_balance, v_balance - v_amount, v_actor,
    jsonb_build_object('approval_request_id', v_req, 'ledger_seq', v_seq, 'account_id', p_account_id,
                       'voucher_date', p_voucher_date)
  );
  delete from app_private.profit_ledger_write_contexts where income_expense_id = v_voucher;
  perform app_private.end_accounting_chain_write_v1();

  v_resp := json_build_object(
    'manager_salary_voucher_id', v_voucher, 'approval_request_id', v_req,
    'manager_id', p_manager_id, 'state', 'PENDING_APPROVAL', 'voucher_id', v_voucher,
    'balance_before', v_balance);
  update app_private.canonical_write_operations
     set subject_id=v_voucher, response_payload=to_jsonb(v_resp), completed_at=now()
   where organization_id=v_org and operation=c_op and subject_scope=p_manager_id::text
     and actor_id=v_actor and idempotency_key=v_key;
  return v_resp;
end;
$function$;

-- ── 7. F4: chốt phạm vi phiếu chi lợi nhuận (thân production + hai chỗ sửa) ──
CREATE OR REPLACE FUNCTION app_private.guard_profit_payout_scope_compat_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_is_payout boolean := false;
  v_doi_chu_the boolean := false;
BEGIN
  v_is_payout := NEW.shareholder_id IS NOT NULL
    OR NEW.profit_manager_id IS NOT NULL
    OR COALESCE(
      NEW.system_source IN ('profit.distribution', 'profit.manager_salary', 'profit.ledger_payout'),
      false
    );

  IF TG_OP = 'UPDATE' THEN
    v_is_payout := v_is_payout
      OR OLD.shareholder_id IS NOT NULL
      OR OLD.profit_manager_id IS NOT NULL
      OR COALESCE(
        OLD.system_source IN ('profit.distribution', 'profit.manager_salary', 'profit.ledger_payout'),
        false
      );
  END IF;

  v_is_payout := v_is_payout OR EXISTS (
    SELECT 1
    FROM public.profit_payout_reservations reservation
    WHERE reservation.payout_voucher_id = NEW.id
  ) OR EXISTS (
    SELECT 1
    FROM public.approval_requests request_row
    WHERE request_row.subject_type = 'FINANCIAL_VOUCHER'
      AND request_row.subject_id = NEW.id
      AND request_row.system_source = 'profit.distribution'
  );

  IF NOT v_is_payout THEN
    RETURN NEW;
  END IF;

  -- 15/11/2026 (sổ tổng lợi nhuận): phiếu mang nguồn của sổ tổng chỉ sinh từ lệnh lập (E5 / E11):
  -- có ngữ cảnh LẬP (C6 'CREATE') của chính phiếu, đang chờ duyệt, chưa ghi sổ. Chốt F1 chỉ gác
  -- UPDATE / DELETE, mà approval_status mặc định 'APPROVED' và cầu a85b tự ghi sổ phiếu chèn ở trạng
  -- thái đó ⇒ chèn thẳng phiếu đã duyệt sẽ ra tiền mà không qua ai.
  IF TG_OP = 'INSERT'
     AND NEW.system_source IN ('profit.ledger_payout', 'profit.manager_salary')
     AND (COALESCE(app_private.profit_ledger_write_context_v1(NEW.id) <> 'CREATE', true)
          OR NEW.approval_status IS DISTINCT FROM 'UNAPPROVED'
          OR NEW.posting_status IS NOT DISTINCT FROM 'POSTED') THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_CREATE_ONLY: phiếu chi theo sổ tổng chỉ được lập bằng lệnh lập phiếu của sổ tổng, ở trạng thái chờ duyệt'
      USING ERRCODE = '55000';
  END IF;

  -- 15/11/2026 (sổ tổng lợi nhuận): gắn hoặc đổi cổ đông / người nhận lương điều hành
  -- trên phiếu chỉ do lệnh chi lợi nhuận của hệ thống làm (đã mở quyền ghi chuỗi kế toán
  -- bằng app_private.begin_accounting_chain_write_v1). Bước ghi sổ V2 đặt lại account_id
  -- mà không đổi hai cột này nên không bị đòi.
  IF TG_OP = 'INSERT' THEN
    v_doi_chu_the := NEW.shareholder_id IS NOT NULL OR NEW.profit_manager_id IS NOT NULL;
  ELSE
    v_doi_chu_the := NEW.shareholder_id IS DISTINCT FROM OLD.shareholder_id
      OR NEW.profit_manager_id IS DISTINCT FROM OLD.profit_manager_id;
  END IF;
  IF v_doi_chu_the AND NOT EXISTS (
    SELECT 1
    FROM app_private.accounting_chain_writer_xids capability
    WHERE capability.transaction_id = txid_current()
      AND capability.backend_pid = pg_backend_pid()
  ) THEN
    RAISE EXCEPTION 'PROFIT_PAYOUT_CHAIN_WRITER_REQUIRED: chỉ lệnh chi lợi nhuận của hệ thống mới được gắn hoặc đổi cổ đông / người nhận lương điều hành trên phiếu'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.shareholder_id IS NOT NULL AND NEW.profit_manager_id IS NOT NULL THEN
    RAISE EXCEPTION 'Profit payout cannot target both a shareholder and a manager'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.account_id IS NULL THEN
    RAISE EXCEPTION 'Profit payout requires a real cashbook account'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM public.accounts account_row
  WHERE account_row.id = NEW.account_id
    AND account_row.organization_id = NEW.organization_id
    AND account_row.deleted_at IS NULL
    AND NOT account_row.is_virtual
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profit payout account must be active, real and in the same organization'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.shareholder_id IS NOT NULL THEN
    PERFORM 1
    FROM public.shareholders shareholder_row
    WHERE shareholder_row.id = NEW.shareholder_id
      AND shareholder_row.organization_id = NEW.organization_id
      AND shareholder_row.deleted_at IS NULL
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Profit payout shareholder must belong to the same organization'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.profit_manager_id IS NOT NULL THEN
    PERFORM 1
    FROM public.profit_managers manager_row
    WHERE manager_row.id = NEW.profit_manager_id
      AND manager_row.organization_id = NEW.organization_id
      AND manager_row.deleted_at IS NULL
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Manager payout target must belong to the same organization'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'Profit payout cannot clear its shareholder/manager identity'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.profit_payout_reservations reservation
    WHERE reservation.payout_voucher_id = NEW.id
      AND (
        reservation.organization_id IS DISTINCT FROM NEW.organization_id
        OR reservation.shareholder_id IS DISTINCT FROM NEW.shareholder_id
      )
  ) THEN
    RAISE EXCEPTION 'Historical payout no longer matches its reservation identity'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.approval_requests request_row
    WHERE request_row.subject_type = 'FINANCIAL_VOUCHER'
      AND request_row.subject_id = NEW.id
      AND request_row.system_source = 'profit.distribution'
      AND (
        request_row.organization_id IS DISTINCT FROM NEW.organization_id
        OR request_row.cashbook_id IS DISTINCT FROM NEW.account_id
      )
  ) THEN
    RAISE EXCEPTION 'Historical payout no longer matches its approval request'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$function$;

-- ── 8. D1.8: đóng các cửa lập tay ───────────────────────────────────────────
-- (a) Hai hạng mục chỉ hệ thống dùng, ẩn khỏi ô chọn ở Thu chi và Báo chi nhanh, nhóm 'Chia lợi nhuận'.
--     force_approval và internal_transfer giữ nguyên. Chỉ đụng dòng còn lệch (chạy lại không ghi gì).
UPDATE public.income_expense_types t
   SET system_only = true,
       manual_hidden = true,
       quick_entry_hidden = true,
       category = 'Chia lợi nhuận'
 WHERE t.rule_key IN ('chia_loi_nhuan', 'luong_dieu_hanh')
   AND (t.system_only IS DISTINCT FROM true
        OR t.manual_hidden IS DISTINCT FROM true
        OR t.quick_entry_hidden IS DISTINCT FROM true
        OR t.category IS DISTINCT FROM 'Chia lợi nhuận');

-- (b) ie_compat_insert_v2: lột thêm shareholder_id, profit_manager_id (thân 20261030100148 + đúng hai chỗ).
CREATE OR REPLACE FUNCTION public.ie_compat_insert_v2(p_row jsonb, p_items jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_org              uuid;
  v_colrec           record;
  v_defj             jsonb;
  v_actor            record;
  v_id               uuid;
  v_clean            jsonb;
  v_item             jsonb;
  v_items            jsonb := coalesce(p_items, '[]'::jsonb);
  v_draft_marker     text := nullif(btrim(coalesce(p_row ->> 'copilot_draft_marker', '')), '');
  v_copilot_draft    boolean := false;
  v_input_item       jsonb;
  v_item_type_id     uuid;
  v_item_quantity    numeric;
  v_item_unit_price  numeric;
  v_item_amount      numeric;
BEGIN
  -- A browser can send a marker-shaped field, but only the execute RPC can
  -- create a matching private row in this transaction.  Delete the row here
  -- so the capability is single-use even if the writer is called twice.
  IF v_draft_marker IS NOT NULL THEN
    DELETE FROM app_private.copilot_ie_writer_context_v1 c
     WHERE c.transaction_id = pg_current_xact_id()::text
       AND c.actor_id = auth.uid()
       AND c.context_name = 'copilot_execute_income_expense_v1'
       AND c.marker_digest = extensions.digest(
             convert_to(v_draft_marker, 'UTF8'), 'sha256')
       AND c.created_at > clock_timestamp() - interval '10 minutes'
       AND EXISTS (
         SELECT 1
           FROM app_private.copilot_ie_writer_capabilities_v1 cap
          WHERE cap.capability_key = 'income_expense_draft_v1'
            AND cap.enabled
       )
    RETURNING c.organization_id INTO v_org;
    v_copilot_draft := FOUND;
  END IF;

  IF v_copilot_draft THEN
    -- The private context owns organization identity.  A mismatching payload
    -- is an invariant failure, not a chance to fall back to another org.
    BEGIN
      IF (p_row ->> 'organization_id') IS NOT NULL
         AND (p_row ->> 'organization_id')::uuid IS DISTINCT FROM v_org THEN
        RAISE EXCEPTION 'copilot organization mismatch' USING ERRCODE = '42501';
      END IF;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'copilot organization mismatch' USING ERRCODE = '42501';
    END;
  ELSE
    -- Preserve the established resolution behavior for ordinary callers.
    v_org := COALESCE(
      (SELECT a.organization_id
         FROM public.accounts a
        WHERE a.id = (p_row ->> 'account_id')::uuid),
      (SELECT b.organization_id
         FROM public.buildings b
        WHERE b.id = (p_row ->> 'building_id')::uuid),
      (p_row ->> 'organization_id')::uuid);
    IF v_org IS NULL THEN
      SELECT m.organization_id INTO v_org
        FROM public.organization_memberships m
       WHERE m.user_id = auth.uid()
         AND m.status = 'ACTIVE'
       LIMIT 1;
    END IF;
  END IF;

  SELECT * INTO v_actor FROM app_private.ie_compat_actor_v2(v_org);
  IF v_actor.membership_id IS NULL THEN
    RAISE EXCEPTION 'active organization membership required' USING ERRCODE = '42501';
  END IF;

  -- Preserve the existing possession guard for callers that select a book.
  -- The Copilot path always strips account_id before the insert.
  IF (p_row ->> 'account_id') IS NOT NULL AND NOT v_copilot_draft THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.cashbook_possession_bindings b
       WHERE b.organization_id = v_org
         AND b.cashbook_id = (p_row ->> 'account_id')::uuid
         AND b.membership_id = v_actor.membership_id
         AND b.valid_to IS NULL
         AND (b.possession_kind = 'CUSTODIAN'
              OR (b.possession_kind = 'KNOWER'
                  AND COALESCE(p_row ->> 'type', '') = 'INCOME'))
    ) THEN
      RAISE EXCEPTION 'cashbook possession is not permitted' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_copilot_draft THEN
    -- Re-resolve the building and item type inside the writer.  The execute
    -- RPC checks these too, but this is the final server-side boundary before
    -- a shared writer and its triggers observe any values.
    IF upper(coalesce(p_row ->> 'type', '')) NOT IN ('INCOME', 'EXPENSE') THEN
      RAISE EXCEPTION 'copilot type is invalid' USING ERRCODE = '22023';
    END IF;
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM public.buildings b
         WHERE b.id = (p_row ->> 'building_id')::uuid
           AND b.organization_id = v_org
           AND b.deleted_at IS NULL
      ) THEN
        RAISE EXCEPTION 'copilot building is not in organization' USING ERRCODE = '42501';
      END IF;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'copilot building is invalid' USING ERRCODE = '22023';
    END;

    IF jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) <> 1 THEN
      RAISE EXCEPTION 'copilot requires exactly one item' USING ERRCODE = '22023';
    END IF;
    v_input_item := v_items -> 0;
    IF jsonb_typeof(v_input_item) <> 'object' THEN
      RAISE EXCEPTION 'copilot item must be an object' USING ERRCODE = '22023';
    END IF;

    BEGIN
      v_item_type_id := NULLIF(v_input_item ->> 'income_expense_type_id', '')::uuid;
      v_item_quantity := COALESCE(NULLIF(v_input_item ->> 'quantity', '')::numeric, 1);
      v_item_unit_price := NULLIF(v_input_item ->> 'unit_price', '')::numeric;
      v_item_amount := NULLIF(v_input_item ->> 'amount', '')::numeric;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'copilot item amount or type is invalid' USING ERRCODE = '22023';
    END;
    IF v_item_type_id IS NULL OR v_item_quantity IS NULL
       OR v_item_quantity <> 1 THEN
      RAISE EXCEPTION 'copilot item quantity or type is invalid' USING ERRCODE = '22023';
    END IF;
    IF v_item_unit_price IS NULL THEN
      v_item_unit_price := v_item_amount;
    END IF;
    IF v_item_amount IS NULL THEN
      v_item_amount := v_item_quantity * v_item_unit_price;
    END IF;
    IF v_item_unit_price IS NULL OR v_item_amount IS NULL
       OR v_item_unit_price::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_item_amount::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_item_unit_price <= 0
       OR v_item_amount <= 0
       OR v_item_amount IS DISTINCT FROM v_item_quantity * v_item_unit_price THEN
      RAISE EXCEPTION 'copilot item amount is invalid' USING ERRCODE = '22023';
    END IF;

    PERFORM 1
      FROM public.income_expense_types t
     WHERE t.id = v_item_type_id
       AND t.organization_id = v_org
       AND lower(t.type) = lower(p_row ->> 'type')
       AND NOT coalesce(t.system_only, false)
       AND (
         NOT coalesce(t.is_restricted, false)
         OR public.can_create_restricted_ie()
       )
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'copilot income/expense type is not permitted' USING ERRCODE = '42501';
    END IF;

    -- Rebuild the line from the allowlist.  Client-supplied organization,
    -- accounting class, lifecycle, and arbitrary columns never reach INSERT.
    v_items := jsonb_build_array(
      jsonb_build_object(
        'income_expense_type_id', v_item_type_id,
        'organization_id',        v_org,
        'description',            COALESCE(
          NULLIF(btrim(v_input_item ->> 'description'), ''),
          p_row ->> 'name'),
        'quantity',               1,
        'unit_price',             v_item_unit_price,
        'amount',                 v_item_amount
      )
    );
  END IF;

  -- Strip server-owned fields before applying the mode-specific values.
  -- 30/10/2026: lột cả cột hoa hồng và dấu nguồn hệ thống. commission_kind chỉ do
  -- trigger hạng mục suy ra; commission_legacy_dup về mặc định false (cờ chỉ dành
  -- cho phiếu trùng có trước 09/07/2026, xem trigger z97_commission_legacy_dup_guard);
  -- system_source là dấu của luồng nghiệp vụ, màn hình dùng để phân loại phiếu.
  -- Trước đây người gọi tự khai commission_kind + cờ legacy với p_items rỗng là lập
  -- được phiếu hoa hồng sống thứ hai cho cùng hợp đồng.
  -- 15/11/2026 (sổ tổng lợi nhuận): lột cả shareholder_id, profit_manager_id. Phiếu chi lợi
  -- nhuận cổ đông / lương điều hành chỉ sinh từ lệnh của sổ tổng
  -- (shareholder_profit_ledger_payout_v1, manager_salary_payout_v1); phiếu thường mang hai
  -- cột này sẽ bị trừ thẳng vào số dư sổ tổng của người đó.
  v_clean := p_row - ARRAY[
    'approval_status', 'approved_by', 'approved_at', 'posting_id',
    'posted_at_v2', 'posting_mode', 'posting_status', 'active_posting_id_v2',
    'reversed_by_posting_id', 'deleted_at', 'maker_user_id',
    'maker_membership_id', 'birth_operation_id', 'birth_txid', 'review_state',
    'commission_kind', 'commission_legacy_dup', 'system_source',
    'shareholder_id', 'profit_manager_id',
    'organization_id', 'user_id', 'copilot_draft_marker', 'copilot_draft_only'
  ]::text[];

  v_clean := v_clean || jsonb_build_object(
    'organization_id', v_org,
    'user_id', auth.uid(),
    'approval_status', CASE
      WHEN v_copilot_draft THEN 'UNAPPROVED'
      WHEN COALESCE(p_row ->> 'type', '') = 'INCOME'
           AND COALESCE(p_row ->> 'repeat_cycle', 'NONE') = 'NONE'
        THEN 'APPROVED'
      ELSE 'UNAPPROVED'
    END,
    'review_state', CASE
      WHEN v_copilot_draft THEN 'PENDING'
      WHEN COALESCE(p_row ->> 'type', '') = 'INCOME'
           AND COALESCE(p_row ->> 'repeat_cycle', 'NONE') = 'NONE'
        THEN 'RESOLVED'
      ELSE 'PENDING'
    END,
    'approved_by', CASE
      WHEN v_copilot_draft THEN NULL::uuid
      WHEN COALESCE(p_row ->> 'type', '') = 'INCOME'
           AND COALESCE(p_row ->> 'repeat_cycle', 'NONE') = 'NONE'
        THEN auth.uid()
      ELSE NULL::uuid
    END,
    'approved_at', CASE
      WHEN v_copilot_draft THEN NULL::timestamptz
      WHEN COALESCE(p_row ->> 'type', '') = 'INCOME'
           AND COALESCE(p_row ->> 'repeat_cycle', 'NONE') = 'NONE'
        THEN now()
      ELSE NULL::timestamptz
    END,
    'posting_mode', 'CASHBOOK',
    'posting_status', 'UNPOSTED',
    'maker_user_id', auth.uid(),
    'maker_membership_id', v_actor.membership_id
  );

  -- Ordinary callers retain the established user override; the Copilot
  -- branch above always keeps the authenticated actor as the owner.
  IF NOT v_copilot_draft THEN
    v_clean := v_clean || jsonb_build_object(
      'user_id', COALESCE((p_row ->> 'user_id')::uuid, auth.uid())
    );
  END IF;

  IF p_row ? 'id' AND NOT v_copilot_draft THEN
    v_clean := v_clean || jsonb_build_object('id', (p_row ->> 'id')::uuid);
  END IF;

  IF v_copilot_draft THEN
    -- Draft mode has no cashbook, posting, approval, recurrence, or source
    -- linkage.  Derived accounting fields are left to their server triggers.
    v_clean := (v_clean - ARRAY[
      'id', 'code', 'account_id', 'contract_id', 'invoice_id', 'payment_id',
      'payment_collection_id', 'handover_id', 'handover_transfer_id',
      'room_id', 'bed_id', 'tenant_id', 'shareholder_id', 'profit_manager_id', 'utility_account_id',
      'approval_request_id', 'approval_version', 'posting_version',
      'review_version', 'review_reason', 'review_deadline',
      'review_owner_membership_id', 'verified_at', 'verified_by',
      'verified_by_name', 'verified_note', 'cancellation_kind',
      'source_payload_hash', 'recognition_source_mode', 'recognition_date',
      'system_source', 'idempotency_key', 'business_result_accounting',
      'counts_in_business_result', 'has_restricted_item', 'kqkd_amount',
      'repeat_cycle', 'repeat_infinity', 'repeat_count', 'repeat_auto_approve',
      'repeat_next_date', 'repeat_parent_id', 'repeat_remaining',
      'active_posting_id_v2', 'posting_id', 'posted_at_v2',
      'reversed_by_posting_id', 'approved_by', 'approved_at', 'review_state',
      'posting_mode', 'posting_status', 'total_amount'
    ]::text[]) || jsonb_build_object(
      'account_id', NULL::uuid,
      'contract_id', NULL::uuid,
      'invoice_id', NULL::uuid,
      'payment_id', NULL::uuid,
      'room_id', NULL::uuid,
      'bed_id', NULL::uuid,
      'tenant_id', NULL::uuid,
      'approval_status', 'UNAPPROVED',
      'review_state', 'PENDING',
      'approved_by', NULL::uuid,
      'approved_at', NULL::timestamptz,
      'posting_mode', 'CASHBOOK',
      'posting_status', 'UNPOSTED',
      'repeat_cycle', 'NONE',
      'repeat_infinity', false,
      'repeat_count', 0,
      'repeat_auto_approve', false,
      'repeat_next_date', NULL::date,
      'repeat_parent_id', NULL::uuid,
      'repeat_remaining', 0,
      'total_amount', v_item_amount
    );
  END IF;

  -- jsonb_populate_record makes absent columns explicit NULLs, so preserve
  -- the established generic default-fill behavior for NOT NULL columns.
  IF (v_clean ->> 'total_amount') IS NULL THEN
    v_clean := v_clean || jsonb_build_object('total_amount', COALESCE((
      SELECT SUM(COALESCE((i ->> 'amount')::numeric,
                          COALESCE((i ->> 'quantity')::numeric, 1)
                          * COALESCE((i ->> 'unit_price')::numeric, 0)))
        FROM jsonb_array_elements(v_items) i), 0));
  END IF;

  FOR v_colrec IN
    SELECT c.column_name, c.column_default
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'income_expenses'
       AND c.is_nullable = 'NO'
       AND c.column_default IS NOT NULL
  LOOP
    IF (v_clean ->> v_colrec.column_name) IS NULL THEN
      EXECUTE format('SELECT to_jsonb(%s)', v_colrec.column_default) INTO v_defj;
      v_clean := v_clean || jsonb_build_object(v_colrec.column_name, v_defj);
    END IF;
  END LOOP;

  -- Danh mục chi chuẩn (03/10/2026): hạng mục CHI chỉ-hệ-thống (hoa hồng môi
  -- giới, thưởng nóng sale, các mục cọc/thanh lý) chỉ sinh từ luồng nghiệp vụ của
  -- chúng — các luồng đó ghi thẳng, không đi qua hàm này. Trang Thu chi bị
  -- create_income_expense_v1 từ chối (0A000) rồi tự rơi sang đây và lập tay được.
  -- Chặn trước mọi lệnh ghi. Nhánh Copilot đã kiểm riêng ở trên.
  IF NOT v_copilot_draft AND EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_items) e
      JOIN public.income_expense_types t
        ON t.id = nullif(e ->> 'income_expense_type_id', '')::uuid
     WHERE coalesce(t.system_only, false)
       AND lower(btrim(t.type)) = 'expense'
  ) THEN
    RAISE EXCEPTION 'Hạng mục này chỉ được tạo từ luồng nghiệp vụ (hợp đồng, phiếu cọc, thanh lý), không lập tay ở Thu chi'
      USING ERRCODE = '42501', HINT = 'ie_system_only_manual_blocked';
  END IF;

  INSERT INTO public.income_expenses
  SELECT * FROM jsonb_populate_record(NULL::public.income_expenses, v_clean)
  RETURNING id INTO v_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_item := (v_item - 'income_expense_id')
              || jsonb_build_object('income_expense_id', v_id);
    FOR v_colrec IN
      SELECT c.column_name, c.column_default
        FROM information_schema.columns c
       WHERE c.table_schema = 'public'
         AND c.table_name = 'income_expense_items'
         AND c.is_nullable = 'NO'
         AND c.column_default IS NOT NULL
    LOOP
      IF (v_item ->> v_colrec.column_name) IS NULL THEN
        EXECUTE format('SELECT to_jsonb(%s)', v_colrec.column_default) INTO v_defj;
        v_item := v_item || jsonb_build_object(v_colrec.column_name, v_defj);
      END IF;
    END LOOP;
    INSERT INTO public.income_expense_items
    SELECT * FROM jsonb_populate_record(NULL::public.income_expense_items, v_item);
  END LOOP;

  INSERT INTO app_private.finance_v2_semantic_event_log
    (organization_id, event_kind, source_table, source_id, source_kind, actor, txid)
  VALUES
    (v_org, 'COMPAT_INSERT', 'income_expenses', v_id, 'V2_WRITE', auth.uid(), pg_current_xact_id());

  RETURN jsonb_build_object(
    'id', v_id,
    'approval_status', (SELECT approval_status
                          FROM public.income_expenses
                         WHERE id = v_id)
  );
END
$function$;

-- (c) Cửa chi cũ không còn ai gọi: thu quyền gọi của người dùng.
REVOKE EXECUTE ON FUNCTION public.create_profit_payout_compat_v1(text, uuid, numeric, uuid, date, text, text)
  FROM PUBLIC, anon, authenticated;

-- ── 9. ACL ───────────────────────────────────────────────────────────────────
-- RPC mới: chỉ authenticated.
REVOKE ALL ON FUNCTION public.shareholder_profit_payout_preview_v1(uuid, numeric, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.shareholder_profit_payout_preview_v1(uuid, numeric, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.shareholder_profit_ledger_payout_v1(uuid, numeric, uuid, date, text, boolean, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.shareholder_profit_ledger_payout_v1(uuid, numeric, uuid, date, text, boolean, text) TO authenticated;
REVOKE ALL ON FUNCTION public.profit_ledger_marker_preview_v1(uuid, text, uuid, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.profit_ledger_marker_preview_v1(uuid, text, uuid, date) TO authenticated;
REVOKE ALL ON FUNCTION public.profit_ledger_set_marker_v1(uuid, text, uuid, date, text, uuid, boolean, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.profit_ledger_set_marker_v1(uuid, text, uuid, date, text, uuid, boolean, text) TO authenticated;
-- E11: giữ đúng ACL production (postgres, authenticated, service_role).
REVOKE ALL ON FUNCTION public.manager_salary_payout_v1(uuid, numeric, uuid, date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manager_salary_payout_v1(uuid, numeric, uuid, date, text, text) TO authenticated, service_role;
-- ie_compat_insert_v2: như 20261030100148 (chỉ authenticated).
REVOKE ALL ON FUNCTION public.ie_compat_insert_v2(jsonb, jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.ie_compat_insert_v2(jsonb, jsonb) TO authenticated;
-- Hàm nội bộ và hàm trigger: không vai nào.
REVOKE ALL ON FUNCTION app_private.profit_ledger_tao_assert_route_v1(uuid, text[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_tao_warnings_v1(numeric, numeric, numeric) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_tao_check_month_v1(uuid, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_tao_advance_erased_v1(uuid, text, uuid, date, numeric) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_tao_set_marker_v1(uuid, text, uuid, date, text, uuid, boolean, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.guard_profit_payout_scope_compat_v1() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.shareholder_profit_payout_preview_v1(uuid, numeric, uuid) IS
  'Sổ tổng lợi nhuận: xem trước một lần chi cho cổ đông (số còn phải trả, phần trong số dư, phần tạm ứng, ước tính tháng chưa chốt, cảnh báo, có lập được không). STABLE, không khoá dòng, không ghi. p_amount / p_account_id NULL ⇒ chỉ số dư.';
COMMENT ON FUNCTION public.shareholder_profit_ledger_payout_v1(uuid, numeric, uuid, date, text, boolean, text) IS
  'Sổ tổng lợi nhuận: lập phiếu chi lợi nhuận cổ đông (UNAPPROVED, yêu cầu duyệt PENDING_APPROVAL). Phần vượt số còn phải trả là tạm ứng, cần p_allow_advance. Chủ: quyền distribute; người được cấp advance_own_cashbook: chỉ chi cho chính mình từ sổ đang giữ. Chỉ chạy khi công tắc shareholder_profit.ledger_payout.v1 ở CANONICAL.';
COMMENT ON FUNCTION public.profit_ledger_marker_preview_v1(uuid, text, uuid, date) IS
  'Sổ tổng lợi nhuận: xem trước mốc "đã trả đủ đến hết tháng X" đặt ngay bây giờ (số dư trước/sau, phần bị loại, phần tạm ứng bị xoá dấu). STABLE, không khoá dòng. Tháng NULL = gỡ mốc.';
COMMENT ON FUNCTION public.profit_ledger_set_marker_v1(uuid, text, uuid, date, text, uuid, boolean, text) IS
  'Sổ tổng lợi nhuận: đặt / đè / gỡ (tháng NULL) mốc "đã trả đủ đến hết tháng X". Tháng X phải đã qua (22023 PROFIT_LEDGER_MARKER_MONTH). Bắt buộc lý do 8..1000, CAS p_expected_marker_id (PT409 = HTTP 409 PROFIT_LEDGER_MARKER_CHANGED, không tự thử lại), xác nhận riêng khi mốc xoá dấu tạm ứng. Chạy ở SHADOW và CANONICAL.';
COMMENT ON FUNCTION app_private.profit_ledger_tao_set_marker_v1(uuid, text, uuid, date, text, uuid, boolean, text, uuid) IS
  'Phần ghi của profit_ledger_set_marker_v1 với người thực hiện tường minh (migration chuyển đổi gọi được). Tự kiểm quyền của p_actor, công tắc SHADOW|CANONICAL, idempotency, CAS, xác nhận tạm ứng. Không cấp cho vai nào.';
COMMENT ON FUNCTION public.manager_salary_payout_v1(uuid, numeric, uuid, date, text, text) IS
  'Lập phiếu chi lương điều hành (UNAPPROVED). Sổ tổng tắt / SHADOW: hành vi cũ. Sổ tổng bật: không chi quá "được nhận − đã trả" (22023 PROFIT_MANAGER_LEDGER_OVERDRAW), ghi dòng sổ và nhật ký. Đóng băng: 55000. Kết quả luôn có voucher_id.';

-- Z. Hậu kiểm (đúng ở cả lượt một lẫn lượt chạy lại).
DO $assert$
DECLARE
  v_xau text;
  r record;
BEGIN
  -- 1. RPC mới: đủ, DEFINER, ghim search_path, đúng volatility, chỉ authenticated gọi được.
  FOR r IN
    SELECT * FROM (VALUES
      ('public.shareholder_profit_payout_preview_v1(uuid,numeric,uuid)', 's'),
      ('public.shareholder_profit_ledger_payout_v1(uuid,numeric,uuid,date,text,boolean,text)', 'v'),
      ('public.profit_ledger_marker_preview_v1(uuid,text,uuid,date)', 's'),
      ('public.profit_ledger_set_marker_v1(uuid,text,uuid,date,text,uuid,boolean,text)', 'v')
    ) AS x(ten, vol)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
       WHERE p.oid = to_regprocedure(r.ten)
         AND p.prosecdef
         AND p.provolatile = r.vol
         AND p.prorettype = 'jsonb'::regtype
         AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')
         AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
         AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
         AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)) THEN
      RAISE EXCEPTION 'Hậu kiểm: % sai hình dạng / ACL', r.ten USING ERRCODE = '55000';
    END IF;
  END LOOP;

  -- 2. Hàm nội bộ: không vai nào ngoài chủ hàm.
  SELECT string_agg(f.ten, ', ') INTO v_xau
    FROM unnest(ARRAY[
      'app_private.profit_ledger_tao_assert_route_v1(uuid,text[])',
      'app_private.profit_ledger_tao_warnings_v1(numeric,numeric,numeric)',
      'app_private.profit_ledger_tao_check_month_v1(uuid,date)',
      'app_private.profit_ledger_tao_advance_erased_v1(uuid,text,uuid,date,numeric)',
      'app_private.profit_ledger_tao_set_marker_v1(uuid,text,uuid,date,text,uuid,boolean,text,uuid)',
      'app_private.guard_profit_payout_scope_compat_v1()'
    ]) AS f(ten)
    LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure(f.ten)
   WHERE p.oid IS NULL
      OR p.proacl IS NULL
      OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner)
      OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%');
  IF v_xau IS NOT NULL THEN
    RAISE EXCEPTION 'Hậu kiểm: hàm nội bộ thiếu, chưa ghim search_path hoặc còn EXECUTE cho vai khác: %', v_xau
      USING ERRCODE = '55000';
  END IF;

  -- 3. Ba thân bị thay: đúng md5 đã ghim, giữ chữ ký / DEFINER / search_path / volatility / ACL.
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_catalog.pg_proc p
       WHERE p.oid = 'public.manager_salary_payout_v1(uuid,numeric,uuid,date,text,text)'::regprocedure)
       <> '7b364f53ecc3c11d6baeecfc638e270c'
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid = 'public.manager_salary_payout_v1(uuid,numeric,uuid,date,text,text)'::regprocedure
          AND p.prosecdef AND p.provolatile = 'v' AND p.prorettype = 'json'::regtype AND p.pronargdefaults = 0
          AND p.proconfig = ARRAY['search_path=pg_catalog, public, app_private']
          AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
          AND has_function_privilege('service_role', p.oid, 'EXECUTE')
          AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'Hậu kiểm: manager_salary_payout_v1 sai thân / hình dạng / ACL' USING ERRCODE = '55000';
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_catalog.pg_proc p
       WHERE p.oid = 'app_private.guard_profit_payout_scope_compat_v1()'::regprocedure)
       <> 'e6f0764b2b9d4c8de8bf73c2331a4fbb'
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_trigger t
        WHERE t.tgrelid = 'public.income_expenses'::regclass
          AND t.tgname = 'a00_00_profit_payout_account_guard'
          AND t.tgfoid = 'app_private.guard_profit_payout_scope_compat_v1()'::regprocedure
          AND t.tgenabled = 'O') THEN
    RAISE EXCEPTION 'Hậu kiểm: guard_profit_payout_scope_compat_v1 sai thân hoặc trigger a00_00 không còn gắn' USING ERRCODE = '55000';
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_catalog.pg_proc p
       WHERE p.oid = 'public.ie_compat_insert_v2(jsonb,jsonb)'::regprocedure)
       <> '342adaf725191f931739db5ef8c54620'
     OR NOT has_function_privilege('authenticated', 'public.ie_compat_insert_v2(jsonb,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.ie_compat_insert_v2(jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Hậu kiểm: ie_compat_insert_v2 sai thân hoặc ACL' USING ERRCODE = '55000';
  END IF;

  -- 4. Cửa chi cũ: người dùng không gọi được.
  IF has_function_privilege('authenticated', 'public.create_profit_payout_compat_v1(text,uuid,numeric,uuid,date,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.create_profit_payout_compat_v1(text,uuid,numeric,uuid,date,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Hậu kiểm: create_profit_payout_compat_v1 còn gọi được bằng authenticated / anon' USING ERRCODE = '55000';
  END IF;

  -- 5. Hai hạng mục: đủ cờ ở mọi công ty.
  IF EXISTS (
    SELECT 1 FROM public.income_expense_types t
     WHERE t.rule_key IN ('chia_loi_nhuan', 'luong_dieu_hanh')
       AND NOT (t.system_only AND t.manual_hidden AND t.quick_entry_hidden AND t.category IS NOT DISTINCT FROM 'Chia lợi nhuận')) THEN
    RAISE EXCEPTION 'Hậu kiểm: hạng mục chia_loi_nhuan / luong_dieu_hanh chưa đóng cửa lập tay' USING ERRCODE = '55000';
  END IF;
END
$assert$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- bo_duong_hoan_khach_thu_hai — gỡ hẳn "đường hoàn khách thứ hai"
-- Ngày 23/09/2026 · chủ quyết: "bỏ hoàn toàn đường này"
-- =============================================================================
-- ĐƯỜNG BỊ GỠ
--   Nút "Kiểm tra" ở Báo cáo thanh lý gọi record_termination_refund_obligation_v1
--   (ghi một "nghĩa vụ hoàn") rồi create_termination_refund_voucher_v1 (sinh phiếu
--   từ nghĩa vụ đó); hành động Copilot `termination.hoan_coc`
--   (copilot_preview/execute_termination_hoan_coc_v1) bọc đúng RPC sinh phiếu. Chống
--   trùng của create_… chỉ nhìn phiếu nối qua bảng termination_refund_obligations,
--   nên đường này sinh được phiếu hoàn THỨ HAI cho hồ sơ đã có phiếu hoàn từ luồng
--   trả phòng. Đo production 23/09/2026 (chỉ đọc): 71 hồ sơ / 227,6 triệu thuộc diện
--   này, 0 hợp đồng đang có hai phiếu hoàn, 0 dòng nghĩa vụ, Copilot 0 lượt chạy,
--   cờ action đang `enabled` canary DEMO. Giao diện (nút, hộp thoại, hook, E2E) gỡ
--   cùng commit; file này đóng cửa máy chủ để không ai gọi thẳng qua API.
--
-- VÌ SAO KHÔNG THU QUYỀN create_termination_refund_voucher_v1
--   Hàm này bị GHIM trong `idempotencyRetirements` của migration-policy.json (nhóm
--   phục hồi 21/09): check-forward-migration-idempotent so ACL + md5 sống của nó với
--   `witness.after` ở MỌI lần CI chạy. Thu quyền ở đây làm cổng đó đỏ vĩnh viễn.
--   Không cần thu: create_… chỉ sinh phiếu từ một dòng termination_refund_obligations
--   CÓ SẴN (không có ⇒ P0002 "Không tìm thấy nghĩa vụ hoàn"), mà nơi DUY NHẤT chèn
--   dòng vào bảng đó là record_… — bị thu quyền dưới đây; authenticated chỉ có
--   SELECT trên bảng; hiện bảng 0 dòng. Khối nghiệm thu đòi ACL + md5 của create_…
--   y hệt trước khi chạy file này.
--
-- LÀM GÌ
--   1. Thu EXECUTE của PUBLIC, anon, authenticated, service_role trên
--      record_termination_refund_obligation_v1 và cặp preview/execute Copilot.
--      Không DROP: không đổi chữ ký, không đổi generated types, không đổi thân hàm.
--   2. Hàng copilot_action_registry `termination.hoan_coc` → enabled = false.
--      Hàng GIỮ LẠI (không DELETE): mirror TS `ACTION_CATALOG` phải khớp đúng các
--      hàng seed của migration đã đóng băng 20260903224415.
--   3. Cờ action `termination.hoan_coc` → disabled, bỏ canary DEMO (đã hết hạn
--      18/09). Ghi qua marker transition v2 để trigger tăng revision + ghi audit,
--      đúng như set_copilot_feature_flag_v2 làm.
--
-- KHÔNG ĐỤNG
--   * preview_termination_refund_v1 — hàm CHỈ ĐỌC; nơi gọi thật duy nhất trong
--     database là record_… (các chỗ khác chỉ nhắc tên trong chú thích). Giữ nguyên
--     quyền; nghiệm thu đòi ACL của nó y hệt trước.
--   * Luồng trả phòng terminate_contract_move_out_impl — nay là nơi DUY NHẤT sinh
--     phiếu hoàn khách thanh lý (chờ duyệt).
--   * Bảng termination_refund_obligations (0 dòng), phiếu, hàm hay trường registry
--     nào khác ngoài `enabled`. Không đụng Đợt 4 (chủ tạm dừng từ 28/08).
--
-- ĐƯỜNG LÙI
--   GRANT EXECUTE lại cho authenticated trên hàm cần mở; UPDATE registry
--   enabled = true; cờ đi set_copilot_feature_flag_v2. Không dữ liệu nghiệp vụ nào đổi.
--
-- Chạy được trên DB rỗng của Restore Drill và chạy hai lượt liên tiếp: mọi bước gác
-- bằng to_regprocedure / to_regclass / to_regrole và điều kiện trạng thái.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 0. Chụp mốc để nghiệm thu: ACL (+ md5 thân) của hai hàm KHÔNG được đụng.
-- ---------------------------------------------------------------------------
DO $moc$
BEGIN
  PERFORM set_config(
    'app.bo_duong_hoan_preview_acl',
    COALESCE((SELECT p.proacl::text FROM pg_proc p
               WHERE p.oid = to_regprocedure('public.preview_termination_refund_v1(uuid)')),
             '<khong_co_ham>'),
    true);
  PERFORM set_config(
    'app.bo_duong_hoan_create_ghim',
    COALESCE((SELECT COALESCE(p.proacl::text, '<acl_null>') || '|' || md5(pg_get_functiondef(p.oid))
                FROM pg_proc p
               WHERE p.oid = to_regprocedure('public.create_termination_refund_voucher_v1(uuid, uuid, boolean, text)')),
             '<khong_co_ham>'),
    true);
END
$moc$;

-- ---------------------------------------------------------------------------
-- 1. Thu quyền gọi ba hàm của đường hoàn thứ hai
-- ---------------------------------------------------------------------------
DO $thu_quyen$
DECLARE
  v_ham text;
  v_vai text;
BEGIN
  FOREACH v_ham IN ARRAY ARRAY[
    'public.record_termination_refund_obligation_v1(uuid)',
    'public.copilot_preview_termination_hoan_coc_v1(uuid, jsonb)',
    'public.copilot_execute_termination_hoan_coc_v1(text, jsonb)'
  ]
  LOOP
    IF to_regprocedure(v_ham) IS NULL THEN
      RAISE NOTICE 'bo qua % — khong ton tai tren DB nay', v_ham;
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_ham);
    FOREACH v_vai IN ARRAY ARRAY['anon', 'authenticated', 'service_role']
    LOOP
      IF to_regrole(v_vai) IS NOT NULL THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', v_ham, v_vai);
      END IF;
    END LOOP;
  END LOOP;
END
$thu_quyen$;

-- ---------------------------------------------------------------------------
-- 2. Tắt hàng đăng ký hành động Copilot
-- ---------------------------------------------------------------------------
DO $tat_dang_ky$
BEGIN
  IF to_regclass('app_private.copilot_action_registry') IS NULL THEN
    RAISE NOTICE 'khong co app_private.copilot_action_registry tren DB nay';
    RETURN;
  END IF;
  UPDATE app_private.copilot_action_registry
     SET enabled = false
   WHERE action_id = 'termination.hoan_coc'
     AND enabled IS DISTINCT FROM false;
END
$tat_dang_ky$;

-- ---------------------------------------------------------------------------
-- 3. Đưa cờ action về disabled (marker transition v2 như set_copilot_feature_flag_v2)
-- ---------------------------------------------------------------------------
DO $tat_co$
BEGIN
  IF to_regclass('public.copilot_feature_flags') IS NULL THEN
    RAISE NOTICE 'khong co public.copilot_feature_flags tren DB nay';
    RETURN;
  END IF;
  PERFORM set_config('app.copilot_feature_flag_transition', 'v2', true);
  UPDATE public.copilot_feature_flags
     SET state = 'disabled',
         canary_org = NULL,
         expires_at = NULL,
         updated_by = NULL,
         reason = 'Chủ quyết 23/09/2026: bỏ hoàn toàn đường hoàn khách thứ hai '
                  '(nút Kiểm tra ở Báo cáo thanh lý + hành động này). Cặp RPC Copilot '
                  'và record_termination_refund_obligation_v1 đã thu EXECUTE.',
         evidence_link = 'migration:20260923161122_bo_duong_hoan_khach_thu_hai',
         rollback_reference = 'migration:20260923161122_bo_duong_hoan_khach_thu_hai '
                              '— GRANT EXECUTE lại rồi set_copilot_feature_flag_v2'
   WHERE scope = 'action'
     AND contract_id = 'termination.hoan_coc'
     AND (state <> 'disabled' OR canary_org IS NOT NULL OR expires_at IS NOT NULL);
  PERFORM set_config('app.copilot_feature_flag_transition', '', true);
END
$tat_co$;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_ham  text;
  v_vai  text;
  v_ho   text[] := '{}'::text[];
  v_gt   text;
BEGIN
  -- a) Không vai ứng dụng nào còn gọi được ba hàm.
  FOREACH v_ham IN ARRAY ARRAY[
    'public.record_termination_refund_obligation_v1(uuid)',
    'public.copilot_preview_termination_hoan_coc_v1(uuid, jsonb)',
    'public.copilot_execute_termination_hoan_coc_v1(text, jsonb)'
  ]
  LOOP
    CONTINUE WHEN to_regprocedure(v_ham) IS NULL;
    FOREACH v_vai IN ARRAY ARRAY['anon', 'authenticated', 'service_role']
    LOOP
      IF to_regrole(v_vai) IS NOT NULL
         AND has_function_privilege(v_vai, v_ham, 'EXECUTE') THEN
        v_ho := v_ho || (v_vai || ' -> ' || v_ham);
      END IF;
    END LOOP;
  END LOOP;
  IF cardinality(v_ho) > 0 THEN
    RAISE EXCEPTION 'nghiem_thu: van con goi duoc: %', array_to_string(v_ho, '; ');
  END IF;

  -- b) preview_termination_refund_v1 KHÔNG bị đụng.
  v_gt := COALESCE((SELECT p.proacl::text FROM pg_proc p
                     WHERE p.oid = to_regprocedure('public.preview_termination_refund_v1(uuid)')),
                   '<khong_co_ham>');
  IF v_gt IS DISTINCT FROM current_setting('app.bo_duong_hoan_preview_acl', true) THEN
    RAISE EXCEPTION 'nghiem_thu: ACL preview_termination_refund_v1 bi doi (% -> %)',
      current_setting('app.bo_duong_hoan_preview_acl', true), v_gt;
  END IF;

  -- c) create_termination_refund_voucher_v1 (ghim retirement 21/09) KHÔNG bị đụng:
  --    ACL và thân hàm y hệt trước.
  v_gt := COALESCE((SELECT COALESCE(p.proacl::text, '<acl_null>') || '|' || md5(pg_get_functiondef(p.oid))
                      FROM pg_proc p
                     WHERE p.oid = to_regprocedure('public.create_termination_refund_voucher_v1(uuid, uuid, boolean, text)')),
                   '<khong_co_ham>');
  IF v_gt IS DISTINCT FROM current_setting('app.bo_duong_hoan_create_ghim', true) THEN
    RAISE EXCEPTION 'nghiem_thu: create_termination_refund_voucher_v1 bi doi (% -> %)',
      current_setting('app.bo_duong_hoan_create_ghim', true), v_gt;
  END IF;

  -- d) Hàng registry còn nguyên hình (mirror TS), chỉ khác enabled = false.
  IF to_regclass('app_private.copilot_action_registry') IS NOT NULL
     AND EXISTS (SELECT 1 FROM app_private.copilot_action_registry
                  WHERE action_id = 'termination.hoan_coc') THEN
    IF NOT EXISTS (
      SELECT 1 FROM app_private.copilot_action_registry
       WHERE action_id = 'termination.hoan_coc'
         AND enabled = false
         AND version = 1
         AND risk = 'L5' AND executor_kind = 'direct_l5_v1' AND consent_required = 'step_up'
         AND permission_key = 'income_expenses.create'
         AND preview_rpc = 'copilot_preview_termination_hoan_coc_v1'
         AND execute_rpc = 'copilot_execute_termination_hoan_coc_v1'
         AND grantable = false
    ) THEN
      RAISE EXCEPTION 'nghiem_thu: hang registry termination.hoan_coc chua tat hoac bi doi hinh';
    END IF;
  END IF;

  -- e) Cờ đã tắt hẳn, không còn canary.
  IF to_regclass('public.copilot_feature_flags') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.copilot_feature_flags
                  WHERE scope = 'action' AND contract_id = 'termination.hoan_coc'
                    AND (state <> 'disabled' OR canary_org IS NOT NULL OR expires_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'nghiem_thu: co action termination.hoan_coc chua ve disabled';
  END IF;

  -- f) Marker transition không rò ra ngoài khối ghi cờ.
  IF COALESCE(current_setting('app.copilot_feature_flag_transition', true), '') <> '' THEN
    RAISE EXCEPTION 'nghiem_thu: marker copilot_feature_flag_transition con bat';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';

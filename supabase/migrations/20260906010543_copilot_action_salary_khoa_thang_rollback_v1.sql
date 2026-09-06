-- =============================================================================
-- copilot_action_salary_khoa_thang_rollback_v1 — đường lùi CÓ THẬT, ghi chú đang nói ngược
-- Ngày 06/09/2026 · fast-follow của G5-C3
-- =============================================================================
-- VẤN ĐỀ — một dòng runbook SAI đẩy người vận hành vào việc sửa DB bằng tay
--   Hàng registry `salary.khoa_thang` (seed ở 20260903224418) đang mang:
--
--     rollback_rpc  = NULL
--     rollback_note = 'Khong tim thay unlock_salary_month_v1 tren production
--                      (03/09/2026). Muon mo khoa thi can thiep DB tay hoac cho
--                      tinh nang unlock tuong lai …'
--
--   Đo lại trên production ngày 06/09/2026 (`pg_get_function_identity_arguments`):
--   hàm CÓ THẬT và đúng là nghịch đảo của khoá —
--   `public.unlock_salary_month_v1(p_period_month date, p_staff_ids uuid[],
--   p_idempotency_key text)`: đòi quyền `salary.unlock` qua
--   `authorize_tenant_action_v3`, khoá tổ chức bằng `lock_org_for_decision_v1`,
--   đi qua `canonical_write_operations` (nên gọi lại cùng khoá là idempotent),
--   route writer `salary.unlock.v1` phải là CANONICAL, và chỉ đổi những dòng
--   `salary_monthly` đang LOCKED về DRAFT.
--
--   Một ghi chú nói "không có đường lùi" khi đường lùi tồn tại thì tệ hơn là
--   không ghi gì: nó bảo người trực đi sửa `salary_monthly` bằng tay, bỏ qua cả
--   cửa quyền, cả khoá tổ chức, cả sổ CWO.
--
-- VÌ SAO CÓ ĐIỀU KIỆN `to_regprocedure` CHỨ KHÔNG GÁN THẲNG
--   `unlock_salary_month_v1` KHÔNG được tạo bởi migration nào trong repo này —
--   `grep` toàn bộ `supabase/migrations/` chỉ thấy tên nó trong CHÍNH câu dò của
--   20260903224418. Tức đây là DRIFT production↔lane (cùng lớp với trigger
--   `a00_rules_immutable` đã ghi nhận 03/09): hàm sống trên prod, không có trong
--   sổ migration.
--
--   Hệ quả bắt buộc: trên DB rỗng của Restore Drill hàm KHÔNG tồn tại. Gán thẳng
--   `rollback_rpc = 'unlock_salary_month_v1'` sẽ ghi vào registry tên một hàm
--   không gọi được — đúng cái lỗi "ghi chú nói ngược sự thật" mà migration này
--   đang sửa, chỉ đổi chiều. Nên phép ghi được gác bằng
--   `to_regprocedure('public.unlock_salary_month_v1(date, uuid[], text)')`:
--   có hàm thì điền, không có thì để nguyên NULL + ghi chú runbook cũ.
--   Registry luôn nói đúng về thứ GỌI ĐƯỢC trên chính DB đó.
--
-- KHÔNG SỬA FILE ĐÓNG BĂNG
--   20260903224418 giữ nguyên từng byte, kể cả khối nghiệm thu của nó vẫn đòi
--   `rollback_rpc IS NULL`. Trong lượt replay migration chạy theo thứ tự nên cả
--   hai điều đúng ở đúng thời điểm của mình: 224418 nghiệm thu hàng vừa seed,
--   rồi file này mới cập nhật. `copilotActionsL5Dot3Migration.test.ts` ghim
--   `rollbackRpc: null` theo VĂN BẢN của file đóng băng — cũng không bị chạm.
--
-- KHÔNG NỚI GÌ KHÁC
--   * Không đổi `risk`/`executor_kind`/`consent_required`/`grantable`/`pin_always`.
--   * `version` giữ nguyên 1: chữ ký action, cửa quyền và cặp preview/execute
--     không đổi, nên kế hoạch đang mở không phải bị `registry_changed`.
--   * CHECK `copilot_action_registry_l6_forbidden` cũng soi `rollback_rpc` —
--     `unlock_salary_month_v1` không khớp `(sql|secret|deploy|migration|drop|
--     truncate|pg_)`, và CHECK `rpc_name_shape` chấp nhận tên này.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';

DO $vao_duong_lui$
DECLARE
  v_co_ham boolean := to_regprocedure('public.unlock_salary_month_v1(date, uuid[], text)') IS NOT NULL;
  v_so_hang int;
BEGIN
  SELECT count(*) INTO v_so_hang
    FROM app_private.copilot_action_registry
   WHERE action_id = 'salary.khoa_thang';
  IF v_so_hang <> 1 THEN
    RAISE EXCEPTION 'khong thay hang registry salary.khoa_thang (seed 20260903224418 phai chay truoc)';
  END IF;

  IF NOT v_co_ham THEN
    RAISE NOTICE 'unlock_salary_month_v1 khong ton tai tren DB nay — giu nguyen rollback_rpc NULL va ghi chu runbook cu (drift prod-lane, xem dau file)';
    RETURN;
  END IF;

  UPDATE app_private.copilot_action_registry
     SET rollback_rpc = 'unlock_salary_month_v1',
         rollback_note =
           'Goi public.unlock_salary_month_v1(p_period_month date, p_staff_ids uuid[], p_idempotency_key text) '
           '— nghich dao dung chieu cua khoa: chi doi dong salary_monthly dang LOCKED ve DRAFT cho (ky, staff_ids). '
           'Doi quyen salary.unlock (authorize_tenant_action_v3) va route writer salary.unlock.v1 = CANONICAL; '
           'goi lai cung p_idempotency_key la idempotent (canonical_write_operations). '
           'CHU Y CHU KY LECH: lock nhan p_managers jsonb, unlock nhan p_staff_ids uuid[] — phai boc staff_id ra. '
           'Danh sach staff_id/period_month doc tu payload cua buoc ke hoach '
           '(app_private.copilot_plan_steps.canonical, KHONG doc duoc tu before_digest vi do la bam), '
           'hoac tu chinh cac dong salary_monthly dang LOCKED cua ky do. Copilot KHONG tu dong goi ham nay.'
   WHERE action_id = 'salary.khoa_thang';
END
$vao_duong_lui$;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — hai nhánh, mỗi nhánh một sự thật; chạy được cả trên DB rỗng
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_co_ham boolean := to_regprocedure('public.unlock_salary_month_v1(date, uuid[], text)') IS NOT NULL;
  v_rpc  text;
  v_note text;
BEGIN
  SELECT rollback_rpc, rollback_note INTO v_rpc, v_note
    FROM app_private.copilot_action_registry
   WHERE action_id = 'salary.khoa_thang';

  IF v_co_ham THEN
    -- Có hàm ⇒ registry PHẢI trỏ tới nó, và câu "khong tim thay" phải biến mất.
    IF v_rpc IS DISTINCT FROM 'unlock_salary_month_v1' THEN
      RAISE EXCEPTION 'nghiem_thu: co unlock_salary_month_v1 nhung rollback_rpc = %', COALESCE(v_rpc, 'NULL');
    END IF;
    IF v_note ~ 'Khong tim thay unlock_salary_month_v1' THEN
      RAISE EXCEPTION 'nghiem_thu: ghi chu van con cau noi nguoc "khong tim thay"';
    END IF;
    IF v_note !~ 'salary\.unlock' OR v_note !~ 'p_staff_ids uuid\[\]' THEN
      RAISE EXCEPTION 'nghiem_thu: ghi chu thieu cua quyen salary.unlock hoac canh bao lech chu ky';
    END IF;
  ELSE
    -- Không có hàm ⇒ KHÔNG được điền tên một hàm không gọi được.
    IF v_rpc IS NOT NULL THEN
      RAISE EXCEPTION 'nghiem_thu: khong co unlock_salary_month_v1 ma registry van tro tan %', v_rpc;
    END IF;
  END IF;

  -- Hai chiều đều phải giữ: hàng vẫn là L5 direct + step_up + không uỷ quyền đứng.
  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry
     WHERE action_id = 'salary.khoa_thang'
       AND version = 1
       AND risk = 'L5' AND executor_kind = 'direct_l5_v1' AND consent_required = 'step_up'
       AND permission_key = 'salary.lock'
       AND grantable = false
       AND preview_rpc = 'copilot_preview_salary_khoa_thang_v1'
       AND execute_rpc = 'copilot_execute_salary_khoa_thang_v1'
  ) THEN
    RAISE EXCEPTION 'nghiem_thu: hang salary.khoa_thang bi noi ngoai pham vi duong lui';
  END IF;
END
$nghiem_thu$;

COMMIT;

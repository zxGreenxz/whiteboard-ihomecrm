-- =====================================================================
-- HOTFIX: nút "Tạo phiếu chi hoa hồng" vỡ — sai TÊN BIẾN trong bản vá tự duyệt
--
-- Chủ báo 01/08 kèm ảnh console: mọi cú bấm "Tạo phiếu chi" ở modal hoa hồng
-- sau khi ký hợp đồng đều `400 — column "v_voucher_id" does not exist`, cả
-- nhánh môi giới lẫn thưởng Sale.
--
-- NGUYÊN NHÂN — lỗi của bản vá `COMMISSION_AUTOPAY_V1` (20260801030000):
-- hàm gốc `create_commission_voucher` khai biến phiếu là **`v_id`**, còn khối
-- chèn lại tham chiếu **`v_voucher_id`** (3 chỗ). PL/pgSQL không phân giải tên
-- biến lúc CREATE FUNCTION, chỉ nổ lúc CHẠY — nên migration áp xanh, còn nút
-- thật thì vỡ. Nhánh 'sale' cũng vỡ vì planner phân giải TOÀN BỘ biểu thức
-- `IF p_kind = 'broker' AND v_voucher_id IS NOT NULL` cho mọi lời gọi, không
-- có chuyện short-circuit ở tầng phân giải tên.
--
-- VÌ SAO TEST HÔM ĐÓ KHÔNG BẮT ĐƯỢC: test chỉ gọi `commission_autopay_check_v1`
-- và adapter — KHÔNG gọi trọn `create_commission_voucher`. Bài học (đã ghi vào
-- §18 danh-gia): vá hàm bằng replace thì test rollback phải GỌI TRỌN hàm đó,
-- vì lỗi tên biến chỉ hiện ra lúc chạy.
--
-- Đã kiểm trên prod trước khi viết hotfix: `v_voucher_id` xuất hiện ĐÚNG 3 lần,
-- tất cả nằm trong khối chèn; khối chỉ có 1 bản, đặt đúng trước RETURN duy nhất
-- ⇒ chỉ sai tên biến, không sai vị trí ⇒ replace toàn cục là an toàn.
-- =====================================================================

BEGIN;

DO $fix$
DECLARE
  v_def text;
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_commission_voucher';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'Không thấy create_commission_voucher. DỪNG.';
  END IF;

  -- Idempotent: đã hết v_voucher_id thì coi như xong.
  IF position('v_voucher_id' IN v_def) = 0 THEN
    IF position('COMMISSION_AUTOPAY_V1' IN v_def) > 0 THEN
      RAISE NOTICE 'create_commission_voucher đã sạch v_voucher_id — bỏ qua';
      RETURN;
    END IF;
    RAISE EXCEPTION
      'Hàm không còn cả khối COMMISSION_AUTOPAY_V1 — ai đó đã viết lại. DỪNG, đọc lại thân hàm.';
  END IF;

  -- Phải đúng hình dạng đã chẩn đoán: 3 lần, và biến đích v_id phải TỒN TẠI.
  SELECT count(*) INTO v_hits FROM regexp_matches(v_def, 'v_voucher_id', 'g');
  IF v_hits <> 3 THEN
    RAISE EXCEPTION
      'v_voucher_id xuất hiện % lần (chẩn đoán là 3) — hình dạng đã đổi. DỪNG, không vá mù.', v_hits;
  END IF;
  IF v_def !~ 'v_id\s+uuid' AND position('v_id,' IN v_def) = 0 AND position('INTO v_id' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không thấy biến v_id trong thân hàm — tên biến đích sai. DỪNG.';
  END IF;

  EXECUTE replace(v_def, 'v_voucher_id', 'v_id');
  RAISE NOTICE 'ĐÃ SỬA create_commission_voucher: v_voucher_id → v_id (3 chỗ)';
END
$fix$;

-- ─────────────────────────────────────────────────────────────────────
-- TỰ KIỂM — thân mới sạch, và các chốt cũ còn nguyên
-- ─────────────────────────────────────────────────────────────────────
DO $verify$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_commission_voucher';

  IF position('v_voucher_id' IN v_src) > 0 THEN
    RAISE EXCEPTION 'Vẫn còn v_voucher_id. DỪNG.';
  END IF;
  IF position('COMMISSION_AUTOPAY_V1' IN v_src) = 0 THEN
    RAISE EXCEPTION 'Mất khối tự duyệt. DỪNG.';
  END IF;
  IF position('v_id IS NOT NULL' IN v_src) = 0 THEN
    RAISE EXCEPTION 'Khối tự duyệt không trỏ vào v_id. DỪNG.';
  END IF;
  -- Hai chốt cũ phải sống: chống chi trùng từ phiếu cọc, và advisory lock.
  IF position('SALE_BONUS_SEES_DEPOSIT_CLAIM' IN v_src) = 0 THEN
    RAISE EXCEPTION 'Mất chốt claim phiếu cọc. DỪNG.';
  END IF;
  IF position('pg_advisory_xact_lock' IN v_src) = 0 THEN
    RAISE EXCEPTION 'Mất advisory lock chống trùng. DỪNG.';
  END IF;
END
$verify$;

COMMIT;

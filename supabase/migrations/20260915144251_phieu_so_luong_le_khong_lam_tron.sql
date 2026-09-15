-- =============================================================================
-- H3.1 — Hạng mục phiếu thu/chi: SỐ LƯỢNG LẺ KHÔNG ĐƯỢC LÀM TRÒN
--
-- VÌ SAO (đo 15/09/2026 trên supabase/baseline/schema.sql — dump prod 06/08)
--   `public.income_expense_items.quantity` khai `integer` (baseline:99604),
--   trong khi đơn vị thật của hạng mục là kWh, m³, người-ngày — đều có phần
--   lẻ. Trigger `auto_calc_item_amount` (baseline:46645) ghi:
--
--       NEW.amount := NEW.quantity * NEW.unit_price;
--
--   Phần lẻ bị cắt NGAY TỪ LÚC GÁN VÀO CỘT, tức là TRƯỚC khi nhân:
--       12,5 kWh × 3.500 đ  →  DB nhận quantity = 12  →  amount = 42.000 đ
--       (đúng phải là 43.750 đ — hụt 1.750 đ mỗi hạng mục)
--   Sai số chảy thẳng vào tổng phiếu, vào bút toán, rồi vào tồn quỹ.
--
-- SỬA GÌ Ở ĐÂY
--   1. Nới kiểu cột: quantity integer → numeric(15,4). Bốn chữ số lẻ đủ cho
--      chỉ số công tơ. CHECK `quantity > 0` giữ nguyên (nới KIỂU không phải
--      nới LUẬT); DEFAULT 1 giữ nguyên.
--   2. Trigger nhân bằng số lẻ và làm tròn tiền ĐÚNG MỘT LẦN, tường minh ở
--      mức đồng: round(quantity * unit_price, 2).
--
--   Hai đường ghi hạng mục dưới đây được sửa TRỌN VẸN chỉ bằng bước 1, vì
--   chúng để chính kiểu cột quyết định phép ép:
--     · ie_compat_insert_v2         — `(i->>'quantity')::numeric`
--                                     (20260830183259_copilot_draft_writer_v1.sql:376)
--     · ie_compat_update_pending_v2 — `jsonb_populate_record(NULL::public.income_expense_items, …)`
--                                     (20260902082004_ie_compat_update_pending_kiem_scope_moi.sql:236)
--
-- CÒN HỞ — CÓ CHỦ Ý, KHÔNG SỬA TRONG MIGRATION NÀY
--   Hai writer còn ÉP KIỂU NGUYÊN NGAY TRONG THÂN HÀM, nên nới cột không chạm
--   tới được:
--     · create_income_expense_v1  baseline:57619  `(item->>'quantity')::integer`
--     · create_income_expense_v2  baseline:58217  `(v_item->>'quantity')::integer`
--   Vá chúng = CREATE OR REPLACE nguyên một writer tiền 969 dòng (v1) chép từ
--   baseline, không đối chiếu được với `pg_get_functiondef` của production
--   trong phiên này. Đó là việc cần chủ duyệt riêng, không phải việc kèm theo.
--   Ghi vào báo cáo H3 để xếp lịch.
--
--   Cũng vì `create_income_expense_v2` ghi thẳng `COALESCE((v_item->>'amount')::numeric, 0)`
--   (baseline:58218) mà trigger CHƯA thể đổi sang `COALESCE(NEW.amount, …)` như
--   plan H3.1 mô tả: client không gửi `amount` (mutations.ts:88-95) nên writer
--   đó đưa vào số 0 THẬT — COALESCE sẽ giữ 0 và mọi hạng mục qua đường ấy
--   thành 0 đồng, im lặng. Trigger vì thế vẫn là NGUỒN DUY NHẤT tính amount;
--   đổi chủ quyền đó phải đi SAU khi writer ngừng ghi 0.
--
-- IDEMPOTENT: bước 1 kiểm kiểu trước khi ALTER; bước 2 là CREATE OR REPLACE
-- cùng chữ ký. Chạy hai lần cho cùng kết quả.
-- KHÔNG sửa dữ liệu cũ — chỉ ĐẾM và báo, vì backfill tiền là việc không lùi được.
-- =============================================================================

-- 1) Nới kiểu cột -------------------------------------------------------------
DO $$
DECLARE
  v_type text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod) INTO v_type
  FROM pg_attribute a
  WHERE a.attrelid = 'public.income_expense_items'::regclass
    AND a.attname = 'quantity'
    AND NOT a.attisdropped;

  IF v_type IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy cột public.income_expense_items.quantity'
      USING ERRCODE = '42703';
  END IF;

  IF v_type = 'numeric(15,4)' THEN
    RAISE NOTICE 'quantity đã là numeric(15,4) — bỏ qua ALTER.';
  ELSE
    RAISE NOTICE 'quantity đang là % — nới sang numeric(15,4).', v_type;
    ALTER TABLE public.income_expense_items
      ALTER COLUMN quantity TYPE numeric(15,4);
    ALTER TABLE public.income_expense_items
      ALTER COLUMN quantity SET DEFAULT 1;
  END IF;
END
$$;

-- CHECK `quantity > 0` là LUẬT NGHIỆP VỤ, không phải hệ quả của kiểu integer —
-- khẳng định lại để một lần nới kiểu trong tương lai không lặng lẽ đánh rơi nó.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.income_expense_items'::regclass
      AND conname = 'income_expense_items_quantity_positive'
  ) THEN
    ALTER TABLE public.income_expense_items
      ADD CONSTRAINT income_expense_items_quantity_positive CHECK (quantity > 0);
  END IF;
END
$$;

COMMENT ON COLUMN public.income_expense_items.quantity IS
  'Số lượng hạng mục — numeric(15,4) vì đơn vị thật là kWh/m³/người-ngày, có phần lẻ. Trước 15/09/2026 là integer và phần lẻ bị cắt trước khi nhân với unit_price.';

-- 2) Trigger nhân bằng số lẻ --------------------------------------------------
CREATE OR REPLACE FUNCTION public.auto_calc_item_amount() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Trigger là NGUỒN DUY NHẤT của amount (xem phần "CÒN HỞ" ở đầu file).
  --
  -- quantity numeric(15,4) × unit_price numeric(15,2) cho scale 6; cột amount
  -- là numeric(15,2) nên Postgres vẫn tự làm tròn lúc gán. Viết round() tường
  -- minh để phép làm tròn nằm TRONG MÃ, đọc được và đo được, thay vì là tác
  -- dụng phụ của khai báo cột.
  NEW.amount := round(NEW.quantity * NEW.unit_price, 2);
  RETURN NEW;
END;
$$;

-- Trigger đã tồn tại từ 20250120000004; khẳng định lại để migration tự đứng
-- được trên một database dựng từ baseline (Restore Drill chạy trên DB rỗng).
DROP TRIGGER IF EXISTS trigger_auto_calc_item_amount ON public.income_expense_items;
CREATE TRIGGER trigger_auto_calc_item_amount
  BEFORE INSERT OR UPDATE ON public.income_expense_items
  FOR EACH ROW EXECUTE FUNCTION public.auto_calc_item_amount();

-- 3) ĐẾM dòng lệch, KHÔNG sửa -------------------------------------------------
DO $$
DECLARE
  v_lech bigint;
  v_tong bigint;
BEGIN
  SELECT count(*) INTO v_tong FROM public.income_expense_items;
  SELECT count(*) INTO v_lech
  FROM public.income_expense_items
  WHERE amount IS DISTINCT FROM round(quantity * unit_price, 2);

  IF v_lech = 0 THEN
    RAISE NOTICE 'income_expense_items: %/% dòng lệch amount <> quantity*unit_price. Sạch.', v_lech, v_tong;
  ELSE
    -- CỐ Ý không UPDATE: mỗi dòng lệch đã chảy vào bút toán và tồn quỹ; sửa
    -- amount mà không đảo bút toán tương ứng là làm sổ lệch tiếp một tầng nữa.
    RAISE NOTICE 'income_expense_items: %/% dòng có amount <> round(quantity*unit_price,2). KHÔNG tự sửa — báo cáo cho chủ quyết đường xử.', v_lech, v_tong;
  END IF;
END
$$;

-- =====================================================================
-- Rủi ro #5 của plan thu chi — bổ sung BỐN BẢNG TIỀN vào publication realtime
--
-- Plan ghi (mục Rủi ro #5): useRealtimeDataSync thiếu hẳn `payments`,
-- `income_expense_items`, `accounts`. "Hôm nay vô hại vì phiếu bất biến; khi
-- phiếu sửa được thì hai người đối chiếu quỹ sẽ đọc ra hai số."
-- Từ Đợt 4 (huỷ một nhát), Đợt 5 (huỷ tại chỗ) và Đợt 6 (chốt sổ), phiếu ĐÃ
-- sửa/huỷ/chốt được — nên điều kiện "hôm nay vô hại" đã hết hiệu lực.
--
-- Vì sao từng bảng:
--   payments              — hoàn tác thu tiền đổi `reversed_at`, và
--                           recompute_invoice_for_id tính paid_amount TỪ bảng
--                           này chứ không từ phiếu. Không có tín hiệu thì màn
--                           hoá đơn vẫn hiện "đã thu" sau khi đã hoàn tác.
--   income_expense_items  — sửa hạng mục đổi total_amount của phiếu qua
--                           trigger, tức đổi luôn TỒN QUỸ, mà trước đây không
--                           phát một tín hiệu nào.
--   accounts              — chốt sổ đặt lock_date; đổi số dư đầu / người phụ
--                           trách cũng đổi con số trên màn.
--   cash_handovers        — phiên bàn giao đổi trạng thái thì CẢ HAI bên phải
--                           thấy ngay, nếu không sẽ có người bấm xác nhận trên
--                           một phiên đã bị huỷ.
--
-- AN TOÀN: cả bốn bảng đều relrowsecurity=true (7-13 policy) và
-- REPLICA IDENTITY = DEFAULT, tức event chỉ mang KHOÁ CHÍNH chứ không mang nội
-- dung dòng. Cố ý KHÔNG đặt REPLICA IDENTITY FULL: hub realtime của repo bỏ qua
-- payload hoàn toàn (event chỉ là tín hiệu invalidate cache), nên phát thêm dữ
-- liệu là rủi ro thuần tuý không đổi lấy gì.
-- =====================================================================

BEGIN;

DO $pub$
DECLARE
  r record;
  v_added int := 0;
BEGIN
  FOR r IN
    SELECT t.tablename
    FROM (VALUES ('payments'), ('income_expense_items'), ('accounts'), ('cash_handovers'))
         AS t(tablename)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_publication_tables p
      WHERE p.pubname = 'supabase_realtime'
        AND p.schemaname = 'public' AND p.tablename = r.tablename
    ) THEN
      RAISE NOTICE '% đã có trong supabase_realtime — bỏ qua', r.tablename;
      CONTINUE;
    END IF;

    -- Chốt chặn: KHÔNG đưa bảng chưa bật RLS vào publication. Realtime lọc
    -- theo RLS của người nghe; bảng không RLS là phát cho mọi tenant.
    IF NOT (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname = r.tablename) THEN
      RAISE EXCEPTION 'Bảng public.% chưa bật RLS — KHÔNG đưa vào publication realtime', r.tablename;
    END IF;

    EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', r.tablename);
    v_added := v_added + 1;
    RAISE NOTICE 'Đã thêm public.% vào supabase_realtime', r.tablename;
  END LOOP;

  RAISE NOTICE 'Tổng bảng thêm mới: %', v_added;
END
$pub$;

COMMIT;

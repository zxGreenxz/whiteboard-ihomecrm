-- P2 — hai bề mặt thừa, không ai dùng, vẫn mở.
--
-- ─── 1. get_my_assignments() đang cho `anon` gọi ─────────────────────────────
-- ACL thật trên production 15/09/2026:
--   {=X/postgres, postgres=X, anon=X, authenticated=X, service_role=X}
-- Tức PUBLIC có EXECUTE, VÀ anon có grant riêng. Nguồn: 20260518000051 dòng
-- 49-50 `GRANT EXECUTE … TO authenticated, anon, service_role`.
--
-- Hàm là STABLE SECURITY DEFINER và thân nó lọc `WHERE sa.staff_id = auth.uid()`.
-- Với anon thì `auth.uid()` là NULL nên hôm nay nó trả 0 dòng — bề mặt này KHÔNG
-- rò dữ liệu ở trạng thái hiện tại. Thu hồi vì lý do khác: nó là SECURITY DEFINER
-- đọc staff_assignments, và lớp duy nhất giữ nó vô hại là một dòng trong thân hàm.
-- Một lần CREATE OR REPLACE sau này bỏ vế auth.uid() là toàn bộ bảng phân công
-- nhân sự phơi ra cho khách vãng lai. Người gọi duy nhất trong mã nguồn là
-- src/hooks/useMyBuildingScope.ts:48 — luôn chạy sau đăng nhập.
--
-- Phải thu hồi CẢ PUBLIC: REVOKE FROM PUBLIC một mình không cắt anon (anon có
-- grant riêng), và REVOKE FROM anon một mình cũng không cắt anon (còn đường
-- PUBLIC). Án lệ đã ghi trong bộ nhớ dự án: "REVOKE FROM PUBLIC không cắt anon
-- trên Supabase". Phải làm cả hai.
--
-- ─── 2. reservation_settlement_vouchers nằm trong publication mà không ai nghe ─
-- `contracts/surfaces/realtime-surface.json` đang ghi thẳng:
--   publishedWithNoListener: ["reservation_settlement_vouchers"]  (đúng 1 bảng)
-- Quét mã nguồn xác nhận: mọi chỗ đụng bảng này đều là `.from(...)` đọc thường
-- (useReservationRefundEvidence.ts, useReservationSettlement.ts) hoặc SQL trong
-- .e2e-fleet — KHÔNG có `.channel(...)` nào subscribe nó.
--
-- CHỌN BỎ KHỎI PUBLICATION, không chọn nối descriptor. Lý do: nối descriptor là
-- thêm một đường tự-làm-mới cho dữ liệu mà giao diện hiện không hiển thị theo
-- thời gian thực, tức tạo ra tải và bề mặt cho một nhu cầu chưa tồn tại. Bỏ khỏi
-- publication thì WAL không còn phải mang bảng này, và ngày nào thật sự cần
-- realtime ở đây thì thêm lại là một dòng ALTER PUBLICATION.
-- Đường lùi: ALTER PUBLICATION supabase_realtime ADD TABLE public.reservation_settlement_vouchers;
--
-- SAU KHI APPLY phải chạy lại `npm run surface:realtime` (và gate
-- `check-realtime-surface`), vì manifest đó sinh từ catalog SỐNG — session này
-- không apply nên chưa regen được.
--
-- Idempotent. KHÔNG apply trong session này — chỉ dry-run qua `npm run migrate:forward`.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Thu hồi anon khỏi get_my_assignments()
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.get_my_assignments() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_assignments() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_assignments() TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Bỏ reservation_settlement_vouchers khỏi publication realtime
-- ─────────────────────────────────────────────────────────────────────────────
-- Bọc trong DO vì `ALTER PUBLICATION … DROP TABLE` ném 42704 khi bảng đã ra
-- ngoài, mà lane apply dán thân file HAI LẦN trong cùng một transaction để đo
-- tính idempotent.
DO $pub$
DECLARE
  v_truoc integer;
  v_sau   integer;
BEGIN
  SELECT count(*) INTO v_truoc FROM pg_publication_tables WHERE pubname = 'supabase_realtime';

  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'reservation_settlement_vouchers'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.reservation_settlement_vouchers;

    -- Bất biến: câu trên được phép bớt ĐÚNG MỘT bảng. Không đặt sàn tuyệt đối
    -- kiểu "phải còn >= 15 bảng" — sàn đó đúng trên production nhưng chặn oan
    -- Restore Drill, nơi publication dựng lại có thể chưa đủ bảng. Phép đo
    -- tương đối thì đúng ở cả hai nơi.
    SELECT count(*) INTO v_sau FROM pg_publication_tables WHERE pubname = 'supabase_realtime';
    IF v_sau <> v_truoc - 1 THEN
      RAISE EXCEPTION 'DROP TABLE lam publication tut tu % xuong % bang — dung', v_truoc, v_sau;
    END IF;
  END IF;
END
$pub$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Tự kiểm
-- ─────────────────────────────────────────────────────────────────────────────
DO $ktra$
BEGIN
  IF has_function_privilege('anon', 'public.get_my_assignments()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon van EXECUTE duoc get_my_assignments()';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_my_assignments()', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated mat quyen EXECUTE get_my_assignments() — useMyBuildingScope se hong';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'reservation_settlement_vouchers'
  ) THEN
    RAISE EXCEPTION 'reservation_settlement_vouchers van con trong publication supabase_realtime';
  END IF;
END
$ktra$;

COMMIT;

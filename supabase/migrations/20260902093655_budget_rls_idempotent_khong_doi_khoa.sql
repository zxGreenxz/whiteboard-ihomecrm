-- =============================================================================
-- Idempotent-hoá bước bật RLS cho app_private.public_room_event_budgets.
--
-- VÌ SAO: gate `check-forward-migration-idempotent` chạy migration LẦN HAI trên
-- production thật và 20260902092508 đỏ với `55P03 canceling statement due to
-- lock timeout`. Nguyên nhân đo được: bảng ngân sách nay bị GHI liên tục bởi
-- chính logger analytics (25 sự kiện trong 1 giờ ngay lúc đo), mà
-- `ALTER TABLE … ENABLE ROW LEVEL SECURITY` đòi ACCESS EXCLUSIVE — nó xếp hàng
-- sau mọi transaction đang ghi rồi hết `lock_timeout = 15s`.
--
-- Bài học tổng quát: câu DDL "vô hại vì đã đúng trạng thái" vẫn PHẢI xin khoá.
-- Trên bảng nguội thì không ai thấy; trên bảng đang có traffic thì lần chạy thứ
-- hai đỏ. Bọc trong điều kiện đọc `pg_class.relrowsecurity` thì lần hai không
-- chạm DDL, không xin khoá, và gate idempotent xanh thật chứ không nhờ may.
--
-- Trạng thái hiện tại (đo 02/09/2026): RLS ĐÃ bật ⇒ file này là no-op trên
-- production. Nó tồn tại để bản dựng lại từ baseline và mọi lần replay sau đều
-- đi qua đường idempotent.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'app_private'
       AND c.relname = 'public_room_event_budgets'
       AND c.relrowsecurity
  ) THEN
    EXECUTE 'ALTER TABLE app_private.public_room_event_budgets ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('app_private.public_room_event_budgets') IS NULL THEN
    RAISE EXCEPTION 'Thiếu bảng ngân sách analytics. DỪNG.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'app_private' AND c.relname = 'public_room_event_budgets' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'RLS chưa bật trên bảng ngân sách analytics. DỪNG.';
  END IF;
END $$;

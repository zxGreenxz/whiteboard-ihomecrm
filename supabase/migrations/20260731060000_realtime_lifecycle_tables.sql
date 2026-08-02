-- =====================================================================
-- Đợt 1 — bổ sung HAI BẢNG VÒNG ĐỜI vào publication realtime
--
-- Đo trên prod 30/07/2026: publication `supabase_realtime` có 21 bảng, và
-- `contract_terminations` + `contract_transfers` **KHÔNG nằm trong đó**.
--
-- Vì sao từng bảng:
--   contract_terminations — hồ sơ thanh lý đổi status (DRAFT → PENDING_APPROVAL →
--       APPROVED/COMPLETED) và đổi số quyết toán. Không có tín hiệu thì hai người
--       cùng mở một hồ sơ sẽ đọc ra hai trạng thái, và người thứ hai bấm duyệt
--       trên hồ sơ đã bị bác. Đợt −1 vừa dựng trigger đông cứng đầu vào quyết
--       toán sau APPROVED/COMPLETED (20260731011000), nên trạng thái này giờ có
--       hệ quả CỨNG — càng cần thấy ngay.
--   contract_transfers   — Đợt 2 vừa biến bảng này thành SỔ AUDIT thật sự
--       (20260731050000: audit ghi trước, không nuốt lỗi; hai đường A/B cùng hình
--       dạng) và dựng projection đoạn cư trú đọc từ nó (20260731051000). Một
--       chuỗi cư trú đổi mà màn không đổi thì người rà tay đối chiếu số cũ.
--
-- AN TOÀN — theo đúng khuôn 20260730230000_realtime_money_tables.sql:
--   • Chặn cứng nếu bảng chưa bật RLS: realtime lọc theo RLS của người nghe, đưa
--     bảng không RLS vào publication là phát cho mọi tenant.
--   • CỐ Ý KHÔNG đặt REPLICA IDENTITY FULL. Cả hai bảng đang là DEFAULT (đo:
--     relreplident='d'), tức event chỉ mang KHOÁ CHÍNH. Hub realtime của repo bỏ
--     qua payload hoàn toàn (event chỉ là tín hiệu invalidate cache), nên phát
--     thêm nội dung dòng là rủi ro rò rỉ thuần tuý, không đổi lấy gì.
--
-- KHÔNG ĐỤNG TIỀN: chỉ ALTER PUBLICATION. Không DDL bảng, không DML.
-- =====================================================================
BEGIN;

DO $pub$
DECLARE
  r record;
  v_added int := 0;
  v_ident "char";
BEGIN
  FOR r IN
    SELECT t.tablename
      FROM (VALUES ('contract_terminations'), ('contract_transfers')) AS t(tablename)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname='public' AND c.relname = r.tablename
    ) THEN
      RAISE EXCEPTION 'Không thấy bảng public.% — DỪNG.', r.tablename;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_publication_tables p
       WHERE p.pubname='supabase_realtime' AND p.schemaname='public'
         AND p.tablename = r.tablename
    ) THEN
      RAISE NOTICE '% đã có trong supabase_realtime — bỏ qua', r.tablename;
      CONTINUE;
    END IF;

    IF NOT (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relname = r.tablename) THEN
      RAISE EXCEPTION
        'Bảng public.% chưa bật RLS — KHÔNG đưa vào publication realtime (realtime lọc theo RLS người nghe)',
        r.tablename;
    END IF;

    -- Ghi nhận REPLICA IDENTITY để nếu ai đó đã đặt FULL thì biết mà xem lại.
    SELECT c.relreplident INTO v_ident
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname = r.tablename;
    IF v_ident = 'f' THEN
      RAISE WARNING 'public.% đang REPLICA IDENTITY FULL — event sẽ mang cả nội dung dòng, xem lại có cần không', r.tablename;
    END IF;

    EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', r.tablename);
    v_added := v_added + 1;
    RAISE NOTICE 'đã thêm public.% vào supabase_realtime', r.tablename;
  END LOOP;

  RAISE NOTICE 'Tổng đã thêm: % bảng', v_added;
END
$pub$;

DO $selfcheck$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(t.tablename, ', ') INTO v_missing
    FROM (VALUES ('contract_terminations'), ('contract_transfers')) AS t(tablename)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_publication_tables p
      WHERE p.pubname='supabase_realtime' AND p.schemaname='public'
        AND p.tablename = t.tablename);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Còn thiếu trong publication: %. DỪNG.', v_missing;
  END IF;
END
$selfcheck$;

COMMIT;

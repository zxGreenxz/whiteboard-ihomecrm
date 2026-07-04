-- =============================================================
-- Realtime cho bảng nghiệp vụ — bật postgres_changes cho
-- invoices / income_expenses / contracts / jobs / customers.
--
-- Phục vụ hub useRealtimeDataSync (FE): màn chính prefetch sẵn trang đầu
-- các trang danh sách; khi dữ liệu đổi (người khác thu tiền, tạo phiếu,
-- giao việc…) event realtime → invalidate + hâm lại cache prefetch.
--
-- RLS vẫn kiểm soát từng subscriber: client chỉ nhận event của dòng nó
-- SELECT được (WALRUS đánh giá policy theo JWT của từng kết nối). Payload
-- phía FE bị bỏ qua — chỉ dùng làm tín hiệu invalidate.
--
-- Idempotent (chỉ ADD nếu chưa có trong publication) — theo đúng pattern
-- 20260626000002_zalo_realtime.sql.
-- =============================================================

BEGIN;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoices', 'income_expenses', 'contracts', 'jobs', 'customers']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

COMMIT;

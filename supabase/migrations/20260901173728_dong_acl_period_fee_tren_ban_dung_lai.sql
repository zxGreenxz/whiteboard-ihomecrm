-- =============================================================================
-- ĐÓNG ACL TƯỜNG MINH cho pay_period_fee + get_period_fee_status
--
-- Vì sao cần khi prod đã đúng: 20260831162000 tạo lại hai hàm này bằng
-- CREATE OR REPLACE — lệnh đó GIỮ NGUYÊN ACL sẵn có, và trên production ACL
-- đã đúng từ 20260731011000 (pay) / 20260710120100 (get) nên selfcheck của nó
-- qua sạch. Nhưng trên BẢN DỰNG LẠI của bài diễn tập khôi phục thì khác:
-- baseline chụp `--no-acl`, còn platform-shim đặt ALTER DEFAULT PRIVILEGES
-- GRANT ALL ON FUNCTIONS TO authenticated, anon, service_role — nên hai hàm
-- (ra đời TRƯỚC cutoff, tức từ baseline) mang EXECUTE cho anon, CREATE OR
-- REPLACE giữ y nguyên, và selfcheck của 20260831162000 nổ đúng ở đó:
-- "anon chạy được pay_period_fee — ACL trôi. DỪNG." (run 33424301408).
--
-- Đây là đúng bài học đã ghi sổ: REVOKE FROM PUBLIC không cắt anon trên
-- Supabase — hàm phải REVOKE đích danh anon. Đặt lại ACL tường minh thì:
--   • prod: no-op (ACL đã đúng y hệt);
--   • diễn tập: mọi file SAU file này trong timeline thấy ACL đúng, không
--     dính artifact shim nữa. Riêng 20260831162000 đứng TRƯỚC nên vẫn dừng
--     ở selfcheck của nó — đã khai entry cascade trong sổ kỳ vọng, `tu` trỏ
--     về platform-shim chứ không phải một migration.
-- =============================================================================

BEGIN;

REVOKE ALL ON FUNCTION public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb,boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb,boolean)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_period_fee_status(text,text,uuid[],text[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_period_fee_status(text,text,uuid[],text[])
  TO authenticated, service_role;

-- Nghiệm thu cùng thước đo với selfcheck của 20260831162000 — chạy được trên
-- cả prod lẫn bản dựng lại (không phụ thuộc dữ liệu).
DO $nghiemthu$
BEGIN
  IF has_function_privilege('anon',
        'public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon vẫn chạy được pay_period_fee sau REVOKE. DỪNG.';
  END IF;
  IF has_function_privilege('anon',
        'public.get_period_fee_status(text,text,uuid[],text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon vẫn chạy được get_period_fee_status sau REVOKE. DỪNG.';
  END IF;
  IF NOT has_function_privilege('authenticated',
        'public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated mất quyền pay_period_fee — GRANT hỏng. DỪNG.';
  END IF;
END
$nghiemthu$;

COMMIT;

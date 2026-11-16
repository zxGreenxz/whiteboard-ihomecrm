-- =============================================================================
-- Sổ tổng lợi nhuận cổ đông — BẢN LÙI R5: mở lại lệnh chi lợi nhuận kiểu cũ cho web (lùi X4 của Đợt 3a,
-- 20261115113530).
--
-- CHỈ DÙNG KHI lùi CẢ web production về bản TRƯỚC Đợt 2 (bản đó còn gọi distribute_shareholder_profit_v1 —
--   src/hooks/income-expenses/specialized.ts). Web Đợt 2 không gọi lệnh này: lùi DB mà giữ web Đợt 2 thì BỎ R5
--   (đừng mở lại một đường chi đi vòng sổ tổng khi không ai cần).
-- CÁCH ÁP — tệp này KHÔNG phải migration, chỉ dùng khi phải lùi; nội dung đã là migration hoàn chỉnh.
--   Runbook: docs/superpowers/runbooks/2026-11-16-so-tong-loi-nhuan-ban-lui-dot3/README.md
--   1. node scripts/tao-ten-migration.mjs so_tong_loi_nhuan_mo_lenh_chi_cu   (chỉ IN ra tên <timestamp>_<slug>.sql)
--   2. tạo supabase/migrations/<tên vừa in> chứa NGUYÊN VĂN tệp này → git add <tệp đó> → npm run provenance:generate
--   3. npm run migrate:forward -- <tệp>            (dry-run: lane dán HAI lượt trong một giao dịch rồi ROLLBACK)
--   4. npm run migrate:forward -- <tệp> --apply    (chỉ sau dry-run xanh)
--   Tách khỏi R1 (bản 15/11 chung một tệp) để lùi R1 không kéo theo R5.
--
-- LÀM GÌ: GRANT EXECUTE … TO authenticated — đúng ACL trước X4 (PUBLIC và anon vẫn không có). Hậu kiểm ACL.
-- AN TOÀN CHẠY LẠI: GRANT lặp không đổi gì. Công ty thật vắng (Restore Drill) ⇒ VẪN chạy, như REVOKE của X4
--   (thay đổi quyền, không phụ thuộc dữ liệu).
-- THỨ TỰ lùi toàn phần: R7a → R7b → R7c → R6 → R3 → R2 → R4 → (R5) → R1; R6 LUÔN trước R1 — xem runbook.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';

GRANT EXECUTE ON FUNCTION public.distribute_shareholder_profit_v1(uuid, numeric, uuid, date, text, text) TO authenticated;

DO $r5_sau$
BEGIN
  IF NOT has_function_privilege('authenticated', 'public.distribute_shareholder_profit_v1(uuid,numeric,uuid,date,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.distribute_shareholder_profit_v1(uuid,numeric,uuid,date,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'R5_SAU: ACL lệnh chi cũ không về đúng bản trước X4 (authenticated gọi được, anon không)'
      USING ERRCODE = '55000';
  END IF;
END
$r5_sau$;

COMMIT;

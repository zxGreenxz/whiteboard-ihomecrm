-- =============================================================================
-- Nối tiếp 20260902084858 (FR020-C02): explain_authorization_v1 phải là VOLATILE.
--
-- VÌ SAO: bản trước đổi gate sang app_private.authorize_tenant_action_v3 — đường
-- này lấy KHOÁ DÒNG (lock_org_for_decision_v1). PostgREST chạy hàm STABLE trong
-- transaction READ ONLY nên lời gọi từ trình duyệt sẽ ném 25006 (lộ ra ngoài
-- thành HTTP 405, rất dễ đọc nhầm là lỗi routing). Gate check-stable-fn-locks
-- bắt đúng ca này ở CI + Restore Drill 02/09/2026 (án lệ đã ghi 5 lần).
--
-- Hàm vốn ĐÃ gọi lock_org_for_decision_v1 từ bản 20260725190000 mà vẫn để STABLE;
-- gate chỉ phát hiện khi chuỗi gọi đi qua authorize_tenant_action_v3. Đổi sang
-- VOLATILE là an toàn với FE: supabase.rpc() gửi POST, không phụ thuộc volatility.
--
-- ALTER thuần, không đổi thân/chữ ký/ACL. Idempotent.
-- =============================================================================

ALTER FUNCTION public.explain_authorization_v1(uuid, text[], uuid, uuid) VOLATILE;

DO $$
DECLARE v_vol "char";
BEGIN
  SELECT p.provolatile INTO v_vol
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'explain_authorization_v1';
  IF v_vol IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy explain_authorization_v1. DỪNG.';
  END IF;
  IF v_vol <> 'v' THEN
    RAISE EXCEPTION 'explain_authorization_v1 vẫn không VOLATILE (provolatile=%). DỪNG.', v_vol;
  END IF;
END $$;

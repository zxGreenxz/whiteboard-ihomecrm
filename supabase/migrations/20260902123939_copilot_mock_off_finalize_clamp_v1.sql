-- =============================================================================
-- Chi phí một lượt gọi AI không được ÂM, và provider `mock` không được bật sẵn
--
-- LỖ ĐANG VÁ
--   `llm-proxy` cho phép ép chi phí ước lượng qua header `x-mock-cost` (dev/test
--   quota/race). Bản trước nhận thẳng `parseFloat(...)`, kể cả số âm, rồi truyền
--   xuống `finalize_ai_usage(..., p_cost_usd, ...)`. Hàm đó ghi nguyên giá trị
--   vào `ai_usage_logs.cost_usd`.
--
--   Cột ấy không chỉ để xem: `reserve_ai_usage` CỘNG nó lại theo ngày rồi so với
--   `daily_usd_cap_*`. Một dòng âm không làm sai một dòng — nó HOÀN LẠI hạn mức
--   đã tiêu. Ai gọi được proxy là tự nạp thêm quota cho chính mình, và cả ba cấp
--   hạn mức (user/owner/global) đều mở ra theo.
--
--   Đường vào đó chỉ mở được khi provider `mock` đang bật. Seed gốc
--   (`20260710200000`) đặt `enabled = true` cho mock với ghi chú "tắt ở Phase 4"
--   — và việc tắt chưa bao giờ vào migration. Production hiện đã `false` vì có
--   người tắt tay trong giao diện admin (đo 02/09/2026: `mock_enabled = false`),
--   nhưng một database dựng lại từ lane forward sẽ bật lại nó. Trạng thái đúng
--   phải nằm trong sổ, không nằm trong trí nhớ của người từng bấm nút.
--
-- BA LỚP, CỐ Ý KHÔNG DỒN VỀ MỘT
--   (1) proxy clamp header về >= 0 (G0-A, `clampMockCost` trong index.ts);
--   (2) hàm clamp lần nữa — `finalize_ai_usage` không chỉ có một người gọi, và
--       proxy có thể được deploy lại từ một bản cũ hơn;
--   (3) CHECK trên bảng — canh cả những đường ghi chưa ai nghĩ tới, kể cả một
--       lần sửa tay bằng `service_role` trong console.
--   Lớp (1) là thứ dễ mất nhất khi redeploy; lớp (3) là thứ không ai vòng qua được.
--
-- VÌ SAO `NOT VALID` RỒI MỚI `VALIDATE`
--   Thêm CHECK thẳng sẽ quét toàn bảng dưới ACCESS EXCLUSIVE. Tách hai bước cho
--   phép khoá nặng chỉ giữ trong chốc lát, phần quét đi với SHARE UPDATE
--   EXCLUSIVE. Đo trước khi viết: 171 dòng, 0 dòng âm, `min(cost_usd) = 0` —
--   VALIDATE chạy qua được. Nếu về sau có dòng âm, VALIDATE sẽ ném và cả
--   migration cuộn lại: đó là hành vi ĐÚNG, vì một CHECK "đã bật" trên dữ liệu
--   vi phạm là một lời hứa suông.
--
-- ĐIỀU NÀY KHÔNG PHỦ
--   Chi phí ghi SAI mà vẫn dương (ví dụ ghi 0 cho một lượt gọi thật) không có gì
--   ở đây bắt được. Đó là việc của đường đọc `usage` trong proxy, không phải của
--   một ràng buộc dấu.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ── 1. Provider `mock` phải TẮT trong sổ ─────────────────────────────────────
-- Không xoá dòng: `ai_usage_logs` cũ vẫn trỏ provider 'mock', và bật lại tay rồi
-- chạy lại migration này thì vẫn phải tắt được.
UPDATE public.ai_providers
   SET enabled = false
 WHERE provider = 'mock';

-- ── 2. finalize_ai_usage: clamp chi phí về >= 0 ──────────────────────────────
-- CÙNG chữ ký cũ, CREATE OR REPLACE (không DROP): đổi chữ ký là đẻ overload và
-- PostgREST sẽ chọn nhầm bản.
CREATE OR REPLACE FUNCTION public.finalize_ai_usage(
  p_id uuid,
  p_prompt_tokens int,
  p_completion_tokens int,
  p_total_tokens int,
  p_cached_tokens int,
  p_cost_usd numeric,
  p_latency_ms int,
  p_status text,
  p_error text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  UPDATE public.ai_usage_logs SET
    prompt_tokens     = COALESCE(p_prompt_tokens, 0),
    completion_tokens = COALESCE(p_completion_tokens, 0),
    total_tokens      = COALESCE(p_total_tokens, 0),
    cached_tokens     = COALESCE(p_cached_tokens, 0),
    -- NULL nghĩa là "không biết chi phí" và cũng phải thành 0: để NULL thì tổng
    -- theo ngày bỏ qua dòng đó, tức lượt gọi ấy miễn phí đối với hạn mức.
    cost_usd          = GREATEST(COALESCE(p_cost_usd, 0), 0),
    latency_ms        = p_latency_ms,
    status            = COALESCE(p_status, 'ok'),
    error_detail      = p_error
  WHERE id = p_id;
END $fn$;

-- CREATE OR REPLACE giữ ACL cũ, nhưng migration phải tự đứng được trên một
-- database dựng lại từ baseline — ở đó chưa có ACL nào để giữ. Án lệ: REVOKE
-- FROM PUBLIC KHÔNG cắt `anon` trên Supabase, phải gọi tên từng vai.
REVOKE ALL ON FUNCTION public.finalize_ai_usage(uuid, int, int, int, int, numeric, int, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_ai_usage(uuid, int, int, int, int, numeric, int, text, text) TO service_role;

-- ── 3. CHECK trên bảng — hàng rào cuối ───────────────────────────────────────
DO $them_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ai_usage_logs_cost_usd_khong_am'
       AND conrelid = 'public.ai_usage_logs'::regclass
  ) THEN
    ALTER TABLE public.ai_usage_logs
      ADD CONSTRAINT ai_usage_logs_cost_usd_khong_am CHECK (cost_usd IS NULL OR cost_usd >= 0) NOT VALID;
  END IF;
END
$them_check$;

DO $validate_check$
BEGIN
  -- `convalidated = false` là trạng thái duy nhất cần quét. Chạy lượt hai thì cờ
  -- đã bật và khối này im lặng bỏ qua.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ai_usage_logs_cost_usd_khong_am'
       AND conrelid = 'public.ai_usage_logs'::regclass
       AND NOT convalidated
  ) THEN
    ALTER TABLE public.ai_usage_logs VALIDATE CONSTRAINT ai_usage_logs_cost_usd_khong_am;
  END IF;
END
$validate_check$;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — chỉ soi catalog, nên chạy được cả trên database rỗng vừa dựng từ
-- baseline. KHÔNG chèn dòng thử: `ai_usage_logs` là sổ chi phí, một dòng rác ở
-- đó làm lệch đúng con số mà hạn mức ngày đọc.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
BEGIN
  -- (1) Ràng buộc phải TỒN TẠI và đã được VALIDATE.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ai_usage_logs_cost_usd_khong_am'
       AND conrelid = 'public.ai_usage_logs'::regclass
       AND contype = 'c'
       AND convalidated
  ) THEN
    RAISE EXCEPTION 'CHECK ai_usage_logs_cost_usd_khong_am khong ton tai hoac chua duoc VALIDATE. DUNG.';
  END IF;

  -- (2) Vai anon/authenticated KHÔNG được gọi finalize_ai_usage.
  IF has_function_privilege('anon', 'public.finalize_ai_usage(uuid, int, int, int, int, numeric, int, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon van goi duoc finalize_ai_usage — trinh duyet ghi thang duoc vao so chi phi. DUNG.';
  END IF;
  IF has_function_privilege('authenticated', 'public.finalize_ai_usage(uuid, int, int, int, int, numeric, int, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated van goi duoc finalize_ai_usage. DUNG.';
  END IF;

  -- (3) service_role PHẢI còn gọi được — proxy chốt sổ bằng vai này.
  IF NOT has_function_privilege('service_role', 'public.finalize_ai_usage(uuid, int, int, int, int, numeric, int, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role mat quyen goi finalize_ai_usage — moi reservation se ket pending. DUNG.';
  END IF;

  -- (4) Không provider `mock` nào còn bật.
  IF NOT EXISTS (SELECT 1 FROM public.ai_providers WHERE provider = 'mock' AND enabled) THEN
    RAISE NOTICE 'Nghiem thu dat: CHECK da validate, anon/authenticated het quyen, mock da tat.';
  ELSE
    RAISE EXCEPTION 'Provider mock VAN dang bat. DUNG.';
  END IF;
END
$nghiem_thu$;

COMMIT;

-- =============================================================================
-- ROLLBACK (chỉ khi phải quay lại đúng hành vi cũ — lưu ý nó mở lại lỗ hạn mức):
--   ALTER TABLE public.ai_usage_logs DROP CONSTRAINT ai_usage_logs_cost_usd_khong_am;
--   UPDATE public.ai_providers SET enabled = true WHERE provider = 'mock';
--   -- và CREATE OR REPLACE lai finalize_ai_usage theo ban o 20260710200000.
-- =============================================================================

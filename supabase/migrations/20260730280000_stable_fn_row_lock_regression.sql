-- =====================================================================
-- HÀM ĐỌC KHAI STABLE MÀ CÓ LẤY KHOÁ DÒNG = CHẾT QUA TRÌNH DUYỆT
--
-- PostgREST chạy hàm STABLE/IMMUTABLE trong transaction READ ONLY. Bất kỳ
-- `SELECT … FOR SHARE` nào trong thân hàm — hoặc trong hàm mà nó gọi — sẽ ném
-- 25006 "cannot execute SELECT FOR SHARE in a read-only transaction".
-- Gọi bằng SQL thì tốt, gọi từ trình duyệt thì hỏng. Đây là lý do nó sống
-- được lâu mà không ai thấy: mọi kiểm thử bằng SQL đều xanh.
--
-- Đợt trước đã vá 4 hàm theo đúng lớp lỗi này. Quét lại bằng ĐỒ THỊ LỜI GỌI
-- (thay vì so chuỗi nông như lần trước — lần trước lọt vì lọc `proacl ILIKE
-- '%authenticated%'`, mà hàm để ACL mặc định thì proacl là NULL) còn đúng 2:
--
--   profit_close_state_v2     STABLE → _profit_assert_authorized_v2 (FOR SHARE ×2)
--   explain_authorization_v1  STABLE → authorize_tenant_action_v3 → FOR SHARE
--
-- profit_close_state_v2 là hàm nuôi tab "Chốt LN tháng". Nó hỏng từ
-- 20260720210000, tức đã 10 ngày: giao diện hiện "Không tải được trạng thái
-- snapshot", và vì `hasSnapshots` suy ra từ chính state đó nên MỌI nút phụ
-- thuộc trạng thái — kể cả nút "Mở khoá tháng" vừa thêm — không bao giờ hiện.
--
-- Cả hai được gọi bằng supabase.rpc() ⇒ POST, nên chuyển VOLATILE không làm
-- mất đường gọi nào (chỉ hàm gọi qua GET mới cần non-volatile).
-- =====================================================================

BEGIN;

DO $fix$
DECLARE
  v_sig text;
  v_n int := 0;
BEGIN
  FOR v_sig IN
    SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('profit_close_state_v2', 'explain_authorization_v1')
      AND p.provolatile <> 'v'
  LOOP
    EXECUTE format('ALTER FUNCTION %s VOLATILE', v_sig);
    RAISE NOTICE 'Đã chuyển VOLATILE: %', v_sig;
    v_n := v_n + 1;
  END LOOP;

  IF v_n = 0 THEN
    RAISE NOTICE 'Cả hai hàm đã VOLATILE — không có gì để làm';
  END IF;
END
$fix$;

-- ─────────────────────────────────────────────────────────────────────
-- HÀNG RÀO: migration tự đổ nếu còn BẤT KỲ hàm public STABLE/IMMUTABLE nào
-- chạm tới khoá dòng (trực tiếp hoặc qua tối đa 4 tầng lời gọi).
-- Cùng tinh thần với scripts/check-view-invoker.mjs: doctrine nào đã cắn
-- nhiều lần thì phải có máy tự bắt, không dựa vào trí nhớ.
-- ─────────────────────────────────────────────────────────────────────
DO $guard$
DECLARE
  v_bad text;
BEGIN
  WITH RECURSIVE fns AS (
    SELECT p.oid, n.nspname AS ns, p.proname AS nm, p.provolatile AS vol,
           pg_get_functiondef(p.oid) AS def, p.proacl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prokind = 'f' AND n.nspname IN ('public', 'app_private')
  ),
  seed AS (
    SELECT oid, nm, 0 AS depth FROM fns
    WHERE def ~* '\mfor\s+(share|update|no key update|key share)\M'
  ),
  closure AS (
    SELECT oid, nm, depth FROM seed
    UNION
    SELECT f.oid, f.nm, c.depth + 1
    FROM fns f JOIN closure c
      ON c.depth < 4 AND f.oid <> c.oid AND f.def ~ ('\m' || c.nm || '\s*\(')
  )
  SELECT string_agg(DISTINCT f.nm, ', ') INTO v_bad
  FROM closure c JOIN fns f ON f.oid = c.oid
  WHERE f.ns = 'public' AND f.vol <> 'v'
    AND (f.proacl IS NULL OR array_to_string(f.proacl, ',') ILIKE '%authenticated%');

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'Còn hàm public khai STABLE/IMMUTABLE mà chạm khoá dòng — sẽ ném 25006 qua PostgREST: %', v_bad;
  END IF;
  RAISE NOTICE 'Hàng rào xanh: không hàm đọc nào còn chạm khoá dòng';
END
$guard$;

COMMIT;

NOTIFY pgrst, 'reload schema';

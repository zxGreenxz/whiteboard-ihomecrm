-- Finance V2 — Bộ lọc trạng thái V2 (§12.1) cho trang Thu chi.
--
-- Dropdown trạng thái bổ sung 3 giá trị composite: "Đã duyệt - Chưa thu/chi"
-- (APPROVED + UNPOSTED/null), "Đã thu/chi" (POSTED), "Đã hoàn tác" (REVERSED).
-- Danh sách lọc client-side qua PostgREST; 3 thẻ tổng dùng RPC
-- get_income_expense_layer_stats nên RPC cần thêm chiều posting:
--   p_posting NULL        → như cũ
--   'UNPOSTED'            → APPROVED và posting_status UNPOSTED/null
--   'POSTED' / 'REVERSED' → theo posting_status
-- Re-emit bằng def-replace (thêm param cuối + 1 điều kiện WHERE) — không đổi
-- logic hiện có; DROP bản cũ vì signature đổi (tránh overload ambiguous).

BEGIN;

DO $patch$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p WHERE p.proname='get_income_expense_layer_stats'
    AND p.pronamespace='public'::regnamespace;

  IF v_def LIKE '%p_posting%' THEN
    RETURN; -- đã vá
  END IF;

  v_def := replace(v_def,
    'p_kqkd_only boolean DEFAULT false)',
    'p_kqkd_only boolean DEFAULT false, p_posting text DEFAULT NULL)');
  v_def := replace(v_def,
    'WHERE ie.deleted_at IS NULL',
    'WHERE ie.deleted_at IS NULL
    AND (p_posting IS NULL
         OR (p_posting = ''POSTED''   AND ie.posting_status = ''POSTED'')
         OR (p_posting = ''REVERSED'' AND ie.posting_status = ''REVERSED'')
         OR (p_posting = ''UNPOSTED'' AND ie.approval_status = ''APPROVED''
             AND COALESCE(ie.posting_status, ''UNPOSTED'') = ''UNPOSTED''))');
  IF v_def NOT LIKE '%p_posting%' OR v_def NOT LIKE '%REVERSED'' AND ie.posting_status%' THEN
    RAISE EXCEPTION 'stats posting filter: pattern không khớp — kiểm tra thủ công';
  END IF;

  DROP FUNCTION public.get_income_expense_layer_stats(
    uuid[], uuid[], uuid, text, date, date, text, uuid, numeric, numeric,
    text, uuid[], uuid[], text[], boolean, text[], boolean);
  EXECUTE v_def;
END
$patch$;

-- Smoke: gọi được với p_posting và không nổ.
DO $smoke$
DECLARE v_row record;
BEGIN
  SELECT * INTO v_row FROM public.get_income_expense_layer_stats(
    p_building_ids => NULL, p_room_ids => NULL, p_account_id => NULL,
    p_type => NULL, p_start_date => NULL, p_end_date => NULL,
    p_approval => 'APPROVED', p_creator_id => NULL, p_amount => NULL,
    p_amount_tol => 5000, p_verified => NULL, p_item_type_ids => NULL,
    p_voucher_ids => NULL, p_sources => NULL, p_source_manual => false,
    p_internal_sources => NULL, p_kqkd_only => false, p_posting => 'POSTED');
  RAISE NOTICE 'stats p_posting smoke OK (cash_income=%)', v_row.cash_income;
END
$smoke$;

COMMIT;

NOTIFY pgrst, 'reload schema';

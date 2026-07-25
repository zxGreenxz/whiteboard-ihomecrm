-- Finance V2 — 7ah: ghi SỔ QUỸ ĐÃ CHỌN lên đầu phiếu khi ghi sổ.
--
-- OWNER BÁO (25/07): 2 phiếu "Tiền nhà (tự động lập)" đã Chi từ sổ ATam nhưng
-- cột "Sổ quỹ" trên danh sách Thu chi hiển thị "—", và phiếu bị tab "Chờ xử lý"
-- nhặt vào dù đã xong. Owner nói đúng: đã chọn sổ thì phải hiện đúng sổ.
--
-- GỐC RỄ
--   Writer sinh phiếu lặp lại tạo phiếu KHÔNG gắn sổ (account_id NULL — chủ đích:
--   "chọn sổ lúc chi"). Khi chi, người chi chọn sổ trong Posting dialog; sổ đó
--   được ghi vào BÚT TOÁN (income_expense_postings + posting_lines) nhưng
--   post_approved_income_expense_v2 / approve_and_post_income_expense_v2 KHÔNG
--   chép ngược lên header phiếu. Header vẫn NULL ⇒
--     • cột "Sổ quỹ" hiển thị "—";
--     • lớp "Tiền thật" lọc `account_id IS NOT NULL` ⇒ phiếu MẤT khỏi tab đó;
--     • lớp "Chờ xử lý" lọc `account_id IS NULL` ⇒ phiếu KẸT lại đó dù đã chi.
--   Tiền không sai (bút toán ghi đúng ATam) — sai ở chỗ hiển thị/phân loại.
--
-- CÙNG GỐC, LỖI NẶNG HƠN (phát hiện khi đo): header giữ sổ chọn LÚC TẠO, còn tiền
--   lại đi qua sổ chọn LÚC CHI ⇒ danh sách hiện SỔ SAI, tệ hơn cả để trống:
--     PT2607200 "khách cọc 205-1392qt"  header ATam ↔ tiền vào TK939
--     PC2607119 "Trả khách thanh lý"    header ATam ↔ tiền ra  TK939
--
-- FIX
--   (1) Hai RPC ghi sổ: `account_id = v_cashbook` — sổ trên phiếu luôn bám SỔ TIỀN
--       THẬT SỰ ĐI QUA, không giữ sổ dự kiến lúc tạo nữa. (Phiếu chưa ghi sổ vẫn
--       giữ nguyên sổ dự kiến để Posting dialog chọn sẵn.)
--   (2) Backfill phiếu ĐÃ ghi sổ: lấy sổ từ dòng MAIN của bút toán ĐANG HIỆU LỰC
--       (active_posting_id_v2) — sửa cả ca trống lẫn ca lệch.
--
-- KHÔNG đụng tiền: chỉ sửa cột hiển thị trên header, không tạo/sửa bút toán nào.
-- Phiếu FLOW-OWNED bị freeze guard chặn sửa header ⇒ loại khỏi backfill, đếm và
-- báo NOTICE để xử lý riêng nếu có.

BEGIN;

-- ---------------------------------------------------------------------------
-- (1) Stamp sổ quỹ trong 2 RPC ghi sổ.
-- ---------------------------------------------------------------------------
DO $patch$
DECLARE
  v_fn  text;
  v_def text;
  v_new text;
  v_hit integer := 0;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'post_approved_income_expense_v2',
    'approve_and_post_income_expense_v2'
  ] LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_fn;
    IF v_def IS NULL THEN
      RAISE EXCEPTION '7ah: không tìm thấy %', v_fn;
    END IF;
    IF v_def LIKE '%7ah: stamp so quy%' THEN
      v_hit := v_hit + 1;
      CONTINUE;
    END IF;

    v_new := replace(v_def,
      'SET active_posting_id_v2 = v_posting_id, posting_status = ''POSTED'',',
      'SET active_posting_id_v2 = v_posting_id, posting_status = ''POSTED'','
      || E'\n         -- 7ah: stamp so quy TIEN THAT SU DI QUA len header (het "-" va het so sai)'
      || E'\n         account_id = v_cashbook,');

    IF v_new = v_def THEN
      RAISE EXCEPTION '7ah: không khớp anchor UPDATE posting trong % — kiểm tra thủ công', v_fn;
    END IF;
    EXECUTE v_new;
    v_hit := v_hit + 1;
  END LOOP;

  IF v_hit < 2 THEN
    RAISE EXCEPTION '7ah: chỉ vá được %/2 RPC', v_hit;
  END IF;
END
$patch$;

-- ---------------------------------------------------------------------------
-- (2) Backfill phiếu đã ghi sổ nhưng header còn trống sổ quỹ.
-- ---------------------------------------------------------------------------
DO $backfill$
DECLARE v_n integer; v_owned integer;
BEGIN
  -- Sổ lấy từ dòng MAIN của bút toán ĐANG HIỆU LỰC (không lấy bút toán cũ đã
  -- hoàn tác — phiếu ghi sổ lại sổ khác sẽ bị stamp sai nếu gộp mọi thế hệ).
  WITH so_hieu_luc AS (
    SELECT ie.id AS ie_id, l.account_id
    FROM public.income_expenses ie
    JOIN public.income_expense_postings po
      ON po.id = ie.active_posting_id_v2
     AND po.posting_subject_kind = 'VOUCHER'
    JOIN public.income_expense_posting_lines l
      ON l.posting_id = po.id AND l.line_kind = 'MAIN'
  )
  UPDATE public.income_expenses ie
     SET account_id = s.account_id,
         updated_at = now()
  FROM so_hieu_luc s
  WHERE s.ie_id = ie.id
    AND ie.account_id IS DISTINCT FROM s.account_id
    AND ie.deleted_at IS NULL
    AND ie.approval_status = 'APPROVED'
    AND NOT EXISTS (SELECT 1 FROM app_private.income_expense_flow_ownership o
                    WHERE o.income_expense_id = ie.id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '7ah backfill: % phiếu được sửa sổ quỹ trên header', v_n;

  SELECT count(*) INTO v_owned
  FROM public.income_expenses ie
  JOIN public.income_expense_postings po ON po.id = ie.active_posting_id_v2
  JOIN public.income_expense_posting_lines l ON l.posting_id = po.id AND l.line_kind = 'MAIN'
  WHERE ie.deleted_at IS NULL AND ie.approval_status = 'APPROVED'
    AND ie.account_id IS DISTINCT FROM l.account_id
    AND EXISTS (SELECT 1 FROM app_private.income_expense_flow_ownership o
                WHERE o.income_expense_id = ie.id);
  IF v_owned > 0 THEN
    RAISE NOTICE '7ah: còn % phiếu FLOW-OWNED lệch sổ — freeze guard chặn, xử lý qua adapter', v_owned;
  END IF;
END
$backfill$;

-- ---------------------------------------------------------------------------
-- (3) Tự kiểm.
-- ---------------------------------------------------------------------------
DO $smoke$
DECLARE
  v_bad integer;
  v_missing integer;
BEGIN
  -- A. Cả 2 RPC đã mang dấu vá.
  SELECT count(*) INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('post_approved_income_expense_v2', 'approve_and_post_income_expense_v2')
    AND pg_get_functiondef(p.oid) NOT LIKE '%7ah: stamp so quy%';
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '7ah smoke A FAIL: còn % RPC chưa vá', v_bad;
  END IF;

  -- B. Không còn phiếu đã ghi sổ mà header trống sổ quỹ (ngoài phiếu flow-owned).
  SELECT count(*) INTO v_missing
  FROM public.income_expenses ie
  WHERE ie.deleted_at IS NULL
    AND ie.approval_status = 'APPROVED'
    AND ie.account_id IS NULL
    AND ie.active_posting_id_v2 IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM app_private.income_expense_flow_ownership o
                    WHERE o.income_expense_id = ie.id);
  IF v_missing <> 0 THEN
    RAISE EXCEPTION '7ah smoke B FAIL: còn % phiếu đã ghi sổ mà header trống sổ quỹ', v_missing;
  END IF;

  -- C. Sổ trên header phải TRÙNG sổ của bút toán đang hiệu lực.
  SELECT count(*) INTO v_bad
  FROM public.income_expenses ie
  JOIN public.income_expense_postings po
    ON po.id = ie.active_posting_id_v2 AND po.posting_subject_kind = 'VOUCHER'
  JOIN public.income_expense_posting_lines l
    ON l.posting_id = po.id AND l.line_kind = 'MAIN'
  WHERE ie.deleted_at IS NULL
    AND ie.approval_status = 'APPROVED'
    AND ie.account_id IS DISTINCT FROM l.account_id
    AND NOT EXISTS (SELECT 1 FROM app_private.income_expense_flow_ownership o
                    WHERE o.income_expense_id = ie.id);
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '7ah smoke C FAIL: % phiếu có sổ header lệch sổ bút toán', v_bad;
  END IF;

  RAISE NOTICE '7ah smoke OK';
END
$smoke$;

COMMIT;

NOTIFY pgrst, 'reload schema';

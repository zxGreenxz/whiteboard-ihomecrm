-- Finance V2 — 7ag: bịt lỗ "ô phân loại để trống thì guard không nổ".
--
-- GỐC RỄ (phát hiện khi truy lỗi cặp bỏ cọc 25/07)
--   3 guard tiền của Finance V2 viết bằng `<>` và `NOT IN`:
--     approve_income_expense_v2        : approval_status <> … OR review_state NOT IN …
--     post_approved_income_expense_v2  : posting_mode <> 'CASHBOOK'
--     approve_and_post_income_expense_v2: cả hai
--   Với posting_mode / review_state / posting_status = NULL, biểu thức cho ra
--   NULL ⇒ `IF NULL THEN` KHÔNG vào nhánh ⇒ guard im lặng cho qua. Đã chứng minh
--   trên chính 10 phiếu bỏ cọc: cả 3 guard đều trả NULL.
--   Nghĩa là chốt "chỉ phiếu CASHBOOK mới được ghi sổ" vô hiệu với mọi phiếu bỏ
--   trống ô phân loại — không riêng gì bỏ cọc.
--
-- HAI TẦNG FIX
--   (1) NGĂN TỪ ĐẦU — trigger a001 BEFORE INSERT điền 3 cột lifecycle khi writer
--       bỏ trống (sổ ảo/không sổ ⇒ NON_CASH·NOT_APPLICABLE; sổ thật ⇒
--       CASHBOOK·UNPOSTED; chờ duyệt ⇒ PENDING, còn lại ⇒ RESOLVED). Riêng ngày
--       24/07 có 21 phiếu mới sinh ra vẫn NULL ⇒ đây là lỗ đang chảy, không phải
--       chỉ dữ liệu cũ.
--   (2) NULL KHÔNG CÒN LỌT — đổi `<>` → `IS DISTINCT FROM` và bọc COALESCE cho
--       NOT IN trong 3 RPC. Phải làm SAU (1)+uplift, nếu không phiếu NULL hiện có
--       sẽ bị chặn oan.
--
-- UPLIFT dữ liệu cũ — CHỈ nhóm an toàn:
--   • bỏ qua phiếu FLOW-OWNED (lifecycle thuộc adapter, có freeze guard riêng);
--   • bỏ qua phiếu bỏ cọc (guard a05 đòi writer thanh lý — đã xử lý ở 20260725010000/020000);
--   • bỏ qua CANCELLED (terminal, không còn thao tác vòng đời);
--   • bỏ qua phiếu gắn payout cổ đông (guard riêng).
--   Phiếu lương APPROVED·NULL được xếp CASHBOOK·UNPOSTED = đúng hiện trạng
--   ("đã duyệt, chưa có bút toán"), KHÔNG tự sinh tiền; nhờ vậy màn Thu chi hiện
--   đúng nút "Chi tiền từ sổ" để owner quyết định.

BEGIN;

-- ---------------------------------------------------------------------------
-- (1) Trigger chuẩn hoá lifecycle lúc INSERT — chạy sau a000 defaults-fill,
--     trước bridge a85/a85b và birth a86.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.ie_normalize_lifecycle_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
DECLARE
  v_virtual boolean := false;
BEGIN
  IF NEW.posting_mode IS NULL THEN
    IF NEW.account_id IS NOT NULL THEN
      SELECT COALESCE(a.is_virtual, false) INTO v_virtual
      FROM public.accounts a WHERE a.id = NEW.account_id;
    END IF;
    NEW.posting_mode := CASE WHEN v_virtual THEN 'NON_CASH' ELSE 'CASHBOOK' END;
  END IF;

  IF NEW.posting_status IS NULL THEN
    NEW.posting_status := CASE WHEN NEW.posting_mode = 'NON_CASH'
                               THEN 'NOT_APPLICABLE' ELSE 'UNPOSTED' END;
  END IF;

  IF NEW.review_state IS NULL THEN
    NEW.review_state := CASE WHEN NEW.approval_status = 'UNAPPROVED'
                             THEN 'PENDING' ELSE 'RESOLVED' END;
  END IF;

  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS a001_ie_lifecycle_normalize ON public.income_expenses;
CREATE TRIGGER a001_ie_lifecycle_normalize
  BEFORE INSERT ON public.income_expenses
  FOR EACH ROW EXECUTE FUNCTION app_private.ie_normalize_lifecycle_columns();

-- ---------------------------------------------------------------------------
-- (2) Uplift dữ liệu cũ trong nhóm an toàn.
-- ---------------------------------------------------------------------------
DO $uplift$
DECLARE v_n integer;
BEGIN
  UPDATE public.income_expenses ie SET
    posting_mode = CASE WHEN COALESCE(a.is_virtual, false) THEN 'NON_CASH' ELSE 'CASHBOOK' END,
    posting_status = CASE
      WHEN COALESCE(a.is_virtual, false) THEN 'NOT_APPLICABLE'
      WHEN ie.active_posting_id_v2 IS NOT NULL OR ie.posting_id IS NOT NULL THEN 'POSTED'
      ELSE 'UNPOSTED' END,
    review_state = COALESCE(ie.review_state,
      CASE WHEN ie.approval_status = 'UNAPPROVED' THEN 'PENDING' ELSE 'RESOLVED' END)
  FROM (SELECT id, is_virtual FROM public.accounts) a
  WHERE a.id IS NOT DISTINCT FROM ie.account_id
    AND ie.posting_mode IS NULL
    AND ie.deleted_at IS NULL
    AND ie.approval_status IN ('UNAPPROVED', 'APPROVED')
    AND COALESCE(ie.system_source, '') NOT IN
        ('termination.forfeit_revenue', 'termination.forfeit_offset')
    AND NOT EXISTS (SELECT 1 FROM app_private.income_expense_flow_ownership o
                    WHERE o.income_expense_id = ie.id)
    AND NOT EXISTS (SELECT 1 FROM public.profit_payout_reservations pr
                    WHERE pr.payout_voucher_id = ie.id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '7ag uplift: % phiếu được xếp loại', v_n;

  -- Phiếu KHÔNG có sổ quỹ: JOIN ở trên bỏ sót (account_id NULL) → xử riêng.
  UPDATE public.income_expenses ie SET
    posting_mode   = 'CASHBOOK',
    posting_status = COALESCE(ie.posting_status, 'UNPOSTED'),
    review_state   = COALESCE(ie.review_state,
      CASE WHEN ie.approval_status = 'UNAPPROVED' THEN 'PENDING' ELSE 'RESOLVED' END)
  WHERE ie.account_id IS NULL
    AND ie.posting_mode IS NULL
    AND ie.deleted_at IS NULL
    AND ie.approval_status IN ('UNAPPROVED', 'APPROVED')
    AND NOT EXISTS (SELECT 1 FROM app_private.income_expense_flow_ownership o
                    WHERE o.income_expense_id = ie.id)
    AND NOT EXISTS (SELECT 1 FROM public.profit_payout_reservations pr
                    WHERE pr.payout_voucher_id = ie.id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '7ag uplift (không sổ): % phiếu', v_n;

  -- Phiếu ĐÃ có posting_mode nhưng thiếu review_state/posting_status (lớp cũ
  -- backfill Stage-4 chỉ điền 2 cột): bù nốt cột còn trống, không đổi cột đã có.
  UPDATE public.income_expenses ie SET
    review_state = COALESCE(ie.review_state,
      CASE WHEN ie.approval_status = 'UNAPPROVED' THEN 'PENDING' ELSE 'RESOLVED' END),
    posting_status = COALESCE(ie.posting_status,
      CASE WHEN ie.posting_mode = 'NON_CASH' THEN 'NOT_APPLICABLE' ELSE 'UNPOSTED' END)
  WHERE ie.posting_mode IS NOT NULL
    AND (ie.review_state IS NULL OR ie.posting_status IS NULL)
    AND ie.deleted_at IS NULL
    AND ie.approval_status IN ('UNAPPROVED', 'APPROVED')
    AND COALESCE(ie.system_source, '') NOT IN
        ('termination.forfeit_revenue', 'termination.forfeit_offset')
    AND NOT EXISTS (SELECT 1 FROM app_private.income_expense_flow_ownership o
                    WHERE o.income_expense_id = ie.id)
    AND NOT EXISTS (SELECT 1 FROM public.profit_payout_reservations pr
                    WHERE pr.payout_voucher_id = ie.id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '7ag uplift (bù cột lẻ): % phiếu', v_n;
END
$uplift$;

-- ---------------------------------------------------------------------------
-- (3) Guard null-safe trong 3 RPC.
-- ---------------------------------------------------------------------------
DO $guards$
DECLARE
  v_fn   text;
  v_def  text;
  v_new  text;
  v_hit  integer := 0;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'approve_income_expense_v2',
    'post_approved_income_expense_v2',
    'approve_and_post_income_expense_v2'
  ] LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_fn;
    IF v_def IS NULL THEN
      RAISE EXCEPTION '7ag: không tìm thấy %', v_fn;
    END IF;

    v_new := v_def;
    v_new := replace(v_new,
      'IF v_ie.posting_mode <> ''CASHBOOK'' THEN',
      'IF v_ie.posting_mode IS DISTINCT FROM ''CASHBOOK'' THEN');
    v_new := replace(v_new,
      'v_ie.approval_status <> ''UNAPPROVED''',
      'v_ie.approval_status IS DISTINCT FROM ''UNAPPROVED''');
    v_new := replace(v_new,
      'v_ie.review_state NOT IN (''PENDING'',''CHANGES_REQUESTED'')',
      'COALESCE(v_ie.review_state, '''') NOT IN (''PENDING'',''CHANGES_REQUESTED'')');
    v_new := replace(v_new,
      'v_ie.posting_status <> ''UNPOSTED''',
      'v_ie.posting_status IS DISTINCT FROM ''UNPOSTED''');

    IF v_new <> v_def THEN
      EXECUTE v_new;
      v_hit := v_hit + 1;
    END IF;
  END LOOP;

  IF v_hit < 3 THEN
    RAISE EXCEPTION '7ag: chỉ vá được %/3 RPC — pattern guard đã đổi, kiểm tra thủ công', v_hit;
  END IF;
  RAISE NOTICE '7ag: đã null-safe %/3 RPC', v_hit;
END
$guards$;

-- ---------------------------------------------------------------------------
-- (4) Tự kiểm.
-- ---------------------------------------------------------------------------
DO $smoke$
DECLARE
  v_bad integer;
  v_id  uuid;
  v_row record;
BEGIN
  -- A. Không còn guard nào dùng dạng so sánh nuốt NULL.
  SELECT count(*) INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('approve_income_expense_v2', 'post_approved_income_expense_v2',
                      'approve_and_post_income_expense_v2')
    AND (pg_get_functiondef(p.oid) LIKE '%v_ie.posting_mode <> ''CASHBOOK''%'
      OR pg_get_functiondef(p.oid) LIKE '%v_ie.approval_status <> ''UNAPPROVED''%'
      OR pg_get_functiondef(p.oid) LIKE '%v_ie.review_state NOT IN%'
      OR pg_get_functiondef(p.oid) LIKE '%v_ie.posting_status <> ''UNPOSTED''%');
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '7ag smoke A FAIL: còn % RPC dùng so sánh nuốt NULL', v_bad;
  END IF;

  -- B. Phiếu SỐNG ngoài nhóm loại trừ phải có đủ 3 cột lifecycle.
  SELECT count(*) INTO v_bad
  FROM public.income_expenses ie
  WHERE ie.deleted_at IS NULL
    AND ie.approval_status IN ('UNAPPROVED', 'APPROVED')
    AND (ie.posting_mode IS NULL OR ie.posting_status IS NULL OR ie.review_state IS NULL)
    AND COALESCE(ie.system_source, '') NOT IN
        ('termination.forfeit_revenue', 'termination.forfeit_offset')
    AND NOT EXISTS (SELECT 1 FROM app_private.income_expense_flow_ownership o
                    WHERE o.income_expense_id = ie.id)
    AND NOT EXISTS (SELECT 1 FROM public.profit_payout_reservations pr
                    WHERE pr.payout_voucher_id = ie.id);
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '7ag smoke B FAIL: còn % phiếu sống thiếu cột lifecycle', v_bad;
  END IF;

  -- C. Trigger a001 thật sự điền cho phiếu mới (insert thử trên DEMO rồi xoá).
  INSERT INTO public.income_expenses
    (organization_id, user_id, code, type, name, building_id, account_id,
     voucher_date, total_amount, approval_status)
  SELECT 'dddd0000-0000-4000-8000-000000000001', m.user_id,
         'SMK7AG-' || floor(extract(epoch from clock_timestamp()))::text,
         'EXPENSE', '[SMOKE 7ag] normalize lifecycle', b.id, NULL,
         CURRENT_DATE, 1000, 'UNAPPROVED'
  FROM public.buildings b
  JOIN public.organization_memberships m
    ON m.organization_id = b.organization_id AND m.status = 'ACTIVE'
  WHERE b.organization_id = 'dddd0000-0000-4000-8000-000000000001'
    AND b.deleted_at IS NULL
  LIMIT 1
  RETURNING id INTO v_id;

  SELECT posting_mode, posting_status, review_state INTO v_row
  FROM public.income_expenses WHERE id = v_id;
  IF v_row.posting_mode IS DISTINCT FROM 'CASHBOOK'
     OR v_row.posting_status IS DISTINCT FROM 'UNPOSTED'
     OR v_row.review_state IS DISTINCT FROM 'PENDING' THEN
    RAISE EXCEPTION '7ag smoke C FAIL: trigger không điền đúng (%, %, %)',
      v_row.posting_mode, v_row.posting_status, v_row.review_state;
  END IF;
  DELETE FROM public.income_expenses WHERE id = v_id;

  RAISE NOTICE '7ag smoke OK';
END
$smoke$;

COMMIT;

NOTIFY pgrst, 'reload schema';

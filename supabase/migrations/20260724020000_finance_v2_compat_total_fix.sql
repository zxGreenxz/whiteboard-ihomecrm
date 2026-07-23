-- Finance V2 — Hotfix 7n: ie_compat_insert_v2 vỡ 23502 total_amount NULL.
--
-- E2E spec finance-v2 bắt được (cùng lớp với 7m/null-id): client compat không
-- gửi total_amount (FE cũng không — dựa trigger recalc theo items), nhưng
-- jsonb_populate_record sinh NULL TƯỜNG MINH cho mọi cột thiếu ⇒ DEFAULT 0
-- không áp ⇒ INSERT header nổ 23502 trước khi items kịp recalc.
--
-- Fix: trước INSERT, nếu v_clean thiếu total_amount thì tính Σ items
-- (amount || quantity*unit_price); items sau đó vẫn recalc chính xác.

BEGIN;

DO $patch$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p WHERE p.proname='ie_compat_insert_v2'
    AND p.pronamespace='public'::regnamespace;
  IF v_def NOT LIKE '%compat_total_fix%' THEN
    v_def := replace(v_def,
      'INSERT INTO public.income_expenses
  SELECT * FROM jsonb_populate_record(NULL::public.income_expenses, v_clean)',
      '-- compat_total_fix: populate_record sinh NULL tường minh → default 0 không áp.
  IF (v_clean->>''total_amount'') IS NULL THEN
    v_clean := v_clean || jsonb_build_object(''total_amount'', COALESCE((
      SELECT SUM(COALESCE((i->>''amount'')::numeric,
                          COALESCE((i->>''quantity'')::numeric,1)
                          * COALESCE((i->>''unit_price'')::numeric,0)))
      FROM jsonb_array_elements(COALESCE(p_items, ''[]''::jsonb)) i), 0));
  END IF;
  INSERT INTO public.income_expenses
  SELECT * FROM jsonb_populate_record(NULL::public.income_expenses, v_clean)');
    IF v_def NOT LIKE '%compat_total_fix%' THEN
      RAISE EXCEPTION 'compat total fix: pattern không khớp — kiểm tra thủ công';
    END IF;
    EXECUTE v_def;
  END IF;
END
$patch$;

COMMIT;

NOTIFY pgrst, 'reload schema';

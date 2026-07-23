-- Finance V2 — Hotfix 7o: compat insert đè MỌI default (lớp lỗi 7m/7n, triệt để).
--
-- jsonb_populate_record(NULL::income_expenses, v_clean) sinh NULL TƯỜNG MINH cho
-- mọi cột thiếu key ⇒ INSERT ... SELECT record nêu đủ cột ⇒ KHÔNG default nào áp
-- (id, created_at, updated_at, total_amount, version…) ⇒ 23502 lần lượt từng cột
-- (E2E bắt created_at ngay sau khi vá total_amount). Fix GENERIC: trước INSERT,
-- bù tự động mọi cột NOT NULL có default còn thiếu trong v_clean bằng chính
-- biểu thức default của cột (đọc từ information_schema — không hardcode).

BEGIN;

DO $patch$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p WHERE p.proname='ie_compat_insert_v2'
    AND p.pronamespace='public'::regnamespace;

  IF v_def NOT LIKE '%compat_defaults_fix%' THEN
    -- (a) thêm biến loop vào DECLARE.
    v_def := replace(v_def,
      'DECLARE
  v_org uuid;',
      'DECLARE
  v_org uuid;
  v_colrec record;
  v_defj jsonb;');
    -- (b) chèn loop bù default ngay trước INSERT (sau total-fix hiện có).
    v_def := replace(v_def,
      'INSERT INTO public.income_expenses
  SELECT * FROM jsonb_populate_record(NULL::public.income_expenses, v_clean)',
      '-- compat_defaults_fix: bù MỌI cột NOT NULL có default còn thiếu (generic).
  FOR v_colrec IN
    SELECT c.column_name, c.column_default
    FROM information_schema.columns c
    WHERE c.table_schema=''public'' AND c.table_name=''income_expenses''
      AND c.is_nullable=''NO'' AND c.column_default IS NOT NULL
  LOOP
    IF (v_clean->>v_colrec.column_name) IS NULL THEN
      EXECUTE format(''SELECT to_jsonb(%s)'', v_colrec.column_default) INTO v_defj;
      v_clean := v_clean || jsonb_build_object(v_colrec.column_name, v_defj);
    END IF;
  END LOOP;
  INSERT INTO public.income_expenses
  SELECT * FROM jsonb_populate_record(NULL::public.income_expenses, v_clean)');
    IF v_def NOT LIKE '%compat_defaults_fix%' THEN
      RAISE EXCEPTION 'compat defaults fix: pattern không khớp — kiểm tra thủ công';
    END IF;
    EXECUTE v_def;
  END IF;
END
$patch$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- Finance V2 — Hotfix 7p: lớp lỗi populate_record-đè-default cho ITEMS (nốt 7o).
--
-- E2E bắt tiếp: sau khi bù default cho header (7o), items vẫn nổ 23502
-- income_expense_items.id NULL — vòng lặp items cũng jsonb_populate_record.
-- Fix cùng cách generic: bù id/quantity/unit_price/created_at (mọi cột NOT NULL
-- có default của income_expense_items) khi item jsonb thiếu key.

BEGIN;

DO $patch$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p WHERE p.proname='ie_compat_insert_v2'
    AND p.pronamespace='public'::regnamespace;

  IF v_def NOT LIKE '%compat_item_defaults_fix%' THEN
    v_def := replace(v_def,
      'FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, ''[]''::jsonb)) LOOP
    INSERT INTO public.income_expense_items
    SELECT * FROM jsonb_populate_record(NULL::public.income_expense_items,
      (v_item - ''income_expense_id'') || jsonb_build_object(''income_expense_id'', v_id));
  END LOOP;',
      'FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, ''[]''::jsonb)) LOOP
    -- compat_item_defaults_fix: populate_record đè default → bù cột thiếu.
    v_item := (v_item - ''income_expense_id'')
              || jsonb_build_object(''income_expense_id'', v_id);
    FOR v_colrec IN
      SELECT c.column_name, c.column_default
      FROM information_schema.columns c
      WHERE c.table_schema=''public'' AND c.table_name=''income_expense_items''
        AND c.is_nullable=''NO'' AND c.column_default IS NOT NULL
    LOOP
      IF (v_item->>v_colrec.column_name) IS NULL THEN
        EXECUTE format(''SELECT to_jsonb(%s)'', v_colrec.column_default) INTO v_defj;
        v_item := v_item || jsonb_build_object(v_colrec.column_name, v_defj);
      END IF;
    END LOOP;
    INSERT INTO public.income_expense_items
    SELECT * FROM jsonb_populate_record(NULL::public.income_expense_items, v_item);
  END LOOP;');
    IF v_def NOT LIKE '%compat_item_defaults_fix%' THEN
      RAISE EXCEPTION 'compat item defaults fix: pattern không khớp — kiểm tra thủ công';
    END IF;
    EXECUTE v_def;
  END IF;
END
$patch$;

COMMIT;

NOTIFY pgrst, 'reload schema';

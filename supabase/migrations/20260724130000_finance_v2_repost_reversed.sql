-- Finance V2 — 7x: CHI LẠI phiếu ĐÃ HOÀN TÁC (mô hình 2 nút — owner chốt 24/07).
--
-- Plan cho phép "reversal + replacement" với generation > 1 (§posting model);
-- unique (org, subject, generation) WHERE POSTING đã sẵn sàng. Hiện writer
-- hardcode generation=1 và post RPC đòi UNPOSTED ⇒ phiếu REVERSED (đã hoàn
-- tác — vd chi nhầm sổ) không chi lại được, phải huỷ + tạo bản sao.
--
-- Nới đúng phạm vi:
-- (1) finance_v2_post_manual_voucher: posting_generation = MAX(gen POSTING)+1.
-- (2) post_approved_income_expense_v2: nhận APPROVED + (UNPOSTED|REVERSED);
--     khi re-post clear reversed_by_posting_id (pointer header sạch).
-- Idempotency/double-click vẫn nguyên: unique idempotency_key + CAS
-- posting_version + unique generation.

BEGIN;

-- (1) generation kế tiếp thay hardcode 1.
DO $gen$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='app_private' AND p.proname='finance_v2_post_manual_voucher';
  IF v_def NOT LIKE '%v_gen integer%' THEN
    v_def := replace(v_def,
      'DECLARE
  v_posting_id uuid := gen_random_uuid();',
      'DECLARE
  v_posting_id uuid := gen_random_uuid();
  v_gen integer;');
    v_def := replace(v_def,
      'v_signed := CASE WHEN p_ie.type = ''INCOME'' THEN p_ie.total_amount ELSE -p_ie.total_amount END;',
      'v_signed := CASE WHEN p_ie.type = ''INCOME'' THEN p_ie.total_amount ELSE -p_ie.total_amount END;

  -- 7x: re-post sau reversal = thế hệ bút toán MỚI (unique generation giữ 1
  -- POSTING active/thế hệ; bút toán cũ + reversal bất biến).
  SELECT COALESCE(MAX(p2.posting_generation), 0) + 1 INTO v_gen
  FROM public.income_expense_postings p2
  WHERE p2.organization_id = p_ie.organization_id
    AND p2.posting_subject_kind = ''VOUCHER''
    AND p2.posting_subject_id = p_ie.id
    AND p2.event_kind = ''POSTING'';');
    v_def := replace(v_def,
      '''POSTING'', p_idempotency_key || '':posting'', ''MANUAL'', 1, now()',
      '''POSTING'', p_idempotency_key || '':posting'', ''MANUAL'', v_gen, now()');
    IF v_def NOT LIKE '%v_gen integer%' OR v_def NOT LIKE '%''MANUAL'', v_gen, now()%' THEN
      RAISE EXCEPTION 'repost gen patch: pattern không khớp — kiểm tra thủ công';
    END IF;
    EXECUTE v_def;
  END IF;
END
$gen$;

-- (2) post RPC nhận REVERSED + clear pointer reversal cũ trên header.
DO $rpc$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='post_approved_income_expense_v2';
  IF v_def NOT LIKE '%NOT IN (''UNPOSTED'', ''REVERSED'')%' THEN
    v_def := replace(v_def,
      'IF v_ie.approval_status <> ''APPROVED'' OR v_ie.posting_status <> ''UNPOSTED'' THEN
    RAISE EXCEPTION ''post_approved_income_expense_v2: voucher must be APPROVED + UNPOSTED (%, %)'',',
      'IF v_ie.approval_status <> ''APPROVED''
     OR v_ie.posting_status NOT IN (''UNPOSTED'', ''REVERSED'') THEN
    RAISE EXCEPTION ''post_approved_income_expense_v2: voucher must be APPROVED + UNPOSTED/REVERSED (%, %)'',');
    v_def := replace(v_def,
      'SET active_posting_id_v2 = v_posting_id, posting_status = ''POSTED'',',
      'SET active_posting_id_v2 = v_posting_id, posting_status = ''POSTED'',
         reversed_by_posting_id = NULL,');
    IF v_def NOT LIKE '%NOT IN (''UNPOSTED'', ''REVERSED'')%'
       OR v_def NOT LIKE '%reversed_by_posting_id = NULL,%' THEN
      RAISE EXCEPTION 'repost rpc patch: pattern không khớp — kiểm tra thủ công';
    END IF;
    EXECUTE v_def;
  END IF;
END
$rpc$;

COMMIT;

NOTIFY pgrst, 'reload schema';

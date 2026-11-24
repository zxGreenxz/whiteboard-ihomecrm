-- Cọc giữ lại theo thoả thuận: phần cọc không hoàn cho khách khi thanh lý thành doanh thu có chứng từ, không để treo
-- trên hợp đồng. Plan "Sang nhượng phòng trong hộp Thanh lý", đợt 4, phần máy chủ (chủ duyệt 24/11/2026; luật sàn do
-- phiên điều phối chốt 25/11/2026, hướng C).
--
-- Luật ở hàm lõi quyết toán rời phòng (terminate_contract_move_out_impl, mọi đường quyết toán đi qua):
--   sàn = số nhỏ hơn giữa cọc đã thu (contracts.deposit_paid hiện hành, đã trừ số hỗ trợ sang nhượng nếu có) và cọc
--   theo hợp đồng (total_deposit; NULL tính là 0). Cọc đem ra quyết toán thấp hơn sàn thì từ chối: hoàn đủ, hoặc ghi
--   phần không hoàn thành dòng kind DEPOSIT_RETAINED "Cọc giữ lại theo thoả thuận".
--   Cọc đem ra nằm giữa sàn và cọc đã thu (sổ cọc ghi dôi trên cọc hợp đồng, người dùng đối chiếu rồi nhập số thực giữ)
--   cho qua như trước: phần dôi là lệch sổ, không phải cọc giữ lại, nên không thành doanh thu.
--   Dòng DEPOSIT_RETAINED là một khoản thu thêm như mọi khoản khác (dòng hoá đơn thanh lý, cấn từ cọc qua cặp bút toán
--   nội bộ), tối đa một dòng, đúng tên, không vượt cọc đem ra. Trên phiếu "Doanh thu thanh lý" phần đó đứng hạng mục
--   riêng "Cọc giữ lại theo thoả thuận" (doanh thu, không phải cọc); tổng phiếu, số phiếu và mọi phép tính khác giữ nguyên.
-- Hai trường hợp sang nhượng (nhờ sale, tự tìm) hoàn đủ cọc: không có dòng DEPOSIT_RETAINED (kiểm ở
-- assert_exit_early_terms_settlement_v1). Bỏ cọc đã giữ toàn bộ cọc: không nhận dòng này (kiểm ở
-- run_contract_exit_settlement_v1). Hàm bỏ cọc và đường duyệt hồ sơ thanh lý kiểu cũ không đổi.
--
-- Hàm hiện hành chỉ nối thêm bằng neo (mỗi neo đúng một lần, chạy lại thì bỏ qua); giữ nguyên hai điểm nối
-- is_contract_exit_settlement_v1 của hàm lõi. Không vá hàm nào trong nhóm retirement của supabase/migration-policy.json.

DO $requires$
BEGIN
  IF to_regprocedure('public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)') IS NULL
    OR to_regprocedure('app_private.run_contract_exit_settlement_v1(uuid,text,jsonb,text,boolean)') IS NULL
    OR to_regprocedure('app_private.assert_exit_early_terms_settlement_v1(uuid,text,jsonb)') IS NULL
    OR to_regprocedure('app_private.is_contract_exit_settlement_v1(uuid,date)') IS NULL
    OR to_regprocedure('public._termination_ensure_type(uuid,text,text)') IS NULL
    OR to_regprocedure('public._termination_apply_extra_charges(uuid,jsonb,date,uuid,uuid)') IS NULL
    OR to_regclass('public.contract_exit_early_terms') IS NULL THEN
    RAISE EXCEPTION 'coc_giu_lai_thieu_phu_thuoc' USING ERRCODE='55000';
  END IF;
END
$requires$;

-- 1. Nối vào hàm hiện hành bằng neo. Neo phải xuất hiện đúng một lần; đã nối thì bỏ qua.
DO $patch$
DECLARE r record; v_body text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    -- Biến của luật sàn và dòng giữ lại.
    (1,'public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)',
      $a$  rec         RECORD;$a$,
      $r$  rec         RECORD;
  v_deposit_floor numeric(15,2);
  v_retained  numeric(15,2) := 0;
  v_retained_count integer := 0;
  v_retained_bad integer := 0;
  v_type_ret  uuid;$r$,
      $m$v_deposit_floor numeric(15,2);$m$),
    -- Luật sàn ngay trước dòng tính cọc đem ra; kiểm dòng giữ lại ngay sau.
    (2,'public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)',
      $a$  v_deposit := LEAST(GREATEST(COALESCE(p_deposit_refund, 0), 0), COALESCE(v_contract.deposit_paid, 0));$a$,
      $r$  -- Đợt 4: cọc đem ra không thấp hơn sàn (số nhỏ hơn giữa cọc đã thu và cọc theo hợp đồng); phần không hoàn theo
  -- thoả thuận là dòng DEPOSIT_RETAINED. Sổ cọc ghi dôi trên cọc hợp đồng giữ như trước (lệch sổ, không thành doanh thu).
  v_deposit_floor := LEAST(GREATEST(COALESCE(v_contract.deposit_paid, 0), 0), GREATEST(COALESCE(v_contract.total_deposit, 0), 0));
  IF GREATEST(COALESCE(p_deposit_refund, 0), 0) < v_deposit_floor THEN
    RAISE EXCEPTION 'Cọc đem ra quyết toán (% đ) thấp hơn cọc phải xử lý (% đ). Hoàn đủ cọc, hoặc ghi phần không hoàn thành dòng "Cọc giữ lại theo thoả thuận".',
      round(GREATEST(COALESCE(p_deposit_refund, 0), 0))::bigint, round(v_deposit_floor)::bigint USING ERRCODE = '22023';
  END IF;
  v_deposit := LEAST(GREATEST(COALESCE(p_deposit_refund, 0), 0), COALESCE(v_contract.deposit_paid, 0));
  IF jsonb_typeof(COALESCE(p_extra_charges, '[]'::jsonb)) = 'array' THEN
    SELECT count(*), COALESCE(SUM(GREATEST(COALESCE(NULLIF(j->>'amount', '')::numeric, 0), 0)), 0),
           count(*) FILTER (WHERE btrim(COALESCE(j->>'description', '')) <> 'Cọc giữ lại theo thoả thuận'
                              OR COALESCE(NULLIF(j->>'amount', '')::numeric, 0) <= 0)
      INTO v_retained_count, v_retained, v_retained_bad
      FROM jsonb_array_elements(p_extra_charges) AS t(j)
     WHERE j->>'kind' = 'DEPOSIT_RETAINED';
  END IF;
  IF v_retained_count > 1 OR v_retained_bad > 0 THEN
    RAISE EXCEPTION 'Quyết toán chỉ có tối đa một dòng "Cọc giữ lại theo thoả thuận", đúng tên đó, số tiền lớn hơn 0'
      USING ERRCODE = '22023';
  END IF;
  IF v_retained > 0 AND v_retained > v_deposit THEN
    RAISE EXCEPTION 'Cọc giữ lại theo thoả thuận (% đ) lớn hơn cọc đem ra quyết toán (% đ)',
      round(v_retained)::bigint, round(v_deposit)::bigint USING ERRCODE = '22023';
  END IF;$r$,
      $m$v_deposit_floor := LEAST($m$),
    -- Ghi chú quyết toán nói rõ phần giữ lại.
    (3,'public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)',
      $a$    || E'\n• Hoàn cọc lại khách: '$a$,
      $r$    || CASE WHEN v_retained > 0 THEN E'\n• Trong đó cọc giữ lại theo thoả thuận: ' || to_char(v_retained, 'FM999G999G999G990') || 'đ (doanh thu thanh lý)' ELSE '' END
    || E'\n• Hoàn cọc lại khách: '$r$,
      $m$Trong đó cọc giữ lại theo thoả thuận: $m$),
    -- Phiếu "Doanh thu thanh lý": phần cọc giữ lại đứng hạng mục riêng, phần còn lại giữ hạng mục cũ; tổng phiếu không đổi.
    (4,'public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)',
      $a$    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, 'Doanh thu thanh lý (cấn cọc)', 1, v_applied_dep, p_move_out_date, p_move_out_date);$a$,
      $r$    IF v_applied_dep > LEAST(v_retained, v_applied_dep) THEN
      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
      VALUES (v_voucher, v_type_inc, 'Doanh thu thanh lý (cấn cọc)', 1, v_applied_dep - LEAST(v_retained, v_applied_dep), p_move_out_date, p_move_out_date);
    END IF;
    IF LEAST(v_retained, v_applied_dep) > 0 THEN
      v_type_ret := public._termination_ensure_type(v_contract.user_id, 'income', 'Cọc giữ lại theo thoả thuận');
      UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_ret AND is_deposit IS DISTINCT FROM FALSE;
      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
      VALUES (v_voucher, v_type_ret, 'Cọc giữ lại theo thoả thuận', 1, LEAST(v_retained, v_applied_dep), p_move_out_date, p_move_out_date);
    END IF;$r$,
      $m$'Cọc giữ lại theo thoả thuận', 1, LEAST(v_retained, v_applied_dep)$m$),
    -- Hai trường hợp sang nhượng hoàn đủ cọc cho khách cũ.
    (5,'app_private.assert_exit_early_terms_settlement_v1(uuid,text,jsonb)',
      $a$  IF t.early_reason IN ('SALE_ASSISTED','SELF_FOUND') THEN$a$,
      $r$  IF t.early_reason IN ('SALE_ASSISTED','SELF_FOUND') AND jsonb_typeof(p_settlement->'extra_charges')='array'
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_settlement->'extra_charges') j WHERE j->>'kind'='DEPOSIT_RETAINED') THEN
    RAISE EXCEPTION 'Hồ sơ sang nhượng phòng hoàn đủ cọc cho khách cũ: không có dòng "Cọc giữ lại theo thoả thuận"' USING ERRCODE='22023';
  END IF;
  IF t.early_reason IN ('SALE_ASSISTED','SELF_FOUND') THEN$r$,
      $m$không có dòng "Cọc giữ lại theo thoả thuận"$m$),
    -- Bỏ cọc: toàn bộ cọc đã thành doanh thu bỏ cọc, không có dòng giữ lại.
    (6,'app_private.run_contract_exit_settlement_v1(uuid,text,jsonb,text,boolean)',
      $a$    RAISE EXCEPTION 'Unknown settlement fields' USING ERRCODE='22023';
  END IF;$a$,
      $r$    RAISE EXCEPTION 'Unknown settlement fields' USING ERRCODE='22023';
  END IF;
  IF p_kind='FORFEIT' AND jsonb_typeof(p_payload->'extra_charges')='array'
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload->'extra_charges') j WHERE j->>'kind'='DEPOSIT_RETAINED') THEN
    RAISE EXCEPTION 'Bỏ cọc đã giữ toàn bộ cọc thành doanh thu bỏ cọc: không thêm dòng "Cọc giữ lại theo thoả thuận"' USING ERRCODE='22023';
  END IF;$r$,
      $m$Bỏ cọc đã giữ toàn bộ cọc thành doanh thu bỏ cọc$m$)
  ) AS edits(ord,signature,anchor,replacement,marker) ORDER BY ord LOOP
    v_body:=pg_get_functiondef(r.signature::regprocedure);
    IF strpos(v_body,r.marker)=0 THEN
      IF (length(v_body)-length(replace(v_body,r.anchor,'')))<>length(r.anchor) THEN
        RAISE EXCEPTION 'coc_giu_lai_neo_lech %',r.ord USING ERRCODE='55000';
      END IF;
      EXECUTE replace(v_body,r.anchor,r.replacement);
    ELSIF (length(v_body)-length(replace(v_body,r.marker,'')))<>length(r.marker)
      OR (length(v_body)-length(replace(v_body,r.replacement,'')))<>length(r.replacement) THEN
      RAISE EXCEPTION 'coc_giu_lai_noi_sai_cho %',r.ord USING ERRCODE='55000';
    END IF;
  END LOOP;
END
$patch$;

-- 2. Nghiệm thu: mỗi điểm nối đúng một lần, hai điểm nối is_contract_exit_settlement_v1 còn nguyên, độ biến động và
-- SECURITY DEFINER giữ nguyên, hàm lõi vẫn đóng với người dùng đăng nhập.
DO $check$
DECLARE r record; v_def text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)','v_deposit_floor numeric(15,2);',1),
    ('public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)','v_deposit_floor := LEAST(',1),
    ('public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)','IF GREATEST(COALESCE(p_deposit_refund, 0), 0) < v_deposit_floor THEN',1),
    ('public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)','v_deposit := LEAST(GREATEST(COALESCE(p_deposit_refund, 0), 0), COALESCE(v_contract.deposit_paid, 0));',1),
    ('public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)','Trong đó cọc giữ lại theo thoả thuận: ',1),
    ('public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)','''Cọc giữ lại theo thoả thuận'', 1, LEAST(v_retained, v_applied_dep)',1),
    ('public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)','''Doanh thu thanh lý (cấn cọc)''',1),
    ('public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)','app_private.is_contract_exit_settlement_v1(p_contract_id,p_move_out_date)',2),
    ('app_private.assert_exit_early_terms_settlement_v1(uuid,text,jsonb)','không có dòng "Cọc giữ lại theo thoả thuận"',1),
    ('app_private.run_contract_exit_settlement_v1(uuid,text,jsonb,text,boolean)','Bỏ cọc đã giữ toàn bộ cọc thành doanh thu bỏ cọc',1)
  ) AS t(sig,marker,times) LOOP
    v_def:=pg_get_functiondef(r.sig::regprocedure);
    IF (length(v_def)-length(replace(v_def,r.marker,'')))<>length(r.marker)*r.times
      OR (SELECT p.provolatile::text FROM pg_proc p WHERE p.oid=r.sig::regprocedure)<>'v'
      OR NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid=r.sig::regprocedure) THEN
      RAISE EXCEPTION 'coc_giu_lai_nghiem_thu_lech %',r.marker USING ERRCODE='55000';
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated','public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)','EXECUTE')
    OR has_function_privilege('anon','public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.run_contract_exit_settlement_v1(uuid,text,jsonb,text,boolean)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.assert_exit_early_terms_settlement_v1(uuid,text,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'coc_giu_lai_nghiem_thu_quyen_lech' USING ERRCODE='55000';
  END IF;
END
$check$;

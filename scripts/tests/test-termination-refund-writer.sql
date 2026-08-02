-- Đợt 8 — test sinh phiếu hoàn. Org DEMO, rollback sạch.
DO $t$
DECLARE
  v_demo uuid := 'dddd0000-0000-4000-8000-000000000001';
  v_owner uuid; v_tm uuid; v_ob uuid; v_acc_that uuid; v_acc_ao uuid;
  v_ket text := ''; v_r jsonb; v_n int;
BEGIN
  SELECT t.id, c.user_id INTO v_tm, v_owner
    FROM contract_terminations t JOIN contracts c ON c.id=t.contract_id
   WHERE c.organization_id=v_demo AND c.room_id IS NOT NULL LIMIT 1;
  IF v_tm IS NULL THEN RAISE EXCEPTION 'KẾT QUẢ: DEMO không có hồ sơ thanh lý gắn phòng'; END IF;
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
  SELECT id INTO v_acc_that FROM accounts WHERE organization_id=v_demo
     AND deleted_at IS NULL AND NOT COALESCE(is_virtual,false) LIMIT 1;
  SELECT id INTO v_acc_ao FROM accounts WHERE organization_id=v_demo
     AND deleted_at IS NULL AND COALESCE(is_virtual,false) LIMIT 1;

  -- Ép ca lệch: cọc 999tr trên hồ sơ nhưng cọc thật = 0
  UPDATE contract_terminations SET total_deposit = 999000000 WHERE id=v_tm;
  v_r := public.record_termination_refund_obligation_v1(v_tm);
  SELECT id INTO v_ob FROM termination_refund_obligations
   WHERE termination_id=v_tm ORDER BY version DESC LIMIT 1;
  v_ket := v_ket || E'\n0 · nghĩa vụ = '||(v_r->>'obligationStatus');

  -- 1: KHÔNG ép ⇒ phải chặn
  BEGIN
    PERFORM public.create_termination_refund_voucher_v1(v_ob, v_acc_that, false, NULL);
    v_ket := v_ket || E'\n1 ✗ sinh phiếu dù nghĩa vụ đang cảnh báo!';
  EXCEPTION WHEN OTHERS THEN
    v_ket := v_ket || CASE WHEN position('chủ tổ chức phải ép' IN SQLERRM) > 0
      THEN E'\n1 ✓ chặn sinh phiếu khi nghĩa vụ cảnh báo'
      ELSE E'\n1 ? '||left(SQLERRM,70) END;
  END;

  -- 2: ép nhưng thiếu lý do ⇒ chặn
  BEGIN
    PERFORM public.create_termination_refund_voucher_v1(v_ob, v_acc_that, true, 'ngan');
    v_ket := v_ket || E'\n2 ✗ nhận lý do quá ngắn';
  EXCEPTION WHEN OTHERS THEN
    v_ket := v_ket || CASE WHEN position('lý do' IN SQLERRM) > 0
      THEN E'\n2 ✓ ép phải kèm lý do đủ dài' ELSE E'\n2 ? '||left(SQLERRM,60) END;
  END;

  -- 3: SỔ ẢO ⇒ chặn
  IF v_acc_ao IS NOT NULL THEN
    BEGIN
      PERFORM public.create_termination_refund_voucher_v1(v_ob, v_acc_ao, true,
                'chủ chấp nhận chi vượt để test');
      v_ket := v_ket || E'\n3 ✗ cho hoàn cọc vào SỔ ẢO!';
    EXCEPTION WHEN OTHERS THEN
      v_ket := v_ket || CASE WHEN position('SỔ ẢO' IN SQLERRM) > 0
        THEN E'\n3 ✓ chặn sổ ảo' ELSE E'\n3 ? '||left(SQLERRM,60) END;
    END;
  END IF;

  -- 4: chủ ép đúng cách ⇒ sinh được, và phiếu CHỜ DUYỆT
  v_r := public.create_termination_refund_voucher_v1(v_ob, v_acc_that, true,
           'Chủ xác nhận đã thu cọc bằng tiền mặt ngoài hệ, chấp nhận hoàn');
  v_ket := v_ket || E'\n4 ✓ chủ ép sinh được phiếu '||(v_r->>'code');
  SELECT count(*) INTO v_n FROM income_expenses
   WHERE id=(v_r->>'voucherId')::uuid AND approval_status='UNAPPROVED'
     AND posting_status IS DISTINCT FROM 'POSTED';
  v_ket := v_ket || CASE WHEN v_n=1 THEN E'\n4b ✓ phiếu CHỜ DUYỆT, chưa ghi sổ'
                         ELSE E'\n4b ✗ phiếu không ở trạng thái chờ duyệt' END;

  -- 5: gọi lại ⇒ trả phiếu cũ, KHÔNG đẻ phiếu thứ hai
  v_r := public.create_termination_refund_voucher_v1(v_ob, v_acc_that, true, 'gọi lại');
  SELECT count(*) INTO v_n FROM income_expenses
   WHERE contract_id=(SELECT contract_id FROM termination_refund_obligations WHERE id=v_ob)
     AND system_source='termination.refund.v2';
  v_ket := v_ket || CASE WHEN (v_r->>'alreadyCreated')::bool AND v_n=1
    THEN E'\n5 ✓ gọi lại trả phiếu cũ, vẫn chỉ 1 phiếu'
    ELSE E'\n5 ✗ đẻ '||v_n||' phiếu' END;

  -- 6: lý do ép phải nằm trong ghi chú phiếu (dấu vết)
  SELECT count(*) INTO v_n FROM income_expenses
   WHERE id=(v_r->>'voucherId')::uuid AND notes LIKE 'ÉP SINH%';
  v_ket := v_ket || CASE WHEN v_n=1 THEN E'\n6 ✓ ghi chú phiếu lưu dấu vết ép sinh + lý do'
                         ELSE E'\n6 ✗ không lưu dấu vết' END;

  RAISE EXCEPTION 'KẾT QUẢ:%', v_ket;
END
$t$;

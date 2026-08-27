-- Đợt 8 + vá 28/08 — test sinh phiếu hoàn. Org DEMO, rollback sạch (RAISE cuối).
--
-- Sửa 28/08/2026:
--  · Fixture thẩm quyền ép: bản cũ lấy c.user_id của hợp đồng — user đó không
--    có quyền ép nên ca 4 gãy 42501. Đo 28/08: org DEMO có 0 binding
--    TENANT_OWNER (is_org_owner_v1 trả false cho cả 7 member), nên dùng nhánh
--    thẩm quyền còn lại của writer: SUPER ADMIN. Test vẫn chỉ ghi vào org DEMO.
--  · Ca 5 đổi từ đếm theo system_source (.v2, chuỗi mồ côi đã bị vá) sang so
--    sánh ĐÚNG id phiếu — miễn nhiễm với phiếu legacy sẵn có của hợp đồng.
--  · Thêm ca 7 (F2: record version mới rồi gọi lại ⇒ vẫn trả phiếu cũ, không đẻ
--    phiếu thứ hai) và ca 8 (F3: hồ sơ DRAFT bị chặn sinh phiếu).
DO $t$
DECLARE
  v_demo uuid := 'dddd0000-0000-4000-8000-000000000001';
  v_owner uuid; v_tm uuid; v_ob uuid; v_ob2 uuid; v_acc_that uuid; v_acc_ao uuid;
  v_ie1 uuid; v_ct2 uuid; v_tm2 uuid;
  v_ket text := ''; v_r jsonb; v_n int;
BEGIN
  -- Thẩm quyền ép: SUPER ADMIN (DEMO không có TENANT_OWNER — đo 28/08).
  SELECT user_id INTO v_owner FROM super_admins LIMIT 1;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'KẾT QUẢ: không có super admin nào để làm fixture'; END IF;
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);

  SELECT t.id INTO v_tm
    FROM contract_terminations t JOIN contracts c ON c.id=t.contract_id
   WHERE c.organization_id=v_demo AND c.room_id IS NOT NULL
     AND t.status IN ('APPROVED','COMPLETED') LIMIT 1;
  IF v_tm IS NULL THEN RAISE EXCEPTION 'KẾT QUẢ: DEMO không có hồ sơ thanh lý đã duyệt gắn phòng'; END IF;

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

  -- 4: chủ ép đúng cách ⇒ sinh được, và phiếu CHỜ DUYỆT với ĐÚNG marker
  v_r := public.create_termination_refund_voucher_v1(v_ob, v_acc_that, true,
           'Chủ xác nhận đã thu cọc bằng tiền mặt ngoài hệ, chấp nhận hoàn');
  v_ie1 := (v_r->>'voucherId')::uuid;
  v_ket := v_ket || E'\n4 ✓ chủ ép sinh được phiếu '||(v_r->>'code');
  SELECT count(*) INTO v_n FROM income_expenses
   WHERE id=v_ie1 AND approval_status='UNAPPROVED'
     AND posting_status IS DISTINCT FROM 'POSTED'
     AND system_source='termination.refund';
  v_ket := v_ket || CASE WHEN v_n=1
    THEN E'\n4b ✓ phiếu CHỜ DUYỆT, chưa ghi sổ, marker termination.refund (F1)'
    ELSE E'\n4b ✗ phiếu sai trạng thái hoặc sai marker' END;

  -- 5: gọi lại cùng phiên bản ⇒ trả ĐÚNG phiếu cũ
  v_r := public.create_termination_refund_voucher_v1(v_ob, v_acc_that, true, 'gọi lại');
  v_ket := v_ket || CASE WHEN (v_r->>'alreadyCreated')::bool
                          AND (v_r->>'voucherId')::uuid = v_ie1
    THEN E'\n5 ✓ gọi lại trả phiếu cũ, không đẻ phiếu thứ hai'
    ELSE E'\n5 ✗ trả phiếu khác hoặc đẻ thêm: '||v_r::text END;

  -- 6: lý do ép phải nằm trong ghi chú phiếu (dấu vết)
  SELECT count(*) INTO v_n FROM income_expenses
   WHERE id=v_ie1 AND notes LIKE 'ÉP SINH%';
  v_ket := v_ket || CASE WHEN v_n=1 THEN E'\n6 ✓ ghi chú phiếu lưu dấu vết ép sinh + lý do'
                         ELSE E'\n6 ✗ không lưu dấu vết' END;

  -- 7 (F2): record PHIÊN BẢN MỚI rồi sinh phiếu trên nó ⇒ vẫn trả phiếu cũ.
  -- Đây chính là lỗ bản cũ: writer chỉ nhìn voucher_id của phiên bản đang gọi.
  v_r := public.record_termination_refund_obligation_v1(v_tm);
  SELECT id INTO v_ob2 FROM termination_refund_obligations
   WHERE termination_id=v_tm ORDER BY version DESC LIMIT 1;
  IF v_ob2 = v_ob THEN
    v_ket := v_ket || E'\n7 ✗ record không tạo được phiên bản mới';
  ELSE
    v_r := public.create_termination_refund_voucher_v1(v_ob2, v_acc_that, true,
             'thử lách bằng phiên bản nghĩa vụ mới');
    v_ket := v_ket || CASE WHEN (v_r->>'alreadyCreated')::bool
                            AND (v_r->>'voucherId')::uuid = v_ie1
      THEN E'\n7 ✓ phiên bản mới KHÔNG lách được — vẫn trả phiếu cũ (F2)'
      ELSE E'\n7 ✗ phiên bản mới đẻ được phiếu thứ hai: '||v_r::text END;
  END IF;

  -- 8 (F3): hồ sơ DRAFT ⇒ chặn sinh phiếu.
  -- Dựng hồ sơ DRAFT mới trên một hợp đồng DEMO chưa có hồ sơ (mỗi HĐ chỉ một
  -- hồ sơ). total_deposit=0 để né ràng buộc refund_method và để chắc chắn lỗi
  -- nhận được là lỗi TRẠNG THÁI chứ không phải lỗi số tiền.
  SELECT c.id INTO v_ct2 FROM contracts c
   WHERE c.organization_id=v_demo AND c.room_id IS NOT NULL AND c.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM contract_terminations t WHERE t.contract_id=c.id)
   LIMIT 1;
  IF v_ct2 IS NULL THEN
    v_ket := v_ket || E'\n8 · bỏ qua: DEMO không còn hợp đồng nào chưa thanh lý';
  ELSE
    INSERT INTO contract_terminations
      (user_id, organization_id, contract_id, actual_move_out_date,
       termination_type, total_deposit, status)
    VALUES (v_owner, v_demo, v_ct2, CURRENT_DATE, 'NORMAL', 0, 'DRAFT')
    RETURNING id INTO v_tm2;
    v_r := public.record_termination_refund_obligation_v1(v_tm2);
    SELECT id INTO v_ob2 FROM termination_refund_obligations
     WHERE termination_id=v_tm2 ORDER BY version DESC LIMIT 1;
    BEGIN
      PERFORM public.create_termination_refund_voucher_v1(v_ob2, v_acc_that, true,
                'thử sinh phiếu trên hồ sơ chưa duyệt');
      v_ket := v_ket || E'\n8 ✗ hồ sơ DRAFT vẫn sinh được phiếu!';
    EXCEPTION WHEN OTHERS THEN
      v_ket := v_ket || CASE WHEN position('trạng thái' IN SQLERRM) > 0
        THEN E'\n8 ✓ hồ sơ DRAFT bị chặn sinh phiếu (F3)'
        ELSE E'\n8 ? '||left(SQLERRM,70) END;
    END;
  END IF;

  RAISE EXCEPTION 'KẾT QUẢ:%', v_ket;
END
$t$;

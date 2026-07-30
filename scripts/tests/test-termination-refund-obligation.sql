-- Đợt 7 — test nghĩa vụ hoàn cọc. Org DEMO, rollback sạch.
DO $t$
DECLARE
  v_demo uuid := 'dddd0000-0000-4000-8000-000000000001';
  v_owner uuid; v_ct uuid; v_tm uuid; v_ket text := ''; v_p jsonb; v_r jsonb; v_n int;
BEGIN
  SELECT c.id, c.user_id INTO v_ct, v_owner
    FROM contracts c JOIN contract_terminations t ON t.contract_id=c.id
   WHERE c.organization_id=v_demo LIMIT 1;
  IF v_ct IS NULL THEN RAISE EXCEPTION 'KẾT QUẢ: DEMO không có hồ sơ thanh lý'; END IF;
  SELECT id INTO v_tm FROM contract_terminations WHERE contract_id=v_ct LIMIT 1;
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);

  -- 1: preview chạy và dùng ĐÚNG cơ sở cọc dùng chung
  v_p := public.preview_termination_refund_v1(v_tm);
  v_ket := v_ket || CASE WHEN v_p ? 'basisFingerprint' AND v_p ? 'realHeld'
    THEN E'\n1 ✓ preview trả cơ sở cọc + fingerprint'
    ELSE E'\n1 ✗ thiếu trường' END;

  -- 2: ép ca VƯỢT CỌC — số hoàn lớn hơn cọc thật
  -- refund_amount là CỘT SINH: = total_deposit − tổng khấu trừ. Không set thẳng
  -- được (428C9), phải đẩy qua total_deposit. Chi tiết này quan trọng: số hoàn
  -- KHÔNG nhập tay tuỳ ý, nhưng ĐẦU VÀO thì có — và đầu vào mới là chỗ sai.
  UPDATE contract_terminations SET total_deposit = 999000000 WHERE id=v_tm;
  v_p := public.preview_termination_refund_v1(v_tm);
  v_ket := v_ket || CASE WHEN v_p->>'obligationStatus' IN ('VUOT_COC_THAT','CHUA_TUNG_VAO_KET')
    THEN E'\n2 ✓ hoàn 999tr ⇒ cảnh báo '||(v_p->>'obligationStatus')
    ELSE E'\n2 ✗ không cảnh báo (status='||(v_p->>'obligationStatus')||')' END;
  v_ket := v_ket || E'\n2b · lời cảnh báo: '||left(COALESCE(v_p->>'warning','(rỗng)'),110);

  -- 3: chốt nghĩa vụ → ghi một dòng
  v_r := public.record_termination_refund_obligation_v1(v_tm);
  v_ket := v_ket || CASE WHEN (v_r->>'version')::int = 1
    THEN E'\n3 ✓ chốt nghĩa vụ version 1' ELSE E'\n3 ✗ version='||(v_r->>'version') END;

  -- 4: BẤT BIẾN — chốt lần hai phải ra version 2, không sửa dòng cũ
  v_r := public.record_termination_refund_obligation_v1(v_tm);
  SELECT count(*) INTO v_n FROM termination_refund_obligations WHERE termination_id=v_tm;
  v_ket := v_ket || CASE WHEN (v_r->>'version')::int = 2 AND v_n = 2
    THEN E'\n4 ✓ chốt lại ra version 2, giữ nguyên dòng cũ (bất biến)'
    ELSE E'\n4 ✗ version='||(v_r->>'version')||' số dòng='||v_n END;

  -- 5: fingerprint phải đổi khi cơ sở cọc đổi
  DECLARE v_f1 text; v_f2 text;
  BEGIN
    SELECT basis_fingerprint INTO v_f1 FROM termination_refund_obligations
     WHERE termination_id=v_tm ORDER BY version DESC LIMIT 1;
    -- Thêm một phiếu cọc DEMO ⇒ cơ sở cọc đổi ⇒ fingerprint phải đổi theo.
    INSERT INTO income_expenses (user_id, organization_id, type, name, building_id,
                                 voucher_date, total_amount, approval_status,
                                 posting_status, contract_id, system_source)
    SELECT v_owner, v_demo, 'INCOME', 'ZZTEST tiền cọc',
           (SELECT r.building_id FROM rooms r WHERE r.id=c.room_id),
           public.org_today_v1(v_demo), 1000000, 'APPROVED', 'POSTED', v_ct, 'zz.test'
      FROM contracts c WHERE c.id=v_ct;
    v_p := public.preview_termination_refund_v1(v_tm);
    v_f2 := v_p->>'basisFingerprint';
    v_ket := v_ket || CASE WHEN v_f1 IS DISTINCT FROM v_f2
      THEN E'\n5 ✓ thêm nguồn cọc ⇒ fingerprint ĐỔI (biết cơ sở đã trôi)'
      ELSE E'\n5 – fingerprint không đổi (phiếu test không lọt bộ lọc cọc)' END;
  EXCEPTION WHEN OTHERS THEN
    v_ket := v_ket || E'\n5 – bỏ qua: '||left(SQLERRM,60);
  END;

  RAISE EXCEPTION 'KẾT QUẢ:%', v_ket;
END
$t$;

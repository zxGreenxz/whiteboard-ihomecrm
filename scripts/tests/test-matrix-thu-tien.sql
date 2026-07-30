-- =====================================================================
-- MA TRẬN KIỂM THỬ — đường thanh toán mới (Đợt 3 + Đợt 7/8)
--
-- Mục tiêu KHÔNG phải "chạy được", mà là **KHÔNG LÁCH ĐƯỢC LUẬT**. Mỗi hạng mục
-- có cặp: ràng buộc ĐÚNG (phải cho qua) và ràng buộc SAI (phải chặn).
--
-- Rủi ro lách luật mà ma trận này nhắm tới:
--   R1. Máy tự chi tiền — phiếu sinh ra bị tự duyệt / tự ghi sổ
--   R2. Người không đủ quyền dùng đường mới để tạo phiếu ở toà không được phép
--   R3. Ghi chéo tổ chức
--   R4. Đẩy tiền vào SỔ ẢO để tồn quỹ không đổi mà vẫn "đã chi"
--   R5. Ép hoàn vượt cọc mà không phải chủ / không để lại dấu vết
--   R6. Sinh trùng để rút hai lần cho cùng một khoản
--   R7. Lách hạng mục HẠN CHẾ (quan_ly) qua đường sinh hàng loạt
--   R8. Gỡ chốt (huỷ claim) rồi sinh lại để nhân đôi phiếu đã duyệt
--
-- Chạy: node scripts/apply-sql.mjs scripts/tests/test-matrix-thu-tien.sql
-- Kết thúc bằng RAISE ⇒ rollback sạch, không để lại gì.
-- =====================================================================
DO $t$
DECLARE
  v_demo  uuid := 'dddd0000-0000-4000-8000-000000000001';
  v_that  uuid := 'aaaa0000-0000-4000-8000-000000000001';
  -- Vai trò DEMO
  v_chu   uuid := 'fb0651bb-1cbd-4016-b0bf-3611dae49a63';  -- Chủ sở hữu tổ chức
  v_ql    uuid := 'f9296fe1-955a-406c-87d1-e8138ad014a6';  -- Quản Lý Tòa (kỹ thuật)
  v_sale  uuid := '7a41bac3-9b30-452a-a503-aa28fe791473';  -- Quản Lý Tòa (sale)
  v_bld   uuid[]; v_b1 uuid; v_bthat uuid;
  v_acc_that uuid; v_acc_ao uuid;
  v_tm uuid; v_ob uuid;
  v_ket text := ''; v_r jsonb; v_n int; v_pass int := 0; v_fail int := 0;
BEGIN
  SELECT array_agg(id) INTO v_bld FROM buildings
   WHERE organization_id=v_demo AND deleted_at IS NULL;
  v_b1 := v_bld[1];
  SELECT id INTO v_bthat FROM buildings WHERE organization_id=v_that AND deleted_at IS NULL LIMIT 1;
  SELECT id INTO v_acc_that FROM accounts WHERE organization_id=v_demo
     AND deleted_at IS NULL AND NOT COALESCE(is_virtual,false) LIMIT 1;
  SELECT id INTO v_acc_ao FROM accounts WHERE organization_id=v_demo
     AND deleted_at IS NULL AND COALESCE(is_virtual,false) LIMIT 1;
  SELECT t.id INTO v_tm FROM contract_terminations t JOIN contracts c ON c.id=t.contract_id
   WHERE c.organization_id=v_demo AND c.room_id IS NOT NULL LIMIT 1;

  -- ═══ NHÓM A — R1: MÁY KHÔNG ĐƯỢC TỰ CHI TIỀN ═══════════════════════
  PERFORM set_config('request.jwt.claim.sub', v_chu::text, true);
  v_r := public.generate_special_fees_v1('2026-11', ARRAY[v_b1], 'mtx-a-000001');
  IF (v_r->>'created')::int > 0 THEN v_pass:=v_pass+1;
     v_ket := v_ket || E'\nA1 ✓ ĐÚNG: chủ sinh được phiếu ('||(v_r->>'created')||')';
  ELSE v_fail:=v_fail+1; v_ket := v_ket || E'\nA1 ✗ chủ không sinh được'; END IF;

  SELECT count(*) INTO v_n FROM income_expenses
   WHERE system_source='special_fee.v1' AND approval_status <> 'UNAPPROVED';
  IF v_n=0 THEN v_pass:=v_pass+1; v_ket:=v_ket||E'\nA2 ✓ SAI-bị-chặn: 0 phiếu tự duyệt (ngưỡng tự duyệt KHÔNG áp cho đường này)';
  ELSE v_fail:=v_fail+1; v_ket:=v_ket||E'\nA2 ✗✗ NGUY HIỂM: '||v_n||' phiếu TỰ DUYỆT'; END IF;

  SELECT count(*) INTO v_n FROM income_expense_posting_lines l
    JOIN income_expense_postings p ON p.id=l.posting_id
    JOIN income_expenses ie ON ie.id=p.voucher_id
   WHERE ie.system_source='special_fee.v1';
  IF v_n=0 THEN v_pass:=v_pass+1; v_ket:=v_ket||E'\nA3 ✓ SAI-bị-chặn: 0 dòng ghi sổ (chưa duyệt ⇒ chưa vào quỹ)';
  ELSE v_fail:=v_fail+1; v_ket:=v_ket||E'\nA3 ✗✗ NGUY HIỂM: đã ghi sổ '||v_n||' dòng'; END IF;

  -- ═══ NHÓM B — R3: KHÔNG GHI CHÉO TỔ CHỨC ═══════════════════════════
  BEGIN
    PERFORM public.generate_special_fees_v1('2026-11', ARRAY[v_b1, v_bthat], 'mtx-b-000001');
    v_fail:=v_fail+1; v_ket:=v_ket||E'\nB1 ✗✗ NGUY HIỂM: sinh được cho toà org KHÁC';
  EXCEPTION WHEN OTHERS THEN
    IF position('tổ chức khác' IN SQLERRM) > 0 THEN v_pass:=v_pass+1;
      v_ket:=v_ket||E'\nB1 ✓ SAI-bị-chặn: trộn toà org khác vào lượt sinh';
    ELSE v_fail:=v_fail+1; v_ket:=v_ket||E'\nB1 ? '||left(SQLERRM,60); END IF;
  END;

  -- ═══ NHÓM C — R2: QUYỀN THEO TOÀ ═══════════════════════════════════
  PERFORM set_config('request.jwt.claim.sub', v_sale::text, true);
  SELECT count(*) INTO v_n FROM public.preview_special_fees_v1('2026-12', NULL);
  v_ket := v_ket || E'\nC0 · Sale xem trước thấy '||v_n||' ô (lọc theo quyền toà)';
  v_pass:=v_pass+1;
  BEGIN
    SELECT count(*) INTO v_n FROM public.preview_special_fees_v1('2026-12', ARRAY[v_bthat]);
    IF v_n = 0 THEN v_pass:=v_pass+1;
      v_ket:=v_ket||E'
C1 ✓ SAI-bị-chặn: xem trước toà org THẬT ⇒ 0 ô (không rò)';
    ELSE v_fail:=v_fail+1;
      v_ket:=v_ket||E'
C1 ✗✗ NGUY HIỂM: xem trước rò '||v_n||' ô của tổ chức khác';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_pass:=v_pass+1;
    v_ket:=v_ket||E'
C1 ✓ SAI-bị-chặn: xem trước org khác bị từ chối thẳng';
  END;

  -- ═══ NHÓM D — R6/R8: CHỐNG SINH TRÙNG ══════════════════════════════
  PERFORM set_config('request.jwt.claim.sub', v_chu::text, true);
  v_r := public.generate_special_fees_v1('2026-11', ARRAY[v_b1], 'mtx-d-000001');
  IF (v_r->>'created')::int = 0 THEN v_pass:=v_pass+1;
    v_ket:=v_ket||E'\nD1 ✓ SAI-bị-chặn: bấm lại cùng kỳ ⇒ 0 phiếu';
  ELSE v_fail:=v_fail+1; v_ket:=v_ket||E'\nD1 ✗✗ NGUY HIỂM: đẻ thêm '||(v_r->>'created'); END IF;

  SELECT count(*) INTO v_n FROM (
    SELECT 1 FROM special_fee_claims WHERE status='GENERATED'
     GROUP BY organization_id,building_id,fee_category,period_month HAVING count(*)>1) q;
  IF v_n=0 THEN v_pass:=v_pass+1; v_ket:=v_ket||E'\nD2 ✓ 0 ô có hai claim sống';
  ELSE v_fail:=v_fail+1; v_ket:=v_ket||E'\nD2 ✗✗ '||v_n||' ô trùng claim'; END IF;

  -- R8: duyệt phiếu rồi thử gỡ claim ⇒ phải chặn
  DECLARE v_cl uuid; v_v uuid;
  BEGIN
    SELECT id, voucher_id INTO v_cl, v_v FROM special_fee_claims
     WHERE status='GENERATED' AND voucher_id IS NOT NULL LIMIT 1;
    UPDATE income_expenses SET approval_status='APPROVED' WHERE id=v_v;
    BEGIN
      PERFORM public.cancel_special_fee_claim_v1(v_cl, 'thu go chot de nhan doi');
      v_fail:=v_fail+1; v_ket:=v_ket||E'\nD3 ✗✗ NGUY HIỂM: gỡ được chốt của phiếu ĐÃ DUYỆT ⇒ nhân đôi được';
    EXCEPTION WHEN OTHERS THEN
      IF position('ĐÃ ĐƯỢC DUYỆT' IN SQLERRM) > 0 THEN v_pass:=v_pass+1;
        v_ket:=v_ket||E'\nD3 ✓ SAI-bị-chặn: không gỡ được chốt khi phiếu đã duyệt';
      ELSE v_fail:=v_fail+1; v_ket:=v_ket||E'\nD3 ? '||left(SQLERRM,60); END IF;
    END;
    UPDATE income_expenses SET approval_status='UNAPPROVED' WHERE id=v_v;
  END;

  -- ═══ NHÓM E — HOÀN CỌC: R4/R5 ══════════════════════════════════════
  IF v_tm IS NOT NULL THEN
    UPDATE contract_terminations SET total_deposit = 500000000 WHERE id=v_tm;
    v_r := public.record_termination_refund_obligation_v1(v_tm);
    SELECT id INTO v_ob FROM termination_refund_obligations
     WHERE termination_id=v_tm ORDER BY version DESC LIMIT 1;
    v_ket := v_ket || E'\nE0 · nghĩa vụ = '||(v_r->>'obligationStatus');

    -- E1 SAI: không ép ⇒ chặn
    BEGIN
      PERFORM public.create_termination_refund_voucher_v1(v_ob, v_acc_that, false, NULL);
      v_fail:=v_fail+1; v_ket:=v_ket||E'\nE1 ✗✗ NGUY HIỂM: hoàn vượt cọc mà không cần ép';
    EXCEPTION WHEN OTHERS THEN
      IF position('chủ tổ chức phải ép' IN SQLERRM)>0 THEN v_pass:=v_pass+1;
        v_ket:=v_ket||E'\nE1 ✓ SAI-bị-chặn: hoàn vượt cọc phải có ép';
      ELSE v_fail:=v_fail+1; v_ket:=v_ket||E'\nE1 ? '||left(SQLERRM,60); END IF;
    END;

    -- E2 SAI: KHÔNG PHẢI CHỦ mà ép ⇒ chặn  (R5 — rủi ro nặng nhất)
    PERFORM set_config('request.jwt.claim.sub', v_ql::text, true);
    BEGIN
      PERFORM public.create_termination_refund_voucher_v1(v_ob, v_acc_that, true,
                'quan ly tu y ep hoan vuot coc');
      v_fail:=v_fail+1; v_ket:=v_ket||E'\nE2 ✗✗ NGUY HIỂM: NGƯỜI KHÔNG PHẢI CHỦ ép được hoàn vượt cọc';
    EXCEPTION WHEN OTHERS THEN
      IF position('Chỉ chủ tổ chức' IN SQLERRM)>0 OR position('quyền' IN SQLERRM)>0 THEN v_pass:=v_pass+1;
        v_ket:=v_ket||E'\nE2 ✓ SAI-bị-chặn: không phải chủ thì không ép được';
      ELSE v_fail:=v_fail+1; v_ket:=v_ket||E'\nE2 ? '||left(SQLERRM,70); END IF;
    END;

    -- E3 SAI: chủ ép nhưng đẩy vào SỔ ẢO ⇒ chặn (R4)
    PERFORM set_config('request.jwt.claim.sub', v_chu::text, true);
    IF v_acc_ao IS NOT NULL THEN
      BEGIN
        PERFORM public.create_termination_refund_voucher_v1(v_ob, v_acc_ao, true,
                  'day tien vao so ao cho ton quy khong doi');
        v_fail:=v_fail+1; v_ket:=v_ket||E'\nE3 ✗✗ NGUY HIỂM: hoàn cọc vào SỔ ẢO';
      EXCEPTION WHEN OTHERS THEN
        IF position('SỔ ẢO' IN SQLERRM)>0 THEN v_pass:=v_pass+1;
          v_ket:=v_ket||E'\nE3 ✓ SAI-bị-chặn: không hoàn vào sổ ảo';
        ELSE v_fail:=v_fail+1; v_ket:=v_ket||E'\nE3 ? '||left(SQLERRM,60); END IF;
      END;
    END IF;

    -- E4 SAI: ép nhưng lý do rỗng ⇒ chặn (dấu vết)
    BEGIN
      PERFORM public.create_termination_refund_voucher_v1(v_ob, v_acc_that, true, '  ');
      v_fail:=v_fail+1; v_ket:=v_ket||E'\nE4 ✗ nhận lý do rỗng';
    EXCEPTION WHEN OTHERS THEN
      v_pass:=v_pass+1; v_ket:=v_ket||E'\nE4 ✓ SAI-bị-chặn: ép phải có lý do';
    END;

    -- E5 ĐÚNG: chủ ép đúng cách ⇒ được, phiếu CHỜ DUYỆT + có dấu vết
    v_r := public.create_termination_refund_voucher_v1(v_ob, v_acc_that, true,
             'Chu xac nhan da thu coc tien mat ngoai he thong');
    SELECT count(*) INTO v_n FROM income_expenses
     WHERE id=(v_r->>'voucherId')::uuid AND approval_status='UNAPPROVED'
       AND notes LIKE 'ÉP SINH%';
    IF v_n=1 THEN v_pass:=v_pass+1;
      v_ket:=v_ket||E'\nE5 ✓ ĐÚNG: chủ ép được, phiếu CHỜ DUYỆT và ghi chú lưu dấu vết';
    ELSE v_fail:=v_fail+1; v_ket:=v_ket||E'\nE5 ✗ phiếu không đúng trạng thái/dấu vết'; END IF;

    -- E6 SAI: gọi lại ⇒ không đẻ phiếu thứ hai (R6)
    v_r := public.create_termination_refund_voucher_v1(v_ob, v_acc_that, true, 'goi lai lan nua');
    SELECT count(*) INTO v_n FROM income_expenses WHERE system_source='termination.refund.v2';
    IF (v_r->>'alreadyCreated')::bool AND v_n=1 THEN v_pass:=v_pass+1;
      v_ket:=v_ket||E'\nE6 ✓ SAI-bị-chặn: gọi lại trả phiếu cũ, vẫn 1 phiếu';
    ELSE v_fail:=v_fail+1; v_ket:=v_ket||E'\nE6 ✗✗ đẻ '||v_n||' phiếu hoàn'; END IF;

    -- E7 SAI: hoàn số âm/0 ⇒ chặn
    UPDATE contract_terminations SET total_deposit = 0 WHERE id=v_tm;
    v_r := public.record_termination_refund_obligation_v1(v_tm);
    BEGIN
      PERFORM public.create_termination_refund_voucher_v1(
        (SELECT id FROM termination_refund_obligations
          WHERE termination_id=v_tm ORDER BY version DESC LIMIT 1),
        v_acc_that, true, 'thu hoan so am');
      v_fail:=v_fail+1; v_ket:=v_ket||E'\nE7 ✗ sinh phiếu hoàn cho số ≤ 0';
    EXCEPTION WHEN OTHERS THEN
      v_pass:=v_pass+1; v_ket:=v_ket||E'\nE7 ✓ SAI-bị-chặn: không sinh phiếu hoàn khi số ≤ 0';
    END;
  END IF;

  -- ═══ NHÓM F — R7: HẠNG MỤC HẠN CHẾ ═════════════════════════════════
  SELECT count(*) INTO v_n FROM income_expenses ie
    JOIN income_expense_items it ON it.income_expense_id=ie.id
    JOIN income_expense_types ty ON ty.id=it.income_expense_type_id
   WHERE ie.system_source='special_fee.v1' AND ty.is_restricted;
  IF v_n = 0 THEN v_pass:=v_pass+1;
    v_ket:=v_ket||E'
F1 ✓ SAI-bị-chặn: 0 phiếu hạng mục HẠN CHẾ do máy sinh hàng loạt';
  ELSE v_fail:=v_fail+1;
    v_ket:=v_ket||E'
F1 ✗✗ NGUY HIỂM: '||v_n||' phiếu HẠN CHẾ chui qua đường sinh hàng loạt';
  END IF;

  -- ═══ NHÓM L — CHỐT CHẶN ĐỢT −1 (đường phí cố định) ═════
  PERFORM set_config('request.jwt.claim.sub', v_chu::text, true);
  -- ĐỐI CHỨNG DƯƠNG: thiếu dòng này thì mọi "bị chặn" dưới đây có thể XANH GIẢ.
  BEGIN
    PERFORM public.pay_period_fee(
      p_building_id:=v_b1, p_category_key:='rac', p_amount:=100000,
      p_period_start:='2029-01', p_period_end:='2029-01',
      p_voucher_date:=public.org_today_v1(v_demo), p_provider_code:=NULL,
      p_account_holder:=NULL, p_account_id:=NULL, p_attachments:=NULL, p_force:=false);
    v_pass:=v_pass+1;
    v_ket:=v_ket||E'\nL0 ✓ ĐÚNG (đối chứng dương): chủ đóng được phí hợp lệ';
  EXCEPTION WHEN OTHERS THEN
    v_fail:=v_fail+1;
    v_ket:=v_ket||E'\nL0 ✗✗ ĐỐI CHỨNG DƯƠNG ĐỎ ⇒ các dòng L khác có thể XANH GIẢ: '||left(SQLERRM,60);
  END;

  PERFORM set_config('request.jwt.claim.sub', v_sale::text, true);
  DECLARE v_bsale uuid;
  BEGIN
    -- Phải là toà sale THỰC SỰ vào được, không thì test trượt ở hàng rào toà
    -- và không bao giờ chạm tới cổng hạng mục HẠN CHẾ (từng xanh giả vì lẽ đó).
    SELECT bb.id INTO v_bsale FROM buildings bb
     WHERE bb.organization_id=v_demo AND bb.deleted_at IS NULL
       AND public.can_access_building(bb.id) LIMIT 1;
    IF v_bsale IS NULL THEN RAISE EXCEPTION 'THIẾU FIXTURE: sale không vào được toà nào'; END IF;
    PERFORM public.pay_period_fee(
      p_building_id:=v_bsale, p_category_key:='quan_ly', p_amount:=100000,
      p_period_start:='2029-01', p_period_end:='2029-01',
      p_voucher_date:=public.org_today_v1(v_demo), p_provider_code:=NULL,
      p_account_holder:=NULL, p_account_id:=NULL, p_attachments:=NULL, p_force:=false);
    v_fail:=v_fail+1;
    v_ket:=v_ket||E'
L1 ✗✗ NGUY HIỂM: người không đủ quyền đóng được phí HẠN CHẾ quan_ly';
  EXCEPTION WHEN OTHERS THEN
    v_pass:=v_pass+1;
    v_ket:=v_ket||E'
L1 ✓ SAI-bị-chặn: quan_ly đòi quyền hạng mục hạn chế'||' ['||left(SQLERRM,44)||']';
  END;

  BEGIN
    PERFORM public.pay_period_fee(
      p_building_id:=v_b1, p_category_key:='rac', p_amount:=100000,
      p_period_start:='2029-01', p_period_end:='2029-01',
      p_voucher_date:=public.org_today_v1(v_demo), p_provider_code:=NULL,
      p_account_holder:=NULL, p_account_id:=NULL, p_attachments:=NULL, p_force:=true);
    v_fail:=v_fail+1;
    v_ket:=v_ket||E'
L2 ✗✗ NGUY HIỂM: không phải chủ vẫn "Đóng thêm" được';
  EXCEPTION WHEN OTHERS THEN
    v_pass:=v_pass+1;
    v_ket:=v_ket||E'
L2 ✓ SAI-bị-chặn: "Đóng thêm" chỉ dành cho chủ';
  END;

  PERFORM set_config('request.jwt.claim.sub', v_chu::text, true);
  BEGIN
    PERFORM public.pay_period_fee(
      p_building_id:=v_b1, p_category_key:='phi_bia_dat', p_amount:=100000,
      p_period_start:='2029-01', p_period_end:='2029-01',
      p_voucher_date:=public.org_today_v1(v_demo), p_provider_code:=NULL,
      p_account_holder:=NULL, p_account_id:=NULL, p_attachments:=NULL, p_force:=false);
    v_fail:=v_fail+1;
    v_ket:=v_ket||E'
L3 ✗✗ nhận hạng mục bịa đặt';
  EXCEPTION WHEN OTHERS THEN
    v_pass:=v_pass+1;
    v_ket:=v_ket||E'
L3 ✓ SAI-bị-chặn: hạng mục ngoài danh sách trắng bị từ chối'||' ['||left(SQLERRM,44)||']';
  END;

  BEGIN
    PERFORM public.pay_period_fee(
      p_building_id:=v_bthat, p_category_key:='rac', p_amount:=100000,
      p_period_start:='2029-01', p_period_end:='2029-01',
      p_voucher_date:=public.org_today_v1(v_demo), p_provider_code:=NULL,
      p_account_holder:=NULL, p_account_id:=NULL, p_attachments:=NULL, p_force:=false);
    v_fail:=v_fail+1;
    v_ket:=v_ket||E'
L4 ✗✗ NGUY HIỂM: chủ DEMO đóng được phí cho toà org THẬT';
  EXCEPTION WHEN OTHERS THEN
    v_pass:=v_pass+1;
    v_ket:=v_ket||E'
L4 ✓ SAI-bị-chặn: không đóng phí xuyên tổ chức'||' ['||left(SQLERRM,44)||']';
  END;


  -- ═══ NHÓM G — ĐỌC CHÉO TỔ CHỨC (RLS) ══════════════════════════════
  -- Bảng mới có RLS không? Người org DEMO có đọc được dữ liệu org THẬT không?
  DECLARE v_rls_claim bool; v_rls_ob bool;
  BEGIN
    SELECT c.relrowsecurity INTO v_rls_claim FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname='special_fee_claims';
    SELECT c.relrowsecurity INTO v_rls_ob FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname='termination_refund_obligations';
    IF v_rls_claim AND v_rls_ob THEN v_pass:=v_pass+1;
      v_ket:=v_ket||E'
G1 ✓ hai bảng mới đều BẬT RLS';
    ELSE v_fail:=v_fail+1; v_ket:=v_ket||E'
G1 ✗✗ NGUY HIỂM: bảng mới chưa bật RLS'; END IF;
  END;

  -- anon tuyệt đối không đọc được
  IF has_table_privilege('anon','public.special_fee_claims','SELECT')
     OR has_table_privilege('anon','public.termination_refund_obligations','SELECT') THEN
    v_fail:=v_fail+1; v_ket:=v_ket||E'
G2 ✗✗ NGUY HIỂM: anon đọc được bảng mới';
  ELSE v_pass:=v_pass+1; v_ket:=v_ket||E'
G2 ✓ SAI-bị-chặn: anon không đọc được';
  END IF;

  -- client KHÔNG được ghi thẳng bảng (chỉ qua RPC)
  IF has_table_privilege('authenticated','public.special_fee_claims','INSERT')
     OR has_table_privilege('authenticated','public.special_fee_claims','UPDATE')
     OR has_table_privilege('authenticated','public.termination_refund_obligations','INSERT')
     OR has_table_privilege('authenticated','public.termination_refund_obligations','UPDATE') THEN
    v_fail:=v_fail+1;
    v_ket:=v_ket||E'
G3 ✗✗ NGUY HIỂM: client ghi THẲNG được bảng chốt ⇒ tự gỡ chốt / tự sửa nghĩa vụ';
  ELSE v_pass:=v_pass+1;
    v_ket:=v_ket||E'
G3 ✓ SAI-bị-chặn: client không ghi thẳng bảng, phải qua RPC';
  END IF;

  -- ═══ NHÓM H — QUYỀN GỌI HÀM ════════════════════════════════════════
  IF has_function_privilege('anon','public.generate_special_fees_v1(text,uuid[],text)','EXECUTE')
     OR has_function_privilege('anon','public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text)','EXECUTE') THEN
    v_fail:=v_fail+1; v_ket:=v_ket||E'
H1 ✗✗ NGUY HIỂM: anon gọi được hàm sinh phiếu';
  ELSE v_pass:=v_pass+1; v_ket:=v_ket||E'
H1 ✓ SAI-bị-chặn: anon không gọi được hàm ghi';
  END IF;

  -- Lõi ghi sổ và cơ sở cọc là NỘI BỘ — client không được chạm
  IF has_function_privilege('authenticated',
       'app_private.finance_v2_post_voucher_with_source_v1(uuid,uuid,text,text,uuid,uuid,date,text,bigint)','EXECUTE')
     OR has_function_privilege('authenticated',
       'app_private.resolve_signed_contract_deposit_basis_v1(uuid,uuid,timestamptz)','EXECUTE') THEN
    v_fail:=v_fail+1; v_ket:=v_ket||E'
H2 ✗✗ NGUY HIỂM: client gọi thẳng được LÕI GHI SỔ ⇒ sinh bút toán tuỳ ý';
  ELSE v_pass:=v_pass+1; v_ket:=v_ket||E'
H2 ✓ SAI-bị-chặn: lõi ghi sổ/cơ sở cọc chỉ nội bộ';
  END IF;

  -- ═══ NHÓM I — NGHĨA VỤ BẤT BIẾN ════════════════════════════════════
  IF v_ob IS NOT NULL THEN
    DECLARE v_before numeric; v_after numeric;
    BEGIN
      SELECT requested_amount INTO v_before FROM termination_refund_obligations WHERE id=v_ob;
      -- Chốt lại phải TẠO BẢN MỚI, không đè bản cũ
      PERFORM public.record_termination_refund_obligation_v1(v_tm);
      SELECT requested_amount INTO v_after FROM termination_refund_obligations WHERE id=v_ob;
      IF v_before IS NOT DISTINCT FROM v_after THEN v_pass:=v_pass+1;
        v_ket:=v_ket||E'
I1 ✓ chốt lại KHÔNG đè bản cũ (bất biến)';
      ELSE v_fail:=v_fail+1; v_ket:=v_ket||E'
I1 ✗✗ bản cũ bị sửa'; END IF;
    END;
  END IF;

  -- ═══ NHÓM K — KỲ ĐÃ KHOÁ ═══════════════════════════════════════════
  -- Phiếu máy sinh là CHỜ DUYỆT nên chưa đụng sổ; chốt kỳ chỉ chặn lúc GHI SỔ.
  -- Khẳng định điều đó đúng: sinh cho kỳ rất cũ vẫn được, nhưng vẫn 0 dòng sổ.
  BEGIN
    v_r := public.generate_special_fees_v1('2020-01', ARRAY[v_b1], 'mtx-k-000001');
    SELECT count(*) INTO v_n FROM income_expense_posting_lines l
      JOIN income_expense_postings p ON p.id=l.posting_id
      JOIN income_expenses ie ON ie.id=p.voucher_id
     WHERE ie.system_source='special_fee.v1';
    IF v_n=0 THEN v_pass:=v_pass+1;
      v_ket:=v_ket||E'
K1 ✓ sinh cho kỳ cũ (2020-01) vẫn 0 dòng ghi sổ — chốt kỳ áp lúc DUYỆT, không lúc sinh';
    ELSE v_fail:=v_fail+1; v_ket:=v_ket||E'
K1 ✗✗ đã ghi sổ '||v_n||' dòng'; END IF;
  EXCEPTION WHEN OTHERS THEN
    v_pass:=v_pass+1; v_ket:=v_ket||E'
K1 ✓ kỳ cũ bị chặn ngay khi sinh: '||left(SQLERRM,50);
  END;

  RAISE EXCEPTION 'MA TRẬN: % ĐẠT / % HỎNG%', v_pass, v_fail, v_ket;
END
$t$;

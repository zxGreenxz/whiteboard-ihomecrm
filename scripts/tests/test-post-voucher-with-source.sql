-- Đợt 1 — test lõi ghi sổ dùng chung. Chỉ org DEMO, kết thúc bằng RAISE nên
-- rollback sạch. Chạy: node scripts/apply-sql.mjs scripts/tests/test-post-voucher-with-source.sql
DO $t$
DECLARE
  v_demo uuid := 'dddd0000-0000-4000-8000-000000000001';
  v_ie uuid; v_p1 uuid; v_p2 uuid; v_ket text := ''; v_n int;
BEGIN
  -- Phiếu DEMO đã duyệt, CHƯA có posting nào (để lõi post được lần đầu).
  SELECT ie.id INTO v_ie FROM income_expenses ie
   WHERE ie.organization_id = v_demo AND ie.deleted_at IS NULL
     AND ie.approval_status = 'APPROVED' AND ie.total_amount > 0
     AND NOT EXISTS (SELECT 1 FROM income_expense_postings p
                      WHERE p.posting_subject_id = ie.id AND p.event_kind='POSTING')
   LIMIT 1;
  IF v_ie IS NULL THEN
    RAISE EXCEPTION 'KẾT QUẢ: bỏ qua — không tìm được phiếu DEMO đã duyệt mà chưa ghi sổ';
  END IF;

  -- CA 1: ghi sổ lần đầu
  v_p1 := app_private.finance_v2_post_voucher_with_source_v1(
            v_demo, v_ie, 'ZZTEST_ADAPTER', 'ZZTEST_SRC', gen_random_uuid());
  v_ket := v_ket || CASE WHEN v_p1 IS NOT NULL
    THEN E'\n1 ✓ ghi sổ được lần đầu' ELSE E'\n1 ✗ không trả posting' END;

  -- CA 2: dòng MAIN phải có, và net_cash_effect khớp dấu
  SELECT count(*) INTO v_n FROM income_expense_posting_lines
   WHERE posting_id = v_p1 AND line_kind='MAIN';
  v_ket := v_ket || CASE WHEN v_n=1 THEN E'\n2 ✓ có đúng 1 dòng MAIN' ELSE E'\n2 ✗ dòng MAIN = '||v_n END;
  SELECT count(*) INTO v_n FROM income_expense_postings p JOIN income_expenses ie ON ie.id=p.voucher_id
   WHERE p.id=v_p1
     AND p.net_cash_effect = CASE WHEN ie.type='INCOME' THEN ie.total_amount ELSE -ie.total_amount END
                             + COALESCE(CASE WHEN ie.change_account_id IS NOT NULL THEN ie.change_amount END,0)
                             + COALESCE(CASE WHEN ie.rounding_account_id IS NOT NULL THEN ie.rounding_amount END,0);
  v_ket := v_ket || CASE WHEN v_n=1 THEN E'\n2 ✓ net_cash_effect cộng đủ MAIN+CHANGE+ROUNDING'
                         ELSE E'\n2 ✗ net_cash_effect sai' END;

  -- CA 3: REPLAY cùng nguồn ⇒ trả lại đúng posting cũ, KHÔNG tạo cái thứ hai
  v_p2 := app_private.finance_v2_post_voucher_with_source_v1(
            v_demo, v_ie, 'ZZTEST_ADAPTER', 'ZZTEST_SRC',
            (SELECT external_source_id FROM income_expense_postings WHERE id=v_p1));
  v_ket := v_ket || CASE WHEN v_p2 = v_p1 THEN E'\n3 ✓ replay cùng nguồn trả lại posting cũ'
                         ELSE E'\n3 ✗ replay tạo posting mới!' END;

  -- CA 4: NGUỒN KHÁC trên cùng phiếu/thế hệ ⇒ lỗi rõ nghĩa, KHÔNG phải 23505 thô
  BEGIN
    PERFORM app_private.finance_v2_post_voucher_with_source_v1(
              v_demo, v_ie, 'ZZTEST_ADAPTER2', 'ZZTEST_SRC2', gen_random_uuid());
    v_ket := v_ket || E'\n4 ✗ cho ghi chồng nguồn khác!';
  EXCEPTION WHEN OTHERS THEN
    v_ket := v_ket || CASE WHEN position('đã được ghi sổ ở thế hệ' IN SQLERRM) > 0
      THEN E'\n4 ✓ chặn nguồn khác ghi chồng, thông điệp rõ nghĩa (không phải 23505 thô)'
      ELSE E'\n4 ? lỗi khác: ' || left(SQLERRM,80) END;
  END;

  -- CA 5: amount_basis rác ⇒ chặn tại cửa, không để constraint ném
  BEGIN
    PERFORM app_private.finance_v2_post_voucher_with_source_v1(
              v_demo, v_ie, 'ZZ', 'ZZ', gen_random_uuid(), NULL, NULL, 'RAC_RUOI');
    v_ket := v_ket || E'\n5 ✗ nhận amount_basis rác';
  EXCEPTION WHEN OTHERS THEN
    v_ket := v_ket || CASE WHEN position('amount_basis' IN SQLERRM) > 0
      THEN E'\n5 ✓ chặn amount_basis không hợp lệ' ELSE E'\n5 ? '||left(SQLERRM,60) END;
  END;

  -- CA 6: phiếu CHƯA DUYỆT ⇒ chặn
  DECLARE v_un uuid;
  BEGIN
    SELECT id INTO v_un FROM income_expenses
     WHERE organization_id=v_demo AND deleted_at IS NULL
       AND approval_status <> 'APPROVED' AND total_amount > 0 LIMIT 1;
    IF v_un IS NULL THEN
      v_ket := v_ket || E'\n6 – bỏ qua (DEMO không có phiếu chưa duyệt)';
    ELSE
      BEGIN
        PERFORM app_private.finance_v2_post_voucher_with_source_v1(
                  v_demo, v_un, 'ZZ', 'ZZ3', gen_random_uuid());
        v_ket := v_ket || E'\n6 ✗ ghi sổ được cho phiếu CHƯA DUYỆT!';
      EXCEPTION WHEN OTHERS THEN
        v_ket := v_ket || CASE WHEN position('chỉ ghi sổ phiếu ĐÃ DUYỆT' IN SQLERRM) > 0
          THEN E'\n6 ✓ chặn phiếu chưa duyệt' ELSE E'\n6 ? '||left(SQLERRM,60) END;
      END;
    END IF;
  END;

  -- CA 7: sai org ⇒ chặn ghi chéo tổ chức
  BEGIN
    PERFORM app_private.finance_v2_post_voucher_with_source_v1(
              'aaaa0000-0000-4000-8000-000000000001', v_ie, 'ZZ', 'ZZ4', gen_random_uuid());
    v_ket := v_ket || E'\n7 ✗ ghi chéo tổ chức được!';
  EXCEPTION WHEN OTHERS THEN
    v_ket := v_ket || CASE WHEN position('không thuộc org' IN SQLERRM) > 0
      THEN E'\n7 ✓ chặn ghi chéo tổ chức' ELSE E'\n7 ? '||left(SQLERRM,60) END;
  END;

  RAISE EXCEPTION 'KẾT QUẢ:%', v_ket;
END
$t$;

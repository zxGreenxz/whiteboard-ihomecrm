-- §15.2 Đợt 9 — KỊCH BẢN DỒN thay cho "24 giờ không lệch tiền".
-- Thời gian không chứng minh gì; SỐ PHÉP TOÁN mới chứng minh. Chạy một loạt thao
-- tác trên DEMO rồi đối chiếu: tổng tiền phải khớp chính xác phần cố ý tạo ra.
DO $t$
DECLARE
  v_demo uuid := 'dddd0000-0000-4000-8000-000000000001';
  v_owner uuid; v_bld uuid[]; v_ket text := '';
  v_ie0 int; v_it0 int; v_pl0 int; v_sum0 numeric;
  v_ie1 int; v_it1 int; v_pl1 int; v_sum1 numeric;
  v_made int := 0; v_made_sum numeric := 0; v_r jsonb; i int;
BEGIN
  SELECT user_id INTO v_owner FROM buildings
   WHERE organization_id=v_demo AND deleted_at IS NULL AND name='Tòa DEMO A';
  SELECT array_agg(id) INTO v_bld FROM buildings
   WHERE organization_id=v_demo AND deleted_at IS NULL;
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);

  SELECT count(*), COALESCE(sum(total_amount),0) INTO v_ie0, v_sum0
    FROM income_expenses WHERE deleted_at IS NULL;
  SELECT count(*) INTO v_it0 FROM income_expense_items;
  SELECT count(*) INTO v_pl0 FROM income_expense_posting_lines;

  -- DỒN: sinh phí cố định cho 6 kỳ liên tiếp, mỗi kỳ bấm HAI LẦN.
  FOR i IN 1..6 LOOP
    v_r := public.generate_special_fees_v1(
             to_char(make_date(2026, i, 1),'YYYY-MM'), v_bld,
             'burst-'||to_char(make_date(2026,i,1),'YYYYMM')||'-a');
    v_made := v_made + (v_r->>'created')::int;
    v_made_sum := v_made_sum + (v_r->>'totalAmount')::numeric;
    -- bấm lại ngay: phải ra 0
    v_r := public.generate_special_fees_v1(
             to_char(make_date(2026, i, 1),'YYYY-MM'), v_bld,
             'burst-'||to_char(make_date(2026,i,1),'YYYYMM')||'-b');
    IF (v_r->>'created')::int <> 0 THEN
      v_ket := v_ket || E'\n✗ kỳ '||i||' bấm lần hai đẻ thêm '||(v_r->>'created');
    END IF;
  END LOOP;
  v_ket := v_ket || E'\n· 12 lượt bấm (6 kỳ × 2) ⇒ sinh '||v_made||' phiếu, tổng '
                  ||round(v_made_sum)::bigint||'đ';

  SELECT count(*), COALESCE(sum(total_amount),0) INTO v_ie1, v_sum1
    FROM income_expenses WHERE deleted_at IS NULL;
  SELECT count(*) INTO v_it1 FROM income_expense_items;
  SELECT count(*) INTO v_pl1 FROM income_expense_posting_lines;

  -- ĐỐI CHIẾU: số phiếu tăng = số sinh ra, tiền tăng = đúng tổng, KHÔNG dòng sổ nào
  v_ket := v_ket || CASE WHEN v_ie1 - v_ie0 = v_made
    THEN E'\n✓ số phiếu tăng đúng bằng số sinh ('||v_made||')'
    ELSE E'\n✗ phiếu tăng '||(v_ie1-v_ie0)||' ≠ sinh '||v_made END;
  v_ket := v_ket || CASE WHEN v_sum1 - v_sum0 = v_made_sum
    THEN E'\n✓ tổng tiền tăng đúng bằng tổng sinh (không dư một đồng)'
    ELSE E'\n✗ tiền tăng '||round(v_sum1-v_sum0)::bigint||' ≠ '||round(v_made_sum)::bigint END;
  v_ket := v_ket || CASE WHEN v_it1 - v_it0 = v_made
    THEN E'\n✓ mỗi phiếu đúng 1 dòng hạng mục'
    ELSE E'\n✗ dòng hạng mục tăng '||(v_it1-v_it0) END;
  v_ket := v_ket || CASE WHEN v_pl1 = v_pl0
    THEN E'\n✓ KHÔNG một dòng ghi sổ nào sinh ra (phiếu chưa duyệt ⇒ chưa vào quỹ)'
    ELSE E'\n✗ sinh '||(v_pl1-v_pl0)||' dòng ghi sổ!' END;
  -- Không phiếu nào tự duyệt
  SELECT count(*) INTO v_ie1 FROM income_expenses
   WHERE system_source='special_fee.v1' AND approval_status <> 'UNAPPROVED';
  v_ket := v_ket || CASE WHEN v_ie1 = 0 THEN E'\n✓ 0 phiếu tự duyệt'
                         ELSE E'\n✗ '||v_ie1||' phiếu tự duyệt!' END;
  -- Không ô nào có 2 claim sống
  SELECT count(*) INTO v_ie1 FROM (
    SELECT 1 FROM special_fee_claims WHERE status='GENERATED'
     GROUP BY organization_id, building_id, fee_category, period_month
    HAVING count(*) > 1) q;
  v_ket := v_ket || CASE WHEN v_ie1 = 0 THEN E'\n✓ 0 ô có hai claim sống'
                         ELSE E'\n✗ '||v_ie1||' ô trùng claim!' END;

  RAISE EXCEPTION 'KẾT QUẢ KỊCH BẢN DỒN:%', v_ket;
END
$t$;

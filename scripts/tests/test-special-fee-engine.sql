-- Đợt 3 — test cỗ máy sinh phiếu. Org DEMO, rollback sạch.
DO $t$
DECLARE
  v_demo uuid := 'dddd0000-0000-4000-8000-000000000001';
  v_owner uuid; v_b1 uuid; v_ket text := ''; v_n int; v_r jsonb;
BEGIN
  SELECT id, user_id INTO v_b1, v_owner FROM buildings
   WHERE organization_id=v_demo AND deleted_at IS NULL AND name='Tòa DEMO A';
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);

  -- 1: preview chạy được dù route OFF
  SELECT count(*) INTO v_n FROM public.preview_special_fees_v1('2026-09', ARRAY[v_b1]);
  v_ket := v_ket || CASE WHEN v_n = 9 THEN E'\n1 ✓ preview trả đủ 9 hạng mục'
                         ELSE E'\n1 ✗ preview trả '||v_n END;

  SELECT count(*) INTO v_n FROM public.preview_special_fees_v1('2026-09', ARRAY[v_b1])
   WHERE status='SẼ_SINH';
  v_ket := v_ket || E'\n1b · '||v_n||' ô SẼ_SINH (đã seed giá ở Đợt −1)';

  -- 2: cờ tiền phải khai ĐỦ BỐN trường mới bật được (commit_sha, migration_sha256,
  --    maintenance_window_id, approval_reference) — thiếu một là FROZEN. Kiểm chốt đó.
  DECLARE v_route text;
  BEGIN
    UPDATE app_private.server_feature_flags SET approval_reference = NULL
     WHERE feature_key='special_fee.generate.v1';
    v_route := app_private.evaluate_feature_route('special_fee.generate.v1', v_demo);
    v_ket := v_ket || CASE WHEN v_route = 'FROZEN'
      THEN E'
2 ✓ thiếu approval_reference ⇒ FROZEN (fail-closed)'
      ELSE E'
2 ✗ vẫn '||v_route END;
    UPDATE app_private.server_feature_flags
       SET approval_reference='Chủ yêu cầu trực tiếp 30/07/2026'
     WHERE feature_key='special_fee.generate.v1';
  END;

  -- 3: sinh thật
  -- Cờ nằm ở app_private.server_feature_flags (không phải feature_rollouts).
  -- Cờ TIỀN bắt buộc có commit_sha + migration_sha256 mới bật được, nếu không
  -- evaluate_feature_route trả FROZEN. Đó là chốt an toàn cố ý: không ai bật được
  -- tính năng tiền mà không ghi lại nó ứng với commit/migration nào.
  INSERT INTO app_private.server_feature_flags
    (feature_key, domain, risk_class, mode, force_freeze, config_version,
     commit_sha, migration_sha256)
  VALUES ('special_fee.generate.v1', 'thu_tien', 'MONEY', 'ON', false, 1,
          '2cc71ed16879393d4edf84d01479f1406ed555d4', '864eb27ab92d36f6bf687e1eebeacb254178213832348443a2ea70e7c00018db')
  ON CONFLICT (feature_key) DO UPDATE
    SET mode='ON', force_freeze=false,
        commit_sha=EXCLUDED.commit_sha, migration_sha256=EXCLUDED.migration_sha256;

  v_r := public.generate_special_fees_v1('2026-09', ARRAY[v_b1], 'zztest-sf-0001');
  v_ket := v_ket || E'\n3 ✓ sinh '||(v_r->>'created')||' phiếu, tổng '
                  ||round((v_r->>'totalAmount')::numeric)::bigint||'đ';

  -- 4: phiếu phải CHỜ DUYỆT, không tự duyệt
  SELECT count(*) INTO v_n FROM income_expenses
   WHERE system_source='special_fee.v1' AND building_id=v_b1
     AND approval_status <> 'UNAPPROVED';
  v_ket := v_ket || CASE WHEN v_n=0 THEN E'\n4 ✓ tất cả phiếu ở trạng thái CHỜ DUYỆT'
                         ELSE E'\n4 ✗ có '||v_n||' phiếu tự duyệt!' END;

  -- 5: BẤM LẦN HAI — không được đẻ thêm
  v_r := public.generate_special_fees_v1('2026-09', ARRAY[v_b1], 'zztest-sf-0002');
  v_ket := v_ket || CASE WHEN (v_r->>'created')::int = 0
    THEN E'\n5 ✓ bấm lần hai sinh 0 phiếu (sổ claim chặn)'
    ELSE E'\n5 ✗ lần hai đẻ thêm '||(v_r->>'created')||' phiếu!' END;

  -- 6: preview nay báo ĐÃ_SINH
  SELECT count(*) INTO v_n FROM public.preview_special_fees_v1('2026-09', ARRAY[v_b1])
   WHERE status='ĐÃ_SINH';
  v_ket := v_ket || CASE WHEN v_n > 0 THEN E'\n6 ✓ preview báo ĐÃ_SINH cho '||v_n||' ô'
                         ELSE E'\n6 ✗ preview không báo ĐÃ_SINH' END;

  -- 7: huỷ claim rồi sinh lại được
  DECLARE v_cl uuid;
  BEGIN
    SELECT id INTO v_cl FROM special_fee_claims
     WHERE building_id=v_b1 AND period_month='2026-09-01' AND status='GENERATED' LIMIT 1;
    PERFORM public.cancel_special_fee_claim_v1(v_cl, 'test huỷ để sinh lại');
    v_r := public.generate_special_fees_v1('2026-09', ARRAY[v_b1], 'zztest-sf-0003');
    v_ket := v_ket || CASE WHEN (v_r->>'created')::int = 1
      THEN E'\n7 ✓ huỷ claim xong sinh lại được đúng 1 phiếu'
      ELSE E'\n7 ✗ sinh lại ra '||(v_r->>'created')||' phiếu' END;
  END;

  -- 8: KHÔNG cho huỷ claim khi phiếu đã duyệt
  DECLARE v_cl2 uuid; v_v uuid;
  BEGIN
    SELECT id, voucher_id INTO v_cl2, v_v FROM special_fee_claims
     WHERE building_id=v_b1 AND status='GENERATED' AND voucher_id IS NOT NULL LIMIT 1;
    UPDATE income_expenses SET approval_status='APPROVED' WHERE id=v_v;
    BEGIN
      PERFORM public.cancel_special_fee_claim_v1(v_cl2, 'thử huỷ khi đã duyệt');
      v_ket := v_ket || E'\n8 ✗ cho huỷ claim của phiếu ĐÃ DUYỆT!';
    EXCEPTION WHEN OTHERS THEN
      v_ket := v_ket || CASE WHEN position('ĐÃ ĐƯỢC DUYỆT' IN SQLERRM) > 0
        THEN E'\n8 ✓ chặn huỷ claim khi phiếu đã duyệt (tránh đẻ phiếu thứ hai)'
        ELSE E'\n8 ? '||left(SQLERRM,70) END;
    END;
  END;

  RAISE EXCEPTION 'KẾT QUẢ:%', v_ket;
END
$t$;

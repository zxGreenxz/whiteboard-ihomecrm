-- Đợt 1 — test context submit dùng chung. Org DEMO, rollback sạch.
DO $t$
DECLARE
  v_demo uuid := 'dddd0000-0000-4000-8000-000000000001';
  v_that uuid := 'aaaa0000-0000-4000-8000-000000000001';
  v_owner uuid; v_bld uuid; v_acc_that uuid; v_acc_ao uuid;
  v_ctx jsonb; v_ket text := '';
BEGIN
  SELECT id, user_id INTO v_bld, v_owner FROM buildings
   WHERE organization_id=v_demo AND deleted_at IS NULL AND name='Tòa DEMO A';
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
  SELECT id INTO v_acc_that FROM accounts
   WHERE organization_id=v_demo AND deleted_at IS NULL AND NOT COALESCE(is_virtual,false) LIMIT 1;
  SELECT id INTO v_acc_ao FROM accounts
   WHERE organization_id=v_demo AND deleted_at IS NULL AND COALESCE(is_virtual,false) LIMIT 1;

  -- 1: đường sạch
  v_ctx := app_private.special_page_submit_context_v1(
             'zz.test.op', v_demo, v_bld, v_acc_that, 'zztest-ctx-0001');
  v_ket := v_ket || CASE WHEN (v_ctx->>'replay')::bool = false
                          AND v_ctx->>'featureRoute' IS NOT NULL
                          AND v_ctx->>'orgToday' IS NOT NULL
    THEN E'\n1 ✓ context sạch: route='||(v_ctx->>'featureRoute')||' ngày='||(v_ctx->>'orgToday')
    ELSE E'\n1 ✗ '||v_ctx::text END;

  -- 2: ngày phải theo múi giờ TỔ CHỨC, không phải CURRENT_DATE của server UTC
  v_ket := v_ket || CASE WHEN (v_ctx->>'orgToday')::date
                          = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
    THEN E'\n2 ✓ orgToday theo giờ VN' ELSE E'\n2 ✗ orgToday lệch' END;

  -- 3: SỔ ẢO phải bị chặn
  IF v_acc_ao IS NULL THEN
    v_ket := v_ket || E'\n3 – bỏ qua (DEMO không có sổ ảo)';
  ELSE
    BEGIN
      PERFORM app_private.special_page_submit_context_v1(
                'zz.test.op', v_demo, v_bld, v_acc_ao, 'zztest-ctx-0002');
      v_ket := v_ket || E'\n3 ✗ CHO GHI VÀO SỔ ẢO!';
    EXCEPTION WHEN OTHERS THEN
      v_ket := v_ket || CASE WHEN position('SỔ ẢO' IN SQLERRM) > 0
        THEN E'\n3 ✓ chặn sổ ảo' ELSE E'\n3 ? '||left(SQLERRM,60) END;
    END;
  END IF;

  -- 4: org mà mình không thuộc
  BEGIN
    PERFORM app_private.special_page_submit_context_v1(
              'zz.test.op', v_that, NULL, NULL, 'zztest-ctx-0003');
    v_ket := v_ket || E'\n4 ? không chặn org lạ (tài khoản này có thể thuộc cả hai org)';
  EXCEPTION WHEN OTHERS THEN
    v_ket := v_ket || CASE WHEN position('không thuộc tổ chức' IN SQLERRM) > 0
      THEN E'\n4 ✓ chặn org không thuộc' ELSE E'\n4 ? '||left(SQLERRM,60) END;
  END;

  -- 5: key rác
  BEGIN
    PERFORM app_private.special_page_submit_context_v1('zz.test.op', v_demo, v_bld, v_acc_that, 'ngan');
    v_ket := v_ket || E'\n5 ✗ nhận key rác';
  EXCEPTION WHEN OTHERS THEN
    v_ket := v_ket || CASE WHEN position('idempotency_key' IN SQLERRM) > 0
      THEN E'\n5 ✓ chặn idempotency_key không hợp lệ' ELSE E'\n5 ? '||left(SQLERRM,60) END;
  END;

  -- 6: toà của org khác
  DECLARE v_bld_that uuid;
  BEGIN
    SELECT id INTO v_bld_that FROM buildings
     WHERE organization_id=v_that AND deleted_at IS NULL LIMIT 1;
    BEGIN
      PERFORM app_private.special_page_submit_context_v1(
                'zz.test.op', v_demo, v_bld_that, v_acc_that, 'zztest-ctx-0004');
      v_ket := v_ket || E'\n6 ✗ nhận toà của org khác!';
    EXCEPTION WHEN OTHERS THEN
      v_ket := v_ket || CASE WHEN position('không thuộc tổ chức' IN SQLERRM) > 0
        THEN E'\n6 ✓ chặn toà khác tổ chức' ELSE E'\n6 ? '||left(SQLERRM,60) END;
    END;
  END;

  -- 7: REPLAY — thao tác đã hoàn tất thì trả kết quả cũ NGAY
  INSERT INTO app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key,
     payload_hash, completed_at, subject_id, response_payload)
  VALUES (v_demo, 'zz.test.op', v_demo::text, v_owner, 'zztest-ctx-0009',
          md5('x'), now(), v_bld, '{"ok":true}'::jsonb);
  v_ctx := app_private.special_page_submit_context_v1(
             'zz.test.op', v_demo, v_bld, v_acc_that, 'zztest-ctx-0009');
  v_ket := v_ket || CASE WHEN (v_ctx->>'replay')::bool = true
    THEN E'\n7 ✓ replay trả kết quả cũ ngay' ELSE E'\n7 ✗ không nhận ra replay' END;

  -- 8: replay phải thắng cả khi sổ quỹ là SỔ ẢO (lookup đứng trước mọi kiểm tra)
  IF v_acc_ao IS NOT NULL THEN
    v_ctx := app_private.special_page_submit_context_v1(
               'zz.test.op', v_demo, v_bld, v_acc_ao, 'zztest-ctx-0009');
    v_ket := v_ket || CASE WHEN (v_ctx->>'replay')::bool = true
      THEN E'\n8 ✓ replay đứng TRƯỚC mọi kiểm tra (không ăn lỗi oan)'
      ELSE E'\n8 ✗ replay bị kiểm tra chặn' END;
  END IF;

  RAISE EXCEPTION 'KẾT QUẢ:%', v_ket;
END
$t$;

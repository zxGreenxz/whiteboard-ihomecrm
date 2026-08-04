-- Đợt 2 Task 0 Step 1/6: dựng fixture DEMO rồi chứng minh 4 tính chất.
-- Production KHÔNG có ca lỗi nào (3/3 dòng transfer đều đủ) nên phải tự dựng.
-- CHỈ org DEMO. Tự dọn cuối bài. Không đụng tiền.
DO $t$
DECLARE
  v_demo  uuid := 'dddd0000-0000-4000-8000-000000000001';
  v_bld   uuid; v_bld2 uuid; v_r1 uuid; v_r2 uuid; v_r3 uuid; v_rx uuid;
  v_ct    uuid; v_ct2 uuid; v_owner uuid;
  v_tr    uuid;
  v_err   text;
  v_n     int;
  v_ket   text := '';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id=v_demo AND name ILIKE '%demo%') THEN
    RAISE EXCEPTION 'Org không phải DEMO — DỪNG.';
  END IF;

  SELECT id, user_id INTO v_bld, v_owner FROM buildings
   WHERE organization_id=v_demo AND deleted_at IS NULL AND name='Tòa DEMO A';
  SELECT id INTO v_bld2 FROM buildings
   WHERE organization_id=v_demo AND deleted_at IS NULL AND name='Tòa DEMO B';

  -- Ba phòng cùng toà + một phòng ở TOÀ KHÁC (để test chặn chuyển chéo toà)
  INSERT INTO rooms (building_id, name, status, rent_price, deposit_amount, organization_id)
  VALUES (v_bld,  'ZT-101', 'AVAILABLE', 5000000, 5000000, v_demo) RETURNING id INTO v_r1;
  INSERT INTO rooms (building_id, name, status, rent_price, deposit_amount, organization_id)
  VALUES (v_bld,  'ZT-102', 'AVAILABLE', 6000000, 6000000, v_demo) RETURNING id INTO v_r2;
  INSERT INTO rooms (building_id, name, status, rent_price, deposit_amount, organization_id)
  VALUES (v_bld,  'ZT-103', 'AVAILABLE', 5500000, 5500000, v_demo) RETURNING id INTO v_r3;
  INSERT INTO rooms (building_id, name, status, rent_price, deposit_amount, organization_id)
  VALUES (v_bld2, 'ZT-901', 'AVAILABLE', 7000000, 7000000, v_demo) RETURNING id INTO v_rx;

  -- Hai hợp đồng ACTIVE ở ZT-101 và ZT-102
  INSERT INTO contracts (room_id, status, signed_date, start_date, end_date, rent_price,
                         total_deposit, user_id, organization_id, contract_number, public_code)
  VALUES (v_r1, 'ACTIVE', '2026-01-01', '2026-01-01', '2026-12-31', 5000000, 5000000,
          v_owner, v_demo, 'ZT-HD-001', 'ZTPC001') RETURNING id INTO v_ct;
  INSERT INTO contracts (room_id, status, signed_date, start_date, end_date, rent_price,
                         total_deposit, user_id, organization_id, contract_number, public_code)
  VALUES (v_r2, 'ACTIVE', '2026-01-01', '2026-01-01', '2026-12-31', 6000000, 6000000,
          v_owner, v_demo, 'ZT-HD-002', 'ZTPC002') RETURNING id INTO v_ct2;

  -- ══ CA 1: audit KHÔNG ghi được ⇒ phải rollback CẢ chuyển phòng ══════
  -- Ép audit lỗi bằng một trigger tạm ném lỗi trên contract_transfers.
  CREATE OR REPLACE FUNCTION app_private.zz_test_break_audit() RETURNS trigger
    LANGUAGE plpgsql AS $b$ BEGIN
      RAISE EXCEPTION 'ZZTEST audit cố tình lỗi'; END $b$;
  CREATE TRIGGER zz_test_break_audit BEFORE INSERT ON contract_transfers
    FOR EACH ROW EXECUTE FUNCTION app_private.zz_test_break_audit();

  BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
    PERFORM public.transfer_room(v_ct, v_r3, NULL, '2026-07-15'::date, 'test');
    v_ket := v_ket || E'\nCA1 ✗ KHÔNG nên thành công';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF position('ZZTEST' IN v_err) > 0 THEN
      v_ket := v_ket || E'\nCA1 ✓ audit lỗi ⇒ RPC ném lỗi (không âm thầm bỏ qua)';
    ELSE
      v_ket := v_ket || E'\nCA1 ? lỗi khác: ' || v_err;
    END IF;
  END;
  -- Hợp đồng phải VẪN ở phòng cũ (chứng minh rollback, không nửa vời)
  SELECT count(*) INTO v_n FROM contracts WHERE id=v_ct AND room_id=v_r1;
  v_ket := v_ket || CASE WHEN v_n=1
    THEN E'\nCA1 ✓ hợp đồng VẪN ở phòng cũ — không có trạng thái nửa vời'
    ELSE E'\nCA1 ✗ hợp đồng đã bị chuyển dù audit lỗi (FAIL-OPEN!)' END;

  DROP TRIGGER zz_test_break_audit ON contract_transfers;
  DROP FUNCTION app_private.zz_test_break_audit();

  -- ══ CA 2: chuyển phòng bình thường ⇒ audit ĐỦ ══════════════════════
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
    PERFORM public.transfer_room(v_ct, v_r3, 5500000, '2026-07-15'::date, 'chuyển thật');
  SELECT count(*) INTO v_n FROM contract_transfers
   WHERE contract_id=v_ct AND status='COMPLETED' AND transfer_type='ROOM_CHANGE'
     AND old_room_id=v_r1 AND new_room_id=v_r3
     AND move_out_date IS NOT NULL AND move_in_date IS NOT NULL;
  v_ket := v_ket || CASE WHEN v_n=1
    THEN E'\nCA2 ✓ audit ghi đủ hai đầu phòng + hai mốc ngày'
    ELSE E'\nCA2 ✗ audit thiếu/không có (n=' || v_n || ')' END;
  SELECT count(*) INTO v_n FROM contracts
   WHERE id=v_ct AND room_id=v_r3 AND status='ACTIVE'
     AND start_date='2026-01-01' AND end_date='2026-12-31';
  v_ket := v_ket || CASE WHEN v_n=1
    THEN E'\nCA2 ✓ giữ ACTIVE và KHÔNG đụng kỳ hạn hợp đồng'
    ELSE E'\nCA2 ✗ status/kỳ hạn bị đổi' END;

  -- ══ CA 3: hợp đồng thứ hai chuyển vào ĐÚNG phòng vừa bị chiếm ═══════
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
    PERFORM public.transfer_room(v_ct2, v_r3, NULL, '2026-07-16'::date, NULL);
    v_ket := v_ket || E'\nCA3 ✗ cho hai hợp đồng vào cùng một phòng!';
  EXCEPTION WHEN OTHERS THEN
    v_ket := v_ket || CASE WHEN position('đã có hợp đồng đang hiệu lực' IN SQLERRM) > 0
      THEN E'\nCA3 ✓ chặn phòng đã có hợp đồng hiệu lực'
      ELSE E'\nCA3 ? lỗi khác: ' || SQLERRM END;
  END;

  -- ══ CA 4: chuyển sang phòng TOÀ KHÁC ⇒ phải chặn ═══════════════════
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
    PERFORM public.transfer_room(v_ct2, v_rx, NULL, '2026-07-16'::date, NULL);
    v_ket := v_ket || E'\nCA4 ✗ cho chuyển sang toà khác!';
  EXCEPTION WHEN OTHERS THEN
    v_ket := v_ket || CASE WHEN position('toà khác' IN SQLERRM) > 0
      THEN E'\nCA4 ✓ chặn chuyển sang toà khác'
      ELSE E'\nCA4 ? lỗi khác: ' || SQLERRM END;
  END;

  -- ══ CA 5: ĐƯỜNG B — duyệt tay phiếu THIẾU old_room_id ⇒ phải chặn ══
  INSERT INTO contract_transfers (user_id, contract_id, transfer_type, transfer_date,
                                  new_room_id, status, organization_id)
  VALUES (v_owner, v_ct2, 'ROOM_CHANGE', '2026-07-20', v_r1, 'DRAFT', v_demo)
  RETURNING id INTO v_tr;
  BEGIN
    UPDATE contract_transfers SET status='APPROVED' WHERE id=v_tr;
    v_ket := v_ket || E'\nCA5 ✗ đường B duyệt được phiếu THIẾU phòng cũ';
  EXCEPTION WHEN OTHERS THEN
    v_ket := v_ket || CASE WHEN position('Thiếu phòng cũ' IN SQLERRM) > 0
      THEN E'\nCA5 ✓ đường B fail-closed khi audit thiếu phòng cũ'
      ELSE E'\nCA5 ? lỗi khác: ' || SQLERRM END;
  END;

  -- ══ CA 6: ĐƯỜNG B đủ dữ liệu ⇒ áp dụng, KHÔNG đụng kỳ hạn/status ══
  UPDATE contract_transfers
     SET old_room_id=v_r2, move_out_date='2026-07-20', move_in_date='2026-07-20'
   WHERE id=v_tr;
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
  UPDATE contract_transfers SET status='APPROVED' WHERE id=v_tr;
  SELECT count(*) INTO v_n FROM contracts
   WHERE id=v_ct2 AND room_id=v_r1 AND status='ACTIVE'
     AND start_date='2026-01-01' AND end_date='2026-12-31'
     AND parent_contract_id IS NULL;
  v_ket := v_ket || CASE WHEN v_n=1
    THEN E'\nCA6 ✓ đường B áp dụng đúng: đổi phòng, GIỮ ACTIVE, không đụng kỳ hạn, không đặt parent'
    ELSE E'\nCA6 ✗ đường B vẫn làm sai (n=' || v_n || ')' END;

  -- ══ DỌN ═══════════════════════════════════════════════════════════
  DELETE FROM contract_transfers WHERE contract_id IN (v_ct, v_ct2);
  DELETE FROM contracts WHERE id IN (v_ct, v_ct2);
  DELETE FROM rooms WHERE id IN (v_r1, v_r2, v_r3, v_rx);

  RAISE EXCEPTION 'KẾT QUẢ:%', v_ket;   -- ném để in ra, và rollback sạch mọi thứ
END
$t$;

-- Đợt 2 Task 0 Step 6 — test residence segments.
-- Production KHÔNG có ca incomplete/ambiguous/overlap nào (3/3 dòng transfer đều
-- đủ old_room_id/new_room_id/move_out_date/move_in_date) nên MỌI ca lệch phải TỰ
-- DỰNG. Chỉ org DEMO. Kết thúc bằng RAISE nên rollback sạch mọi fixture.
--
-- Chạy: node scripts/apply-sql.mjs scripts/tests/test-room-residence-segments.sql
DO $t$
DECLARE
  v_demo uuid := 'dddd0000-0000-4000-8000-000000000001';
  v_bld uuid; v_owner uuid;
  v_a1 uuid; v_a2 uuid; v_a3 uuid; v_b1 uuid; v_c1 uuid;
  v_d1 uuid; v_d2 uuid; v_d3 uuid; v_e1 uuid; v_e2 uuid;
  v_rooms uuid[];
  v_ct_ok uuid; v_ct_noxfer uuid; v_ct_inc uuid; v_ct_amb uuid; v_ct_tie uuid;
  v_ket text := '';
  v_n int; v_s record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id=v_demo AND name ILIKE '%demo%') THEN
    RAISE EXCEPTION 'Org không phải DEMO — DỪNG.';
  END IF;
  SELECT id, user_id INTO v_bld, v_owner FROM buildings
   WHERE organization_id=v_demo AND deleted_at IS NULL AND name='Tòa DEMO A';
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);

  -- Mỗi hợp đồng phải có PHÒNG HIỆN TẠI RIÊNG: có unique
  -- contracts_one_active_per_room_uq (một hợp đồng ACTIVE / một phòng).
  INSERT INTO rooms (building_id,name,status,rent_price,deposit_amount,organization_id)
  SELECT v_bld,'ZS-'||g,'AVAILABLE',5000000,5000000,v_demo FROM generate_series(201,210) g;
  SELECT array_agg(id ORDER BY name) INTO v_rooms FROM rooms
   WHERE name LIKE 'ZS-2%' AND building_id=v_bld AND deleted_at IS NULL;
  v_a1:=v_rooms[1]; v_a2:=v_rooms[2]; v_a3:=v_rooms[3]; v_b1:=v_rooms[4]; v_c1:=v_rooms[5];
  v_d1:=v_rooms[6]; v_d2:=v_rooms[7]; v_d3:=v_rooms[8]; v_e1:=v_rooms[9]; v_e2:=v_rooms[10];

  -- Helper: tạo hợp đồng
  INSERT INTO contracts (room_id,status,signed_date,start_date,end_date,rent_price,
                         total_deposit,user_id,organization_id,contract_number,public_code)
  VALUES (v_a3,'ACTIVE','2026-01-01','2026-01-01','2026-12-31',5000000,5000000,
          v_owner,v_demo,'ZS-OK','ZSPC001') RETURNING id INTO v_ct_ok;
  INSERT INTO contracts (room_id,status,signed_date,start_date,end_date,rent_price,
                         total_deposit,user_id,organization_id,contract_number,public_code)
  VALUES (v_b1,'ACTIVE','2026-02-01','2026-02-01','2026-12-31',5000000,5000000,
          v_owner,v_demo,'ZS-NOXFER','ZSPC002') RETURNING id INTO v_ct_noxfer;
  INSERT INTO contracts (room_id,status,signed_date,start_date,end_date,rent_price,
                         total_deposit,user_id,organization_id,contract_number,public_code)
  VALUES (v_c1,'ACTIVE','2026-01-01','2026-01-01','2026-12-31',5000000,5000000,
          v_owner,v_demo,'ZS-INC','ZSPC003') RETURNING id INTO v_ct_inc;
  INSERT INTO contracts (room_id,status,signed_date,start_date,end_date,rent_price,
                         total_deposit,user_id,organization_id,contract_number,public_code)
  VALUES (v_d2,'ACTIVE','2026-01-01','2026-01-01','2026-12-31',5000000,5000000,
          v_owner,v_demo,'ZS-AMB','ZSPC004') RETURNING id INTO v_ct_amb;
  INSERT INTO contracts (room_id,status,signed_date,start_date,end_date,rent_price,
                         total_deposit,user_id,organization_id,contract_number,public_code)
  VALUES (v_e2,'ACTIVE','2026-01-01','2026-01-01','2026-12-31',5000000,5000000,
          v_owner,v_demo,'ZS-TIE','ZSPC005') RETURNING id INTO v_ct_tie;

  -- ══ CA A: chuỗi ĐÚNG, hai bước, cùng ngày ra/vào (không tạo khoảng trống ảo)
  -- ZS-OK: 201 → 202 (15/03) → 203 (10/05). room_id hiện tại = 203 ✔
  INSERT INTO contract_transfers (user_id,contract_id,transfer_type,transfer_date,
    old_room_id,new_room_id,move_out_date,move_in_date,status,organization_id)
  VALUES (v_owner,v_ct_ok,'ROOM_CHANGE','2026-03-15',v_a1,v_a2,'2026-03-15','2026-03-15','COMPLETED',v_demo);
  INSERT INTO contract_transfers (user_id,contract_id,transfer_type,transfer_date,
    old_room_id,new_room_id,move_out_date,move_in_date,status,organization_id)
  VALUES (v_owner,v_ct_ok,'ROOM_CHANGE','2026-05-10',v_a2,v_a3,'2026-05-10','2026-05-10','APPROVED',v_demo);

  SELECT count(*) INTO v_n FROM public.get_room_residence_segments_v1(ARRAY[v_ct_ok]);
  v_ket := v_ket || CASE WHEN v_n=3 THEN E'\nA ✓ 2 bước chuyển ⇒ 3 đoạn'
                         ELSE E'\nA ✗ số đoạn = '||v_n||' (mong đợi 3)' END;
  SELECT count(*) INTO v_n FROM public.get_room_residence_segments_v1(ARRAY[v_ct_ok]) WHERE trusted;
  v_ket := v_ket || CASE WHEN v_n=3 THEN E'\nA ✓ cả 3 đoạn trusted'
                         ELSE E'\nA ✗ có đoạn không trusted' END;
  -- Không có khoảng trống ảo: to_date của đoạn i = from_date của đoạn i+1
  SELECT count(*) INTO v_n FROM (
    SELECT s.to_date, lead(s.from_date) OVER (ORDER BY s.seg_index) AS nxt
      FROM public.get_room_residence_segments_v1(ARRAY[v_ct_ok]) s) x
   WHERE nxt IS NOT NULL AND to_date IS DISTINCT FROM nxt;
  v_ket := v_ket || CASE WHEN v_n=0 THEN E'\nA ✓ không có khoảng trống ảo giữa các đoạn'
                         ELSE E'\nA ✗ '||v_n||' chỗ hở giữa các đoạn' END;
  -- Phủ CẢ hai đường
  SELECT count(DISTINCT source_path) INTO v_n
    FROM public.get_room_residence_segments_v1(ARRAY[v_ct_ok]);
  v_ket := v_ket || CASE WHEN v_n=3
    THEN E'\nA ✓ nhận cả 3 nguồn: CONTRACT_START + TRANSFER_ROOM_COMPLETED + TRIGGER_APPROVED'
    ELSE E'\nA ✗ chỉ thấy '||v_n||' nguồn' END;

  -- ══ CA B: KHÔNG có transfer ⇒ 1 đoạn, from_date = start_date (được tin)
  SELECT * INTO v_s FROM public.get_room_residence_segments_v1(ARRAY[v_ct_noxfer]);
  v_ket := v_ket || CASE WHEN v_s.from_date='2026-02-01' AND v_s.to_date IS NULL AND v_s.trusted
    THEN E'\nB ✓ không transfer ⇒ 1 đoạn mở, tin start_date'
    ELSE E'\nB ✗ from='||COALESCE(v_s.from_date::text,'NULL')||' to='||COALESCE(v_s.to_date::text,'NULL')||' trusted='||v_s.trusted END;

  -- ══ CA C: INCOMPLETE — bước đầu thiếu old_room_id
  INSERT INTO contract_transfers (user_id,contract_id,transfer_type,transfer_date,
    old_room_id,new_room_id,move_out_date,move_in_date,status,organization_id)
  VALUES (v_owner,v_ct_inc,'ROOM_CHANGE','2026-04-01',NULL,v_c1,'2026-04-01','2026-04-01','COMPLETED',v_demo);
  SELECT count(*) INTO v_n FROM public.get_room_residence_segments_v1(ARRAY[v_ct_inc])
   WHERE NOT trusted AND diagnostic LIKE 'SEGMENT_HISTORY_INCOMPLETE%';
  v_ket := v_ket || CASE WHEN v_n > 0
    THEN E'\nC ✓ thiếu old_room_id ⇒ SEGMENT_HISTORY_INCOMPLETE, trusted=false'
    ELSE E'\nC ✗ không báo INCOMPLETE' END;

  -- ══ CA D: AMBIGUOUS — chuỗi không nối (bước 2 có old_room khác new_room bước 1)
  INSERT INTO contract_transfers (user_id,contract_id,transfer_type,transfer_date,
    old_room_id,new_room_id,move_out_date,move_in_date,status,organization_id)
  VALUES (v_owner,v_ct_amb,'ROOM_CHANGE','2026-03-01',v_d1,v_d2,'2026-03-01','2026-03-01','COMPLETED',v_demo);
  INSERT INTO contract_transfers (user_id,contract_id,transfer_type,transfer_date,
    old_room_id,new_room_id,move_out_date,move_in_date,status,organization_id)
  VALUES (v_owner,v_ct_amb,'ROOM_CHANGE','2026-06-01',v_d3,v_d2,'2026-06-01','2026-06-01','COMPLETED',v_demo);
  SELECT count(*) INTO v_n FROM public.get_room_residence_segments_v1(ARRAY[v_ct_amb])
   WHERE NOT trusted AND diagnostic LIKE 'SEGMENT_HISTORY_AMBIGUOUS%';
  v_ket := v_ket || CASE WHEN v_n > 0
    THEN E'\nD ✓ chuỗi không nối ⇒ SEGMENT_HISTORY_AMBIGUOUS, trusted=false'
    ELSE E'\nD ✗ không báo AMBIGUOUS' END;
  -- và phải KHÔNG trả đoạn nào trusted (không nửa tin nửa không)
  SELECT count(*) INTO v_n FROM public.get_room_residence_segments_v1(ARRAY[v_ct_amb]) WHERE trusted;
  v_ket := v_ket || CASE WHEN v_n=0
    THEN E'\nD ✓ KHÔNG trả đoạn trusted nào cho hợp đồng lỗi (không nửa vời)'
    ELSE E'\nD ✗ vẫn có '||v_n||' đoạn trusted' END;

  -- ══ CA E: AMBIGUOUS — hai bước cùng ngày hiệu lực (tie)
  INSERT INTO contract_transfers (user_id,contract_id,transfer_type,transfer_date,
    old_room_id,new_room_id,move_out_date,move_in_date,status,organization_id)
  VALUES (v_owner,v_ct_tie,'ROOM_CHANGE','2026-03-01',v_e1,v_e2,'2026-03-01','2026-03-01','COMPLETED',v_demo);
  INSERT INTO contract_transfers (user_id,contract_id,transfer_type,transfer_date,
    old_room_id,new_room_id,move_out_date,move_in_date,status,organization_id)
  VALUES (v_owner,v_ct_tie,'ROOM_CHANGE','2026-03-01',v_e1,v_e2,'2026-03-01','2026-03-01','COMPLETED',v_demo);
  SELECT count(*) INTO v_n FROM public.get_room_residence_segments_v1(ARRAY[v_ct_tie])
   WHERE NOT trusted AND diagnostic LIKE '%cùng ngày hiệu lực%';
  v_ket := v_ket || CASE WHEN v_n > 0
    THEN E'\nE ✓ hai bước cùng ngày ⇒ AMBIGUOUS (không đoán thứ tự)'
    ELSE E'\nE ✗ không báo tie' END;

  -- ══ CA F: TENANT_CHANGE / DRAFT / CANCELLED KHÔNG cắt đoạn phòng
  INSERT INTO contract_transfers (user_id,contract_id,transfer_type,transfer_date,
    old_room_id,new_room_id,move_out_date,move_in_date,status,organization_id)
  VALUES (v_owner,v_ct_noxfer,'ROOM_CHANGE','2026-07-01',v_b1,v_a1,'2026-07-01','2026-07-01','DRAFT',v_demo);
  SELECT count(*) INTO v_n FROM public.get_room_residence_segments_v1(ARRAY[v_ct_noxfer]);
  v_ket := v_ket || CASE WHEN v_n=1
    THEN E'\nF ✓ phiếu DRAFT không cắt đoạn'
    ELSE E'\nF ✗ DRAFT đã cắt đoạn (n='||v_n||')' END;

  -- ══ CA G: hàm conflicts chỉ liệt kê hợp đồng lỗi
  SELECT count(*) INTO v_n FROM public.get_room_residence_conflicts_v1(
    ARRAY[v_ct_ok,v_ct_noxfer,v_ct_inc,v_ct_amb,v_ct_tie]);
  v_ket := v_ket || CASE WHEN v_n=3
    THEN E'\nG ✓ conflicts trả đúng 3 hợp đồng lỗi (INC, AMB, TIE), bỏ 2 hợp đồng tốt'
    ELSE E'\nG ✗ conflicts trả '||v_n||' (mong đợi 3)' END;

  -- ══ CA H: production phải SẠCH — 0 hợp đồng lỗi ngoài fixture
  SELECT count(*) INTO v_n FROM public.get_room_residence_conflicts_v1(NULL)
   WHERE contract_number NOT LIKE 'ZS-%';
  v_ket := v_ket || CASE WHEN v_n=0
    THEN E'\nH ✓ dữ liệu thật: 0 hợp đồng có chuỗi cư trú lỗi'
    ELSE E'\nH ⚠ dữ liệu thật có '||v_n||' hợp đồng chuỗi lỗi — cần rà tay' END;

  DELETE FROM contract_transfers WHERE contract_id IN (v_ct_ok,v_ct_noxfer,v_ct_inc,v_ct_amb,v_ct_tie);
  DELETE FROM contracts WHERE id IN (v_ct_ok,v_ct_noxfer,v_ct_inc,v_ct_amb,v_ct_tie);
  DELETE FROM rooms WHERE id = ANY(v_rooms);

  RAISE EXCEPTION 'KẾT QUẢ:%', v_ket;
END
$t$;

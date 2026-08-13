-- =============================================================================
-- DEMO — ma trận dữ liệu đầy đủ: 4 toà · 2 quản lý mỗi người 2 toà · ≥10 phòng/toà
--            phủ đủ trạng thái hiển thị · khách + xe · sổ quỹ riêng
--
-- Viết sau một đợt khảo sát 7 vùng lược đồ + một vòng đối chiếu chéo đã BÁC 7
-- khẳng định sai. Những chỗ đắt nhất được ghi ngay tại chỗ dùng.
--
-- ========================== LUẬT 1 — CÁCH LY TỔ CHỨC =========================
-- Ghi organization_id TƯỜNG MINH trên MỌI dòng của MỌI bảng, kể cả bảng mà
-- trigger trg_autofill_org suy đúng.
--
-- VÌ SAO KHÔNG TIN TRIGGER: public._autofill_org() dò building_id → room_id →
-- contract_id → invoice_id → income_expense_id → account_id → customer_id →
-- membership(user_id). Dò hết mà không ra thì nó GÁN CỨNG hằng số
-- 'aaaa0000-0000-4000-8000-000000000001' (công ty THẬT) và ghi log trong một
-- khối `EXCEPTION WHEN OTHERS THEN NULL` — tức nuốt luôn cả lỗi ghi log. Sai
-- lặng lẽ, không một dòng báo.
--
-- Nặng hơn: `buildings` là bảng DUY NHẤT không có trigger đó. Quên org ở toà
-- nhà thì phòng/tầng/xe chèn sau sẽ dò không ra và rơi về công ty thật.
--
-- Nghiệm thu vì vậy KHÔNG chỉ đếm dòng của Demo, mà đếm TOÀN BỘ dòng của công
-- ty thật trước/sau và bắt buộc KHÔNG ĐỔI MỘT DÒNG NÀO trên cả 304 bảng.
--
-- ========================= LUẬT 2 — KHÔNG CHẠM OPENCLAW ======================
-- Phòng "đã cọc" KHÔNG được INSERT thẳng status='RESERVED'. Lý do (đã đọc thân
-- hàm): trg_ie_reconcile_room_ins (AFTER INSERT ON income_expenses) gọi
-- recompute_room_reservation(); lúc chèn PHIẾU thì HẠNG MỤC chưa có nên
-- room_has_holding_deposit() = false, phòng RESERVED bị lật về AVAILABLE — và
-- chính cú UPDATE đó khớp trg_room_status_reconcile
-- (AFTER UPDATE OF status WHEN new.status='AVAILABLE') → gọi
-- app_private.openclaw_insert_crm_occurrence_v1 → GHI VÀO VÙNG OPENCLAW.
-- Nhìn kết quả cuối thì "đúng" mà đã lỡ chạm.
-- → Chèn AVAILABLE, rồi phiếu, rồi item. Chiều AVAILABLE→RESERVED không khớp
--   mệnh đề WHEN nên không chạm gì.
-- Cũng KHÔNG truyền openclaw_availability_revision: nhánh INSERT của
-- app_private.openclaw_bump_room_availability_revision_v1 RAISE 42501 nếu khác 1.
--
-- ==================== LUẬT 3 — KHÔNG ĂN DÃY SỐ CÔNG TY THẬT ==================
-- Bộ sinh invoice_number lấy MAX+1 TOÀN CỤC trên 'INV-<năm>-%' (đã tới
-- INV-2026-00617). Hoá đơn demo dùng dãy riêng 'DEMO-2026-…' đặt tay.
-- contracts.contract_number và income_expenses.code cũng sinh theo COUNT/MAX nên
-- các bảng đó phải INSERT TỪNG DÒNG, không insert nhiều dòng một câu.
--
-- ======================= TRẠNG THÁI PHÒNG — 5 NHÓM HIỂN THỊ ==================
-- src/lib/roomStatus.ts::getRoomDisplayStatus KHÔNG đọc thẳng rooms.status:
--   có HĐ ACTIVE/EXTENDED còn 1..30 ngày → "sắp hết hạn"
--   có HĐ ACTIVE/EXTENDED khác          → "đang thuê"
--   không HĐ: MAINTENANCE→"bảo trì", RESERVED→"đã cọc", còn lại→"trống"
-- Nên phủ trạng thái phải dựng bằng HỢP ĐỒNG và PHIẾU CỌC thật, không phải bằng
-- cách đặt cờ. 'UNAVAILABLE' bỏ hẳn — không có nhánh hiển thị nào.
--
-- ============================ PHÂN CÔNG QUẢN LÝ ==============================
-- demo.quanly → Toà A + B · demo.kythuat → Toà C + D.
-- Cách làm: XOÁ dòng role_binding_scopes trỏ scope ORGANIZATION của họ rồi CHÈN
-- đúng 2 dòng trỏ scope BUILDING. Sót một dòng ORGANIZATION là allow_org bật
-- lại và người đó thấy cả 4 toà. KHÔNG tạo binding mới —
-- role_bindings_one_open_canonical_role_uidx chặn binding thứ hai cùng người+vai.
--
-- MỖI QUẢN LÝ MỘT SỔ QUỸ RIÊNG: policy income_expenses_select_fund_member là
-- PERMISSIVE và chỉ kiểm account_id, KHÔNG kiểm toà nhà. Cho hai người chung một
-- sổ là mỗi người thấy phiếu thu/chi của cả 4 toà, phá sạch giới hạn 2 toà.
--
-- Ba tài khoản còn lại (ketoan, sale, codong) GIỮ NGUYÊN phạm vi toàn công ty —
-- kế toán và sale cần nhìn toàn bộ, đó là chủ ý chứ không phải bỏ sót.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '600s';

-- Tắt trg_contract_link_orphan_deposits để phiếu cọc giữ chỗ không bị hút nhầm
-- sang hợp đồng của phòng khác.
SET LOCAL app.contract_create_v2 = 'on';

-- ---------------------------------------------------------------------------
-- CHỐT TRƯỚC: chụp số dòng của CÔNG TY THẬT trên mọi bảng có organization_id.
-- Đây là lưới an toàn của LUẬT 1.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _truoc(bang text, so bigint) ON COMMIT DROP;

DO $chup$
DECLARE r record; v bigint;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_class c
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id'
                         AND a.attnum>0 AND NOT a.attisdropped
     WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p')
       AND NOT c.relispartition
     ORDER BY c.relname
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id = %L',
                   r.relname, 'aaaa0000-0000-4000-8000-000000000001') INTO v;
    INSERT INTO _truoc VALUES (r.relname, v);
  END LOOP;
END
$chup$;

CREATE TEMP TABLE _ngoaile_truoc(so bigint) ON COMMIT DROP;
INSERT INTO _ngoaile_truoc
SELECT count(*) FROM public.authorization_migration_exceptions;

-- ---------------------------------------------------------------------------
-- SEED
-- ---------------------------------------------------------------------------
DO $seed$
DECLARE
  ORG   constant uuid := 'dddd0000-0000-4000-8000-000000000001';
  U_CHU constant uuid := 'de6f33f3-349f-4bec-bd3d-106192f6715e';  -- demo.chunha
  U_QL  constant uuid := 'fb0651bb-1cbd-4016-b0bf-3611dae49a63';  -- demo.quanly
  U_KT  constant uuid := 'f9296fe1-955a-406c-87d1-e8138ad014a6';  -- demo.kythuat
  v_a uuid; v_b uuid; v_c uuid; v_d uuid;
  v_toa uuid; v_phong uuid; v_kh uuid; v_hd uuid; v_pt uuid;
  v_sq_ql uuid; v_sq_kt uuid;
  v_loai_coc uuid;
  r record; i int; v_n int; v_ten text;
BEGIN
  -- === 1. TOÀ NHÀ ==========================================================
  -- organization_id VÀ user_id đều tường minh: buildings không có autofill, và
  -- auth.uid() = NULL dưới vai postgres nên trigger set_user_id không cứu được.
  SELECT id INTO v_a FROM public.buildings WHERE organization_id=ORG AND name='DEMO Toà A';
  SELECT id INTO v_b FROM public.buildings WHERE organization_id=ORG AND name='DEMO Toà B';
  IF v_a IS NULL OR v_b IS NULL THEN
    RAISE EXCEPTION 'Không thấy DEMO Toà A/B — file này nối tiếp 20260811040000. DỪNG.';
  END IF;

  INSERT INTO public.buildings (organization_id, user_id, name, province, district, ward, total_floors)
  VALUES (ORG, U_CHU, 'DEMO Toà C', 'Hồ Chí Minh', 'Quận Gò Vấp', 'Phường 9', 3)
  RETURNING id INTO v_c;
  INSERT INTO public.buildings (organization_id, user_id, name, province, district, ward, total_floors)
  VALUES (ORG, U_CHU, 'DEMO Toà D', 'Hồ Chí Minh', 'Quận Tân Bình', 'Phường 14', 2)
  RETURNING id INTO v_d;

  -- === 2. PHẠM VI THEO TOÀ =================================================
  -- Phải có TRƯỚC role_binding_scopes (FK ghép organization_id + scope_id).
  FOREACH v_toa IN ARRAY ARRAY[v_a, v_b, v_c, v_d] LOOP
    INSERT INTO public.authorization_scopes (organization_id, scope_type, building_id)
    VALUES (ORG, 'BUILDING', v_toa)
    ON CONFLICT DO NOTHING;
  END LOOP;

  -- === 3. TẦNG =============================================================
  -- status chữ THƯỜNG — CHECK floors_status_check khác hẳn enum in hoa của
  -- buildings/rooms. Viết 'ACTIVE' là vi phạm ngay.
  FOR r IN SELECT * FROM (VALUES (v_a,3),(v_b,2),(v_c,3),(v_d,2)) AS t(toa, so_tang) LOOP
    FOR i IN 1 .. r.so_tang LOOP
      INSERT INTO public.floors (organization_id, building_id, floor_number, user_id, status)
      VALUES (ORG, r.toa, i, U_CHU, 'active')
      ON CONFLICT (building_id, floor_number) DO NOTHING;
    END LOOP;
  END LOOP;

  -- === 4. PHÒNG ============================================================
  -- Bổ sung cho đủ ≥10 mỗi toà. KHÔNG truyền openclaw_availability_revision.
  -- Đặt status cuối cùng ngay lúc INSERT, TRỪ nhóm sẽ thành "đã cọc" (để
  -- AVAILABLE, dựng bằng phiếu cọc ở bước 8) — xem LUẬT 2.
  FOR r IN SELECT * FROM (VALUES
      (v_a,'A',12,3),(v_b,'B',10,2),(v_c,'C',12,3),(v_d,'D',10,2)
    ) AS t(toa, ma, so_phong, so_tang)
  LOOP
    FOR i IN 1 .. r.so_phong LOOP
      v_ten := r.ma || '-' || lpad(i::text, 2, '0');
      CONTINUE WHEN EXISTS (SELECT 1 FROM public.rooms
                             WHERE building_id=r.toa AND name=v_ten AND deleted_at IS NULL);
      INSERT INTO public.rooms
        (organization_id, building_id, name, rent_price, deposit_amount,
         floor, status, area, max_occupants)
      VALUES (ORG, r.toa, v_ten,
              CASE WHEN i % 4 = 0 THEN 5000000 WHEN i % 3 = 0 THEN 3000000 ELSE 4000000 END,
              CASE WHEN i % 4 = 0 THEN 5000000 WHEN i % 3 = 0 THEN 3000000 ELSE 4000000 END,
              least(((i - 1) / 4) + 1, r.so_tang),
              -- Phòng thứ 9 mỗi toà là BẢO TRÌ (đọc thẳng từ rooms.status).
              CASE WHEN i = 9 THEN 'MAINTENANCE'::room_status ELSE 'AVAILABLE'::room_status END,
              20, CASE WHEN i % 5 = 0 THEN 2 ELSE 1 END);
    END LOOP;
  END LOOP;

  -- === 5. SỔ QUỸ RIÊNG CHO TỪNG QUẢN LÝ ====================================
  -- Dùng chung một sổ sẽ phá giới hạn 2 toà — xem chú thích đầu file.
  INSERT INTO public.accounts (organization_id, user_id, name, code)
  VALUES (ORG, U_QL, 'DEMO Quỹ Toà A+B', 'DEMO-QAB') RETURNING id INTO v_sq_ql;
  INSERT INTO public.accounts (organization_id, user_id, name, code)
  VALUES (ORG, U_KT, 'DEMO Quỹ Toà C+D', 'DEMO-QCD') RETURNING id INTO v_sq_kt;

  -- === 6. KHÁCH HÀNG =======================================================
  -- user_id phải là tài khoản demo: RLS đọc theo current_visible_owner_ids()
  -- (thành viên ACTIVE của org). Dùng UID người thật thì tài khoản demo thấy 0.
  -- phone khớp ^[0-9]{10,11}$.
  FOR i IN 1 .. 24 LOOP
    INSERT INTO public.customers (organization_id, user_id, full_name, phone)
    VALUES (ORG, U_CHU,
            'DEMO Khách ' || lpad(i::text, 2, '0'),
            '09' || lpad((10000000 + i)::text, 8, '0'));
  END LOOP;

  -- === 7. HỢP ĐỒNG — TỪNG DÒNG MỘT (contract_number sinh theo COUNT+1) =====
  -- Mỗi toà: 4 HĐ dài (đang thuê) + 1 HĐ sắp hết hạn (còn 15 ngày).
  -- AFTER INSERT tự đẩy rooms.status='OCCUPIED' — không set tay.
  FOR r IN
    SELECT rm.id AS room_id, rm.building_id, rm.rent_price, rm.deposit_amount,
           row_number() OVER (PARTITION BY rm.building_id ORDER BY rm.name) AS thu_tu
      FROM public.rooms rm
     WHERE rm.organization_id = ORG AND rm.deleted_at IS NULL
       AND rm.status = 'AVAILABLE'
     ORDER BY rm.building_id, rm.name
  LOOP
    CONTINUE WHEN r.thu_tu > 5;   -- 4 dài + 1 sắp hết hạn mỗi toà

    SELECT id INTO v_kh FROM public.customers
     WHERE organization_id=ORG
       AND NOT EXISTS (SELECT 1 FROM public.contract_customers cc WHERE cc.customer_id = customers.id)
     ORDER BY full_name LIMIT 1;
    CONTINUE WHEN v_kh IS NULL;

    -- signed_date là NOT NULL không default (public_code thì trigger
    -- trg_set_contract_public_code lo, không truyền tay).
    INSERT INTO public.contracts
      (organization_id, user_id, room_id, signed_date, start_date, end_date, status,
       rent_price, total_deposit)
    VALUES (ORG, U_CHU, r.room_id,
            current_date - 90,
            current_date - 90,
            CASE WHEN r.thu_tu = 5 THEN current_date + 15 ELSE current_date + 300 END,
            'ACTIVE', r.rent_price, r.deposit_amount)
    RETURNING id INTO v_hd;

    INSERT INTO public.contract_customers
      (organization_id, contract_id, customer_id, is_representative)
    VALUES (ORG, v_hd, v_kh, true);

    -- Xe: gắn building_id + room_id, nếu không nhân viên demo không thấy.
    IF r.thu_tu <= 3 THEN
      INSERT INTO public.vehicles
        (organization_id, user_id, customer_id, building_id, room_id,
         vehicle_type, license_plate, vehicle_name, owner_name, color)
      VALUES (ORG, U_CHU, v_kh, r.building_id, r.room_id, 'MOTORBIKE',
              '59D1 - ' || lpad((100 + (r.thu_tu * 7))::text, 3, '0') || '.'
                        || lpad((10 + r.thu_tu)::text, 2, '0'),
              (ARRAY['Wave','Vision','Air Blade','Sirius','Exciter'])[1 + (r.thu_tu % 5)],
              'DEMO Khách', (ARRAY['đen','xanh','đỏ','xám'])[1 + (r.thu_tu % 4)]);
    END IF;
  END LOOP;

  -- === 8. PHIẾU CỌC → dựng phòng "ĐÃ CỌC" ==================================
  -- Đây là cách DUY NHẤT an toàn: phòng vẫn đang AVAILABLE, chèn phiếu rồi chèn
  -- hạng mục cọc; recompute_room_reservation sẽ đẩy AVAILABLE→RESERVED, chiều
  -- đó không khớp WHEN của trigger OpenClaw.
  SELECT id INTO v_loai_coc FROM public.income_expense_types
   WHERE organization_id=ORG AND is_deposit = true ORDER BY name LIMIT 1;

  IF v_loai_coc IS NOT NULL THEN
    FOR r IN
      SELECT rm.id AS room_id, rm.building_id, rm.rent_price,
             row_number() OVER (PARTITION BY rm.building_id ORDER BY rm.name) AS thu_tu
        FROM public.rooms rm
       WHERE rm.organization_id=ORG AND rm.deleted_at IS NULL
         AND rm.status='AVAILABLE'
         AND NOT EXISTS (SELECT 1 FROM public.contracts c
                          WHERE c.room_id=rm.id AND c.status IN ('ACTIVE','EXTENDED'))
       ORDER BY rm.building_id, rm.name
    LOOP
      CONTINUE WHEN r.thu_tu > 1;   -- 1 phòng đã cọc mỗi toà

      -- Cột bắt buộc là `name` và `voucher_date` (KHÔNG phải description /
      -- transaction_date). total_amount để 0 — trigger sẽ đẩy lên theo hạng mục,
      -- đó cũng là đường an toàn nhất của cầu hạch toán.
      INSERT INTO public.income_expenses
        (organization_id, user_id, building_id, room_id, account_id, type,
         name, voucher_date, total_amount, approval_status, approved_by)
      VALUES (ORG, U_CHU, r.building_id, r.room_id,
              CASE WHEN r.building_id IN (v_a, v_b) THEN v_sq_ql ELSE v_sq_kt END,
              'INCOME', 'DEMO cọc giữ chỗ', current_date - 3, 0, 'APPROVED', U_CHU)
      RETURNING id INTO v_pt;

      -- accounting_class là NOT NULL không default; cọc giữ chỗ dùng 'DEPOSIT'.
      INSERT INTO public.income_expense_items
        (organization_id, income_expense_id, income_expense_type_id, amount, accounting_class)
      VALUES (ORG, v_pt, v_loai_coc, r.rent_price, 'DEPOSIT');
    END LOOP;
  END IF;

  -- === 9. SIẾT PHẠM VI HAI QUẢN LÝ =========================================
  -- XOÁ dòng ORGANIZATION rồi CHÈN đúng 2 dòng BUILDING. Sót một dòng
  -- ORGANIZATION là allow_org bật lại và người đó thấy cả 4 toà.
  FOR r IN SELECT * FROM (VALUES (U_QL, v_a, v_b), (U_KT, v_c, v_d))
                      AS t(nguoi, toa1, toa2)
  LOOP
    DELETE FROM public.role_binding_scopes rbs
     USING public.role_bindings rb, public.organization_memberships m,
           public.authorization_scopes s
     WHERE rbs.role_binding_id = rb.id
       AND rb.membership_id = m.id
       AND m.user_id = r.nguoi AND m.organization_id = ORG
       AND s.id = rbs.scope_id AND s.scope_type = 'ORGANIZATION';

    INSERT INTO public.role_binding_scopes (organization_id, role_binding_id, scope_id)
    SELECT ORG, rb.id, s.id
      FROM public.role_bindings rb
      JOIN public.organization_memberships m ON m.id = rb.membership_id
      JOIN public.authorization_scopes s
        ON s.organization_id = ORG AND s.scope_type = 'BUILDING'
       AND s.building_id IN (r.toa1, r.toa2)
     WHERE m.user_id = r.nguoi AND m.organization_id = ORG
     ON CONFLICT DO NOTHING;
  END LOOP;

  RAISE NOTICE 'Seed xong.';
END
$seed$;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  ORG constant uuid := 'dddd0000-0000-4000-8000-000000000001';
  r record; v bigint; v_lech text := ''; v_n bigint;
BEGIN
  -- (1) LUẬT 1 — công ty thật KHÔNG được đổi một dòng nào, trên mọi bảng.
  FOR r IN SELECT bang, so FROM _truoc LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id = %L',
                   r.bang, 'aaaa0000-0000-4000-8000-000000000001') INTO v;
    IF v <> r.so THEN
      v_lech := v_lech || format('%s(%s→%s) ', r.bang, r.so, v);
    END IF;
  END LOOP;
  IF v_lech <> '' THEN
    RAISE EXCEPTION 'DỮ LIỆU DEMO ĐÃ CHẠM VÀO CÔNG TY THẬT: %', v_lech;
  END IF;

  -- (2) Không có dòng nào rơi vào nhánh PROD_DEFAULT_FALLBACK.
  SELECT count(*) INTO v FROM public.authorization_migration_exceptions;
  IF v <> (SELECT so FROM _ngoaile_truoc) THEN
    RAISE EXCEPTION 'authorization_migration_exceptions tăng % dòng — có dòng bị gán về org PROD.',
      v - (SELECT so FROM _ngoaile_truoc);
  END IF;

  -- (3) Quy mô ma trận.
  SELECT count(*) INTO v FROM public.buildings WHERE organization_id=ORG AND deleted_at IS NULL;
  IF v <> 4 THEN RAISE EXCEPTION 'Demo có % toà, cần 4.', v; END IF;

  FOR r IN SELECT b.name, count(rm.id) AS so
             FROM public.buildings b
             LEFT JOIN public.rooms rm ON rm.building_id=b.id AND rm.deleted_at IS NULL
            WHERE b.organization_id=ORG AND b.deleted_at IS NULL
            GROUP BY b.name
  LOOP
    IF r.so < 10 THEN RAISE EXCEPTION 'Toà % chỉ có % phòng, cần ≥10.', r.name, r.so; END IF;
  END LOOP;

  -- (4) Phủ đủ 5 nhóm hiển thị.
  SELECT count(*) INTO v FROM public.rooms WHERE organization_id=ORG AND status='MAINTENANCE';
  IF v < 4 THEN RAISE EXCEPTION 'Chỉ % phòng bảo trì, cần ≥4 (mỗi toà 1).', v; END IF;

  SELECT count(*) INTO v FROM public.rooms WHERE organization_id=ORG AND status='RESERVED';
  IF v < 4 THEN RAISE EXCEPTION 'Chỉ % phòng đã cọc, cần ≥4 — phiếu cọc chưa đẩy được RESERVED.', v; END IF;

  SELECT count(*) INTO v FROM public.contracts
   WHERE organization_id=ORG AND status='ACTIVE' AND end_date > current_date + 30;
  IF v < 12 THEN RAISE EXCEPTION 'Chỉ % hợp đồng dài hạn, cần ≥12.', v; END IF;

  SELECT count(*) INTO v FROM public.contracts
   WHERE organization_id=ORG AND status='ACTIVE'
     AND end_date BETWEEN current_date + 1 AND current_date + 30;
  IF v < 4 THEN RAISE EXCEPTION 'Chỉ % hợp đồng sắp hết hạn, cần ≥4 (mỗi toà 1).', v; END IF;

  SELECT count(*) INTO v FROM public.rooms rm
   WHERE rm.organization_id=ORG AND rm.status='AVAILABLE'
     AND NOT EXISTS (SELECT 1 FROM public.contracts c
                      WHERE c.room_id=rm.id AND c.status IN ('ACTIVE','EXTENDED'));
  IF v < 4 THEN RAISE EXCEPTION 'Chỉ % phòng trống, cần ≥4.', v; END IF;

  -- (5) Khách và xe.
  SELECT count(*) INTO v FROM public.customers WHERE organization_id=ORG;
  IF v < 20 THEN RAISE EXCEPTION 'Chỉ % khách hàng.', v; END IF;
  SELECT count(*) INTO v FROM public.vehicles
   WHERE organization_id=ORG AND building_id IS NOT NULL AND room_id IS NOT NULL;
  IF v < 8 THEN RAISE EXCEPTION 'Chỉ % xe có gắn toà+phòng.', v; END IF;

  -- (6) PHÂN CÔNG — mỗi quản lý ĐÚNG 2 toà, 0 dòng ORGANIZATION còn sót.
  FOR r IN SELECT * FROM (VALUES
      ('fb0651bb-1cbd-4016-b0bf-3611dae49a63'::uuid, 'demo.quanly'),
      ('f9296fe1-955a-406c-87d1-e8138ad014a6'::uuid, 'demo.kythuat')) AS t(nguoi, ten)
  LOOP
    SELECT count(*) INTO v
      FROM public.role_binding_scopes rbs
      JOIN public.role_bindings rb ON rb.id = rbs.role_binding_id
      JOIN public.organization_memberships m ON m.id = rb.membership_id
      JOIN public.authorization_scopes s ON s.id = rbs.scope_id
     WHERE m.user_id = r.nguoi AND m.organization_id = ORG AND s.scope_type='BUILDING';
    IF v <> 2 THEN RAISE EXCEPTION '% có % phạm vi toà, cần đúng 2.', r.ten, v; END IF;

    SELECT count(*) INTO v
      FROM public.role_binding_scopes rbs
      JOIN public.role_bindings rb ON rb.id = rbs.role_binding_id
      JOIN public.organization_memberships m ON m.id = rb.membership_id
      JOIN public.authorization_scopes s ON s.id = rbs.scope_id
     WHERE m.user_id = r.nguoi AND m.organization_id = ORG AND s.scope_type='ORGANIZATION';
    IF v <> 0 THEN RAISE EXCEPTION '% còn % phạm vi TOÀN CÔNG TY — sẽ thấy cả 4 toà.', r.ten, v; END IF;
  END LOOP;

  -- (7) Soi bằng chính vai quản lý: đúng 2 toà, và 0 dòng công ty khác.
  CREATE TEMP TABLE _soi(k text, gt bigint) ON COMMIT DROP;
  GRANT INSERT, SELECT ON _soi TO PUBLIC;

  PERFORM set_config('request.jwt.claims',
    '{"sub":"fb0651bb-1cbd-4016-b0bf-3611dae49a63","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  INSERT INTO _soi
  SELECT 'ql_toa', (SELECT count(*) FROM (SELECT public.accessible_building_ids()) s)
  UNION ALL SELECT 'ql_ngoai', (SELECT count(*) FROM public.buildings WHERE organization_id <> ORG);
  RESET ROLE;

  PERFORM set_config('request.jwt.claims',
    '{"sub":"f9296fe1-955a-406c-87d1-e8138ad014a6","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  INSERT INTO _soi
  SELECT 'kt_toa', (SELECT count(*) FROM (SELECT public.accessible_building_ids()) s)
  UNION ALL SELECT 'kt_ngoai', (SELECT count(*) FROM public.buildings WHERE organization_id <> ORG);
  RESET ROLE;

  SELECT gt INTO v_n FROM _soi WHERE k='ql_toa';
  IF v_n <> 2 THEN RAISE EXCEPTION 'demo.quanly truy cập được % toà, cần 2.', v_n; END IF;
  SELECT gt INTO v_n FROM _soi WHERE k='kt_toa';
  IF v_n <> 2 THEN RAISE EXCEPTION 'demo.kythuat truy cập được % toà, cần 2.', v_n; END IF;
  SELECT gt INTO v_n FROM _soi WHERE k='ql_ngoai';
  IF v_n <> 0 THEN RAISE EXCEPTION 'demo.quanly thấy % toà công ty KHÁC.', v_n; END IF;
  SELECT gt INTO v_n FROM _soi WHERE k='kt_ngoai';
  IF v_n <> 0 THEN RAISE EXCEPTION 'demo.kythuat thấy % toà công ty KHÁC.', v_n; END IF;

  RAISE NOTICE 'Nghiệm thu đạt: 4 toà, mỗi quản lý đúng 2 toà, công ty thật không đổi một dòng nào.';
END
$nghiem_thu$;

COMMIT;

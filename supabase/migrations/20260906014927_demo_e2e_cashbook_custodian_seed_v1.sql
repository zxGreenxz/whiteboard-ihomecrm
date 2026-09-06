-- =============================================================================
-- demo_e2e_cashbook_custodian_seed_v1 — DEMO thiếu người GIỮ SỔ nên không phiếu
-- nào trên DEMO duyệt được, kể cả bằng tay
-- Ngày 06/09/2026 · fixture cho ca 6 ma trận L5
-- =============================================================================
-- ĐO ĐƯỢC
--   Ca 6 dựng một phiếu thu chi rồi cho Copilot duyệt. Cả hai đường duyệt đòi
--   phiếu phải CÓ SỔ QUỸ, và gán sổ quỹ (`update_income_expense_quick`, đúng RPC
--   mà màn "Sửa phiếu" dùng) đi qua
--   `app_private.assert_cashbook_access_v2(org, cashbook, 'CUSTODIAN', membership)`.
--
--   Trạng thái DEMO ngày 06/09/2026: 72 binding CUSTODIAN, TẤT CẢ trỏ vào sổ
--   `ZFleet Sổ …` do một suite E2E khác tạo rồi XOÁ MỀM. Không một sổ quỹ SỐNG
--   nào của DEMO có người giữ. Hệ quả: `demo.chunha` không gán được sổ quỹ cho
--   phiếu nào, nên không phiếu nào trên DEMO duyệt được — bằng Copilot hay bằng
--   tay đều vậy. Đây đúng là khoảng trống đã ghi trong memory
--   `demo-org-mat-fixture-giu-so` ("0 binding CUSTODIAN nên E2E posting dialog
--   chết ở bước seed"), nay chặn thêm cả đường duyệt.
--
-- VÌ SAO SEED LÀ ĐÚNG, KHÔNG PHẢI NỚI HÀNG RÀO
--   `assert_cashbook_access_v2` là hàng rào THẬT của miền tiền: ai giữ sổ thì mới
--   được đưa tiền vào sổ đó. Không sửa nó một dòng nào. Thứ thiếu là DỮ LIỆU
--   fixture của org DEMO — cùng loại việc mà 20260903220254 đã làm cho tài khoản
--   E2E. Một dòng, đúng một sổ quỹ, đúng một người, đúng org DEMO.
--
-- PHẠM VI HẸP VÀ TỰ TẮT
--   * CHỈ org DEMO (`dddd0000-…-0001`) — hằng số cứng trong file, không tham số.
--   * CHỈ sổ "DEMO Quỹ tiền mặt" (sổ tiền mặt chung, không phải sổ cấn trừ nội bộ)
--     và CHỈ `demo.chunha` (người tạo phiếu trong ca 6).
--   * `possession_kind = 'CUSTODIAN'`, `valid_to = NULL` (mở), `reason` nói rõ là
--     fixture E2E để người đọc sổ sau này không tưởng là quyền thật của nghiệp vụ.
--   * Thiếu org / thiếu user / thiếu sổ ⇒ RAISE NOTICE rồi RETURN. Restore Drill
--     replay trên DB rỗng KHÔNG có ba thứ đó, và một fixture DEMO không bao giờ
--     được làm đổ một lượt replay.
--   * Bảng KHÔNG có unique constraint trên (org, sổ, membership, kind) nên phép
--     idempotent là `IF EXISTS … RETURN`, không phải `ON CONFLICT`.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';

DO $seed_giu_so$
DECLARE
  c_org  constant uuid := 'dddd0000-0000-4000-8000-000000000001';
  c_so   constant text := 'DEMO Quỹ tiền mặt';
  c_mail constant text := 'demo.chunha@username.ihomecrm.local';
  v_so   uuid;
  v_mem  uuid;
BEGIN
  SELECT a.id INTO v_so
    FROM public.accounts a
   WHERE a.organization_id = c_org
     AND a.name = c_so
     AND a.deleted_at IS NULL
   ORDER BY a.id
   LIMIT 1;

  SELECT m.id INTO v_mem
    FROM public.organization_memberships m
    JOIN auth.users u ON u.id = m.user_id
   WHERE m.organization_id = c_org
     AND m.status = 'ACTIVE'
     AND u.email = c_mail
   ORDER BY m.id
   LIMIT 1;

  IF v_so IS NULL OR v_mem IS NULL THEN
    RAISE NOTICE 'seed giu so: bo qua (so quy "%" hoac thanh vien % khong co tren DB nay)', c_so, c_mail;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.cashbook_possession_bindings b
     WHERE b.organization_id = c_org
       AND b.cashbook_id = v_so
       AND b.membership_id = v_mem
       AND b.possession_kind = 'CUSTODIAN'
       AND b.valid_from <= now()
       AND (b.valid_to IS NULL OR b.valid_to > now())
  ) THEN
    RAISE NOTICE 'seed giu so: da co binding CUSTODIAN mo — khong lam gi';
    RETURN;
  END IF;

  INSERT INTO public.cashbook_possession_bindings
    (organization_id, cashbook_id, membership_id, possession_kind, reason)
  VALUES
    (c_org, v_so, v_mem, 'CUSTODIAN',
     'Fixture E2E org DEMO (20260906014927): chunha giu so tien mat de ca 6 ma tran L5 gan duoc so quy cho phieu. KHONG phai quyen nghiep vu that.');

  RAISE NOTICE 'seed giu so: da cap CUSTODIAN "%" cho %', c_so, c_mail;
END
$seed_giu_so$;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — hai nhánh; trên DB rỗng thì "không có fixture" là kết quả ĐÚNG
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  c_org constant uuid := 'dddd0000-0000-4000-8000-000000000001';
  v_so  uuid;
  v_mem uuid;
  v_dem int;
BEGIN
  SELECT a.id INTO v_so FROM public.accounts a
   WHERE a.organization_id = c_org AND a.name = 'DEMO Quỹ tiền mặt' AND a.deleted_at IS NULL
   ORDER BY a.id LIMIT 1;
  SELECT m.id INTO v_mem FROM public.organization_memberships m
    JOIN auth.users u ON u.id = m.user_id
   WHERE m.organization_id = c_org AND m.status = 'ACTIVE'
     AND u.email = 'demo.chunha@username.ihomecrm.local'
   ORDER BY m.id LIMIT 1;

  IF v_so IS NULL OR v_mem IS NULL THEN
    RAISE NOTICE 'nghiem_thu: DB nay khong co fixture DEMO — khong ket luan gi, dung nhu thiet ke';
    RETURN;
  END IF;

  SELECT count(*) INTO v_dem
    FROM public.cashbook_possession_bindings b
   WHERE b.organization_id = c_org
     AND b.cashbook_id = v_so
     AND b.membership_id = v_mem
     AND b.possession_kind = 'CUSTODIAN'
     AND (b.valid_to IS NULL OR b.valid_to > now());
  IF v_dem < 1 THEN
    RAISE EXCEPTION 'nghiem_thu: chua co binding CUSTODIAN mo cho chunha tren so tien mat DEMO';
  END IF;
  -- Chạy lại lượt hai KHÔNG được đẻ dòng thứ hai (bảng không có unique key).
  IF v_dem > 1 THEN
    RAISE EXCEPTION 'nghiem_thu: co % binding trung — phep idempotent bi hong', v_dem;
  END IF;

  -- KHÔNG nới ra sổ khác: chỉ đúng MỘT sổ quỹ sống được cấp trong đợt này.
  SELECT count(DISTINCT b.cashbook_id) INTO v_dem
    FROM public.cashbook_possession_bindings b
    JOIN public.accounts a ON a.id = b.cashbook_id
   WHERE b.organization_id = c_org
     AND b.membership_id = v_mem
     AND b.possession_kind = 'CUSTODIAN'
     AND a.deleted_at IS NULL
     AND (b.valid_to IS NULL OR b.valid_to > now());
  IF v_dem <> 1 THEN
    RAISE EXCEPTION 'nghiem_thu: chunha dang giu % so quy SONG (mong doi dung 1)', v_dem;
  END IF;
END
$nghiem_thu$;

COMMIT;

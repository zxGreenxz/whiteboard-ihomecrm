-- =============================================================================
-- bat_bo_may_chi_ap_dung_sua_cong_an — BẬT bộ máy chi theo cam kết (27/09/2026)
-- =============================================================================
-- LỆNH CHỦ (27/09/2026, trực tiếp): "Phí công an hạng mục là tiền công an không phải làm
-- tạm trú sửa lại, bật hết lên luôn đi đừng test 14 ngày hay 7 ngày gì nữa".
--
-- SỐ ĐO TRƯỚC KHI BẬT (production, chỉ đọc, thay cho 14 ngày bóng):
--   · fee_type_matches('cong_an') nhận MỌI loại nhóm 'CA' ⇒ "Làm tạm trú" (7.000–14.000đ/
--     người) bị coi là tiền công an ⇒ ô công an 405PVB học số 7.000đ. Tiền công an thật của
--     405PVB: PC2609132 500.000đ (tháng 8), PC2606014 1.000.000đ (tháng 6–7) = 500.000đ/tháng.
--   · 13 toà có phiếu ĐỊNH KỲ quản lý tự duyệt (≈ 28,6tr/tháng) + 403PVB vệ sinh (1,5tr) nhưng
--     chưa khai ở Phí cố định ⇒ chưa có cam kết ⇒ bật lên là mỗi tháng các phiếu đó về CHỜ.
--   · 5 cặp điện/nước có hoá đơn 120 ngày mà chưa có trần: 111PVC, 158PVC, 15KV, 44TL (nước),
--     Kho Văn Phòng Chung (điện).
--   · G6: 69 phiếu điện nước 90 ngày, 0 phiếu do người không giữ sổ để chi ⇒ bật không ảnh hưởng.
--
-- LÀM GÌ
--   1. fee_type_matches: công an KHÔNG gồm "tạm trú" (mirror TS feeCategories.ts +
--      fixedExpenseCategories.ts sửa cùng commit, test đối chiếu chéo giữ ba bề mặt khớp).
--   2. 405PVB công an: cam kết 10/2026–09/2027 và số gợi ý 7.000đ → 500.000đ/tháng (tháng
--      chưa có khoản tiêu — câu 11 không bị phạm).
--   3. Cam kết cho cặp (toà, hạng mục CAM_KET) có phiếu định kỳ HÀNG THÁNG tự duyệt đang chạy
--      mà CHƯA có cam kết: số = đúng tiền định kỳ đã được duyệt (một lệnh chi đứng đã được người
--      có quyền duyệt cho tự duyệt), 10/2026–09/2027. Bỏ qua cặp chủ đánh dấu "không áp dụng".
--      Cặp đã có cam kết GIỮ NGUYÊN số chủ khai (vd rác 15KV 120k vs định kỳ 300k ⇒ phiếu định
--      kỳ về CHỜ — đúng loại lệch chủ muốn thấy).
--   4. Trần còn thiếu theo câu 03 (chủ đã duyệt công thức): cao nhất 3 tháng gần nhất + 20%,
--      làm tròn lên nghìn, hiệu lực từ 09/2026 — chỉ cặp có hoá đơn mà chưa có trần.
--   5. Công tắc: 7 hạng mục CAM_KET cho MỌI toà từ 10/2026 (tháng đầu có cam kết); điện, nước
--      cho từng toà ĐÃ có trần từ 09/2026. Chỉ org THẬT; org DEMO (thử E2E) không bật.
--   6. Cờ spend.engine.v1 + spend.cashbook_chi.v1 → ON (đủ bốn trường truy vết; thiếu thì
--      evaluate_feature_route trả FROZEN).
--
-- ĐƯỜNG LÙI (không cần migration mới để dừng khẩn):
--   UPDATE app_private.server_feature_flags SET mode='SHADOW' WHERE feature_key IN
--   ('spend.engine.v1','spend.cashbook_chi.v1');  ⇒ mọi cửa chi đi luật cũ ngay; hoặc tắt từng
--   công tắc ở màn Cam kết chi. Cam kết/trần thêm ở đây đổi lại được qua màn/RPC của chủ.
--
-- Chạy được hai lượt; trên DB rỗng của Restore Drill phần dữ liệu tự bỏ qua (không có org/toà).
-- =============================================================================

BEGIN;

-- 0. Nền + ghim md5 fee_type_matches (lượt hai: thân đã mang dấu "tam tru" ⇒ cho qua).
DO $truoc$
DECLARE
  v_def text;
BEGIN
  -- Chỉ đòi đúng thứ file này dùng (bảng/hàm của 20260926150000). KHÔNG đòi hàm lõi cổng của
  -- 160000: trên bản dựng lại của Restore Drill, 160000 dừng đúng kỳ vọng (cascade) — đo 27/09.
  IF to_regclass('app_private.spend_policy_switches') IS NULL
     OR to_regclass('app_private.spend_commitments') IS NULL
     OR to_regprocedure('app_private.spend_ledger_sync_v1(uuid)') IS NULL
     OR to_regprocedure('app_private.spend_route_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu bộ máy chi — chạy 20260926150000 trước' USING ERRCODE = '55000';
  END IF;
  v_def := pg_get_functiondef(to_regprocedure('public.fee_type_matches(text,text,text)'));
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'Thiếu public.fee_type_matches' USING ERRCODE = '55000';
  END IF;
  IF md5(v_def) <> ALL (ARRAY['bd502397a42a955132935a3cb7d2f526'])
     AND position('tam tru' in v_def) = 0 THEN
    RAISE EXCEPTION 'fee_type_matches đã đổi so với bản đã rà — chụp lại pg_get_functiondef rồi rà lại'
      USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- 1. Bộ khớp tên: công an là TIỀN CÔNG AN, không phải làm tạm trú.
CREATE OR REPLACE FUNCTION public.fee_type_matches(p_category_key text, p_cat text, p_name text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT CASE p_category_key
    WHEN 'internet'  THEN (public.nrm_vn(p_cat) = 'internet' OR public.nrm_vn(p_name) LIKE '%internet%')
    WHEN 'rac'       THEN (public.nrm_vn(p_name) LIKE '%rac%')
    -- 27/09/2026 (lệnh chủ): hạng mục công an là TIỀN CÔNG AN hằng tháng, KHÔNG phải phí làm
    -- tạm trú (tính theo đầu người). "Làm tạm trú" mang category 'CA' nên bản cũ nuốt luôn ⇒
    -- ô công an 405PVB học số 7.000đ. Mirror: src/lib/feeCategories.ts + fixedExpenseCategories.ts.
    WHEN 'cong_an'   THEN ((public.nrm_vn(p_cat) = 'ca' OR public.nrm_vn(p_name) LIKE '%cong an%')
                             AND public.nrm_vn(p_name) NOT LIKE '%tam tru%')
    WHEN 've_sinh'   THEN ((public.nrm_vn(p_cat) = 've sinh' OR public.nrm_vn(p_name) LIKE '%ve sinh toa nha%')
                             AND public.nrm_vn(p_name) NOT LIKE '%rac%')
    WHEN 'thang_may' THEN (public.nrm_vn(p_name) LIKE '%thang may%')
    WHEN 'dien'      THEN (public.nrm_vn(p_cat) = 'dien' OR public.nrm_vn(p_name) LIKE '%tien dien%')
    WHEN 'nuoc'      THEN (public.nrm_vn(p_cat) = 'nuoc' OR public.nrm_vn(p_name) LIKE '%tien nuoc%')
    WHEN 'tien_nha'  THEN (public.nrm_vn(p_cat) = 'tien nha' OR public.nrm_vn(p_name) LIKE '%tien nha%')
    -- A1: phí quản lý KHÔNG phải tiền lương. Loại 'Lương quản lý',
    -- 'Ứng lương quản lý' và mọi type có category CHỨA 'luong' ('Lương',
    -- 'Lương thưởng', 'Lương nhân viên'…). Vế category phải là NOT LIKE — không
    -- phải `<> 'luong'` — để khớp ĐÚNG bản mirror TypeScript
    -- (src/lib/feeCategories.ts: `!c.includes('luong')`); xem ghi chú A1 đầu file.
    WHEN 'quan_ly'   THEN (public.nrm_vn(p_name) LIKE '%quan ly%'
                             AND public.nrm_vn(p_name) NOT LIKE '%luong%'
                             AND public.nrm_vn(p_cat)  NOT LIKE '%luong%')
    ELSE false
  END
$function$;

-- 2. 405PVB công an: 7.000đ (phí tạm trú lọt vào) → 500.000đ/tháng.
DO $cong_an_405$
DECLARE
  v_toa   constant uuid := 'e823da47-9ec3-4c31-aa63-5cabc58b80b9';
  v_org   uuid;
  r       record;
  v_n     int := 0;
BEGIN
  SELECT b.organization_id INTO v_org FROM public.buildings b WHERE b.id = v_toa AND b.deleted_at IS NULL;
  IF v_org IS NULL THEN
    RETURN;   -- DB diễn tập / không có toà
  END IF;
  FOR r IN
    SELECT c.* FROM app_private.spend_commitments c
     WHERE c.building_id = v_toa AND c.fee_category = 'cong_an' AND c.status = 'PUBLISHED'
       AND c.amount = 7000
       AND NOT EXISTS (SELECT 1 FROM app_private.spend_commitment_draws d
                        WHERE d.commitment_id = c.id AND d.kind IN ('HOLD', 'DRAW'))
     ORDER BY c.period_month
  LOOP
    PERFORM app_private.spend_lock_keys_v1(ARRAY[
      v_org || ':' || v_toa || ':cong_an:' || to_char(r.period_month, 'YYYY-MM')]);
    UPDATE app_private.spend_commitments
       SET status = 'RETIRED', retired_at = clock_timestamp()
     WHERE id = r.id;
    INSERT INTO app_private.spend_commitments
      (organization_id, building_id, fee_category, period_month, amount, status, source, note)
    VALUES
      (v_org, v_toa, 'cong_an', r.period_month, 500000, 'PUBLISHED', 'MANUAL',
       'Sửa theo lệnh chủ 27/09/2026: tiền công an 500.000đ/tháng; 7.000đ cũ là phí làm tạm trú lọt vào');
    v_n := v_n + 1;
  END LOOP;
  UPDATE public.building_fee_accounts
     SET default_amount = 500000, updated_at = now()
   WHERE building_id = v_toa AND fee_category = 'cong_an' AND deleted_at IS NULL
     AND default_amount = 7000;
  RAISE NOTICE '405PVB công an: % tháng cam kết 7.000đ → 500.000đ', v_n;
END
$cong_an_405$;

-- 3. Cam kết từ phiếu định kỳ hàng tháng tự duyệt đang chạy, cho cặp CHƯA có cam kết.
WITH dinh_ky AS (
  SELECT e.organization_id, e.building_id, t.fee_category,
         sum(i.quantity * i.unit_price) AS moi_thang
    FROM public.income_expenses e
    JOIN public.income_expense_items i ON i.income_expense_id = e.id
    JOIN public.income_expense_types t
      ON t.id = i.income_expense_type_id AND t.organization_id = e.organization_id
   WHERE e.type = 'EXPENSE'
     AND e.repeat_cycle = 'MONTH'
     AND e.repeat_parent_id IS NULL
     AND e.deleted_at IS NULL
     AND e.approval_status = 'APPROVED'
     AND e.repeat_auto_approve
     AND (e.repeat_infinity OR e.repeat_count > 0)
     AND e.building_id IS NOT NULL
     AND t.fee_category IS NOT NULL
     AND t.spend_mode = 'CAM_KET'
   GROUP BY 1, 2, 3
), thieu AS (
  SELECT d.* FROM dinh_ky d
   WHERE d.moi_thang > 0
     AND NOT EXISTS (SELECT 1 FROM app_private.spend_commitments c
                      WHERE c.building_id = d.building_id AND c.fee_category = d.fee_category
                        AND c.status = 'PUBLISHED')
     AND NOT EXISTS (SELECT 1 FROM public.building_fee_accounts f
                      WHERE f.building_id = d.building_id AND f.fee_category = d.fee_category
                        AND f.deleted_at IS NULL AND COALESCE(f.not_applicable, false))
)
INSERT INTO app_private.spend_commitments
  (organization_id, building_id, fee_category, period_month, amount, status, source, note)
SELECT t.organization_id, t.building_id, t.fee_category, thang::date, t.moi_thang,
       'PUBLISHED', 'MIGRATED',
       'Từ phiếu định kỳ hàng tháng đã được duyệt cho tự duyệt (chưa khai ở Phí cố định) — bật bộ máy 27/09/2026'
  FROM thieu t
 CROSS JOIN generate_series(DATE '2026-10-01', DATE '2027-09-01', INTERVAL '1 month') AS thang
ON CONFLICT DO NOTHING;

-- 4. Trần còn thiếu theo câu 03: cao nhất 3 tháng gần nhất + 20%, làm tròn lên nghìn.
WITH thang AS (
  SELECT e.organization_id, e.building_id, u.utility_type,
         date_trunc('month', COALESCE(i.start_date, e.voucher_date))::date AS ky,
         sum(COALESCE(i.amount, i.quantity * i.unit_price)) AS tien
    FROM public.income_expenses e
    JOIN public.income_expense_items i ON i.income_expense_id = e.id
    JOIN public.building_utility_accounts u ON u.id = e.utility_account_id
   WHERE e.system_source = 'utility.bill'
     AND e.deleted_at IS NULL
     AND e.approval_status <> 'CANCELLED'
     AND e.voucher_date > DATE '2026-09-27' - 120
   GROUP BY 1, 2, 3, 4
), ba_thang AS (
  SELECT t.*, row_number() OVER (PARTITION BY t.organization_id, t.building_id, t.utility_type
                                 ORDER BY t.ky DESC) AS thu_tu
    FROM thang t
), de_xuat AS (
  SELECT b.organization_id, b.building_id, b.utility_type,
         ceil(max(b.tien) * 1.2 / 1000) * 1000 AS tran, max(b.tien) AS cao_nhat
    FROM ba_thang b
   WHERE b.thu_tu <= 3
   GROUP BY 1, 2, 3
)
INSERT INTO app_private.utility_ceiling_versions
  (organization_id, building_id, utility_type, effective_from_month, ceiling_amount, status, note)
SELECT d.organization_id, d.building_id, d.utility_type, DATE '2026-09-01', d.tran, 'PUBLISHED',
       'Câu 03 (chủ duyệt công thức 26/09): cao nhất 3 tháng gần nhất ' || d.cao_nhat::bigint
       || 'đ + 20% — bật bộ máy 27/09/2026'
  FROM de_xuat d
 WHERE d.tran > 0
   AND (app_private.utility_ceiling_check_v1(d.organization_id, d.building_id, d.utility_type,
                                             DATE '2026-09-01', 0)->>'verdict') = 'NO_RULE';

-- 5. Công tắc — chỉ org THẬT.
-- 5a. Bảy hạng mục CAM_KET, mọi toà, từ 10/2026.
INSERT INTO app_private.spend_policy_switches (organization_id, fee_category, building_id, period_from, note)
SELECT o.id, k.key, NULL, DATE '2026-10-01',
       'Bật theo lệnh chủ 27/09/2026 ("bật hết lên luôn") — hạng mục cam kết, mọi toà, từ tháng đầu có cam kết'
  FROM public.organizations o
 CROSS JOIN unnest(ARRAY['tien_nha', 'internet', 'quan_ly', 've_sinh', 'cong_an', 'rac', 'thang_may']) AS k(key)
 WHERE o.id = 'aaaa0000-0000-4000-8000-000000000001'
   AND EXISTS (SELECT 1 FROM public.income_expense_types t
                WHERE t.organization_id = o.id AND t.fee_category = k.key AND t.spend_mode = 'CAM_KET')
   AND NOT EXISTS (SELECT 1 FROM app_private.spend_policy_switches s
                    WHERE s.organization_id = o.id AND s.fee_category = k.key AND s.building_id IS NULL
                      AND s.retired_at IS NULL AND s.period_from = DATE '2026-10-01');

-- 5b. Điện, nước: từng toà ĐÃ có trần, từ 09/2026.
INSERT INTO app_private.spend_policy_switches (organization_id, fee_category, building_id, period_from, note)
SELECT b.organization_id, k.key, b.id, DATE '2026-09-01',
       'Bật theo lệnh chủ 27/09/2026 ("bật hết lên luôn") — theo trần, toà đã có trần'
  FROM public.buildings b
 CROSS JOIN (VALUES ('dien', 'ELECTRIC'), ('nuoc', 'WATER')) AS k(key, utility)
 WHERE b.organization_id = 'aaaa0000-0000-4000-8000-000000000001'
   AND b.deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM public.income_expense_types t
                WHERE t.organization_id = b.organization_id AND t.fee_category = k.key AND t.spend_mode = 'TRAN')
   AND (app_private.utility_ceiling_check_v1(b.organization_id, b.id, k.utility, DATE '2026-09-01', 0)->>'verdict')
       <> 'NO_RULE'
   AND NOT EXISTS (SELECT 1 FROM app_private.spend_policy_switches s
                    WHERE s.organization_id = b.organization_id AND s.fee_category = k.key
                      AND s.building_id = b.id AND s.retired_at IS NULL AND s.period_from = DATE '2026-09-01');

-- 6. Cờ → ON (đủ bốn trường truy vết).
UPDATE app_private.server_feature_flags
   SET mode = 'ON',
       force_freeze = false,
       commit_sha = '4f3113044edd9725687290cf63428843a876ccac',
       migration_sha256 = '220957162ac537066c3a66b7f1fd2373d0a95640d4eae76f5dbfa04baa11257c',
       maintenance_window_id = 'MW-2026-09-27-bat-bo-may-chi',
       approval_reference = 'Chủ ra lệnh trực tiếp 27/09/2026: "bật hết lên luôn đi đừng test 14 ngày hay 7 ngày gì nữa"',
       reason = CASE feature_key
                  WHEN 'spend.engine.v1' THEN 'Bộ máy chi theo cam kết: cổng áp quyết định ở bucket đã bật công tắc'
                  ELSE 'G6: người lập phải giữ sổ để chi (chủ sổ/CUSTODIAN/OPERATOR) ở 3 cửa Thanh toán' END,
       updated_at = now()
 WHERE feature_key IN ('spend.engine.v1', 'spend.cashbook_chi.v1')
   AND mode IS DISTINCT FROM 'ON';

-- 7. Sổ tiêu kéo theo cam kết mới (phiếu đã có trong các tháng vừa có cam kết).
DO $keo_so$
DECLARE
  v_id uuid;
  v_n  int := 0;
BEGIN
  FOR v_id IN
    SELECT DISTINCT e.id
      FROM public.income_expenses e
      JOIN public.income_expense_items i ON i.income_expense_id = e.id
      JOIN public.income_expense_types t ON t.id = i.income_expense_type_id
     WHERE e.type = 'EXPENSE' AND t.fee_category IS NOT NULL AND t.spend_mode = 'CAM_KET'
       AND COALESCE(i.end_date, i.start_date, e.voucher_date) >= DATE '2026-10-01'
     ORDER BY 1
  LOOP
    PERFORM app_private.spend_ledger_sync_v1(v_id);
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'Sổ tiêu đồng bộ lại % phiếu', v_n;
END
$keo_so$;

-- 8. Tự kiểm.
DO $sau$
DECLARE
  v_audit jsonb;
BEGIN
  IF public.fee_type_matches('cong_an', 'CA', 'Làm tạm trú')
     OR public.fee_type_matches('cong_an', NULL, 'Tạm trú công an')
     OR NOT public.fee_type_matches('cong_an', 'CA', 'Tiền công an')
     OR NOT public.fee_type_matches('cong_an', 'CA', 'Công an phường')
     OR NOT public.fee_type_matches('quan_ly', 'Vận Hành', 'Quản Lý')
     OR public.fee_type_matches('quan_ly', NULL, 'Lương quản lý')
     OR NOT public.fee_type_matches('tien_nha', 'Tiền Nhà', 'Tiền nhà') THEN
    RAISE EXCEPTION 'fee_type_matches sai sau khi sửa' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.organizations WHERE id = 'aaaa0000-0000-4000-8000-000000000001') THEN
    IF app_private.spend_route_v1('aaaa0000-0000-4000-8000-000000000001') <> 'CANONICAL'
       OR app_private.evaluate_feature_route('spend.cashbook_chi.v1', 'aaaa0000-0000-4000-8000-000000000001') <> 'CANONICAL' THEN
      RAISE EXCEPTION 'Cờ bộ máy chi chưa ra tuyến CANONICAL' USING ERRCODE = '55000';
    END IF;
    IF (SELECT count(*) FROM app_private.spend_policy_switches
         WHERE organization_id = 'aaaa0000-0000-4000-8000-000000000001' AND retired_at IS NULL
           AND building_id IS NULL) < 7 THEN
      RAISE EXCEPTION 'Thiếu công tắc hạng mục cam kết' USING ERRCODE = '55000';
    END IF;
    IF EXISTS (SELECT 1 FROM app_private.spend_commitments
                WHERE building_id = 'e823da47-9ec3-4c31-aa63-5cabc58b80b9' AND fee_category = 'cong_an'
                  AND status = 'PUBLISHED' AND amount = 7000) THEN
      RAISE EXCEPTION '405PVB công an còn cam kết 7.000đ' USING ERRCODE = '55000';
    END IF;
  END IF;
  v_audit := app_private.spend_ledger_audit_v1(NULL);
  IF (v_audit->>'lech_thieu')::int <> 0 OR (v_audit->>'lech_thua')::int <> 0 THEN
    RAISE EXCEPTION 'Sổ tiêu lệch trạng thái: %', v_audit USING ERRCODE = '55000';
  END IF;
END
$sau$;

COMMIT;

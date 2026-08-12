-- =============================================================================
-- Demo: chép bộ loại thu/chi từ công ty thật
--
-- GATE BẮT ĐÚNG, LẦN NỮA. Ngay sau khi dựng Demo (20260811040000), bộ đo rò từ
-- chối kết luận với vai demo.chunha:
--
--   ❌ Đối chứng dương (income_expense_types) thấy 0 dòng — bài đo đang MÙ chứ
--      không phải sạch.
--
-- Đây là chốt chống ảo giác số 4 của scripts/measure-org-leak.mjs, và nó đúng:
-- một vai thấy 0 dòng ở MỌI bảng thì "không rò" là kết luận vô nghĩa — không
-- phân biệt được "đã rào kín" với "chưa có dữ liệu để mà rò".
--
-- Nhưng đây không chỉ là chuyện làm vừa lòng bộ đo. Không có loại thu/chi thì
-- Demo KHÔNG test được nghiệp vụ tiền — mà đó là phần nghiệp vụ nặng nhất của
-- hệ thống. Công ty thật có 98 loại; Demo có 0.
--
-- CHÉP TỪ CÔNG TY THẬT chứ không bịa danh mục mới: kịch bản test chỉ có giá trị
-- khi nó chạy trên đúng bộ danh mục đang chạy thật. Bịa ra "DEMO Tiền phòng"
-- thì test xanh mà production vẫn có thể vỡ ở một loại nào đó không ai nghĩ tới.
--
-- Chỉ chép ĐỊNH NGHĨA (tên, kiểu, cờ) — không chép một đồng giao dịch nào.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

DO $chep$
DECLARE
  ORG      constant uuid := 'dddd0000-0000-4000-8000-000000000001';
  ORG_THAT constant uuid := 'aaaa0000-0000-4000-8000-000000000001';
  v_chunha uuid;
  v_n      int;
BEGIN
  SELECT id INTO v_chunha FROM auth.users WHERE email = 'demo.chunha@username.ihomecrm.local';
  IF v_chunha IS NULL THEN
    RAISE EXCEPTION 'Không có tài khoản chủ Demo. DỪNG.';
  END IF;

  INSERT INTO public.income_expense_types
    (organization_id, user_id, name, type, description, is_default, category,
     is_deposit, is_restricted, hide_in_report, force_approval, system_only)
  SELECT ORG, v_chunha, t.name, t.type, t.description, t.is_default, t.category,
         t.is_deposit, t.is_restricted, t.hide_in_report, t.force_approval, t.system_only
    FROM public.income_expense_types t
   WHERE t.organization_id = ORG_THAT
     AND NOT EXISTS (SELECT 1 FROM public.income_expense_types d
                      WHERE d.organization_id = ORG AND d.name = t.name AND d.type = t.type);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'Demo: chép % loại thu/chi từ công ty thật.', v_n;
END
$chep$;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — chốt chống ảo giác của chính bộ đo phải đạt được từ đây trở đi:
-- chủ Demo thấy >0 dòng CỦA MÌNH và 0 dòng của công ty khác.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  ORG      constant uuid := 'dddd0000-0000-4000-8000-000000000001';
  v_chunha uuid;
  v_minh   bigint;
  v_ngoai  bigint;
  v_that   bigint;
BEGIN
  SELECT id INTO v_chunha FROM auth.users WHERE email = 'demo.chunha@username.ihomecrm.local';
  SELECT count(*) INTO v_that FROM public.income_expense_types
   WHERE organization_id = 'aaaa0000-0000-4000-8000-000000000001';

  CREATE TEMP TABLE _nt(k text, v bigint) ON COMMIT DROP;
  GRANT INSERT, SELECT ON _nt TO PUBLIC;

  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', v_chunha::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO _nt
  SELECT 'minh',  (SELECT count(*) FROM public.income_expense_types WHERE organization_id = ORG)
  UNION ALL
  SELECT 'ngoai', (SELECT count(*) FROM public.income_expense_types WHERE organization_id <> ORG);
  RESET ROLE;

  SELECT v INTO v_minh  FROM _nt WHERE k = 'minh';
  SELECT v INTO v_ngoai FROM _nt WHERE k = 'ngoai';

  IF v_minh = 0 THEN
    RAISE EXCEPTION 'Chủ Demo vẫn thấy 0 loại thu/chi của mình — chốt chống mù của bộ đo sẽ vẫn đỏ. DỪNG.';
  END IF;
  IF v_ngoai > 0 THEN
    RAISE EXCEPTION 'Chủ Demo thấy % loại thu/chi của công ty KHÁC — cách ly hỏng. DỪNG.', v_ngoai;
  END IF;
  IF v_minh <> v_that THEN
    RAISE NOTICE 'Lưu ý: Demo có % loại, công ty thật có % (lệch do trùng tên bị bỏ qua).', v_minh, v_that;
  END IF;

  RAISE NOTICE 'Nghiệm thu đạt: chủ Demo thấy % loại của mình, 0 của công ty khác.', v_minh;
END
$nghiem_thu$;

COMMIT;

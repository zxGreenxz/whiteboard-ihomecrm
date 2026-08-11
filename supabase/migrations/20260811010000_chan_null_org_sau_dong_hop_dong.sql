-- =============================================================================
-- Chặn dòng organization_id NULL ở sáu bảng nghiệp vụ app đang ghi vào
--
-- GATE ĐÃ LÀM ĐÚNG VIỆC CỦA NÓ. 20260809020000 vá 3.621 dòng NULL rồi dựng gate
-- đếm chúng, kèm ghi chú rằng 105 bảng VẪN nhận được NULL và "thứ canh chỗ đó là
-- gate, không phải trigger". Chưa đầy hai ngày sau, app chạy thật đẻ ra 24 dòng
-- NULL mới và gate bắt được ngay lần chạy đầu:
--
--   inspection_photos 17 · inspection_sessions 2 · salary_attendance_day 2
--   material_usages 1 · cash_handovers 1 · material_usage_items 1
--
-- Nhánh `organization_id IS NULL` của công thức biên giới nghĩa là 24 dòng này
-- hiển thị cho MỌI tổ chức. Hôm nay chỉ có một tổ chức nên chưa ai thấy gì —
-- nhưng đây không còn là rủi ro lý thuyết nữa, nó là tốc độ phát sinh đo được.
--
-- ------------------------- VÌ SAO NAY MỚI GẮN TRIGGER -----------------------
-- File 20260809020000 cố ý KHÔNG gắn trigger diện rộng cho 84 bảng, vì hàm dùng
-- chung `app_private._autofill_org` có nhánh cuối rơi về HẰNG SỐ 'aaaa…' — gắn
-- diện rộng sẽ làm gate xanh trong khi âm thầm dán nhãn "công ty thật" lên dữ
-- liệu chưa ai xác minh. Lý lẽ đó KHÔNG đổi.
--
-- Cái đổi là bằng chứng: sáu bảng NÀY được chứng minh là đang chảy NULL thật,
-- với tốc độ đo được. Gắn cho sáu bảng có bằng chứng khác hẳn gắn cho 84 bảng
-- theo phỏng đoán.
--
-- Và dùng hàm FAIL-CLOSED chứ không dùng _autofill_org:
--   suy được  → điền
--   không suy → NỔ, và người ghi thấy lỗi ngay
-- thay vì lặng lẽ ghi 'aaaa…' rồi để lại một dòng không ai biết là đoán.
-- Với sáu bảng này mọi dòng đều có user_id hoặc bảng cha, nên nhánh nổ gần như
-- không bao giờ chạm tới trong vận hành bình thường; nếu nó chạm, đó là một
-- đường ghi mới chưa ai nghĩ tới và đáng được biết ngay.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- Hàm suy tổ chức, FAIL-CLOSED. Tổng quát theo cột có mặt trong dòng, nên dùng
-- lại được cho bảng khác mà không phải viết bản sao thứ hai.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.autofill_org_strict()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $f$
DECLARE
  j     jsonb := to_jsonb(NEW);
  v_org uuid;
  v_n   int;
  -- [cột khoá ngoại, bảng cha] — thứ tự là thứ tự ĐỘ TIN CẬY giảm dần.
  cha   text[][] := ARRAY[
    ARRAY['session_id',  'inspection_sessions'],
    ARRAY['usage_id',    'material_usages'],
    ARRAY['handover_id', 'cash_handovers'],
    ARRAY['building_id', 'buildings'],
    ARRAY['room_id',     'rooms'],
    ARRAY['contract_id', 'contracts'],
    ARRAY['invoice_id',  'invoices']
  ];
  nguoi text[] := ARRAY['user_id', 'giver_id', 'staff_id'];
  i     int;
BEGIN
  IF NEW.organization_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- (1) Suy qua bảng CHA — chắc chắn hơn suy qua người, vì nó gắn dòng con vào
  --     đúng tổ chức của thứ nó thuộc về, không phụ thuộc ai đang thao tác.
  FOR i IN 1 .. array_length(cha, 1) LOOP
    CONTINUE WHEN NOT (j ? cha[i][1]) OR (j->>cha[i][1]) IS NULL;
    EXECUTE format('SELECT organization_id FROM public.%I WHERE id = $1', cha[i][2])
      INTO v_org USING (j->>cha[i][1])::uuid;
    EXIT WHEN v_org IS NOT NULL;
  END LOOP;

  -- (2) Suy qua NGƯỜI, và CHỈ khi người đó thuộc đúng MỘT tổ chức ACTIVE.
  --     Người hai tổ chức thì không suy được — đoán bừa còn tệ hơn nổ.
  IF v_org IS NULL THEN
    FOR i IN 1 .. array_length(nguoi, 1) LOOP
      CONTINUE WHEN NOT (j ? nguoi[i]) OR (j->>nguoi[i]) IS NULL;
      SELECT (array_agg(DISTINCT m.organization_id))[1], count(DISTINCT m.organization_id)
        INTO v_org, v_n
        FROM public.organization_memberships m
       WHERE m.user_id = (j->>nguoi[i])::uuid AND m.status = 'ACTIVE';
      IF v_n IS DISTINCT FROM 1 THEN v_org := NULL; END IF;
      EXIT WHEN v_org IS NOT NULL;
    END LOOP;
  END IF;

  IF v_org IS NULL THEN
    RAISE EXCEPTION '% : không suy được organization_id cho dòng này. Đường ghi phải tự khai organization_id, hoặc dòng phải có cha/người thuộc đúng một tổ chức.',
      TG_TABLE_NAME USING ERRCODE = '23502';
  END IF;

  NEW.organization_id := v_org;
  RETURN NEW;
END;
$f$;

COMMENT ON FUNCTION app_private.autofill_org_strict() IS
  'Suy organization_id từ bảng cha rồi tới người. FAIL-CLOSED: không suy được thì NỔ — khác app_private._autofill_org vốn rơi về hằng số tổ chức thật.';

-- ---------------------------------------------------------------------------
-- Vá 24 dòng đang có. THỨ TỰ QUAN TRỌNG: 17 dòng inspection_photos chỉ suy được
-- SAU khi cha của chúng (inspection_sessions) có nhãn — đúng mẫu dây chuyền mà
-- GĐ6 đã gặp.
-- ---------------------------------------------------------------------------
DO $va$
DECLARE
  v_n bigint; v_tong bigint := 0;
BEGIN
  -- Lượt 1: các bảng suy qua NGƯỜI.
  UPDATE public.inspection_sessions t SET organization_id = m.org
    FROM (SELECT user_id, (array_agg(DISTINCT organization_id))[1] AS org FROM public.organization_memberships
           WHERE status='ACTIVE' GROUP BY user_id HAVING count(DISTINCT organization_id)=1) m
   WHERE m.user_id = t.user_id AND t.organization_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_tong := v_tong + v_n;

  UPDATE public.salary_attendance_day t SET organization_id = m.org
    FROM (SELECT user_id, (array_agg(DISTINCT organization_id))[1] AS org FROM public.organization_memberships
           WHERE status='ACTIVE' GROUP BY user_id HAVING count(DISTINCT organization_id)=1) m
   WHERE m.user_id = t.user_id AND t.organization_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_tong := v_tong + v_n;

  UPDATE public.material_usages t SET organization_id = m.org
    FROM (SELECT user_id, (array_agg(DISTINCT organization_id))[1] AS org FROM public.organization_memberships
           WHERE status='ACTIVE' GROUP BY user_id HAVING count(DISTINCT organization_id)=1) m
   WHERE m.user_id = t.user_id AND t.organization_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_tong := v_tong + v_n;

  UPDATE public.cash_handovers t SET organization_id = m.org
    FROM (SELECT user_id, (array_agg(DISTINCT organization_id))[1] AS org FROM public.organization_memberships
           WHERE status='ACTIVE' GROUP BY user_id HAVING count(DISTINCT organization_id)=1) m
   WHERE m.user_id = t.giver_id AND t.organization_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_tong := v_tong + v_n;

  -- Lượt 2: con của những bảng vừa vá.
  UPDATE public.inspection_photos t SET organization_id = p.organization_id
    FROM public.inspection_sessions p
   WHERE p.id = t.session_id AND t.organization_id IS NULL AND p.organization_id IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_tong := v_tong + v_n;

  UPDATE public.material_usage_items t SET organization_id = p.organization_id
    FROM public.material_usages p
   WHERE p.id = t.usage_id AND t.organization_id IS NULL AND p.organization_id IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_tong := v_tong + v_n;

  RAISE NOTICE 'Đã điền organization_id cho % dòng.', v_tong;
END
$va$;

-- ---------------------------------------------------------------------------
-- Gắn trigger để không tái diễn.
-- ---------------------------------------------------------------------------
DO $gan$
DECLARE b text;
BEGIN
  FOREACH b IN ARRAY ARRAY['inspection_sessions','inspection_photos','salary_attendance_day',
                           'material_usages','material_usage_items','cash_handovers'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_autofill_org_strict ON public.%I', b);
    EXECUTE format(
      'CREATE TRIGGER trg_autofill_org_strict BEFORE INSERT ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app_private.autofill_org_strict()', b);
  END LOOP;
END
$gan$;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  b text; v_n bigint; v_con text := ''; v_tong bigint := 0;
BEGIN
  FOREACH b IN ARRAY ARRAY['inspection_sessions','inspection_photos','salary_attendance_day',
                           'material_usages','material_usage_items','cash_handovers'] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id IS NULL', b) INTO v_n;
    IF v_n > 0 THEN v_tong := v_tong + v_n; v_con := v_con || format('%s(%s) ', b, v_n); END IF;

    SELECT count(*) INTO v_n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = b AND t.tgname = 'trg_autofill_org_strict' AND NOT t.tgisinternal;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'Bảng % chưa gắn được trigger chặn NULL. DỪNG.', b;
    END IF;
  END LOOP;

  IF v_tong > 0 THEN
    RAISE EXCEPTION 'Còn % dòng NULL chưa vá được: %', v_tong, v_con;
  END IF;

  RAISE NOTICE 'Sáu bảng đã sạch dòng NULL và đã có trigger chặn.';
END
$nghiem_thu$;

COMMIT;

-- =============================================================================
-- ROLLBACK: DROP TRIGGER trg_autofill_org_strict trên sáu bảng, DROP FUNCTION
-- app_private.autofill_org_strict(). Phần điền dữ liệu không có đường lùi tự
-- động — dùng bản dump lane tự chụp trước lúc apply.
-- =============================================================================

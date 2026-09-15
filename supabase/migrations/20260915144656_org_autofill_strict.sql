-- =============================================================================
-- 33 trigger điền organization_id: bỏ hàm ĐOÁN, dùng hàm FAIL-CLOSED
--
-- VẤN ĐỀ (I3.1, plan rà soát 15/09/2026)
--   public._autofill_org() (20260713121000) kết thúc bằng gán HẰNG SỐ tổ chức
--   THẬT (aaaa0000-0000-4000-8000-000000000001) khi không suy được tổ chức. Nó
--   chạy trên 33 bảng, gồm gần như toàn bộ đường tiền và PII: income_expenses,
--   invoices, payments, contracts, customers, tenants, deposits, meters…
--   Người thuộc NHIỀU tổ chức (chủ vừa là thành viên công ty THẬT vừa là thành
--   viên DEMO) tạo một dòng mà đường ghi quên khai organization_id thì dòng đó
--   rơi thẳng vào SỔ THẬT — im lặng, không lỗi.
--
--   app_private.autofill_org_strict() (20260811010000, mở rộng 20260811020000)
--   đã có sẵn và làm đúng việc đó theo lối fail-closed: suy được thì điền,
--   không suy được thì NỔ (23502) để người ghi thấy ngay. Nó đang canh 12 bảng.
--   File này chuyển 33 bảng còn lại sang dùng nó, và gắn thêm cho hai bảng vẫn
--   đang nhận NULL mà chưa có trigger nào: notifications,
--   public_room_share_tokens.
--
-- ĐO TRƯỚC KHI SỬA (production, read-only, 15/09/2026)
--   • 33 trigger đang trỏ vào public._autofill_org, 12 trigger trỏ vào
--     app_private.autofill_org_strict.
--   • Nhánh rơi-về-hằng-số của _autofill_org ghi một dòng
--     authorization_migration_exceptions mỗi lần chạy. Đếm được:
--         reason = PROD_DEFAULT_FALLBACK at insert  →  0 dòng.
--     (Bảng đó có 3 dòng thật từ 16/07 với lý do khác, nên nó ghi được — số 0
--     là số 0 thật, không phải INSERT bị nuốt.)
--     Nghĩa là trong vận hành hiện nay nhánh đoán CHƯA từng chạy: đổi sang
--     fail-closed không làm hỏng đường ghi nào đang dùng, nó chỉ bịt cửa.
--   • notifications: 0 dòng organization_id NULL.
--     public_room_share_tokens: 0 dòng organization_id NULL.
--     → gắn trigger không cần vá dữ liệu cũ.
--
-- HÀM SUY ĐƯỢC MỞ RỘNG — BẮT BUỘC, KHÔNG PHẢI TIỆN TAY
--   Bản strict đang chạy chỉ biết 7 cột cha (session_id, usage_id, handover_id,
--   building_id, room_id, contract_id, invoice_id). 33 bảng chuyển sang có
--   những cột cha mà bản cũ KHÔNG biết — income_expense_items chỉ có
--   income_expense_id, income_expense_batch_items có batch_id, meter_readings
--   có meter_id… Chuyển nguyên trạng là biến "đoán sai org" thành "nổ giữa
--   đường tiền". Nên danh sách cha được mở đúng bằng tập cột mà _autofill_org
--   vốn suy (income_expense_id, account_id, customer_id) cộng các cột cha CÓ
--   KHOÁ NGOẠI THẬT của 35 bảng (batch_id, meter_id, deposit_id, job_id,
--   tenant_id). Thứ tự cũng đổi về đúng thứ tự của _autofill_org (building →
--   room → contract → invoice → …) để 33 bảng chuyển sang giữ nguyên kết quả.
--
--   Đã đối chiếu khoá ngoại thật trên production: mỗi tên cột trong danh sách
--   chỉ trỏ tới ĐÚNG MỘT bảng cha trên toàn bộ 35 bảng — không có cột nào cùng
--   tên mà khác cha.
--
-- CHỐT UUID — vá một cái bẫy có sẵn
--   public_room_events.session_id là TEXT (id phiên trình duyệt), không phải
--   khoá ngoại. Bản strict đang chạy thấy cột tên session_id là ép sang uuid
--   → 22P02 "invalid input syntax for type uuid" mỗi khi dòng đó thiếu
--   organization_id. Bản này chỉ tra khi giá trị ĐÚNG DẠNG uuid, nên cột trùng
--   tên mà khác nghĩa bị bỏ qua thay vì làm nổ.
--
-- KHÔNG XOÁ public._autofill_org()
--   Giữ lại làm đường lùi: rollback là gắn lại trigger cũ, không phải dựng lại
--   hàm. Đánh dấu bằng COMMENT để không ai gắn mới nhầm.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Hàm suy tổ chức, FAIL-CLOSED — bản mở rộng.
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
  v_val text;
  -- [cột khoá ngoại, bảng cha] — thứ tự là thứ tự ĐỘ TIN CẬY giảm dần, và bảy
  -- dòng đầu giữ đúng thứ tự của public._autofill_org để 33 bảng chuyển sang
  -- suy ra cùng một kết quả như trước.
  cha   text[][] := ARRAY[
    ARRAY['building_id',       'buildings'],
    ARRAY['room_id',           'rooms'],
    ARRAY['contract_id',       'contracts'],
    ARRAY['invoice_id',        'invoices'],
    ARRAY['income_expense_id', 'income_expenses'],
    ARRAY['account_id',        'accounts'],
    ARRAY['customer_id',       'customers'],
    ARRAY['session_id',        'inspection_sessions'],
    ARRAY['usage_id',          'material_usages'],
    ARRAY['handover_id',       'cash_handovers'],
    ARRAY['batch_id',          'income_expense_batches'],
    ARRAY['meter_id',          'meters'],
    ARRAY['deposit_id',        'deposits'],
    ARRAY['job_id',            'jobs'],
    ARRAY['tenant_id',         'tenants']
  ];
  nguoi text[] := ARRAY['user_id', 'owner_id', 'giver_id', 'staff_id'];
  i     int;
BEGIN
  IF NEW.organization_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- (1) Suy qua bảng CHA — chắc chắn hơn suy qua người, vì nó gắn dòng con vào
  --     đúng tổ chức của thứ nó thuộc về, không phụ thuộc ai đang thao tác.
  FOR i IN 1 .. array_length(cha, 1) LOOP
    CONTINUE WHEN NOT (j ? cha[i][1]);
    v_val := j->>cha[i][1];
    -- Cột trùng tên mà không phải uuid (public_room_events.session_id là id
    -- phiên trình duyệt, kiểu text) thì BỎ QUA, không ép kiểu rồi nổ 22P02.
    CONTINUE WHEN v_val IS NULL OR v_val !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    EXECUTE format('SELECT organization_id FROM public.%I WHERE id = $1', cha[i][2])
      INTO v_org USING v_val::uuid;
    EXIT WHEN v_org IS NOT NULL;
  END LOOP;

  -- (2) Suy qua NGƯỜI, và CHỈ khi người đó thuộc đúng MỘT tổ chức ACTIVE.
  --     Người hai tổ chức thì không suy được — đoán bừa còn tệ hơn nổ. Đây
  --     chính là cửa mà _autofill_org để hở: nó đoán bừa ra org THẬT.
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
  'Suy organization_id tu bang cha (15 cot, co chot dung-dang-uuid) roi toi nguoi (chi khi nguoi thuoc dung mot to chuc ACTIVE). FAIL-CLOSED: khong suy duoc thi NO 23502 - khac public._autofill_org von roi ve hang so to chuc THAT. Tu 15/09/2026 canh toan bo 35 bang.';

REVOKE ALL ON FUNCTION app_private.autofill_org_strict() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.autofill_org_strict() FROM anon;
REVOKE ALL ON FUNCTION app_private.autofill_org_strict() FROM authenticated;

-- ---------------------------------------------------------------------------
-- 2. Chuyển 33 trigger sang hàm fail-closed — GIỮ NGUYÊN TÊN TRIGGER.
--
--    Tên quyết định THỨ TỰ CHẠY giữa các trigger cùng thời điểm (Postgres xếp
--    theo tên). accounts dùng tên a01_autofill_org đúng để chạy trước những
--    trigger khác trên bảng đó. Đổi tên là đổi thứ tự — nên tra tên thật từ
--    catalog rồi dựng lại y hệt.
--
--    Đọc catalog thay vì chép cứng danh sách nên khối này IDEMPOTENT: chạy lần
--    hai không còn trigger nào trỏ vào _autofill_org, vòng lặp chạy 0 lượt.
-- ---------------------------------------------------------------------------
DO $chuyen$
DECLARE
  r record;
  v_n int := 0;
BEGIN
  FOR r IN
    SELECT c.relname AS bang, t.tgname AS ten
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc  p ON p.oid = t.tgfoid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT t.tgisinternal
       AND p.proname = '_autofill_org'
       AND p.pronamespace = 'public'::regnamespace
       AND n.nspname = 'public'
     ORDER BY c.relname
  LOOP
    EXECUTE format('DROP TRIGGER %I ON public.%I', r.ten, r.bang);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app_private.autofill_org_strict()', r.ten, r.bang);
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'Da chuyen % trigger sang autofill_org_strict.', v_n;
END
$chuyen$;

-- ---------------------------------------------------------------------------
-- 3. Hai bảng còn nhận NULL mà chưa có trigger nào.
--
--    notifications: đường ghi đã tìm được là award_job_bonus,
--    record_payment_gps, request_paid_leave. Dòng có contract_id / invoice_id /
--    job_id thì suy qua cha; còn lại suy qua user_id.
--    public_room_share_tokens: chỉ có owner_id — nằm sẵn trong danh sách người.
--
--    Khối vá là DÂY AN TOÀN: đo 15/09 cả hai bảng đều 0 dòng NULL. Nó chỉ chạy
--    nếu có dòng mới kịp sinh ra giữa lúc đo và lúc apply.
-- ---------------------------------------------------------------------------
DO $va$
DECLARE v_n bigint; v_tong bigint := 0;
BEGIN
  UPDATE public.notifications t SET organization_id = c.organization_id
    FROM public.contracts c
   WHERE c.id = t.contract_id AND t.organization_id IS NULL AND c.organization_id IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_tong := v_tong + v_n;

  UPDATE public.notifications t SET organization_id = i.organization_id
    FROM public.invoices i
   WHERE i.id = t.invoice_id AND t.organization_id IS NULL AND i.organization_id IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_tong := v_tong + v_n;

  UPDATE public.notifications t SET organization_id = g.organization_id
    FROM public.jobs g
   WHERE g.id = t.job_id AND t.organization_id IS NULL AND g.organization_id IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_tong := v_tong + v_n;

  UPDATE public.notifications t SET organization_id = m.org
    FROM (SELECT user_id, (array_agg(DISTINCT organization_id))[1] AS org
            FROM public.organization_memberships WHERE status = 'ACTIVE'
           GROUP BY user_id HAVING count(DISTINCT organization_id) = 1) m
   WHERE m.user_id = t.user_id AND t.organization_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_tong := v_tong + v_n;

  UPDATE public.public_room_share_tokens t SET organization_id = m.org
    FROM (SELECT user_id, (array_agg(DISTINCT organization_id))[1] AS org
            FROM public.organization_memberships WHERE status = 'ACTIVE'
           GROUP BY user_id HAVING count(DISTINCT organization_id) = 1) m
   WHERE m.user_id = t.owner_id AND t.organization_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_tong := v_tong + v_n;

  RAISE NOTICE 'Va organization_id cho % dong (do 15/09 la 0).', v_tong;
END
$va$;

DO $gan$
DECLARE b text;
BEGIN
  FOREACH b IN ARRAY ARRAY['notifications', 'public_room_share_tokens'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_autofill_org_strict ON public.%I', b);
    EXECUTE format(
      'CREATE TRIGGER trg_autofill_org_strict BEFORE INSERT ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION app_private.autofill_org_strict()', b);
  END LOOP;
END
$gan$;

COMMENT ON FUNCTION public._autofill_org() IS
  'DA NGUNG DUNG 15/09/2026 - khong con trigger nao tro vao. Nhanh cuoi cua ham roi ve HANG SO to chuc THAT khi khong suy duoc, nen no dan nhan cong ty that len dong chua ai xac minh. Thay bang app_private.autofill_org_strict (fail-closed). Giu lai CHI de lam duong lui; dung gan moi.';

-- ---------------------------------------------------------------------------
-- NGHIỆM THU
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_cu int; v_moi int; v_null bigint; v_anon boolean; v_auth boolean; b text;
BEGIN
  SELECT count(*) INTO v_cu
    FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE NOT t.tgisinternal AND p.proname = '_autofill_org'
     AND p.pronamespace = 'public'::regnamespace;
  IF v_cu <> 0 THEN
    RAISE EXCEPTION 'Con % trigger tro vao public._autofill_org. DUNG.', v_cu;
  END IF;

  SELECT count(*) INTO v_moi
    FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE NOT t.tgisinternal AND p.proname = 'autofill_org_strict';
  IF v_moi < 35 THEN
    RAISE EXCEPTION 'Chi dem duoc % trigger autofill_org_strict (ky vong >= 35). DUNG.', v_moi;
  END IF;

  FOREACH b IN ARRAY ARRAY['notifications', 'public_room_share_tokens'] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id IS NULL', b) INTO v_null;
    IF v_null > 0 THEN
      RAISE EXCEPTION 'Bang % con % dong organization_id NULL sau khi va. DUNG.', b, v_null;
    END IF;
  END LOOP;

  SELECT has_function_privilege('anon', p.oid, 'EXECUTE'),
         has_function_privilege('authenticated', p.oid, 'EXECUTE')
    INTO v_anon, v_auth
    FROM pg_proc p
   WHERE p.proname = 'autofill_org_strict' AND p.pronamespace = 'app_private'::regnamespace;
  IF v_anon OR v_auth THEN
    RAISE EXCEPTION 'autofill_org_strict van goi duoc: anon=% authenticated=%', v_anon, v_auth;
  END IF;

  RAISE NOTICE 'OK: 0 trigger doan org, % trigger fail-closed, hai bang moi sach NULL.', v_moi;
END
$nghiem_thu$;

-- =============================================================================
-- ROLLBACK: gắn lại public._autofill_org cho đúng 33 bảng ở mục 2 (tên trigger
-- giữ nguyên nên chỉ cần dựng lại trigger với EXECUTE FUNCTION cũ), DROP TRIGGER
-- trg_autofill_org_strict trên notifications + public_room_share_tokens, và
-- CREATE OR REPLACE lại thân autofill_org_strict của 20260811020000. Phần vá dữ
-- liệu (0 dòng lúc đo) không có đường lùi tự động — dùng dump lane chụp trước.
-- =============================================================================

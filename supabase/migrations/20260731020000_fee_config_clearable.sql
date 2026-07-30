-- =====================================================================
-- Cấu hình phí cố định: XOÁ ĐƯỢC giá trị sai + đọc/ghi cờ "Không áp dụng"
-- về đúng một nguồn.
--
-- VÌ SAO CẦN (đo trên prod 30/07/2026, không suy luận từ file):
--
--   (1) `upsert_building_fee_account` dùng
--         default_amount = COALESCE(EXCLUDED.default_amount, cũ)
--       cho CẢ BỐN cột. Truyền NULL nghĩa là "giữ nguyên", nên **không có đường
--       nào xoá** một giá gõ sai, một mã khách hàng sai, hay một sổ mặc định trỏ
--       sai. Đây là ngõ cụt thật: chủ gõ 1.500.000 thành 15.000.000 thì con số đó
--       ở lại vĩnh viễn, và mỗi kỳ lưới phí lại mời đóng theo nó.
--       ⚠ KHÔNG được đổi COALESCE thành gán thẳng: `pay_period_fee` gọi cùng
--       khuôn ON CONFLICT này và CHỈ truyền vài cột (mục "Học cấu hình" ở
--       20260731011000:761) — gán thẳng sẽ khiến mỗi lần đóng tiền XOÁ SẠCH các
--       cột nó không truyền. Vì vậy thêm THAM SỐ RIÊNG để nói rõ ý định xoá.
--
--   (2) Cờ "Không áp dụng" bị ĐỌC MỘT NƠI, GHI MỘT NƠI. RPC ghi vào
--       `buildings.hidden_fixed_expenses` (và tự khai đó là nguồn duy nhất), còn
--       giao diện đọc cột `building_fee_accounts.not_applicable`. Đo thật:
--         building_fee_accounts.not_applicable = true : 0/109 dòng (KHÔNG AI GHI)
--         buildings.hidden_fixed_expenses            : 6 mục ở 4 toà
--           403PVB [nuoc, ve_sinh] · 65NTG [cong_an, ve_sinh]
--           405PVB [nuoc]          · 1392QT [nuoc]
--       ⇒ đúng những ô chủ đã tắt lại hiện "đang áp dụng". Frontend đã sửa để
--       đọc `hidden_fixed_expenses`. Ở đây thêm hàm ĐỌC gộp để trang Cài đặt lấy
--       một phát, và giữ cột `not_applicable` ĐỒNG BỘ theo nguồn duy nhất để bất
--       kỳ chỗ đọc cũ nào cũng thôi nói dối.
--
-- KHÔNG ĐỤNG TIỀN: file này chỉ sờ bảng cấu hình (`building_fee_accounts`) và
-- cột `buildings.hidden_fixed_expenses`. Không một câu nào lên `income_expenses`,
-- `income_expense_items`, `accounts`, `payments`, `invoices`.
-- =====================================================================
BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 0. PREFLIGHT — không vá mù
-- ─────────────────────────────────────────────────────────────────────
DO $preflight$
BEGIN
  IF to_regprocedure('public.upsert_building_fee_account(uuid,text,text,text,numeric,uuid,boolean)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu upsert_building_fee_account/7 — chữ ký đã đổi? DỪNG, không vá mù.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='building_fee_accounts' AND column_name='not_applicable'
  ) THEN
    RAISE EXCEPTION 'Thiếu cột building_fee_accounts.not_applicable. DỪNG.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='buildings' AND column_name='hidden_fixed_expenses'
  ) THEN
    RAISE EXCEPTION 'Thiếu cột buildings.hidden_fixed_expenses. DỪNG.';
  END IF;
  -- Khuôn ON CONFLICT mà pay_period_fee dựa vào phải còn đó.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND tablename='building_fee_accounts'
       AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%building_id%'
       AND indexdef ILIKE '%fee_category%'
  ) THEN
    RAISE EXCEPTION 'Không thấy unique index (building_id, fee_category) — ON CONFLICT sẽ vỡ. DỪNG.';
  END IF;
END
$preflight$;

-- ─────────────────────────────────────────────────────────────────────
-- 1. ĐỒNG BỘ MỘT LẦN: kéo cột not_applicable về khớp nguồn duy nhất
--    Chỉ sửa CỜ CẤU HÌNH, không phải số tiền. Idempotent.
-- ─────────────────────────────────────────────────────────────────────
UPDATE building_fee_accounts f
   SET not_applicable = true, updated_at = now()
  FROM buildings b
 WHERE b.id = f.building_id
   AND f.deleted_at IS NULL
   AND f.fee_category = ANY(COALESCE(b.hidden_fixed_expenses, '{}'))
   AND f.not_applicable IS DISTINCT FROM true;

UPDATE building_fee_accounts f
   SET not_applicable = false, updated_at = now()
  FROM buildings b
 WHERE b.id = f.building_id
   AND f.deleted_at IS NULL
   AND NOT (f.fee_category = ANY(COALESCE(b.hidden_fixed_expenses, '{}')))
   AND f.not_applicable IS DISTINCT FROM false;

-- ─────────────────────────────────────────────────────────────────────
-- 2. upsert_building_fee_account — THÊM ý định xoá tường minh
--
--    Ba tham số mới, đều DEFAULT false nên MỌI caller cũ (kể cả
--    pay_period_fee, vốn gọi bằng tên tham số) giữ nguyên hành vi từng cột:
--      p_clear_amount   → đặt default_amount     = NULL
--      p_clear_provider → đặt provider_code      = NULL và account_holder = NULL
--      p_clear_account  → đặt default_account_id = NULL
--    Cờ xoá THẮNG giá trị truyền vào: gửi kèm cả hai là ý định mâu thuẫn, và
--    "xoá" là vế an toàn hơn (không ghi âm thầm một số mới).
--
--    ⚠ Giữ nguyên tên/thứ tự 7 tham số cũ và CHỈ THÊM vào cuối: PostgREST định
--    tuyến RPC theo TÊN tham số, nên caller cũ không cần đổi. Đổi chữ ký là tạo
--    overload mới ⇒ hàm mới hứng default privileges (án lệ đã có trong repo),
--    nên bên dưới REVOKE/GRANT lại tường minh.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.upsert_building_fee_account(
  p_building_id      uuid,
  p_fee_category     text,
  p_provider_code    text    DEFAULT NULL,
  p_account_holder   text    DEFAULT NULL,
  p_default_amount   numeric DEFAULT NULL,
  p_default_account_id uuid  DEFAULT NULL,
  p_not_applicable   boolean DEFAULT NULL,
  p_clear_amount     boolean DEFAULT false,
  p_clear_provider   boolean DEFAULT false,
  p_clear_account    boolean DEFAULT false
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_owner uuid;
  v_id    uuid;
  v_na    boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_fee_category NOT IN ('tien_nha','dien','nuoc','internet','quan_ly','ve_sinh','cong_an','rac','thang_may') THEN
    RAISE EXCEPTION 'Hạng mục phí không hợp lệ: %', p_fee_category;
  END IF;
  IF p_default_amount IS NOT NULL AND p_default_amount < 0 THEN
    RAISE EXCEPTION 'Giá mặc định không được âm' USING ERRCODE = '22023';
  END IF;

  SELECT b.user_id INTO v_owner FROM buildings b
   WHERE b.id = p_building_id AND b.deleted_at IS NULL;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Không tìm thấy toà nhà'; END IF;
  IF NOT (public.can_access_building(p_building_id)
          OR public.ie_all_buildings_scope(p_building_id)
          OR v_owner = auth.uid()
          OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền cấu hình toà này' USING ERRCODE = '42501';
  END IF;

  -- Cờ "Không áp dụng" — NGUỒN DUY NHẤT là buildings.hidden_fixed_expenses.
  -- Làm TRƯỚC phần upsert để giá trị cuối cùng của nó dùng được ngay bên dưới
  -- khi đồng bộ cột không_áp_dụng của chính dòng cấu hình.
  IF p_not_applicable IS TRUE THEN
    UPDATE buildings
       SET hidden_fixed_expenses = (
         SELECT array(SELECT DISTINCT k FROM unnest(COALESCE(hidden_fixed_expenses,'{}') || ARRAY[p_fee_category]) k))
     WHERE id = p_building_id;
  ELSIF p_not_applicable IS FALSE THEN
    UPDATE buildings
       SET hidden_fixed_expenses = array_remove(COALESCE(hidden_fixed_expenses,'{}'), p_fee_category)
     WHERE id = p_building_id;
  END IF;

  SELECT p_fee_category = ANY(COALESCE(b.hidden_fixed_expenses,'{}'))
    INTO v_na
    FROM buildings b WHERE b.id = p_building_id;

  INSERT INTO building_fee_accounts
    (building_id, fee_category, provider_code, account_holder,
     default_amount, default_account_id, not_applicable, user_id)
  VALUES
    (p_building_id, p_fee_category,
     CASE WHEN p_clear_provider THEN NULL ELSE NULLIF(btrim(p_provider_code), '') END,
     CASE WHEN p_clear_provider THEN NULL ELSE NULLIF(btrim(p_account_holder), '') END,
     CASE WHEN p_clear_amount   THEN NULL ELSE p_default_amount END,
     CASE WHEN p_clear_account  THEN NULL ELSE p_default_account_id END,
     COALESCE(v_na, false), v_owner)
  ON CONFLICT (building_id, fee_category) WHERE deleted_at IS NULL
  DO UPDATE SET
    -- Mỗi cột: cờ xoá thắng → NULL; không thì giữ nguyên nghĩa cũ
    -- (giá trị mới nếu có, ngược lại giữ giá trị đang có).
    provider_code = CASE WHEN p_clear_provider THEN NULL
                         ELSE COALESCE(NULLIF(btrim(EXCLUDED.provider_code), ''),
                                       building_fee_accounts.provider_code) END,
    account_holder = CASE WHEN p_clear_provider THEN NULL
                          ELSE COALESCE(NULLIF(btrim(EXCLUDED.account_holder), ''),
                                        building_fee_accounts.account_holder) END,
    default_amount = CASE WHEN p_clear_amount THEN NULL
                          ELSE COALESCE(EXCLUDED.default_amount,
                                        building_fee_accounts.default_amount) END,
    default_account_id = CASE WHEN p_clear_account THEN NULL
                              ELSE COALESCE(building_fee_accounts.default_account_id,
                                            EXCLUDED.default_account_id) END,
    -- Luôn kéo về khớp nguồn duy nhất, kể cả khi caller không truyền cờ.
    not_applicable = COALESCE(v_na, false),
    updated_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

-- Chữ ký đổi (7 → 10 tham số) nên hàm là đối tượng MỚI và hứng default
-- privileges. Siết lại tường minh, đúng án lệ đã ghi trong repo.
REVOKE ALL ON FUNCTION public.upsert_building_fee_account(uuid,text,text,text,numeric,uuid,boolean,boolean,boolean,boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_building_fee_account(uuid,text,text,text,numeric,uuid,boolean,boolean,boolean,boolean)
  TO authenticated, service_role;

-- Bản 7 tham số cũ giờ là overload dư. Bỏ đi để PostgREST không phải chọn nhập
-- nhằng giữa hai hàm cùng tên (caller cũ truyền theo TÊN nên bản 10 tham số phủ
-- hết nhờ DEFAULT). Chỉ DROP đúng chữ ký cũ.
DROP FUNCTION IF EXISTS public.upsert_building_fee_account(uuid,text,text,text,numeric,uuid,boolean);

COMMENT ON FUNCTION public.upsert_building_fee_account(uuid,text,text,text,numeric,uuid,boolean,boolean,boolean,boolean) IS
  'Khai/sửa cấu hình phí cố định của (toà × hạng mục). Tham số giá trị giữ nghĩa '
  '"NULL = giữ nguyên" để pay_period_fee học cấu hình mà không xoá cột nó không '
  'truyền; muốn XOÁ thì dùng p_clear_amount / p_clear_provider / p_clear_account '
  '(cờ xoá thắng giá trị truyền kèm). Cờ "Không áp dụng" ghi vào '
  'buildings.hidden_fixed_expenses (nguồn duy nhất) và luôn được đồng bộ xuống '
  'cột building_fee_accounts.not_applicable — trước 30/07/2026 cột đó không ai '
  'ghi (0/109 dòng true) nên giao diện hiện sai "đang áp dụng" cho ô đã tắt.';

-- ─────────────────────────────────────────────────────────────────────
-- 3. HÀM ĐỌC cho trang Cài đặt — trả CẢ ma trận, kể cả ô CHƯA khai
--
--    Trang Cài đặt cần thấy ô TRỐNG để biết còn thiếu gì (đo 30/07: org thật
--    53/162 ô chưa khai, DEMO 0/27). Nếu chỉ SELECT bảng cấu hình thì ô chưa
--    khai vô hình, đúng lý do hôm nay không ai biết mình còn nợ cấu hình.
--
--    VOLATILE: thân hàm gọi can_access_building/ie_all_buildings_scope, mà
--    trong repo này nhánh phân quyền có thể lấy khoá dòng (FOR SHARE) ⇒ khai
--    STABLE là ăn 25006 qua PostgREST. Án lệ đã cắn 5 lần, xem CLAUDE.md.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_fee_config_matrix_v1(p_building_ids uuid[] DEFAULT NULL)
 RETURNS TABLE (
   building_id        uuid,
   building_name      text,
   fee_category       text,
   provider_code      text,
   account_holder     text,
   default_amount     numeric,
   default_account_id uuid,
   default_account_name text,
   not_applicable     boolean,
   is_declared        boolean,
   last_voucher_date  date,
   voucher_count      integer
 )
 LANGUAGE sql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH kinds(k, ord) AS (
    VALUES ('tien_nha',1),('dien',2),('nuoc',3),('internet',4),('quan_ly',5),
           ('ve_sinh',6),('cong_an',7),('rac',8),('thang_may',9)
  ),
  b AS (
    SELECT bb.id, bb.name, COALESCE(bb.hidden_fixed_expenses,'{}') AS hidden
      FROM buildings bb
     WHERE bb.deleted_at IS NULL
       AND (p_building_ids IS NULL OR bb.id = ANY(p_building_ids))
       AND (public.can_access_building(bb.id)
         OR public.ie_all_buildings_scope(bb.id)
         OR bb.user_id = auth.uid()
         OR public.is_admin() OR public.is_super_admin())
  ),
  -- Lần đóng gần nhất theo (toà, hạng mục): cho chủ biết ô nào đang thực sự chạy
  -- và ô nào khai rồi mà chưa bao giờ dùng.
  used AS (
    SELECT ie.building_id AS bid, k.k AS kk,
           max(ie.voucher_date) AS last_date,
           count(DISTINCT ie.id)::int AS cnt
      FROM income_expense_items it
      JOIN income_expense_types t ON t.id = it.income_expense_type_id AND t.type='expense'
      JOIN income_expenses ie ON ie.id = it.income_expense_id
                             AND ie.type='EXPENSE'
                             AND ie.approval_status='APPROVED'
                             AND ie.deleted_at IS NULL
      CROSS JOIN kinds k
     WHERE public.fee_type_matches(k.k, t.category, t.name)
     GROUP BY 1,2
  )
  SELECT b.id, b.name, k.k,
         f.provider_code, f.account_holder, f.default_amount,
         f.default_account_id, a.name,
         (k.k = ANY(b.hidden))            AS not_applicable,
         (f.building_id IS NOT NULL)      AS is_declared,
         u.last_date, COALESCE(u.cnt, 0)
    FROM b
    CROSS JOIN kinds k
    LEFT JOIN building_fee_accounts f
      ON f.building_id = b.id AND f.fee_category = k.k AND f.deleted_at IS NULL
    LEFT JOIN accounts a ON a.id = f.default_account_id AND a.deleted_at IS NULL
    LEFT JOIN used u ON u.bid = b.id AND u.kk = k.k
   ORDER BY b.name, k.ord;
$function$;

REVOKE ALL ON FUNCTION public.get_fee_config_matrix_v1(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_fee_config_matrix_v1(uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_fee_config_matrix_v1(uuid[]) IS
  'Ma trận cấu hình phí cố định (toà × 9 hạng mục) cho trang Cài đặt. Trả CẢ ô '
  'CHƯA khai (is_declared=false) để thấy được phần còn nợ — đo 30/07/2026: org '
  'thật 53/162 ô chưa khai. not_applicable đọc từ buildings.hidden_fixed_expenses '
  '(nguồn duy nhất). Kèm last_voucher_date/voucher_count để phân biệt ô đang chạy '
  'thật với ô khai rồi chưa dùng. VOLATILE vì nhánh phân quyền có thể lấy khoá dòng.';

-- ─────────────────────────────────────────────────────────────────────
-- 4. TỰ KIỂM — thà nổ lúc apply hơn hỏng âm thầm trên trình duyệt
-- ─────────────────────────────────────────────────────────────────────
DO $selfcheck$
DECLARE
  v_lech int;
  v_def  text;
BEGIN
  -- (a) Sau đồng bộ, cột not_applicable phải khớp tuyệt đối nguồn duy nhất.
  SELECT count(*) INTO v_lech
    FROM building_fee_accounts f JOIN buildings b ON b.id = f.building_id
   WHERE f.deleted_at IS NULL
     AND f.not_applicable IS DISTINCT FROM (f.fee_category = ANY(COALESCE(b.hidden_fixed_expenses,'{}')));
  IF v_lech > 0 THEN
    RAISE EXCEPTION 'Còn % dòng lệch giữa not_applicable và hidden_fixed_expenses. DỪNG.', v_lech;
  END IF;

  -- (b) Chỉ được còn MỘT overload, kẻo PostgREST định tuyến nhập nhằng.
  SELECT count(*) INTO v_lech
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='upsert_building_fee_account';
  IF v_lech <> 1 THEN
    RAISE EXCEPTION 'upsert_building_fee_account có % overload, phải đúng 1. DỪNG.', v_lech;
  END IF;

  -- (c) pay_period_fee gọi bằng TÊN tham số nên phải còn khớp — nếu ai đó đổi
  --     tên tham số, việc học cấu hình sẽ vỡ ÂM THẦM mỗi lần đóng tiền.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='pay_period_fee';
  IF v_def IS NULL THEN RAISE EXCEPTION 'Không đọc được pay_period_fee. DỪNG.'; END IF;
  IF position('INSERT INTO building_fee_accounts' IN v_def) = 0 THEN
    RAISE EXCEPTION 'pay_period_fee không còn học cấu hình — khuôn ON CONFLICT đã đổi? DỪNG.';
  END IF;

  -- (d) anon KHÔNG được chạy hai hàm này.
  IF has_function_privilege('anon','public.get_fee_config_matrix_v1(uuid[])','EXECUTE')
     OR has_function_privilege('anon',
          'public.upsert_building_fee_account(uuid,text,text,text,numeric,uuid,boolean,boolean,boolean,boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'anon đang chạy được hàm cấu hình phí — REVOKE. DỪNG.';
  END IF;
  IF NOT has_function_privilege('authenticated','public.get_fee_config_matrix_v1(uuid[])','EXECUTE') THEN
    RAISE EXCEPTION 'authenticated không chạy được get_fee_config_matrix_v1 — trang Cài đặt sẽ trắng. DỪNG.';
  END IF;

  -- (e) Hàm đọc KHÔNG được khai STABLE/IMMUTABLE (án lệ 25006 qua PostgREST).
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='get_fee_config_matrix_v1' AND p.provolatile <> 'v'
  ) THEN
    RAISE EXCEPTION 'get_fee_config_matrix_v1 phải VOLATILE (nhánh authz lấy khoá dòng). DỪNG.';
  END IF;
END
$selfcheck$;

COMMIT;

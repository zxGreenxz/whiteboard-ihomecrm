-- P0 — generate_contract_number() đang đua: hai người tạo hợp đồng cùng lúc ra TRÙNG SỐ.
--
-- HIỆN TRẠNG (đọc thân hàm thật trên production 15/09/2026, oid 19313):
--   Hàm là BEFORE INSERT trigger, KHÔNG SECURITY DEFINER, KHÔNG search_path, và
--   lấy số kế tiếp bằng
--       SELECT COUNT(*) + 1 FROM contracts
--        WHERE user_id = NEW.user_id AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM NOW())
--   Không khoá gì cả. Hai transaction chạy song song đều đọc cùng một COUNT nên
--   cùng sinh một số. `idx_contracts_contract_number` KHÔNG unique nên database
--   không chặn, và `create_contract_v2` không truyền `contract_number` nên MỌI
--   hợp đồng đều đi qua đường này.
--
--   Đã trùng thật: 10 cặp (organization_id, contract_number) còn sống trên
--   production (HD-2026-00001..00006, 00009, 00010, 00024, 00274 — 20 dòng).
--   Vì thế file này KHÔNG tạo unique index: một unique index sẽ hoặc ngã ngay,
--   hoặc buộc phải sửa dữ liệu lịch sử — việc đó cần chủ quyết, không phải việc
--   của một migration kỹ thuật. Xem báo cáo plan F.
--
-- HAI SỬA:
--   1. Bảng đếm `app_private.contract_number_counters(organization_id, year)`.
--      Mỗi lần cấp số là một UPDATE trên ĐÚNG MỘT DÒNG → Postgres tự khoá dòng,
--      transaction thứ hai đợi rồi đọc giá trị đã tăng. Đây là chỗ đua biến mất.
--      Khoá đổi từ `user_id` sang `organization_id`: số hợp đồng là của công ty,
--      không phải của người gõ. 6/10 cặp trùng hiện có là hai user KHÁC NHAU
--      trong CÙNG một org — đúng lớp lỗi mà khoá cũ không thấy.
--
--   2. Đổi tên trigger `generate_contract_number_trigger` → `trg_generate_contract_number`.
--      BẮT BUỘC, không phải thẩm mỹ: Postgres bắn trigger cùng thời điểm theo
--      THỨ TỰ CHỮ CÁI của tên. Tên cũ ('g') đứng TRƯỚC `trg_autofill_org` ('t'),
--      nên lúc hàm chạy thì `NEW.organization_id` còn NULL và mọi thứ khoá theo
--      org sẽ hỏng. Tên mới nằm giữa `trg_autofill_org` và
--      `trg_set_contract_public_code`, và vẫn sau `contracts_set_user_id_audit`
--      (cần `NEW.user_id` để tra tiền tố).
--
-- SEED — vì sao không đếm bừa:
--   Production có 251 số hợp đồng NHẬP TỪ NGOÀI theo khuôn khác hẳn
--   ('HĐT-045073/11102024'). Lấy max chữ số cuối trên toàn bảng cho ra 31.082.025
--   → số kế tiếp sẽ nhảy lên tám chữ số. Nên seed chỉ đọc số ĐÚNG KHUÔN do chính
--   hàm này sinh ra: '<tiền tố>-<năm>-<số>'. Đo thật: PROD 372, DEMO 35.
--
-- GIÁ PHẢI TRẢ (nói thẳng): các lần tạo hợp đồng trong CÙNG một org + năm nay
--   xếp hàng sau nhau trên một dòng đếm, tới khi transaction cha commit. Đó là
--   cái giá của việc không trùng số. Với nhịp tạo hợp đồng của hệ này (445 hợp
--   đồng tổng cộng) nó không đo được.
--
-- Idempotent: chạy lại nhiều lần trong cùng một transaction không đổi kết quả.
-- KHÔNG apply trong session này — chỉ dry-run qua `npm run migrate:forward`.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Bảng đếm
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_private.contract_number_counters (
  organization_id uuid        NOT NULL,
  year            integer     NOT NULL,
  last_no         bigint      NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contract_number_counters_pkey PRIMARY KEY (organization_id, year),
  CONSTRAINT contract_number_counters_last_no_khong_am CHECK (last_no >= 0)
);

COMMENT ON TABLE app_private.contract_number_counters IS
  'Số hợp đồng kế tiếp theo (công ty, năm). Nằm ở app_private nên client không thấy: '
  'schema này chỉ cấp USAGE cho postgres và ie_canonical_writer. Chỉ generate_contract_number() ghi.';

-- app_private không cấp USAGE cho anon/authenticated, nhưng khai tường minh để
-- một lần GRANT nhầm ở schema khác không lặng lẽ mở bảng này ra.
REVOKE ALL ON TABLE app_private.contract_number_counters FROM PUBLIC;
REVOKE ALL ON TABLE app_private.contract_number_counters FROM anon, authenticated;

-- Seed cho các (org, năm) đã có số đúng khuôn. Hàm cũng tự seed khi gặp cặp mới,
-- nên khối này chỉ để trạng thái sau migration đọc được ngay bằng mắt.
INSERT INTO app_private.contract_number_counters (organization_id, year, last_no)
SELECT c.organization_id,
       (substring(c.contract_number from '-([0-9]{4})-[0-9]{1,9}$'))::int AS nam,
       max((substring(c.contract_number from '([0-9]{1,9})$'))::bigint)   AS last_no
  FROM public.contracts c
 WHERE c.organization_id IS NOT NULL
   AND c.contract_number ~ '-[0-9]{4}-[0-9]{1,9}$'
 GROUP BY 1, 2
ON CONFLICT (organization_id, year) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Hàm cấp số
-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY DEFINER vì hàm phải ghi app_private, mà người gọi (authenticated)
-- không có USAGE ở đó. search_path ghim cứng để không ai chèn schema giả.
CREATE OR REPLACE FUNCTION public.generate_contract_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_prefix  text;
  v_org     uuid   := NEW.organization_id;
  v_year    integer := EXTRACT(YEAR FROM now())::integer;
  v_seed    bigint;
  v_counter bigint;
  v_new     text;
  v_lan     integer := 0;
BEGIN
  IF NEW.contract_number IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Tiền tố theo cài đặt của người tạo, mặc định 'HD' (giữ nguyên hành vi cũ).
  -- Đo 15/09/2026: bảng settings KHÔNG có dòng nào key='contract_number_format',
  -- nên hôm nay nhánh này luôn ra 'HD'.
  SELECT COALESCE(s.value->>'contract_prefix', 'HD')
    INTO v_prefix
    FROM public.settings s
   WHERE s.user_id = NEW.user_id
     AND s.key = 'contract_number_format';
  IF v_prefix IS NULL OR v_prefix = '' THEN
    v_prefix := 'HD';
  END IF;

  -- Đường lùi: không xác định được công ty thì giữ nguyên cách đếm cũ thay vì
  -- ngã. Trên production nhánh này không chạy — `trg_autofill_org` đứng trước
  -- và luôn điền organization_id (có cả fallback về org PROD), và
  -- contracts.organization_id đang 0 dòng NULL.
  IF v_org IS NULL THEN
    SELECT COUNT(*) + 1
      INTO v_counter
      FROM public.contracts c
     WHERE c.user_id = NEW.user_id
       AND EXTRACT(YEAR FROM c.created_at) = v_year;
    NEW.contract_number := v_prefix || '-' || v_year::text || '-' || lpad(v_counter::text, 5, '0');
    RETURN NEW;
  END IF;

  -- Seed chỉ chạy khi cặp (org, năm) chưa có dòng đếm — tức một lần mỗi công ty
  -- mỗi năm. Không đặt ngoài IF: câu SELECT dưới đây quét contracts theo org, và
  -- chạy nó ở MỌI lần tạo hợp đồng là trả giá mãi mãi cho một việc dùng một lần.
  IF NOT EXISTS (
    SELECT 1 FROM app_private.contract_number_counters
     WHERE organization_id = v_org AND year = v_year
  ) THEN
    -- Seed CHỈ từ số đúng khuôn '<tiền tố>-<năm>-<số>'. Số nhập từ ngoài
    -- ('HĐT-045073/11102024') không khớp nên không kéo bộ đếm đi lung tung.
    -- KHÔNG lọc deleted_at: số của hợp đồng đã xoá mềm vẫn là số đã dùng.
    SELECT COALESCE(max((substring(c.contract_number from '([0-9]{1,9})$'))::bigint), 0)
      INTO v_seed
      FROM public.contracts c
     WHERE c.organization_id = v_org
       AND c.contract_number ~ ('-' || v_year::text || '-[0-9]{1,9}$');

    INSERT INTO app_private.contract_number_counters (organization_id, year, last_no)
    VALUES (v_org, v_year, v_seed)
    ON CONFLICT (organization_id, year) DO NOTHING;
  END IF;

  LOOP
    v_lan := v_lan + 1;

    -- ĐÂY là chỗ chống đua: UPDATE khoá đúng một dòng, transaction thứ hai đợi
    -- rồi đọc last_no đã tăng. Không dùng SELECT … FOR UPDATE rồi UPDATE riêng —
    -- một lệnh thì không có khe hở giữa đọc và ghi.
    UPDATE app_private.contract_number_counters
       SET last_no = last_no + 1,
           updated_at = now()
     WHERE organization_id = v_org
       AND year = v_year
    RETURNING last_no INTO v_counter;

    IF v_counter IS NULL THEN
      RAISE EXCEPTION 'generate_contract_number: khong co dong dem cho org % nam %', v_org, v_year;
    END IF;

    v_new := v_prefix || '-' || v_year::text || '-' || lpad(v_counter::text, 5, '0');

    -- Bộ đếm mới nên không biết các số trùng/lệch có từ trước. Nhảy qua số đã
    -- dùng thay vì đẻ thêm một cặp trùng nữa.
    EXIT WHEN NOT EXISTS (
      SELECT 1
        FROM public.contracts c
       WHERE c.organization_id = v_org
         AND c.contract_number = v_new
    );

    IF v_lan >= 1000 THEN
      RAISE EXCEPTION 'generate_contract_number: khong tim duoc so trong sau % lan (org %, nam %)',
        v_lan, v_org, v_year;
    END IF;
  END LOOP;

  NEW.contract_number := v_new;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.generate_contract_number() IS
  'BEFORE INSERT trên contracts: cấp contract_number theo (organization_id, năm) '
  'bằng bộ đếm khoá dòng ở app_private.contract_number_counters. Phải chạy SAU trg_autofill_org.';

-- Hàm trigger không cần EXECUTE của người gọi lúc bắn (Postgres chỉ kiểm lúc
-- CREATE TRIGGER), nên thu hồi được mà không ảnh hưởng gì. Trạng thái trước
-- migration đã là {postgres=X,service_role=X}; khai lại để CREATE OR REPLACE
-- sau này không âm thầm mở về PUBLIC (án lệ 07/08/2026 trong check-definer-acl).
REVOKE ALL ON FUNCTION public.generate_contract_number() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_contract_number() FROM anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Trigger: đổi tên để chạy SAU trg_autofill_org
-- ─────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS generate_contract_number_trigger ON public.contracts;
DROP TRIGGER IF EXISTS trg_generate_contract_number ON public.contracts;
CREATE TRIGGER trg_generate_contract_number
  BEFORE INSERT ON public.contracts
  FOR EACH ROW
  EXECUTE FUNCTION public.generate_contract_number();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Tự kiểm — thứ tự trigger là thứ dễ hỏng nhất ở đây và không có test nào khác canh
-- ─────────────────────────────────────────────────────────────────────────────
DO $ktra$
DECLARE
  v_cu      integer;
  v_autofill text;
  v_gen      text;
  v_secdef   boolean;
  v_cfg      text[];
BEGIN
  SELECT count(*) INTO v_cu
    FROM pg_trigger
   WHERE tgrelid = 'public.contracts'::regclass
     AND tgname = 'generate_contract_number_trigger';
  IF v_cu <> 0 THEN
    RAISE EXCEPTION 'trigger cu generate_contract_number_trigger van con tren contracts';
  END IF;

  SELECT tgname INTO v_autofill FROM pg_trigger
   WHERE tgrelid = 'public.contracts'::regclass AND tgname = 'trg_autofill_org';
  SELECT tgname INTO v_gen FROM pg_trigger
   WHERE tgrelid = 'public.contracts'::regclass AND tgname = 'trg_generate_contract_number';

  IF v_autofill IS NULL THEN
    RAISE EXCEPTION 'khong thay trigger trg_autofill_org tren contracts';
  END IF;
  IF v_gen IS NULL THEN
    RAISE EXCEPTION 'khong thay trigger trg_generate_contract_number tren contracts';
  END IF;
  IF NOT (v_autofill < v_gen) THEN
    RAISE EXCEPTION 'thu tu trigger sai: % phai dung truoc % (Postgres ban theo thu tu chu cai)',
      v_autofill, v_gen;
  END IF;

  SELECT p.prosecdef, p.proconfig INTO v_secdef, v_cfg
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'generate_contract_number';
  IF NOT COALESCE(v_secdef, false) THEN
    RAISE EXCEPTION 'generate_contract_number phai la SECURITY DEFINER';
  END IF;
  IF v_cfg IS NULL OR NOT (v_cfg::text LIKE '%search_path%') THEN
    RAISE EXCEPTION 'generate_contract_number phai ghim search_path';
  END IF;

  IF to_regclass('app_private.contract_number_counters') IS NULL THEN
    RAISE EXCEPTION 'thieu bang app_private.contract_number_counters';
  END IF;
END
$ktra$;

COMMIT;

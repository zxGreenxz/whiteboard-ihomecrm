-- =============================================================================
-- GĐ5 — Biên giới tổ chức SINH TỪ CATALOG, gắn ngay lúc CREATE TABLE
--
-- VÌ SAO VÁ XONG 304 BẢNG VẪN CHƯA XONG VIỆC.
-- Bốn giai đoạn trước đưa số bảng có biên giới từ 32 lên 297/304. Chúng không làm
-- gì cho bảng NGÀY MAI — mà đó đúng là cách khuyết tật này sinh ra:
-- 20260713121000_sprint3b gắn biên giới theo một danh sách viết tay 28 bảng vào
-- tháng 7 năm ngoái; mọi bảng ra đời sau đều thiếu, âm thầm, suốt hơn một năm,
-- cho tới khi đo mới lòi ra 272 bảng không có ranh giới nào giữa các công ty.
-- Vá xong rồi dừng nghĩa là hẹn gặp lại đúng vấn đề này sau một năm nữa.
--
-- Event trigger giải quyết ở đúng chỗ: policy được gắn TRONG CÙNG transaction với
-- CREATE TABLE. Không tồn tại khoảnh khắc nào một bảng sống trên production mà
-- thiếu biên giới. Cái này mạnh hơn "gate chặn ở CI" — gate có thể bị bỏ qua,
-- bị tắt, hoặc chạy sau khi đã apply; còn cơ chế này thì không thể bị quên.
--
-- ⚠ CÁI BẪY ĐÃ ĐO ĐƯỢC: `ALTER TABLE … ENABLE ROW LEVEL SECURITY` do chính hàm
-- phát ra LẠI là một `ddl_command_end`, nên nó gọi lại chính mình → đệ quy vô
-- hạn, chết bằng lỗi 54001 "stack depth limit exceeded" ngay lần CREATE TABLE đầu
-- tiên. Chốt chống tái nhập ở dưới không phải phòng xa, nó là điều kiện để hàm
-- chạy được lần nào.
--
-- Đã xác minh trên chính production (trong transaction rollback) rằng role
-- `postgres` của lane migration TẠO ĐƯỢC event trigger và nó BẮN THẬT, dù
-- rolsuper=false — Supabase cấp qua supautils/supabase_privileged_role.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- Hàm gắn biên giới cho MỘT bảng. Idempotent, im lặng khi không áp dụng.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_private.ensure_org_boundary_v1(p_relname text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_oid oid;
BEGIN
  SELECT c.oid INTO v_oid
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname = p_relname
     AND c.relkind IN ('r', 'p')          -- gồm cả bảng phân mảnh CHA
     AND NOT c.relispartition;            -- phân mảnh con thừa hưởng từ cha
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Cột phải tên ĐÚNG 'organization_id'.
  -- Dò theo '%organization_id' sẽ bắt cả source_organization_id /
  -- target_organization_id rồi sinh policy tham chiếu một cột không tồn tại →
  -- lỗi 42703 ngay giữa CREATE TABLE của người khác. Bảng nhiều cột org là ca
  -- cần con người phân xử, không phải ca cho máy đoán.
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
     WHERE a.attrelid = v_oid AND a.attname = 'organization_id'
       AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    RETURN false;
  END IF;

  IF EXISTS (SELECT 1 FROM app_private.org_boundary_exemptions e WHERE e.table_name = p_relname) THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid = v_oid AND p.polname = p_relname || '_org_boundary'
  ) THEN
    RETURN false;
  END IF;

  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', p_relname);
  EXECUTE format(
    'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
    'USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids()))) '
    'WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))',
    p_relname || '_org_boundary', p_relname);

  RAISE NOTICE 'org_boundary: đã gắn biên giới tổ chức cho public.%', p_relname;
  RETURN true;
END
$fn$;

COMMENT ON FUNCTION app_private.ensure_org_boundary_v1(text) IS
  'Gắn policy RESTRICTIVE <bảng>_org_boundary nếu bảng có cột organization_id và không nằm trong sổ miễn trừ. '
  'Idempotent. Gọi bởi event trigger org_boundary_tu_dong.';

-- ─────────────────────────────────────────────────────────────────────
-- Event trigger. Chốt chống tái nhập là bắt buộc — xem khối chú thích đầu file.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_private.trg_org_boundary_tu_dong()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  o record;
  v_ten text;
BEGIN
  -- CHỐT CHỐNG TÁI NHẬP.
  -- ALTER TABLE … ENABLE ROW LEVEL SECURITY mà hàm ensure_ phát ra chính nó là
  -- một ddl_command_end. Không có chốt này thì lần CREATE TABLE đầu tiên chết
  -- bằng 54001 stack depth limit exceeded.
  IF coalesce(current_setting('app.org_boundary_guard', true), '') = 'on' THEN
    RETURN;
  END IF;
  PERFORM set_config('app.org_boundary_guard', 'on', true);

  FOR o IN
    SELECT objid, command_tag, object_type
      FROM pg_event_trigger_ddl_commands()
     WHERE command_tag IN ('CREATE TABLE', 'ALTER TABLE')
  LOOP
    SELECT c.relname INTO v_ten
      FROM pg_class c
     WHERE c.oid = o.objid AND c.relnamespace = 'public'::regnamespace;
    IF v_ten IS NOT NULL THEN
      PERFORM app_private.ensure_org_boundary_v1(v_ten);
    END IF;
  END LOOP;

  PERFORM set_config('app.org_boundary_guard', 'off', true);
EXCEPTION WHEN OTHERS THEN
  -- Nhả chốt cả trên đường lỗi. Không nhả thì mọi DDL còn lại trong cùng
  -- transaction bị bỏ qua ÂM THẦM — bảng mới sinh ra không có biên giới và
  -- không ai biết, đúng kiểu hỏng mà cả việc này sinh ra để chống.
  PERFORM set_config('app.org_boundary_guard', 'off', true);
  RAISE;
END
$fn$;

DROP EVENT TRIGGER IF EXISTS org_boundary_tu_dong;
CREATE EVENT TRIGGER org_boundary_tu_dong
  ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'ALTER TABLE')
  EXECUTE FUNCTION app_private.trg_org_boundary_tu_dong();

-- ─────────────────────────────────────────────────────────────────────
-- VERIFY — bắn thử event trigger thật, cả ca thuận lẫn ca ngược.
-- Một event trigger được cài mà không ai thử bắn là một event trigger không ai
-- biết có chạy hay không.
-- ─────────────────────────────────────────────────────────────────────
DO $verify$
DECLARE
  v_permissive boolean;
  v_cmd "char";
  v_co_policy boolean;
BEGIN
  -- CA THUẬN: bảng mới có organization_id → phải TỰ nhận policy.
  CREATE TABLE public.zz_thu_bien_gioi (id int, organization_id uuid);

  SELECT p.polpermissive, p.polcmd
    INTO v_permissive, v_cmd
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relname = 'zz_thu_bien_gioi' AND p.polname = 'zz_thu_bien_gioi_org_boundary';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event trigger KHÔNG bắn: bảng mới có organization_id mà không có biên giới. DỪNG.';
  END IF;
  IF v_permissive THEN
    RAISE EXCEPTION 'Policy tự sinh ra PERMISSIVE (nới quyền) thay vì RESTRICTIVE. DỪNG.';
  END IF;
  IF v_cmd <> '*' THEN
    RAISE EXCEPTION 'Policy tự sinh không phủ FOR ALL (đang là %). DỪNG.', v_cmd;
  END IF;

  -- CA NGƯỢC: bảng KHÔNG có cột org → không được đụng vào.
  CREATE TABLE public.zz_thu_khong_org (id int, ghi_chu text);
  SELECT EXISTS (
    SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
     WHERE c.relname = 'zz_thu_khong_org'
  ) INTO v_co_policy;
  IF v_co_policy THEN
    RAISE EXCEPTION 'Event trigger gắn policy cho bảng KHÔNG có organization_id — dò cột đang quá rộng. DỪNG.';
  END IF;

  -- CA THÊM CỘT: ALTER TABLE thêm organization_id cũng phải được bắt.
  ALTER TABLE public.zz_thu_khong_org ADD COLUMN organization_id uuid;
  SELECT EXISTS (
    SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
     WHERE c.relname = 'zz_thu_khong_org' AND p.polname = 'zz_thu_khong_org_org_boundary'
  ) INTO v_co_policy;
  IF NOT v_co_policy THEN
    RAISE EXCEPTION 'ALTER TABLE thêm organization_id không được gắn biên giới. DỪNG.';
  END IF;

  DROP TABLE IF EXISTS public.zz_thu_bien_gioi;
  DROP TABLE IF EXISTS public.zz_thu_khong_org;

  RAISE NOTICE 'org_boundary: event trigger bắn đúng cả ba ca (tạo mới, không có cột, thêm cột).';
END
$verify$;

-- Chốt cuối: không để sót bảng thử nào.
DO $don_dep$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class WHERE relname LIKE 'zz_thu_%' AND relnamespace = 'public'::regnamespace
  ) THEN
    RAISE EXCEPTION 'Còn sót bảng thử zz_thu_* trên production. DỪNG.';
  END IF;
END
$don_dep$;

COMMIT;

-- =============================================================================
-- ROLLBACK:
--   DROP EVENT TRIGGER IF EXISTS org_boundary_tu_dong;
--   DROP FUNCTION IF EXISTS app_private.trg_org_boundary_tu_dong();
--   DROP FUNCTION IF EXISTS app_private.ensure_org_boundary_v1(text);
-- Bỏ lớp này = quay lại trạng thái "bảng mới ra đời không có biên giới, và
-- không ai biết", tức đúng khuyết tật đã âm thầm hơn một năm.
-- =============================================================================

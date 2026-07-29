-- =====================================================================
-- Đợt 1 — Công tắc "Chuẩn kế toán" (BẤT ĐỘNG)
--
-- Đặt công tắc chặt/linh hoạt lên SERVER trước, khi chưa writer nào đọc và
-- chưa nút nào xuất hiện. Sau migration này hành vi hệ thống KHÔNG đổi một
-- chút nào — chỉ có thêm một bảng, ba hàm và một cột trong RPC cờ client.
--
-- VÌ SAO KHÔNG DÙNG app_private.server_feature_flags:
--   Bảng đó KHÔNG có cột organization_id (đã kiểm: feature_key, domain,
--   risk_class, mode, force_freeze, config_version, starts_at, ends_at, …).
--   Hành vi theo-org chỉ có qua server_feature_flag_canary_orgs với cửa sổ
--   starts_at/ends_at HỮU HẠN và trả FROZEN khi hết hạn. Bật "linh hoạt cho
--   org DEMO" trên cơ chế đó là bật luôn cho ORG THẬT.
--
-- VÌ SAO KHÔNG COPY NGUYÊN set_ie_auto_approve_threshold_v1:
--   Mẫu đó suy ra org bằng `min(m.organization_id::text)::uuid` rồi mới ưu
--   tiên org mà actor là chủ. Với chủ có 2 org, `min()` chọn
--   'aaaa0000-…' = ORG THẬT. Một cú bấm định làm trên DEMO sẽ ghi vào org
--   thật mà không báo gì. Ở đây `p_organization_id` là THAM SỐ BẮT BUỘC và
--   quyền chủ được kiểm TRONG ĐÚNG ORG ĐÓ.
--
-- ĐỂ Ở app_private (khác plan gốc ghi `public.org_accounting_mode`):
--   schema app_private không nằm trong danh sách schema PostgREST phơi ra,
--   nên bảng không tồn tại với client kể cả khi ai đó lỡ GRANT sau này —
--   chặt hơn "public + REVOKE" mà vẫn đúng yêu cầu "không cấp cho
--   authenticated". Đồng bộ với bảng anh em app_private.ie_auto_approve_config.
-- =====================================================================

BEGIN;

-- ── 1. Sổ thay đổi chế độ (APPEND-ONLY) ─────────────────────────────
-- Một điều khiển quyết định "được sửa tiền tới đâu" thì mọi lần bật/tắt
-- phải để lại dấu. Không dùng income_expense_audit_log vì sổ đó theo TỪNG
-- PHIẾU và có hash-chain riêng.
CREATE TABLE IF NOT EXISTS app_private.org_accounting_mode (
  id                  bigserial PRIMARY KEY,
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  strict_mode         boolean NOT NULL,
  effective_from      timestamptz NOT NULL DEFAULT now(),
  actor_user_id       uuid,
  actor_membership_id uuid,
  reason              text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_org_accounting_mode_lookup
  ON app_private.org_accounting_mode (organization_id, effective_from DESC, id DESC);

REVOKE ALL ON app_private.org_accounting_mode FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE app_private.org_accounting_mode_id_seq
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE app_private.org_accounting_mode IS
  'Sổ append-only bật/tắt chế độ Chuẩn kế toán theo tổ chức. Dòng mới nhất theo (effective_from, id) là chế độ đang hiệu lực. Thiếu dòng = CHUẨN KẾ TOÁN (fail-closed).';

CREATE OR REPLACE FUNCTION app_private.guard_org_accounting_mode_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'app_private.org_accounting_mode là append-only (thao tác %)', TG_OP
    USING ERRCODE = '55000';
END
$fn$;

DROP TRIGGER IF EXISTS a00_org_accounting_mode_append_only ON app_private.org_accounting_mode;
CREATE TRIGGER a00_org_accounting_mode_append_only
  BEFORE UPDATE OR DELETE ON app_private.org_accounting_mode
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_org_accounting_mode_append_only();

DROP TRIGGER IF EXISTS a00_org_accounting_mode_no_truncate ON app_private.org_accounting_mode;
CREATE TRIGGER a00_org_accounting_mode_no_truncate
  BEFORE TRUNCATE ON app_private.org_accounting_mode
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.guard_org_accounting_mode_append_only();

-- ── 2. Đọc chế độ — FAIL-CLOSED THẬT ────────────────────────────────
CREATE OR REPLACE FUNCTION app_private.ie_accounting_strict_v1(p_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT COALESCE(
    (SELECT m.strict_mode
       FROM app_private.org_accounting_mode m
      WHERE m.organization_id = p_org
        AND m.effective_from <= now()
      ORDER BY m.effective_from DESC, m.id DESC
      LIMIT 1),
    true  -- KHÔNG có dòng nào ⇒ CHUẨN KẾ TOÁN. Org mới, org lạ, lỗi đọc:
          -- tất cả đều rơi về hành vi chặt hiện hành.
  );
$fn$;

REVOKE ALL ON FUNCTION app_private.ie_accounting_strict_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Cổng duy nhất mọi RPC linh hoạt (Đợt 4/5) sẽ gọi.
CREATE OR REPLACE FUNCTION app_private.ie_flex_mode_enabled_v1(p_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT NOT app_private.ie_accounting_strict_v1(p_org);
$fn$;

REVOKE ALL ON FUNCTION app_private.ie_flex_mode_enabled_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION app_private.ie_flex_mode_enabled_v1(uuid) IS
  'Org này có đang ở chế độ THU CHI LINH HOẠT không? Mọi RPC linh hoạt phải gọi hàm này và raise 55000 kèm dấu [STRICT_MODE] khi trả false.';

-- ── 3. Ai được đổi công tắc ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_private.is_org_owner_v1(p_org uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.role_bindings rb
    JOIN public.organization_memberships m
      ON m.id = rb.membership_id
     AND m.organization_id = rb.organization_id
     AND m.user_id = p_user
     AND m.status = 'ACTIVE'
     AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= now()
     AND (m.valid_to IS NULL OR m.valid_to > now())
    JOIN public.organization_roles r
      ON r.id = rb.role_id AND r.name = 'Chủ sở hữu tổ chức'
    WHERE rb.organization_id = p_org
  );
$fn$;

REVOKE ALL ON FUNCTION app_private.is_org_owner_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ── 4. RPC đọc — một dòng cho MỖI tổ chức actor đang thuộc ──────────
-- Cố ý trả theo-org thay vì suy ra "org của tôi": chủ có 2 org sẽ thấy 2
-- dòng có TÊN rõ ràng, không bao giờ bấm nhầm org.
CREATE OR REPLACE FUNCTION public.list_ie_accounting_standard_v1()
RETURNS TABLE(
  organization_id uuid,
  organization_name text,
  strict_mode boolean,
  can_manage boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT o.id,
         o.name,
         app_private.ie_accounting_strict_v1(o.id),
         app_private.is_org_owner_v1(o.id, auth.uid()) OR public.is_super_admin()
  FROM public.organizations o
  JOIN public.organization_memberships m
    ON m.organization_id = o.id
   AND m.user_id = auth.uid()
   AND m.status = 'ACTIVE'
  ORDER BY o.name;
$fn$;

REVOKE ALL ON FUNCTION public.list_ie_accounting_standard_v1()
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.list_ie_accounting_standard_v1() TO authenticated;

-- ── 5. RPC ghi — org là THAM SỐ BẮT BUỘC ────────────────────────────
CREATE OR REPLACE FUNCTION public.set_ie_accounting_standard_v1(
  p_organization_id uuid,
  p_strict boolean,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_membership uuid;
  v_current boolean;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'Thiếu tổ chức — không suy đoán tổ chức để tránh đổi nhầm org thật'
      USING ERRCODE = '22023';
  END IF;
  IF p_strict IS NULL THEN
    RAISE EXCEPTION 'Thiếu giá trị chế độ' USING ERRCODE = '22023';
  END IF;

  SELECT m.id INTO v_membership
  FROM public.organization_memberships m
  WHERE m.user_id = v_actor
    AND m.organization_id = p_organization_id
    AND m.status = 'ACTIVE'
    AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= now()
    AND (m.valid_to IS NULL OR m.valid_to > now())
  LIMIT 1;

  IF v_membership IS NULL AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Không thuộc tổ chức này' USING ERRCODE = '42501';
  END IF;

  -- Quyền chủ kiểm TRONG ĐÚNG ORG được truyền vào.
  IF NOT (app_private.is_org_owner_v1(p_organization_id, v_actor)
          OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Chỉ Chủ sở hữu tổ chức được đổi chế độ Chuẩn kế toán'
      USING ERRCODE = '42501';
  END IF;

  v_current := app_private.ie_accounting_strict_v1(p_organization_id);

  -- Không ghi dòng rác khi bấm lại đúng giá trị đang chạy.
  IF v_current IS NOT DISTINCT FROM p_strict THEN
    RETURN jsonb_build_object(
      'organization_id', p_organization_id,
      'strict_mode', v_current,
      'changed', false
    );
  END IF;

  INSERT INTO app_private.org_accounting_mode
    (organization_id, strict_mode, actor_user_id, actor_membership_id, reason)
  VALUES
    (p_organization_id, p_strict, v_actor, v_membership, NULLIF(btrim(COALESCE(p_reason,'')), ''));

  RETURN jsonb_build_object(
    'organization_id', p_organization_id,
    'strict_mode', p_strict,
    'changed', true
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.set_ie_accounting_standard_v1(uuid, boolean, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.set_ie_accounting_standard_v1(uuid, boolean, text) TO authenticated;

-- ── 6. Cờ client: thêm cột thứ 6 ────────────────────────────────────
-- BẮT BUỘC DROP rồi CREATE: hàm đang là RETURNS TABLE, thêm cột bằng
-- CREATE OR REPLACE sẽ raise 42P13. DROP xoá luôn ACL nên phải cấp lại
-- ĐÚNG như cũ (đã dump: postgres=X/postgres, authenticated=X/postgres).
DROP FUNCTION IF EXISTS public.get_finance_v2_client_flags_v1();

CREATE FUNCTION public.get_finance_v2_client_flags_v1()
RETURNS TABLE(
  organization_id uuid,
  read_semantics_route text,
  workflow_route text,
  posting_route text,
  access_route text,
  accounting_standard_strict boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT m.organization_id,
         app_private.finance_v2_route_pure_v1('income_expense.read_semantics.v2', m.organization_id),
         app_private.finance_v2_route_pure_v1('income_expense.workflow.v2', m.organization_id),
         app_private.finance_v2_route_pure_v1('income_expense.posting.v2', m.organization_id),
         app_private.finance_v2_route_pure_v1('cashbook.access.v2', m.organization_id),
         app_private.ie_accounting_strict_v1(m.organization_id)
  FROM public.organization_memberships m
  WHERE m.user_id = auth.uid() AND m.status = 'ACTIVE';
$fn$;

REVOKE ALL ON FUNCTION public.get_finance_v2_client_flags_v1() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_finance_v2_client_flags_v1() TO authenticated;

-- ── 7. Seed: hai org đã biết chuyển sang LINH HOẠT ──────────────────
-- Mặc định của hàm đọc là CHẶT (fail-closed cho org mới/lạ); còn hai org
-- đang chạy thì chủ đã chọn linh hoạt, nên ghi TƯỜNG MINH. Mặc định và
-- seed CỐ Ý ngược nhau — đó không phải nhầm lẫn.
INSERT INTO app_private.org_accounting_mode
  (organization_id, strict_mode, reason)
SELECT o.id, false, 'Seed Đợt 1 — chủ chọn chế độ thu chi linh hoạt cho mô hình nhỏ'
FROM public.organizations o
WHERE o.id IN (
  'aaaa0000-0000-4000-8000-000000000001',
  'dddd0000-0000-4000-8000-000000000001'
)
AND NOT EXISTS (
  SELECT 1 FROM app_private.org_accounting_mode m WHERE m.organization_id = o.id
);

COMMIT;

NOTIFY pgrst, 'reload schema';

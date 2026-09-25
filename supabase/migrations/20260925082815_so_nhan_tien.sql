-- =============================================================================
-- so_nhan_tien — sổ nhận tiền theo hình thức thu + đổi hình thức thu của khoản thu
-- Ngày 25/09/2026 · đợt 1 "sửa phiếu thu chi" · chủ chốt: "sổ quỹ là đã được đính
-- kèm gắn cứng sẵn với từng hình thức thu của từng người"; "chuyển khoản: A"
-- (mỗi toà một danh sách sổ được nhận = sổ mặc định + sổ phụ); người thu được đổi
-- hình thức thu (sổ đi theo hình thức); "không được phép thay đổi dữ liệu đang tồn tại".
-- =============================================================================
-- VÌ SAO
--   Luật "hình thức nào vào sổ nào" chỉ nằm ở giao diện (src/lib/cashAccount.ts);
--   máy chủ chỉ kiểm người thu có giữ/biết sổ. Đo prod 60 ngày: TM 235/239 đúng
--   sổ tiền mặt riêng (4 lần nhầm vào sổ ngân hàng); TT 81/81 đúng sổ mặc định toà;
--   TK 302/337 đúng sổ mặc định, 35 lần vào sổ ngân hàng khác của chính người thu
--   (NATHAN TKHIEP ×28 ở 102LVT/1392QT/403PVB/405PVB/512TT; JOEY CGIANG8818 ×6 ở
--   950NK). Muốn sửa hình thức/sổ của khoản thu thì phải hoàn tác rồi thu lại.
--
-- LÀM GÌ
--   1. app_private.personal_cash_books: sổ tiền mặt riêng của từng thành viên
--      (có hiệu lực theo thời gian, tối đa 1 dòng đang hiệu lực / thành viên).
--   2. app_private.building_receiving_cashbooks: sổ PHỤ nhận TK/TT theo toà; sổ mặc
--      định vẫn ở buildings.default_account_id_tk/_tt.
--   3. Khởi tạo (chỉ ghi vào HAI BẢNG MỚI): sổ tiền mặt riêng = sổ tên "…Thu" không
--      ảo do chính người đó sở hữu và đang giữ (ưu tiên is_default) ⇒ NATHAN Hiệp Thu,
--      JOEY Hiển Thu, B.Huy Huy Thu, NG TÂM Tâm Thu; tài khoản chủ công ty không có
--      sổ. Sổ phụ TK: 102LVT, 1392QT, 403PVB, 405PVB, 512TT → TKHIEP; 950NK → CGIANG8818.
--   4. app_private.receiving_cashbook_ids_v1 / receiving_cashbook_allowed_v1:
--      TM = sổ riêng của người thu; TK/TT = {mặc định} ∪ sổ phụ, giao với sổ người
--      thu đang giữ hoặc biết (đúng luật possession của thu tiền hiện hành).
--   5. RPC đọc: get_receiving_cashbooks_v1 (người thu / chủ công ty),
--      list_receiving_cashbook_settings_v1 (chủ công ty). RPC cài:
--      set_personal_cash_book_v1, set_building_receiving_cashbooks_v1 (chủ công ty).
--   6. app_private.move_posted_income_cashbook_v1: lõi đổi sổ của phiếu thu đã ghi
--      sổ (tách từ move_income_voucher_cashbook_v1 — hàm đó gỡ ở migration đóng
--      đường cũ sau khi web mới lên).
--   7. public.change_collection_tender_method_v1: đổi hình thức thu (và sổ trong
--      danh sách cho phép) của một dòng thu; không đổi số tiền, không đổi nợ hoá
--      đơn; lưu lịch sử income_expense_revisions kind COLLECTION_METHOD.
--   Máy chủ BẮT luật danh sách sổ lúc thu (record_invoice_collection_v5) ở migration
--   đóng đường cũ, sau khi giao diện mới lên.
--
-- KHÔNG ĐỤNG
--   Không sửa dữ liệu đang có: không UPDATE sổ, toà, khoản thu, phiếu nào lúc
--   migrate. Chỉ tạo bảng/hàm và ghi khởi tạo vào hai bảng mới.
--
-- ĐƯỜNG LÙI
--   REVOKE EXECUTE các RPC mới khỏi authenticated. Hai bảng cấu hình để nguyên.
--
-- Chạy được hai lượt liên tiếp và trên DB rỗng của Restore Drill.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 0. Nền phải có (M3 của đợt này tạo bảng lịch sử sửa phiếu).
DO $truoc$
BEGIN
  IF to_regclass('public.income_expense_revisions') IS NULL THEN
    RAISE EXCEPTION 'Thiếu public.income_expense_revisions — chạy migration sua_phieu_cho_duyet trước'
      USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- ---------------------------------------------------------------------------
-- 1. Hai bảng cấu hình.
CREATE TABLE IF NOT EXISTS app_private.personal_cash_books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  membership_id uuid NOT NULL REFERENCES public.organization_memberships(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  valid_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  valid_to timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS personal_cash_books_dang_hieu_luc
  ON app_private.personal_cash_books (membership_id) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS personal_cash_books_org
  ON app_private.personal_cash_books (organization_id);

CREATE TABLE IF NOT EXISTS app_private.building_receiving_cashbooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  building_id uuid NOT NULL REFERENCES public.buildings(id) ON DELETE CASCADE,
  payment_method text NOT NULL CHECK (payment_method IN ('TK', 'TT')),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (building_id, payment_method, account_id)
);
CREATE INDEX IF NOT EXISTS building_receiving_cashbooks_org
  ON app_private.building_receiving_cashbooks (organization_id);

REVOKE ALL ON app_private.personal_cash_books, app_private.building_receiving_cashbooks
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Khởi tạo — chỉ ghi vào hai bảng mới, bỏ qua dòng đã có.
INSERT INTO app_private.personal_cash_books (organization_id, membership_id, account_id)
SELECT m.organization_id, m.id, x.account_id
  FROM public.organization_memberships m
  CROSS JOIN LATERAL (
    SELECT a.id AS account_id
      FROM public.accounts a
     WHERE a.organization_id = m.organization_id
       AND a.user_id = m.user_id
       AND a.deleted_at IS NULL
       AND NOT COALESCE(a.is_virtual, false)
       AND a.name ~* '\mthu\s*$'
       AND EXISTS (
         SELECT 1 FROM public.cashbook_possession_bindings b
          WHERE b.organization_id = m.organization_id
            AND b.cashbook_id = a.id
            AND b.membership_id = m.id
            AND b.possession_kind = 'CUSTODIAN'
            AND b.valid_to IS NULL)
     ORDER BY COALESCE(a.is_default, false) DESC, a.created_at, a.id
     LIMIT 1
  ) x
 WHERE m.status = 'ACTIVE'
   AND NOT EXISTS (
     SELECT 1 FROM app_private.personal_cash_books p WHERE p.membership_id = m.id);

INSERT INTO app_private.building_receiving_cashbooks (organization_id, building_id, payment_method, account_id)
SELECT b.organization_id, b.id, 'TK', a.id
  FROM (VALUES ('102LVT', 'TKHIEP'), ('1392QT', 'TKHIEP'), ('403PVB', 'TKHIEP'),
               ('405PVB', 'TKHIEP'), ('512TT', 'TKHIEP'), ('950NK', 'CGIANG8818')) s(toa, so)
  JOIN public.buildings b ON b.name = s.toa AND b.deleted_at IS NULL
  JOIN public.accounts a ON a.name = s.so AND a.organization_id = b.organization_id
                        AND a.deleted_at IS NULL AND NOT COALESCE(a.is_virtual, false)
 WHERE a.id IS DISTINCT FROM b.default_account_id_tk
ON CONFLICT (building_id, payment_method, account_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Danh sách sổ được nhận.
CREATE OR REPLACE FUNCTION app_private.receiving_cashbook_ids_v1(
  p_org uuid, p_building uuid, p_method text, p_membership uuid)
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
  -- TM: sổ tiền mặt riêng đang hiệu lực của người thu.
  -- TK/TT: sổ mặc định của toà (đứng đầu) rồi các sổ phụ, chỉ giữ sổ thật còn
  -- dùng và người thu đang GIỮ hoặc BIẾT (p_membership NULL ⇒ không lọc).
  WITH ung_vien AS (
    SELECT p.account_id, 0 AS thu_tu
      FROM app_private.personal_cash_books p
     WHERE p_method = 'TM'
       AND p.organization_id = p_org
       AND p.membership_id = p_membership
       AND p.valid_to IS NULL
    UNION ALL
    SELECT CASE p_method WHEN 'TK' THEN b.default_account_id_tk ELSE b.default_account_id_tt END, 0
      FROM public.buildings b
     WHERE p_method IN ('TK', 'TT')
       AND b.id = p_building
       AND b.organization_id = p_org
    UNION ALL
    SELECT r.account_id, 1
      FROM app_private.building_receiving_cashbooks r
     WHERE p_method IN ('TK', 'TT')
       AND r.building_id = p_building
       AND r.organization_id = p_org
       AND r.payment_method = p_method
  ), gon AS (
    SELECT DISTINCT ON (u.account_id) u.account_id, u.thu_tu, a.name
      FROM ung_vien u
      JOIN public.accounts a ON a.id = u.account_id
                            AND a.organization_id = p_org
                            AND a.deleted_at IS NULL
                            AND NOT COALESCE(a.is_virtual, false)
     WHERE u.account_id IS NOT NULL
       AND (p_method = 'TM' OR p_membership IS NULL
            OR app_private.ie_has_cashbook_possession_v1(p_org, u.account_id, p_membership))
     ORDER BY u.account_id, u.thu_tu
  )
  SELECT COALESCE(array_agg(g.account_id ORDER BY g.thu_tu, g.name, g.account_id), '{}'::uuid[])
    FROM gon g
$function$;

CREATE OR REPLACE FUNCTION app_private.receiving_cashbook_allowed_v1(
  p_org uuid, p_building uuid, p_method text, p_membership uuid, p_account uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
  SELECT COALESCE(
    p_account = ANY (app_private.receiving_cashbook_ids_v1(p_org, p_building, p_method, p_membership)),
    false)
$function$;

REVOKE ALL ON FUNCTION app_private.receiving_cashbook_ids_v1(uuid, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.receiving_cashbook_allowed_v1(uuid, uuid, text, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Thành viên (đang hoạt động, hoặc gần nhất) của một người trong tổ chức.
CREATE OR REPLACE FUNCTION app_private.member_of_org_v1(p_org uuid, p_user uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT m.id
    FROM public.organization_memberships m
   WHERE m.organization_id = p_org AND m.user_id = p_user
   ORDER BY (m.status = 'ACTIVE') DESC, m.valid_from DESC NULLS LAST, m.id
   LIMIT 1
$function$;
REVOKE ALL ON FUNCTION app_private.member_of_org_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Đọc danh sách sổ được nhận cho một người thu (màn thu tiền, hộp đổi hình thức).
CREATE OR REPLACE FUNCTION public.get_receiving_cashbooks_v1(
  p_organization_id uuid,
  p_building_id uuid DEFAULT NULL,
  p_collector_user_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := app_private.current_uid_v1();
  v_collector uuid;
  v_membership uuid;
  v_personal jsonb;
  v_tk jsonb := '[]'::jsonb;
  v_tt jsonb := '[]'::jsonb;
  v_default_tk uuid;
  v_default_tt uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'Thiếu tổ chức' USING ERRCODE = '22023';
  END IF;
  IF NOT public.is_super_admin() AND NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
     WHERE m.organization_id = p_organization_id AND m.user_id = v_actor AND m.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Không thuộc tổ chức này' USING ERRCODE = '42501';
  END IF;

  v_collector := COALESCE(p_collector_user_id, v_actor);
  IF v_collector <> v_actor
     AND NOT public.is_super_admin()
     AND NOT app_private.ie_actor_is_company_owner_v1(p_organization_id, v_actor) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty xem được sổ nhận tiền của người khác' USING ERRCODE = '42501';
  END IF;
  v_membership := app_private.member_of_org_v1(p_organization_id, v_collector);

  SELECT jsonb_build_object('id', a.id, 'name', a.name) INTO v_personal
    FROM public.accounts a
   WHERE a.id = (app_private.receiving_cashbook_ids_v1(p_organization_id, NULL, 'TM', v_membership))[1];

  IF p_building_id IS NOT NULL THEN
    SELECT b.default_account_id_tk, b.default_account_id_tt INTO v_default_tk, v_default_tt
      FROM public.buildings b
     WHERE b.id = p_building_id AND b.organization_id = p_organization_id AND b.deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Toà nhà không thuộc tổ chức' USING ERRCODE = '42501';
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'isDefault', a.id = v_default_tk)
                              ORDER BY x.ord), '[]'::jsonb)
      INTO v_tk
      FROM unnest(app_private.receiving_cashbook_ids_v1(p_organization_id, p_building_id, 'TK', v_membership))
           WITH ORDINALITY AS x(id, ord)
      JOIN public.accounts a ON a.id = x.id;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'isDefault', a.id = v_default_tt)
                              ORDER BY x.ord), '[]'::jsonb)
      INTO v_tt
      FROM unnest(app_private.receiving_cashbook_ids_v1(p_organization_id, p_building_id, 'TT', v_membership))
           WITH ORDINALITY AS x(id, ord)
      JOIN public.accounts a ON a.id = x.id;
  END IF;

  RETURN jsonb_build_object(
    'collectorUserId', v_collector,
    'personalCashBook', v_personal,
    'TK', v_tk,
    'TT', v_tt);
END
$function$;

-- ---------------------------------------------------------------------------
-- 5. Màn cài "Sổ nhận tiền" (chủ công ty).
CREATE OR REPLACE FUNCTION public.list_receiving_cashbook_settings_v1(p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := app_private.current_uid_v1();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'Thiếu tổ chức' USING ERRCODE = '22023';
  END IF;
  IF NOT public.is_super_admin()
     AND NOT app_private.ie_actor_is_company_owner_v1(p_organization_id, v_actor) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty cài được sổ nhận tiền' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'members', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'membershipId', m.id,
               'userId', m.user_id,
               'name', COALESCE(NULLIF(btrim(pr.full_name), ''), u.email),
               'memberType', m.member_type,
               'personalCashBook', (
                 SELECT jsonb_build_object('id', a.id, 'name', a.name)
                   FROM app_private.personal_cash_books p
                   JOIN public.accounts a ON a.id = p.account_id
                  WHERE p.membership_id = m.id AND p.valid_to IS NULL
                  LIMIT 1))
             ORDER BY COALESCE(NULLIF(btrim(pr.full_name), ''), u.email))
        FROM public.organization_memberships m
        JOIN auth.users u ON u.id = m.user_id
        LEFT JOIN public.profiles pr ON pr.id = m.user_id
       WHERE m.organization_id = p_organization_id AND m.status = 'ACTIVE'), '[]'::jsonb),
    'buildings', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', b.id,
               'name', b.name,
               'TK', jsonb_build_object(
                 'defaultAccountId', b.default_account_id_tk,
                 'extraAccountIds', COALESCE((
                   SELECT jsonb_agg(r.account_id ORDER BY r.created_at, r.account_id)
                     FROM app_private.building_receiving_cashbooks r
                    WHERE r.building_id = b.id AND r.payment_method = 'TK'), '[]'::jsonb)),
               'TT', jsonb_build_object(
                 'defaultAccountId', b.default_account_id_tt,
                 'extraAccountIds', COALESCE((
                   SELECT jsonb_agg(r.account_id ORDER BY r.created_at, r.account_id)
                     FROM app_private.building_receiving_cashbooks r
                    WHERE r.building_id = b.id AND r.payment_method = 'TT'), '[]'::jsonb)))
             ORDER BY b.name)
        FROM public.buildings b
       WHERE b.organization_id = p_organization_id AND b.deleted_at IS NULL), '[]'::jsonb),
    'accounts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', a.id,
               'name', a.name,
               'custodianMembershipIds', COALESCE((
                 SELECT jsonb_agg(DISTINCT b.membership_id)
                   FROM public.cashbook_possession_bindings b
                  WHERE b.cashbook_id = a.id AND b.valid_to IS NULL AND b.possession_kind = 'CUSTODIAN'),
                 '[]'::jsonb))
             ORDER BY a.name)
        FROM public.accounts a
       WHERE a.organization_id = p_organization_id AND a.deleted_at IS NULL
         AND NOT COALESCE(a.is_virtual, false)), '[]'::jsonb));
END
$function$;

CREATE OR REPLACE FUNCTION public.set_personal_cash_book_v1(p_membership_id uuid, p_account_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := app_private.current_uid_v1();
  v_org uuid;
  v_current uuid;
  v_name text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  SELECT m.organization_id INTO v_org
    FROM public.organization_memberships m
   WHERE m.id = p_membership_id AND m.status = 'ACTIVE';
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Thành viên không còn hoạt động' USING ERRCODE = '22023';
  END IF;
  PERFORM app_private.lock_org_for_decision_v1(v_org);
  IF NOT public.is_super_admin()
     AND NOT app_private.ie_actor_is_company_owner_v1(v_org, v_actor) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty cài được sổ nhận tiền' USING ERRCODE = '42501';
  END IF;

  IF p_account_id IS NOT NULL THEN
    SELECT a.name INTO v_name
      FROM public.accounts a
     WHERE a.id = p_account_id AND a.organization_id = v_org
       AND a.deleted_at IS NULL AND NOT COALESCE(a.is_virtual, false);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sổ tiền mặt riêng phải là sổ thật của tổ chức' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.cashbook_possession_bindings b
       WHERE b.organization_id = v_org AND b.cashbook_id = p_account_id
         AND b.membership_id = p_membership_id AND b.possession_kind = 'CUSTODIAN'
         AND b.valid_to IS NULL
    ) THEN
      RAISE EXCEPTION 'Người này chưa giữ sổ "%" — cấp quyền giữ sổ trước rồi mới đặt làm sổ tiền mặt riêng', v_name
        USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT p.account_id INTO v_current
    FROM app_private.personal_cash_books p
   WHERE p.membership_id = p_membership_id AND p.valid_to IS NULL
   FOR UPDATE;

  IF v_current IS DISTINCT FROM p_account_id THEN
    UPDATE app_private.personal_cash_books
       SET valid_to = clock_timestamp()
     WHERE membership_id = p_membership_id AND valid_to IS NULL;
    IF p_account_id IS NOT NULL THEN
      INSERT INTO app_private.personal_cash_books (organization_id, membership_id, account_id, created_by)
      VALUES (v_org, p_membership_id, p_account_id, v_actor);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'membershipId', p_membership_id,
    'personalCashBook', CASE WHEN p_account_id IS NULL THEN NULL
                             ELSE jsonb_build_object('id', p_account_id, 'name', v_name) END);
END
$function$;

CREATE OR REPLACE FUNCTION public.set_building_receiving_cashbooks_v1(
  p_building_id uuid,
  p_method text,
  p_default_account_id uuid,
  p_extra_account_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := app_private.current_uid_v1();
  v_org uuid;
  v_extras uuid[];
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('TK', 'TT') THEN
    RAISE EXCEPTION 'Hình thức phải là TK (Chuyển khoản) hoặc TT (Thanh toán)' USING ERRCODE = '22023';
  END IF;
  SELECT b.organization_id INTO v_org
    FROM public.buildings b WHERE b.id = p_building_id AND b.deleted_at IS NULL;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Toà nhà không tồn tại' USING ERRCODE = '22023';
  END IF;
  PERFORM app_private.lock_org_for_decision_v1(v_org);
  IF NOT public.is_super_admin()
     AND NOT app_private.ie_actor_is_company_owner_v1(v_org, v_actor) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty cài được sổ nhận tiền' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT x), '{}'::uuid[]) INTO v_extras
    FROM unnest(COALESCE(p_extra_account_ids, '{}'::uuid[])) x
   WHERE x IS NOT NULL AND x IS DISTINCT FROM p_default_account_id;
  IF cardinality(v_extras) > 20 THEN
    RAISE EXCEPTION 'Tối đa 20 sổ phụ cho một hình thức' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_extras || CASE WHEN p_default_account_id IS NULL THEN '{}'::uuid[]
                                          ELSE ARRAY[p_default_account_id] END) x
     WHERE NOT EXISTS (
       SELECT 1 FROM public.accounts a
        WHERE a.id = x AND a.organization_id = v_org
          AND a.deleted_at IS NULL AND NOT COALESCE(a.is_virtual, false))
  ) THEN
    RAISE EXCEPTION 'Sổ nhận tiền phải là sổ thật của tổ chức' USING ERRCODE = '22023';
  END IF;

  IF p_method = 'TK' THEN
    UPDATE public.buildings SET default_account_id_tk = p_default_account_id
     WHERE id = p_building_id AND default_account_id_tk IS DISTINCT FROM p_default_account_id;
  ELSE
    UPDATE public.buildings SET default_account_id_tt = p_default_account_id
     WHERE id = p_building_id AND default_account_id_tt IS DISTINCT FROM p_default_account_id;
  END IF;

  DELETE FROM app_private.building_receiving_cashbooks r
   WHERE r.building_id = p_building_id AND r.payment_method = p_method
     AND NOT (r.account_id = ANY (v_extras));
  INSERT INTO app_private.building_receiving_cashbooks
    (organization_id, building_id, payment_method, account_id, created_by)
  SELECT v_org, p_building_id, p_method, x, v_actor FROM unnest(v_extras) x
  ON CONFLICT (building_id, payment_method, account_id) DO NOTHING;

  RETURN jsonb_build_object(
    'buildingId', p_building_id,
    'method', p_method,
    'defaultAccountId', p_default_account_id,
    'extraAccountIds', to_jsonb(v_extras));
END
$function$;

-- ---------------------------------------------------------------------------
-- 6. Lõi đổi sổ của phiếu THU đã ghi sổ (cơ chế của move_income_voucher_cashbook_v1,
--    không kiểm quyền — người gọi tự kiểm). Cửa CASHBOOK_MOVE để cầu a85 đảo bút
--    toán sổ cũ và ghi thế hệ mới ở sổ mới; hậu kiểm tiền rời hẳn sổ cũ.
CREATE OR REPLACE FUNCTION app_private.move_posted_income_cashbook_v1(p_voucher uuid, p_new_account uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v public.income_expenses%ROWTYPE;
  v_after public.income_expenses%ROWTYPE;
  v_old_acc public.accounts%ROWTYPE;
  v_new_acc public.accounts%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.income_expenses WHERE id = p_voucher AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE = 'P0002';
  END IF;
  IF v.type <> 'INCOME' OR v.approval_status <> 'APPROVED' THEN
    RAISE EXCEPTION 'Chỉ đổi sổ cho phiếu THU đã duyệt' USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v.posting_status, 'UNPOSTED') <> 'POSTED' OR v.active_posting_id_v2 IS NULL THEN
    RAISE EXCEPTION 'Phiếu chưa ghi sổ nên không có bút toán nào để chuyển' USING ERRCODE = '55000';
  END IF;
  IF v.account_id IS NULL OR p_new_account IS NULL OR p_new_account = v.account_id THEN
    RAISE EXCEPTION 'Sổ mới phải khác sổ hiện tại' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_old_acc FROM public.accounts WHERE id = v.account_id;
  IF COALESCE(v_old_acc.is_virtual, false) THEN
    RAISE EXCEPTION 'Phiếu đang ghi trên sổ nội bộ (sổ ảo) — không đổi sổ ở đây' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_new_acc FROM public.accounts WHERE id = p_new_account;
  IF v_new_acc.id IS NULL OR v_new_acc.organization_id IS DISTINCT FROM v.organization_id
     OR v_new_acc.deleted_at IS NOT NULL OR COALESCE(v_new_acc.is_virtual, false) THEN
    RAISE EXCEPTION 'Sổ quỹ đích phải là sổ thật của tổ chức' USING ERRCODE = '22023';
  END IF;

  PERFORM app_private.begin_ie_flex_write_v1(p_voucher, 'CASHBOOK_MOVE');
  UPDATE public.income_expenses
     SET account_id = p_new_account,
         updated_at = now()
   WHERE id = p_voucher;
  PERFORM app_private.end_ie_flex_write_v1(p_voucher);

  -- Phiếu của đợt thu hoá đơn: dòng thu (tender) phải trỏ cùng sổ với phiếu
  -- (1 phiếu ↔ 1 dòng thu).
  IF v.payment_collection_id IS NOT NULL THEN
    UPDATE public.invoice_payment_tenders t
       SET account_id = p_new_account
     WHERE t.voucher_id = p_voucher;
    IF NOT FOUND OR EXISTS (
      SELECT 1 FROM public.invoice_payment_tenders t
       WHERE t.voucher_id = p_voucher AND t.account_id IS DISTINCT FROM p_new_account
    ) THEN
      RAISE EXCEPTION 'Dòng thu của đợt không khớp sổ mới — dừng lại, báo quản trị.' USING ERRCODE = '55000';
    END IF;
  END IF;

  SELECT * INTO v_after FROM public.income_expenses WHERE id = p_voucher;
  IF COALESCE(v_after.posting_status, '') <> 'POSTED' THEN
    RAISE EXCEPTION 'Đổi sổ nhưng phiếu không ghi sổ lại được (trạng thái %) — dừng lại, báo quản trị.',
      COALESCE(v_after.posting_status, 'không rõ') USING ERRCODE = '55000';
  END IF;
  IF COALESCE((
       SELECT sum(l.signed_amount) FROM public.income_expense_posting_lines l
       JOIN public.income_expense_postings p ON p.id = l.posting_id
       WHERE p.posting_subject_kind = 'VOUCHER' AND p.posting_subject_id = p_voucher
         AND l.account_id = v.account_id), 0) <> 0 THEN
    RAISE EXCEPTION 'Đổi sổ nhưng sổ quỹ cũ vẫn còn số dư của phiếu này — dừng lại, báo quản trị.'
      USING ERRCODE = '55000';
  END IF;
  IF COALESCE((
       SELECT sum(l.signed_amount) FROM public.income_expense_posting_lines l
       JOIN public.income_expense_postings p ON p.id = l.posting_id
       WHERE p.posting_subject_kind = 'VOUCHER' AND p.posting_subject_id = p_voucher
         AND l.account_id = p_new_account), 0) = 0 THEN
    RAISE EXCEPTION 'Đổi sổ nhưng sổ quỹ mới không nhận được khoản nào — dừng lại, báo quản trị.'
      USING ERRCODE = '55000';
  END IF;
END
$function$;
REVOKE ALL ON FUNCTION app_private.move_posted_income_cashbook_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Đổi hình thức thu của một dòng thu.
CREATE OR REPLACE FUNCTION public.change_collection_tender_method_v1(
  p_tender_id uuid,
  p_new_method text,
  p_new_account_id uuid DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := app_private.current_uid_v1();
  v_actor_name text;
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_idem text := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  v_collection_id uuid;
  v_org uuid;
  v_collection public.invoice_payment_collections%ROWTYPE;
  v_invoice public.invoices%ROWTYPE;
  v_tender public.invoice_payment_tenders%ROWTYPE;
  v_row public.income_expenses%ROWTYPE;
  v_prev public.income_expense_revisions%ROWTYPE;
  v_flow text;
  v_collector_membership uuid;
  v_allowed uuid[];
  v_new_account uuid;
  v_building_name text;
  v_old_name text;
  v_new_name text;
  v_nhan_cu text;
  v_nhan_moi text;
  v_changed text[] := '{}';
  v_before jsonb;
  v_after jsonb;
  v_revision_no integer;
BEGIN
  -- ── Tham số ──────────────────────────────────────────────────────────────
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_tender_id IS NULL OR p_new_method IS NULL OR p_new_method NOT IN ('TM', 'TK', 'TT') THEN
    RAISE EXCEPTION 'Hình thức thu mới phải là Tiền mặt, Chuyển khoản hoặc Thanh toán' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_reason) < 8 OR char_length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'Phải ghi lý do đổi hình thức thu (ít nhất 8 ký tự).' USING ERRCODE = '22023';
  END IF;
  IF v_idem IS NOT NULL AND v_idem !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'idempotency_key phải dài 8-200 ký tự ASCII và chỉ chứa A-Z, a-z, 0-9, ., _, :, -'
      USING ERRCODE = '22023';
  END IF;

  -- ── Khoá theo đúng thứ tự của hoàn tác khoản thu: đợt thu → hoá đơn → tổ chức → dòng → phiếu
  SELECT t.collection_id INTO v_collection_id FROM public.invoice_payment_tenders t WHERE t.id = p_tender_id;
  IF v_collection_id IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy dòng thu' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_collection FROM public.invoice_payment_collections c WHERE c.id = v_collection_id FOR UPDATE;
  SELECT * INTO v_invoice FROM public.invoices i WHERE i.id = v_collection.invoice_id FOR UPDATE;
  v_org := v_collection.organization_id;
  PERFORM app_private.lock_org_for_decision_v1(v_org);
  SELECT * INTO v_tender FROM public.invoice_payment_tenders t WHERE t.id = p_tender_id FOR UPDATE;
  IF v_tender.voucher_id IS NULL THEN
    RAISE EXCEPTION 'Dòng thu này không có phiếu thu (đã thối lại toàn bộ) — không đổi hình thức được'
      USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_row FROM public.income_expenses ie WHERE ie.id = v_tender.voucher_id FOR UPDATE;

  -- Gọi lại cùng khoá sau khi đã ghi: trả kết quả cũ.
  IF v_idem IS NOT NULL THEN
    SELECT * INTO v_prev
      FROM public.income_expense_revisions r
     WHERE r.income_expense_id = v_tender.voucher_id
       AND r.actor_id = v_actor
       AND r.idempotency_key = v_idem;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'tenderId', p_tender_id, 'voucherId', v_tender.voucher_id, 'changed', true, 'replayed', true,
        'revisionNo', v_prev.revision_no, 'changedFields', to_jsonb(v_prev.changed_fields));
    END IF;
  END IF;

  -- ── Điều kiện khoản thu ───────────────────────────────────────────────────
  IF v_collection.status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'Khoản thu đã hoàn tác — không đổi hình thức được' USING ERRCODE = '55000';
  END IF;
  IF v_row.id IS NULL OR v_row.deleted_at IS NOT NULL OR v_row.approval_status <> 'APPROVED'
     OR COALESCE(v_row.posting_status, 'UNPOSTED') <> 'POSTED' OR v_row.active_posting_id_v2 IS NULL THEN
    RAISE EXCEPTION 'Phiếu thu của dòng này không còn ở trạng thái đã ghi sổ — không đổi hình thức được'
      USING ERRCODE = '55000';
  END IF;
  SELECT o.flow_kind INTO v_flow
    FROM app_private.income_expense_flow_ownership o WHERE o.income_expense_id = v_row.id;
  IF v_flow IS DISTINCT FROM 'INVOICE_COLLECTION_V5' THEN
    RAISE EXCEPTION 'Chỉ đổi được hình thức của khoản thu hoá đơn kiểu mới' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(v_tender.change_amount, 0) <> 0 OR COALESCE(v_row.change_amount, 0) <> 0 THEN
    RAISE EXCEPTION 'Khoản thu có tiền thối nên không đổi hình thức được.' USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v_tender.rounding_amount, 0) <> 0 OR COALESCE(v_row.rounding_amount, 0) <> 0 THEN
    RAISE EXCEPTION 'Khoản thu có làm tròn nên không đổi hình thức được.' USING ERRCODE = '55000';
  END IF;

  -- ── Quyền: chính người đã thu (còn trong tổ chức), chủ công ty, super admin ──
  IF NOT public.is_super_admin()
     AND NOT app_private.ie_actor_is_company_owner_v1(v_org, v_actor) THEN
    IF v_collection.actor_id IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'Chỉ người đã thu hoặc chủ công ty đổi được hình thức thu' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.organization_memberships m
       WHERE m.organization_id = v_org AND m.user_id = v_actor AND m.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'Không còn là thành viên đang hoạt động của tổ chức' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- ── Sổ mới: trong danh sách của (toà hoá đơn, hình thức mới, NGƯỜI ĐÃ THU) ──
  SELECT b.name INTO v_building_name FROM public.buildings b WHERE b.id = v_invoice.building_id;
  v_collector_membership := app_private.member_of_org_v1(v_org, v_collection.actor_id);
  v_allowed := app_private.receiving_cashbook_ids_v1(v_org, v_invoice.building_id, p_new_method,
                                                     v_collector_membership);
  IF p_new_account_id IS NULL THEN
    v_new_account := v_allowed[1];
    IF v_new_account IS NULL THEN
      IF p_new_method = 'TM' THEN
        RAISE EXCEPTION 'Người thu chưa có sổ tiền mặt riêng — nhờ chủ công ty cài ở Sổ nhận tiền.'
          USING ERRCODE = '55000';
      END IF;
      RAISE EXCEPTION 'Toà % chưa cài sổ nhận tiền cho hình thức %.',
        COALESCE(v_building_name, '(không rõ)'),
        CASE p_new_method WHEN 'TK' THEN 'Chuyển khoản' ELSE 'Thanh toán' END
        USING ERRCODE = '55000';
    END IF;
  ELSE
    v_new_account := p_new_account_id;
    IF NOT (v_new_account = ANY (v_allowed)) THEN
      SELECT a.name INTO v_new_name FROM public.accounts a WHERE a.id = v_new_account;
      RAISE EXCEPTION 'Sổ "%" không nằm trong danh sách sổ nhận tiền % của toà %.',
        COALESCE(v_new_name, '(không rõ)'),
        CASE p_new_method WHEN 'TM' THEN 'Tiền mặt' WHEN 'TK' THEN 'Chuyển khoản' ELSE 'Thanh toán' END,
        COALESCE(v_building_name, '(không rõ)')
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF p_new_method = v_tender.payment_method::text AND v_new_account = v_tender.account_id THEN
    RAISE EXCEPTION 'Hình thức và sổ mới trùng hiện tại — không có gì để đổi' USING ERRCODE = '22023';
  END IF;
  IF p_new_method <> v_tender.payment_method::text THEN v_changed := v_changed || 'payment_method'::text; END IF;
  IF v_new_account IS DISTINCT FROM v_tender.account_id THEN v_changed := v_changed || 'account_id'::text; END IF;

  -- Sổ đã chốt / phiên bàn giao / tháng lợi nhuận ở vị trí cũ; sổ mới do trigger khoá kỳ xét.
  PERFORM app_private.assert_period_open_for_edit_v1(v_row.id, 'đổi hình thức thu');

  -- ── Ghi ───────────────────────────────────────────────────────────────────
  SELECT a.name INTO v_old_name FROM public.accounts a WHERE a.id = v_tender.account_id;
  SELECT a.name INTO v_new_name FROM public.accounts a WHERE a.id = v_new_account;
  v_before := jsonb_build_object(
    'payment_method', v_tender.payment_method,
    'account', jsonb_build_object('id', v_tender.account_id, 'name', v_old_name),
    'amount', v_tender.gross_amount,
    'collection_date', v_collection.collection_date,
    'invoice_number', v_invoice.invoice_number);
  v_after := v_before || jsonb_build_object(
    'payment_method', p_new_method,
    'account', jsonb_build_object('id', v_new_account, 'name', v_new_name));

  IF v_new_account IS DISTINCT FROM v_row.account_id THEN
    PERFORM app_private.move_posted_income_cashbook_v1(v_row.id, v_new_account);
  END IF;

  PERFORM app_private.begin_accounting_chain_write_v1();
  UPDATE public.invoice_payment_tenders
     SET payment_method = p_new_method::public.payment_method,
         account_id = v_new_account
   WHERE id = p_tender_id;
  UPDATE public.payments
     SET payment_method = p_new_method::public.payment_method
   WHERE tender_id = p_tender_id
     AND payment_method IS DISTINCT FROM p_new_method::public.payment_method;
  PERFORM app_private.end_accounting_chain_write_v1();

  v_actor_name := app_private.ie_actor_display_name_v1(v_actor);
  SELECT COALESCE(max(r.revision_no), 0) + 1 INTO v_revision_no
    FROM public.income_expense_revisions r WHERE r.income_expense_id = v_row.id;
  INSERT INTO public.income_expense_revisions
    (organization_id, income_expense_id, revision_no, kind, actor_id, actor_name, reason,
     changed_fields, before_snapshot, after_snapshot, idempotency_key)
  VALUES
    (v_org, v_row.id, v_revision_no, 'COLLECTION_METHOD', v_actor, COALESCE(v_actor_name, 'Người dùng'),
     v_reason, v_changed, v_before, v_after, v_idem);

  v_nhan_cu := v_tender.payment_method::text || ' · ' || COALESCE(v_old_name, '?');
  v_nhan_moi := p_new_method || ' · ' || COALESCE(v_new_name, '?');
  PERFORM app_private.append_income_expense_event_v1(
    v_org, v_row.id, 'COLLECTION_METHOD_CHANGED', v_actor, v_actor_name,
    v_nhan_cu, v_nhan_moi, v_reason);

  RETURN jsonb_build_object(
    'tenderId', p_tender_id,
    'voucherId', v_row.id,
    'changed', true,
    'revisionNo', v_revision_no,
    'changedFields', to_jsonb(v_changed),
    'from', jsonb_build_object('method', v_tender.payment_method, 'accountId', v_tender.account_id,
                               'accountName', v_old_name),
    'to', jsonb_build_object('method', p_new_method, 'accountId', v_new_account, 'accountName', v_new_name));
END
$function$;

-- ---------------------------------------------------------------------------
-- 8. Quyền gọi.
REVOKE ALL ON FUNCTION public.get_receiving_cashbooks_v1(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_receiving_cashbooks_v1(uuid, uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.list_receiving_cashbook_settings_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_receiving_cashbook_settings_v1(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.set_personal_cash_book_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_personal_cash_book_v1(uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.set_building_receiving_cashbooks_v1(uuid, text, uuid, uuid[])
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_building_receiving_cashbooks_v1(uuid, text, uuid, uuid[]) TO authenticated;
REVOKE ALL ON FUNCTION public.change_collection_tender_method_v1(uuid, text, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.change_collection_tender_method_v1(uuid, text, uuid, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 9. Nghiệm thu.
DO $nghiem_thu$
DECLARE
  v_ham text;
BEGIN
  FOREACH v_ham IN ARRAY ARRAY[
    'public.get_receiving_cashbooks_v1(uuid,uuid,uuid)',
    'public.list_receiving_cashbook_settings_v1(uuid)',
    'public.set_personal_cash_book_v1(uuid,uuid)',
    'public.set_building_receiving_cashbooks_v1(uuid,text,uuid,uuid[])',
    'public.change_collection_tender_method_v1(uuid,text,uuid,text,text)']
  LOOP
    IF NOT has_function_privilege('authenticated', v_ham, 'EXECUTE')
       OR has_function_privilege('anon', v_ham, 'EXECUTE') THEN
      RAISE EXCEPTION 'nghiem_thu: quyen goi % sai', v_ham;
    END IF;
  END LOOP;
  FOREACH v_ham IN ARRAY ARRAY[
    'app_private.receiving_cashbook_ids_v1(uuid,uuid,text,uuid)',
    'app_private.receiving_cashbook_allowed_v1(uuid,uuid,text,uuid,uuid)',
    'app_private.member_of_org_v1(uuid,uuid)',
    'app_private.move_posted_income_cashbook_v1(uuid,uuid)']
  LOOP
    IF has_function_privilege('authenticated', v_ham, 'EXECUTE') THEN
      RAISE EXCEPTION 'nghiem_thu: ham noi bo % dang mo cho authenticated', v_ham;
    END IF;
  END LOOP;
  IF has_table_privilege('authenticated', 'app_private.personal_cash_books', 'SELECT')
     OR has_table_privilege('authenticated', 'app_private.building_receiving_cashbooks', 'SELECT') THEN
    RAISE EXCEPTION 'nghiem_thu: bang cau hinh dang mo cho authenticated';
  END IF;
  IF COALESCE(array_length(app_private.receiving_cashbook_ids_v1(NULL, NULL, 'CT', NULL), 1), 0) <> 0 THEN
    RAISE EXCEPTION 'nghiem_thu: hinh thuc la phai tra danh sach rong';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';

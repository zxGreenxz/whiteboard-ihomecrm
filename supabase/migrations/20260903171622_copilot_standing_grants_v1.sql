-- G5-B — Uy quyen dung (standing grants): diem noi #4 cua Muc 3 toan quyen.
--
-- Truoc file nay, moi ke hoach L4 tro xuong (van dang mo o L4) van phai co
-- MOT NGUOI bam duyet — click hoac PIN step-up (G5-A). Standing grant la
-- duong thu ba: mot super admin cap truoc mot han muc cho DUNG MOT action,
-- theo NGAY, kem rang buoc tuy chon (so tien tran, danh sach toa nha), con
-- hieu luc toi da 30 ngay. Khi van `standing_grants_enabled` mo VA moi buoc
-- cua mot ke hoach deu duoc mot han muc con song phu, `copilot_plan_create_v1`
-- tu duyet ke hoach ngay luc lap — khong ai bam gi ca.
--
-- POLICY MAC DINH VAN LA `standing_grants_enabled = false` (seed tu
-- 20260903043956). File nay CHI xay co che; G5-D moi la noi bat van. Truoc
-- G5-D, nhanh tu duyet trong `copilot_plan_create_v1` khong bao gio chay —
-- dung khuon voi cach nhanh step-up L5 cua G5-A chua chay vi tran van la L4.
--
-- BON THU DUNG O DAY:
--   1. Cot `grantable` tren registry — action nao duoc phep uy quyen dung.
--      G5-C se dat `false` cho nhom hanh dong phan quyen (cap quyen/moi
--      thanh vien/doi trang thai thanh vien); moi action seed hien tai deu
--      `true` vi chua co hang nao thuoc nhom do.
--   2. Bang `copilot_standing_grants` + so `copilot_standing_grants_audit`
--      (chi ghi them, cung khuon `copilot_action_policy_audit`) + trigger
--      BEFORE INSERT tu choi hang nao tro toi mot action khong `grantable`.
--   3. 5 RPC public: tao/thu hoi/thu hoi tat ca/danh sach/bao cao ngay.
--   4. Ba ham CREATE OR REPLACE — than DUOC DOC THANG TU PRODUCTION qua
--      Management API ngay truoc khi viet file nay (khong chep tu migration
--      cu, vi ca `copilot_ledger_append_v1` lan `copilot_plan_approve_v1` da
--      tung duoc CREATE OR REPLACE nhieu lan sau 20260903100253):
--        - `app_private.copilot_ledger_append_v1` — them cot `amount`.
--        - `public.copilot_plan_create_v1` — them nhanh tu duyet (diem noi #4).
--        - `public.copilot_plan_execute_step_v1` — ghi `amount` vao so
--          `step_done` de bao cao ngay cong duoc tong tien.
--      `copilot_plan_approve_v1` KHONG doi — duong bam/PIN thu cong khong
--      lien quan gi toi uy quyen dung.
--
-- VI SAO SOAT PHU BANG `FOR UPDATE` NGAY TU LUOT SOAT, KHONG SOAT-ROI-KHOA-SAU
--   Neu soat truoc (khong khoa) roi moi khoa+ghi tang o mot lenh rieng, co
--   mot khoang giua hai buoc do ma mot ke hoach SONG SONG khac co the doc
--   cung `used_today` con thap roi ca hai cung nghi minh duoc phu — vuot
--   `max_per_day` that su. Khoa `FOR UPDATE` ngay trong vong lap soat giu
--   nguyen toi het loi goi ham (het giao dich), nen khong phien nao khac
--   doi duoc hang da khoa cho toi khi ham nay tra ve.
--
-- VI SAO MOT BUOC KHONG DUOC PHU KHONG PHAI LA LOI
--   `copilot_plan_create_v1` van tra ve mot ke hoach DRAFT hop le — dung
--   duong ma no da di truoc G5-B. Uy quyen dung la MOT DUONG TAT, khong phai
--   dieu kien bat buoc; thieu no thi nguoi dung quay lai bam duyet nhu cu.
--
-- DUONG LUI
--   Bang/ham moi la them, khong doi bang cu (ngoai them cot `grantable` vao
--   registry va `amount` vao so — ca hai NULLABLE/DEFAULT nen khong pha du
--   lieu cu). Lui = DROP ham/trigger/bang moi theo thu tu nguoc, CREATE OR
--   REPLACE lai `copilot_ledger_append_v1`/`copilot_plan_create_v1`/
--   `copilot_plan_execute_step_v1` ve than dang chay truoc file nay (luu o
--   `docs/generated/schema-change-evidence/` sau khi apply), roi ALTER TABLE
--   DROP COLUMN hai cot moi.

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. REGISTRY — cot `grantable`
-- ---------------------------------------------------------------------------
ALTER TABLE app_private.copilot_action_registry
  ADD COLUMN IF NOT EXISTS grantable boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN app_private.copilot_action_registry.grantable IS
  'Action co duoc uy quyen dung (standing grant, G5-B) hay khong. G5-C se dat '
  'false cho nhom hanh dong phan quyen (cap quyen/moi thanh vien/doi trang '
  'thai thanh vien) — nhom do khong bao gio duoc tu duyet ma khong co nguoi '
  'bam, du van uy quyen dung co mo hay khong.';

-- ---------------------------------------------------------------------------
-- 2. SỔ — thêm ba sự kiện `grant_*` vào CHECK của `event`, thêm cột `amount`.
-- ---------------------------------------------------------------------------
DO $mo_rong_event_ledger_grant$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'copilot_action_ledger_event_check'
       AND conrelid = 'app_private.copilot_action_ledger'::regclass
       AND pg_get_constraintdef(oid) NOT LIKE '%grant_created%'
  ) THEN
    ALTER TABLE app_private.copilot_action_ledger
      DROP CONSTRAINT copilot_action_ledger_event_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'copilot_action_ledger_event_check'
       AND conrelid = 'app_private.copilot_action_ledger'::regclass
  ) THEN
    ALTER TABLE app_private.copilot_action_ledger
      ADD CONSTRAINT copilot_action_ledger_event_check
      CHECK (event IN (
        'plan_created', 'plan_approved', 'step_done', 'step_failed',
        'step_blocked', 'plan_cancelled', 'plan_expired',
        'action_executed', 'action_failed', 'policy_changed',
        'capability_changed', 'step_up_pin_set', 'step_up_verified',
        'step_up_locked', 'step_up_unlocked',
        'grant_created', 'grant_revoked', 'grant_used'));
  END IF;
END
$mo_rong_event_ledger_grant$;

-- Ba su kien grant_* LUON mang to chuc (mot han muc dung khong bao gio la
-- hang toan he thong) — khong dong cham `copilot_action_ledger_org_required`.

ALTER TABLE app_private.copilot_action_ledger ADD COLUMN IF NOT EXISTS amount numeric;

COMMENT ON COLUMN app_private.copilot_action_ledger.amount IS
  'So tien cua canonical.amount khi buoc co truong nay (writer tien). '
  'Nullable: da so action khong co so tien. Dung cho bao cao ngay cua uy '
  'quyen dung (copilot_standing_grants_daily_report_v1) — KHONG dung lam '
  'bang chung ghi so, payload_digest moi la bang chung.';

CREATE OR REPLACE FUNCTION app_private.copilot_ledger_append_v1(p jsonb)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $ledger_append$
DECLARE
  v_id    uuid;
  v_uid   uuid := auth.uid();
  v_org   uuid := NULLIF(p ->> 'organization_id', '')::uuid;
  v_event text := NULLIF(p ->> 'event', '');
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'copilot_ledger_payload_invalid' USING ERRCODE = '22023';
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF v_org IS NULL AND (v_event IS NULL OR v_event NOT IN (
       'policy_changed', 'step_up_pin_set', 'step_up_unlocked', 'step_up_locked')) THEN
    RAISE EXCEPTION 'copilot_ledger_organization_required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO app_private.copilot_action_ledger (
    plan_id, step_no, plan_version, event, user_id, organization_id, action_id,
    permission_key, permission_snapshot, consent_id, consent_kind, step_up_id,
    grant_id, payload_digest, before_digest, after_digest, outcome, error_code,
    sqlstate, entity_table, entity_id, audit_id, amount
  )
  VALUES (
    NULLIF(p ->> 'plan_id', '')::uuid,
    NULLIF(p ->> 'step_no', '')::int,
    NULLIF(p ->> 'plan_version', '')::int,
    v_event,
    v_uid,
    v_org,
    NULLIF(p ->> 'action_id', ''),
    NULLIF(p ->> 'permission_key', ''),
    COALESCE(p -> 'permission_snapshot', '{}'::jsonb),
    NULLIF(p ->> 'consent_id', '')::uuid,
    NULLIF(p ->> 'consent_kind', ''),
    NULLIF(p ->> 'step_up_id', '')::uuid,
    NULLIF(p ->> 'grant_id', '')::uuid,
    -- Digest đi vào dưới dạng hex để hàm gọi không phải tự dựng bytea trong jsonb.
    decode(NULLIF(p ->> 'payload_digest', ''), 'hex'),
    decode(NULLIF(p ->> 'before_digest', ''), 'hex'),
    decode(NULLIF(p ->> 'after_digest', ''), 'hex'),
    p -> 'outcome',
    NULLIF(p ->> 'error_code', ''),
    NULLIF(p ->> 'sqlstate', ''),
    NULLIF(p ->> 'entity_table', ''),
    NULLIF(p ->> 'entity_id', '')::uuid,
    NULLIF(p ->> 'audit_id', '')::uuid,
    -- G5-B: so tien cua canonical.amount khi buoc co truong nay. Khong qua
    -- hex vi day la so, khong phai bang chung bam — di thang qua numeric.
    NULLIF(p ->> 'amount', '')::numeric
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END
$ledger_append$;

-- Quyen khong doi (da REVOKE ALL + guard tu 20260903043956/150311); CREATE OR
-- REPLACE khong dong cham privilege. Ghi lai o day CHI de nguoi doc khong phai
-- lat nguoc hai migration cu de biet ai goi duoc ham nay.
-- authenticated: KHONG goi truc tiep (chi cac RPC public khac PERFORM no qua
-- SECURITY DEFINER). anon/service_role: khong.

-- ---------------------------------------------------------------------------
-- 3. BẢNG — copilot_standing_grants + sổ chỉ-ghi-thêm của nó
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_private.copilot_standing_grants (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  granter_user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id         uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  action_id               text NOT NULL REFERENCES app_private.copilot_action_registry(action_id),
  -- Khoá tuỳ chọn: `max_amount` (numeric), `building_ids` (mảng chuỗi uuid),
  -- `entity_filter` (jsonb tự do — CHƯA có action nào đọc khoá này ở v1;
  -- chừa chỗ cho G5-C/G5-D thay vì phải ALTER TABLE thêm cột).
  constraints             jsonb NOT NULL DEFAULT '{}'::jsonb,
  max_per_day             int NOT NULL,
  used_today              int NOT NULL DEFAULT 0,
  used_on                 date,
  expires_at              timestamptz NOT NULL,
  created_with_step_up_id uuid NOT NULL REFERENCES app_private.copilot_write_confirmations(id),
  revoked_at              timestamptz,
  revoked_by              uuid,
  reason                  text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT clock_timestamp()
);

DO $rang_buoc_standing_grants$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'copilot_standing_grants_max_per_day_check'
       AND conrelid = 'app_private.copilot_standing_grants'::regclass
  ) THEN
    ALTER TABLE app_private.copilot_standing_grants
      ADD CONSTRAINT copilot_standing_grants_max_per_day_check
      CHECK (max_per_day BETWEEN 1 AND 200);
  END IF;

  -- Brief chốt CHECK theo hàng, không phải theo cột: `expires_at` so với
  -- `created_at` CỦA CHÍNH HÀNG ĐÓ — một hạn mức không bao giờ sống quá 30
  -- ngày kể từ lúc được cấp, bất kể ai cấp hay cấp lúc nào.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'copilot_standing_grants_expires_within_30d'
       AND conrelid = 'app_private.copilot_standing_grants'::regclass
  ) THEN
    ALTER TABLE app_private.copilot_standing_grants
      ADD CONSTRAINT copilot_standing_grants_expires_within_30d
      CHECK (expires_at <= created_at + interval '30 days');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'copilot_standing_grants_reason_required'
       AND conrelid = 'app_private.copilot_standing_grants'::regclass
  ) THEN
    ALTER TABLE app_private.copilot_standing_grants
      ADD CONSTRAINT copilot_standing_grants_reason_required
      CHECK (btrim(reason) <> '');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'copilot_standing_grants_constraints_object'
       AND conrelid = 'app_private.copilot_standing_grants'::regclass
  ) THEN
    ALTER TABLE app_private.copilot_standing_grants
      ADD CONSTRAINT copilot_standing_grants_constraints_object
      CHECK (jsonb_typeof(constraints) = 'object');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'copilot_standing_grants_used_today_nonneg'
       AND conrelid = 'app_private.copilot_standing_grants'::regclass
  ) THEN
    ALTER TABLE app_private.copilot_standing_grants
      ADD CONSTRAINT copilot_standing_grants_used_today_nonneg
      CHECK (used_today >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'copilot_standing_grants_revoked_pair'
       AND conrelid = 'app_private.copilot_standing_grants'::regclass
  ) THEN
    ALTER TABLE app_private.copilot_standing_grants
      ADD CONSTRAINT copilot_standing_grants_revoked_pair
      CHECK ((revoked_at IS NULL) = (revoked_by IS NULL));
  END IF;
END
$rang_buoc_standing_grants$;

-- Truy vấn nóng nhất: "hạn mức nào CÒN SỐNG cho (tổ chức, action) này" — đúng
-- điều kiện mà `copilot_plan_create_v1` hỏi cho MỖI bước của MỌI kế hoạch khi
-- van đang mở. Index bộ phận vì hàng đã thu hồi không bao giờ nằm trong câu hỏi đó.
CREATE INDEX IF NOT EXISTS idx_copilot_standing_grants_active
  ON app_private.copilot_standing_grants (organization_id, action_id)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE app_private.copilot_standing_grants IS
  'Uy quyen dung (standing grant, G5-B): mot super admin cap truoc han muc '
  'cho DUNG MOT action, theo NGAY, kem rang buoc tuy chon, con hieu luc toi '
  'da 30 ngay. copilot_plan_create_v1 tu duyet ke hoach khi moi buoc duoc '
  'mot hang o day phu VA van standing_grants_enabled dang mo.';

REVOKE ALL ON app_private.copilot_standing_grants FROM PUBLIC;
DO $thu_hoi_standing_grants$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON app_private.copilot_standing_grants FROM anon;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON app_private.copilot_standing_grants FROM authenticated;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON app_private.copilot_standing_grants FROM service_role;
  END IF;
END
$thu_hoi_standing_grants$;

-- CỔNG THEO HÀNG. Cùng lý do với `copilot_action_registry_l5_row_check`: gate
-- tĩnh ở tầng RPC (bên dưới) là một bản sao, không phải nguồn sự thật duy
-- nhất — ai đó INSERT thẳng vào bảng (kể cả từ một RPC action tương lai lỡ
-- quên kiểm) vẫn bị chặn NGAY tại đây.
CREATE OR REPLACE FUNCTION app_private.copilot_standing_grant_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $guard$
DECLARE
  v_grantable boolean;
  v_enabled   boolean;
BEGIN
  SELECT grantable, enabled INTO v_grantable, v_enabled
    FROM app_private.copilot_action_registry
   WHERE action_id = NEW.action_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'copilot_action_disabled: % khong co trong registry', NEW.action_id
      USING ERRCODE = '42501';
  END IF;
  IF NOT v_enabled THEN
    RAISE EXCEPTION 'copilot_action_disabled: % da tat trong registry', NEW.action_id
      USING ERRCODE = '42501';
  END IF;
  IF NOT v_grantable THEN
    RAISE EXCEPTION 'action_not_grantable: % khong the uy quyen dung', NEW.action_id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$guard$;

DROP TRIGGER IF EXISTS trg_copilot_standing_grant_guard
  ON app_private.copilot_standing_grants;
CREATE TRIGGER trg_copilot_standing_grant_guard
  BEFORE INSERT ON app_private.copilot_standing_grants
  FOR EACH ROW EXECUTE FUNCTION app_private.copilot_standing_grant_guard_v1();

-- Sổ riêng của grant: chỉ ghi thêm, cùng khuôn `copilot_action_policy_audit`.
-- `copilot_action_ledger` là dòng thời gian CHUNG cho mọi thứ của Copilot;
-- bảng này là sổ CHUYÊN của uy quyền đứng — dễ soi vòng đời một hạn mức
-- (created → used* → revoked) mà không phải lọc dòng thời gian chung.
CREATE TABLE IF NOT EXISTS app_private.copilot_standing_grants_audit (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id        uuid NOT NULL,
  organization_id uuid,
  action          text NOT NULL CHECK (action IN ('created', 'revoked', 'revoked_all', 'used')),
  actor           uuid,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_copilot_standing_grants_audit_grant
  ON app_private.copilot_standing_grants_audit (grant_id, created_at);

CREATE OR REPLACE FUNCTION app_private.copilot_standing_grants_audit_bat_bien_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $f$
BEGIN
  RAISE EXCEPTION
    'copilot_standing_grants_audit chi ghi them: % bi tu choi.', TG_OP
    USING ERRCODE = '42501';
END
$f$;

DROP TRIGGER IF EXISTS trg_copilot_standing_grants_audit_bat_bien
  ON app_private.copilot_standing_grants_audit;
CREATE TRIGGER trg_copilot_standing_grants_audit_bat_bien
  BEFORE UPDATE OR DELETE ON app_private.copilot_standing_grants_audit
  FOR EACH ROW EXECUTE FUNCTION app_private.copilot_standing_grants_audit_bat_bien_v1();

REVOKE ALL ON app_private.copilot_standing_grants_audit FROM PUBLIC;
DO $thu_hoi_standing_grants_audit$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON app_private.copilot_standing_grants_audit FROM anon;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON app_private.copilot_standing_grants_audit FROM authenticated;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON app_private.copilot_standing_grants_audit FROM service_role;
  END IF;
END
$thu_hoi_standing_grants_audit$;

-- ---------------------------------------------------------------------------
-- 4. RPC 1/5 — TẠO UỶ QUYỀN ĐỨNG
-- ---------------------------------------------------------------------------
-- Thứ tự cửa: danh tính → vai (super admin) → tổ chức tồn tại → van
-- `standing_grants_enabled` → action tồn tại/bật/`grantable` → hình dạng
-- tham số → step-up token. Token là cửa ĐẮT NHẤT (chạm bảng nonce) nên đứng
-- cuối — mọi cửa rẻ hơn phải chặn trước, cùng nguyên tắc `copilot_action_gate_v1`.
CREATE OR REPLACE FUNCTION public.copilot_standing_grant_create_v1(
  p_organization_id uuid,
  p_action_id       text,
  p_constraints     jsonb,
  p_max_per_day     int,
  p_expires_at      timestamptz,
  p_reason          text,
  p_step_up_token   text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $tao_grant$
DECLARE
  v_actor       uuid := auth.uid();
  v_now         timestamptz := clock_timestamp();
  v_reg         app_private.copilot_action_registry%ROWTYPE;
  v_policy      app_private.copilot_action_policy%ROWTYPE;
  v_step_up     app_private.copilot_write_confirmations%ROWTYPE;
  v_constraints jsonb := COALESCE(p_constraints, '{}'::jsonb);
  v_grant_id    uuid;
  v_expires     timestamptz := p_expires_at;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'standing_grant_not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.organizations o
     WHERE o.id = p_organization_id AND o.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'organization_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_policy FROM app_private.copilot_action_policy WHERE id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'copilot_policy_missing' USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_policy.standing_grants_enabled THEN
    RAISE EXCEPTION 'standing_grants_disabled' USING ERRCODE = '42501';
  END IF;

  IF p_action_id IS NULL THEN
    RAISE EXCEPTION 'grant_action_required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_reg FROM app_private.copilot_action_registry WHERE action_id = p_action_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'copilot_action_disabled: % khong co trong registry', p_action_id
      USING ERRCODE = '42501';
  END IF;
  IF NOT v_reg.enabled THEN
    RAISE EXCEPTION 'copilot_action_disabled: % da tat trong registry', p_action_id
      USING ERRCODE = '42501';
  END IF;
  IF NOT v_reg.grantable THEN
    RAISE EXCEPTION 'action_not_grantable: % khong the uy quyen dung', p_action_id
      USING ERRCODE = '42501';
  END IF;

  IF p_max_per_day IS NULL OR p_max_per_day < 1 OR p_max_per_day > 200 THEN
    RAISE EXCEPTION 'grant_max_per_day_invalid' USING ERRCODE = '22023';
  END IF;

  IF v_expires IS NULL OR v_expires <= v_now OR v_expires > v_now + interval '30 days' THEN
    RAISE EXCEPTION 'grant_expires_invalid' USING ERRCODE = '22023';
  END IF;

  IF COALESCE(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'grant_reason_required' USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(v_constraints) <> 'object' THEN
    RAISE EXCEPTION 'grant_constraints_invalid' USING ERRCODE = '22023';
  END IF;
  IF v_constraints ? 'max_amount' THEN
    BEGIN
      IF (v_constraints ->> 'max_amount')::numeric <= 0 THEN
        RAISE EXCEPTION 'grant_constraints_invalid' USING ERRCODE = '22023';
      END IF;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'grant_constraints_invalid' USING ERRCODE = '22023';
    END;
  END IF;
  IF v_constraints ? 'building_ids' AND jsonb_typeof(v_constraints -> 'building_ids') <> 'array' THEN
    RAISE EXCEPTION 'grant_constraints_invalid' USING ERRCODE = '22023';
  END IF;

  -- STEP-UP — cùng khuôn với `copilot_plan_approve_v1` (G5-A): hình sai không
  -- soi bảng, mọi nhánh sai đều trả CÙNG một mã (không xác nhận giúp kẻ tấn
  -- công token nào "gần đúng").
  IF p_step_up_token IS NULL OR p_step_up_token !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'step_up_required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_step_up
    FROM app_private.copilot_write_confirmations c
   WHERE c.nonce_digest = extensions.digest(decode(p_step_up_token, 'hex'), 'sha256')
   FOR UPDATE;
  IF NOT FOUND
     OR v_step_up.user_id IS DISTINCT FROM v_actor
     OR v_step_up.tool IS DISTINCT FROM 'step_up'
     OR v_step_up.permission_key IS DISTINCT FROM 'copilot.step_up'
     OR v_step_up.consumed_at IS NOT NULL
     OR v_step_up.expires_at <= v_now
     OR v_step_up.organization_id IS DISTINCT FROM p_organization_id
     OR v_step_up.payload_hash IS DISTINCT FROM app_private.copilot_payload_hash_v1(
          jsonb_build_object('org', p_organization_id)) THEN
    RAISE EXCEPTION 'step_up_required' USING ERRCODE = '42501';
  END IF;

  -- TIÊU TOKEN (CAS) NGAY TRƯỚC KHI GHI — không còn validate nào phía sau có
  -- thể thất bại, nên đốt token ở đây không bao giờ đốt oan một lần thất bại.
  UPDATE app_private.copilot_write_confirmations
     SET consumed_at = v_now
   WHERE id = v_step_up.id AND consumed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'step_up_required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO app_private.copilot_standing_grants (
    granter_user_id, organization_id, action_id, constraints, max_per_day,
    expires_at, created_with_step_up_id, reason
  )
  VALUES (
    v_actor, p_organization_id, p_action_id, v_constraints, p_max_per_day,
    v_expires, v_step_up.id, btrim(p_reason)
  )
  RETURNING id INTO v_grant_id;

  INSERT INTO app_private.copilot_standing_grants_audit (
    grant_id, organization_id, action, actor, detail
  )
  VALUES (
    v_grant_id, p_organization_id, 'created', v_actor,
    jsonb_build_object(
      'action_id', p_action_id, 'max_per_day', p_max_per_day,
      'expires_at', v_expires, 'constraints', v_constraints, 'reason', btrim(p_reason))
  );

  PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',           'grant_created',
    'organization_id', p_organization_id,
    'action_id',       p_action_id,
    'permission_key',  v_reg.permission_key,
    'grant_id',        v_grant_id,
    'step_up_id',      v_step_up.id,
    'outcome', jsonb_build_object(
      'max_per_day', p_max_per_day, 'expires_at', v_expires,
      'constraints', v_constraints, 'reason', btrim(p_reason))));

  RETURN jsonb_build_object(
    'ok',          true,
    'error_code',  NULL,
    'grant_id',    v_grant_id,
    'action_id',   p_action_id,
    'max_per_day', p_max_per_day,
    'expires_at',  v_expires
  );
END
$tao_grant$;

REVOKE ALL ON FUNCTION public.copilot_standing_grant_create_v1(uuid, text, jsonb, int, timestamptz, text, text) FROM PUBLIC;
DO $quyen_tao_grant$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_standing_grant_create_v1(uuid, text, jsonb, int, timestamptz, text, text) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_standing_grant_create_v1(uuid, text, jsonb, int, timestamptz, text, text) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_standing_grant_create_v1(uuid, text, jsonb, int, timestamptz, text, text) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_standing_grant_create_v1(uuid, text, jsonb, int, timestamptz, text, text) TO authenticated;
  END IF;
END
$quyen_tao_grant$;

-- ---------------------------------------------------------------------------
-- 5. RPC 2/5 — THU HỒI MỘT HẠN MỨC
-- ---------------------------------------------------------------------------
-- KHÔNG cần step-up: thu hồi luôn dễ hơn cấp (đóng một cửa không cần xác thực
-- hai lớp — mở mới cần, cùng triết lý với `copilot_step_up_unlock_v1` không
-- đòi PIN của người bị mở khoá).
CREATE OR REPLACE FUNCTION public.copilot_standing_grant_revoke_v1(
  p_grant_id uuid,
  p_reason   text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $thu_hoi_grant$
DECLARE
  v_actor uuid := auth.uid();
  v_row   app_private.copilot_standing_grants%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'standing_grant_not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_grant_id IS NULL THEN
    RAISE EXCEPTION 'grant_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF COALESCE(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'grant_reason_required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM app_private.copilot_standing_grants
   WHERE id = p_grant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'grant_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'grant_already_revoked' USING ERRCODE = '22023';
  END IF;

  UPDATE app_private.copilot_standing_grants
     SET revoked_at = clock_timestamp(), revoked_by = v_actor
   WHERE id = p_grant_id;

  INSERT INTO app_private.copilot_standing_grants_audit (
    grant_id, organization_id, action, actor, detail
  )
  VALUES (
    p_grant_id, v_row.organization_id, 'revoked', v_actor,
    jsonb_build_object('reason', btrim(p_reason))
  );

  PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',           'grant_revoked',
    'organization_id', v_row.organization_id,
    'action_id',       v_row.action_id,
    'grant_id',        p_grant_id,
    'outcome',         jsonb_build_object('reason', btrim(p_reason))));

  RETURN jsonb_build_object('ok', true, 'error_code', NULL, 'grant_id', p_grant_id);
END
$thu_hoi_grant$;

REVOKE ALL ON FUNCTION public.copilot_standing_grant_revoke_v1(uuid, text) FROM PUBLIC;
DO $quyen_thu_hoi_grant$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_standing_grant_revoke_v1(uuid, text) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_standing_grant_revoke_v1(uuid, text) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_standing_grant_revoke_v1(uuid, text) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_standing_grant_revoke_v1(uuid, text) TO authenticated;
  END IF;
END
$quyen_thu_hoi_grant$;

-- ---------------------------------------------------------------------------
-- 6. RPC 3/5 — KILL SWITCH: THU HỒI TOÀN BỘ HẠN MỨC CỦA MỘT TỔ CHỨC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_standing_grants_revoke_all_v1(
  p_organization_id uuid,
  p_reason          text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $thu_hoi_all_grant$
DECLARE
  v_actor uuid := auth.uid();
  v_row   app_private.copilot_standing_grants%ROWTYPE;
  v_n     int := 0;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'standing_grant_not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'grant_reason_required' USING ERRCODE = '22023';
  END IF;

  FOR v_row IN
    SELECT * FROM app_private.copilot_standing_grants
     WHERE organization_id = p_organization_id AND revoked_at IS NULL
     FOR UPDATE
  LOOP
    UPDATE app_private.copilot_standing_grants
       SET revoked_at = clock_timestamp(), revoked_by = v_actor
     WHERE id = v_row.id;

    INSERT INTO app_private.copilot_standing_grants_audit (
      grant_id, organization_id, action, actor, detail
    )
    VALUES (
      v_row.id, p_organization_id, 'revoked_all', v_actor,
      jsonb_build_object('reason', btrim(p_reason))
    );

    PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',           'grant_revoked',
      'organization_id', p_organization_id,
      'action_id',       v_row.action_id,
      'grant_id',        v_row.id,
      'outcome',         jsonb_build_object('reason', btrim(p_reason), 'kill_switch', true)));

    v_n := v_n + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'error_code', NULL, 'revoked_count', v_n);
END
$thu_hoi_all_grant$;

REVOKE ALL ON FUNCTION public.copilot_standing_grants_revoke_all_v1(uuid, text) FROM PUBLIC;
DO $quyen_thu_hoi_all_grant$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_standing_grants_revoke_all_v1(uuid, text) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_standing_grants_revoke_all_v1(uuid, text) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_standing_grants_revoke_all_v1(uuid, text) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_standing_grants_revoke_all_v1(uuid, text) TO authenticated;
  END IF;
END
$quyen_thu_hoi_all_grant$;

-- ---------------------------------------------------------------------------
-- 7. RPC 4/5 — DANH SÁCH HẠN MỨC CỦA MỘT TỔ CHỨC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_standing_grants_list_v1(p_organization_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $ds_grant$
DECLARE
  v_actor uuid := auth.uid();
  v_ket   jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'standing_grant_not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'grant_id',        g.id,
           'action_id',       g.action_id,
           'label_vi',        COALESCE(r.label_vi, g.action_id),
           'constraints',     g.constraints,
           'max_per_day',     g.max_per_day,
           'used_today',      CASE WHEN g.used_on IS DISTINCT FROM current_date
                                    THEN 0 ELSE g.used_today END,
           'used_on',         g.used_on,
           'expires_at',      g.expires_at,
           'revoked_at',      g.revoked_at,
           'revoked_by',      g.revoked_by,
           'reason',          g.reason,
           'granter_user_id', g.granter_user_id,
           'created_at',      g.created_at
         ) ORDER BY g.created_at DESC), '[]'::jsonb)
    INTO v_ket
    FROM app_private.copilot_standing_grants g
    LEFT JOIN app_private.copilot_action_registry r ON r.action_id = g.action_id
   WHERE g.organization_id = p_organization_id;

  RETURN v_ket;
END
$ds_grant$;

REVOKE ALL ON FUNCTION public.copilot_standing_grants_list_v1(uuid) FROM PUBLIC;
DO $quyen_ds_grant$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_standing_grants_list_v1(uuid) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_standing_grants_list_v1(uuid) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_standing_grants_list_v1(uuid) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_standing_grants_list_v1(uuid) TO authenticated;
  END IF;
END
$quyen_ds_grant$;

-- ---------------------------------------------------------------------------
-- 8. RPC 5/5 — BÁO CÁO NGÀY
-- ---------------------------------------------------------------------------
-- Hai vế: DANH SÁCH kế hoạch tự duyệt trong ngày (đọc `copilot_plans`, lọc
-- `consent_kind = 'standing_grant'`), và TỔNG TIỀN (đọc cột `amount` mới của
-- sổ, tại đúng sự kiện `step_done` mang `consent_kind = 'standing_grant'` —
-- một kế hoạch có thể có nhiều bước `step_done`, nên tổng tiền cộng theo
-- BƯỚC, không theo kế hoạch).
CREATE OR REPLACE FUNCTION public.copilot_standing_grants_daily_report_v1(
  p_organization_id uuid,
  p_date            date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $bc_ngay_grant$
DECLARE
  v_actor uuid := auth.uid();
  v_ngay  date := COALESCE(p_date, current_date);
  v_ket   jsonb;
  v_tong  numeric;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'standing_grant_not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'plan_id',            p.id,
           'approved_at',        p.approved_at,
           'plan_status',        p.status,
           'max_risk',           p.max_risk,
           'step_count',         p.step_count,
           'standing_grant_ids', to_jsonb(p.standing_grant_ids)
         ) ORDER BY p.approved_at DESC), '[]'::jsonb)
    INTO v_ket
    FROM app_private.copilot_plans p
   WHERE p.organization_id = p_organization_id
     AND p.consent_kind = 'standing_grant'
     AND p.approved_at >= v_ngay::timestamptz
     AND p.approved_at < (v_ngay + 1)::timestamptz;

  SELECT COALESCE(sum(l.amount), 0)
    INTO v_tong
    FROM app_private.copilot_action_ledger l
   WHERE l.organization_id = p_organization_id
     AND l.event = 'step_done'
     AND l.consent_kind = 'standing_grant'
     AND l.created_at >= v_ngay::timestamptz
     AND l.created_at < (v_ngay + 1)::timestamptz;

  RETURN jsonb_build_object(
    'date',         v_ngay,
    'plans',        v_ket,
    'plan_count',   jsonb_array_length(v_ket),
    'total_amount', v_tong
  );
END
$bc_ngay_grant$;

REVOKE ALL ON FUNCTION public.copilot_standing_grants_daily_report_v1(uuid, date) FROM PUBLIC;
DO $quyen_bc_ngay_grant$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_standing_grants_daily_report_v1(uuid, date) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_standing_grants_daily_report_v1(uuid, date) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_standing_grants_daily_report_v1(uuid, date) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_standing_grants_daily_report_v1(uuid, date) TO authenticated;
  END IF;
END
$quyen_bc_ngay_grant$;

-- ---------------------------------------------------------------------------
-- 9. `copilot_plan_create_v1` — CREATE OR REPLACE, thêm nhánh tự duyệt.
--    Thân đọc THẲNG từ production qua Management API ngay trước khi viết file
--    này (chữ ký KHÔNG đổi — 3 tham số cũ nguyên vẹn); chỉ hai chỗ đổi: (a)
--    mỗi bước trong `v_gom` mang thêm khoá `grantable` lấy từ registry, (b)
--    sau khi vòng lặp dựng bước đóng, một khối soát-rồi-tự-duyệt được chèn
--    trước `v_plan_digest`, và nhánh RETURN cuối cùng được bọc thêm một
--    nhánh `IF v_standing_ok` phía trước — nhánh KHÔNG được phủ chạy y hệt
--    code cũ, không một dòng nào của đường DRAFT/nonce cũ bị đổi.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.copilot_plan_create_v1(
  p_organization_id  uuid,
  p_client_request_id text,
  p_steps            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $lap_ke_hoach$
DECLARE
  v_actor      uuid := auth.uid();
  v_n          int;
  v_i          int;
  v_dem        int;
  v_cu         app_private.copilot_plans%ROWTYPE;
  v_reg        app_private.copilot_action_registry%ROWTYPE;
  v_max_direct text;
  v_policy_rev bigint;
  v_reg_rev    text;
  v_buoc       jsonb;
  v_du_lieu    jsonb;
  v_hanh_dong  text;
  v_kq         jsonb;
  v_canonical  jsonb;
  v_preview    jsonb;
  v_nonce_hex  text;
  v_digest     bytea;
  v_ref        int;
  v_voucher    uuid;
  v_ie         public.income_expenses%ROWTYPE;
  v_gom        jsonb := '[]'::jsonb;
  v_gom_digest jsonb := '[]'::jsonb;
  v_max_risk   text := 'L3';
  v_plan_digest bytea;
  v_plan_id    uuid;
  v_het        timestamptz;
  v_nonce      bytea;
  v_consent_id uuid;
  v_message    text;
  -- G5-B - uy quyen dung (standing grant): dieu kien phu + khoa + tang dem.
  v_standing_enabled boolean;
  v_standing_ok      boolean;
  v_grant_locks      jsonb;
  v_step_entry       jsonb;
  v_j                int;
  v_matched_id       uuid;
  v_grant_row        app_private.copilot_standing_grants%ROWTYPE;
  v_reset_used       int;
  v_planned          int;
  v_final_grant_ids  uuid[];
  v_first_grant_id   uuid;
  v_grant_key        text;
  v_grant_val        text;
  v_han_grant        timestamptz;
  v_plan_version_moi int;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  -- Vai được phép chạy kế hoạch đọc từ `copilot_action_policy.allowed_roles`
  -- (điểm nối #7). v1 seed `{superadmin}` nhưng KHÔNG hard-code ở đây: G4 mở vai
  -- khác bằng cách lật policy, không bằng cách sửa RPC này.
  IF NOT app_private.copilot_plan_role_allowed_v1(p_organization_id) THEN
    RAISE EXCEPTION 'plan_role_not_allowed' USING ERRCODE = '42501';
  END IF;

  -- Công tắc của CẢ cơ chế kế hoạch. Tắt = không lập được kế hoạch nào, kể cả
  -- khi từng action bên trong đang bật.
  IF NOT app_private.copilot_action_flag_allows_v1('copilot.execution_plan', p_organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organizations o
     WHERE o.id = p_organization_id AND o.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'organization_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF p_client_request_id IS NULL
     OR p_client_request_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'client_request_id_invalid' USING ERRCODE = '22023';
  END IF;

  -- CHỐNG LẶP. Gửi lại cùng `client_request_id` trả về ĐÚNG kế hoạch cũ và
  -- `consent_nonce = null`: nonce chỉ ra một lần, và một lần gửi lại vì mạng chập
  -- không được biến thành một phiếu đồng ý thứ hai cho cùng dãy bước.
  SELECT * INTO v_cu
    FROM app_private.copilot_plans
   WHERE user_id = v_actor AND client_request_id = p_client_request_id;
  IF FOUND THEN
    -- CÙNG khoá nhưng KHÁC công ty không phải một lần gửi lại — đó là một khoá
    -- bị dùng lại. Trả về kế hoạch cũ ở đây sẽ đưa cho người gọi một kế hoạch
    -- của công ty khác, kèm `plan_digest` của nó, chỉ vì client sinh trùng chuỗi.
    IF v_cu.organization_id IS DISTINCT FROM p_organization_id THEN
      RAISE EXCEPTION 'client_request_id_reused' USING ERRCODE = '22023';
    END IF;
    RETURN app_private.copilot_plan_summary_v1(v_cu.id)
           || jsonb_build_object(
                'ok',            true,
                'error_code',    NULL,
                'consent_nonce', NULL,
                'da_ton_tai',    true);
  END IF;

  IF p_steps IS NULL OR jsonb_typeof(p_steps) <> 'array' THEN
    RAISE EXCEPTION 'plan_steps_invalid' USING ERRCODE = '22023';
  END IF;
  v_n := jsonb_array_length(p_steps);
  IF v_n < 1 OR v_n > 8 THEN
    RAISE EXCEPTION 'plan_step_count: % buoc, cho phep 1..8', v_n USING ERRCODE = '22023';
  END IF;

  -- Hạn mức kế hoạch ĐANG MỞ. Đếm theo hạn thật của từng trạng thái chứ không
  -- theo status trần: trạng thái hết hạn được đánh giá LƯỜI (chỉ đổi khi có ai
  -- chạm vào kế hoạch), nên đếm trần sẽ khoá vĩnh viễn một người sau ba kế hoạch
  -- bỏ quên.
  SELECT count(*) INTO v_dem
    FROM app_private.copilot_plans p
   WHERE p.user_id = v_actor
     AND ((p.status = 'DRAFT' AND p.expires_at > clock_timestamp())
          OR (p.status = 'APPROVED'
              AND COALESCE(p.execute_deadline, p.expires_at) > clock_timestamp()));
  IF v_dem >= 3 THEN
    RAISE EXCEPTION 'plan_limit: dang co % ke hoach mo', v_dem USING ERRCODE = '22023';
  END IF;

  SELECT max_direct_risk, revision INTO v_max_direct, v_policy_rev
    FROM app_private.copilot_action_policy WHERE id;
  IF v_max_direct IS NULL THEN
    RAISE EXCEPTION 'copilot_policy_missing' USING ERRCODE = 'P0002';
  END IF;
  v_reg_rev := app_private.copilot_plan_registry_revision_v1();

  FOR v_i IN 0 .. v_n - 1 LOOP
    v_buoc := p_steps -> v_i;
    IF jsonb_typeof(COALESCE(v_buoc, 'null'::jsonb)) <> 'object' THEN
      RAISE EXCEPTION 'step_invalid:%', v_i + 1 USING ERRCODE = '22023';
    END IF;
    v_hanh_dong := v_buoc ->> 'hanh_dong';
    v_du_lieu := v_buoc -> 'du_lieu';
    IF v_hanh_dong IS NULL
       OR jsonb_typeof(COALESCE(v_du_lieu, 'null'::jsonb)) <> 'object' THEN
      RAISE EXCEPTION 'step_invalid:%', v_i + 1 USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_reg
      FROM app_private.copilot_action_registry
     WHERE action_id = v_hanh_dong;
    IF NOT FOUND OR NOT v_reg.enabled THEN
      RAISE EXCEPTION 'copilot_action_disabled: % (buoc %)', v_hanh_dong, v_i + 1
        USING ERRCODE = '42501';
    END IF;

    -- TRẦN RỦI RO. `maker_submit_v1` được miễn vì nó KHÔNG ghi trực tiếp: nó đẩy
    -- một phiếu nháp vào hàng chờ để một CON NGƯỜI khác duyệt. Đó là lý do một
    -- bước L5 kiểu đó chạy được trong khi trần đang là L4 — và cũng là lý do
    -- miễn trừ này chỉ áp cho đúng một `executor_kind`, không áp theo mức rủi ro.
    IF v_reg.executor_kind <> 'maker_submit_v1'
       AND (CASE v_reg.risk WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END)
         > (CASE v_max_direct WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END) THEN
      RAISE EXCEPTION 'plan_risk_not_allowed: % la % nhung tran hien tai la %',
        v_hanh_dong, v_reg.risk, v_max_direct
        USING ERRCODE = '42501';
    END IF;

    -- CỔNG HÀNH ĐỘNG: registry + cờ kill switch + lệnh cấm khẩn cấp + phạm vi
    -- quyền thật. Hàm này tự NÉM với mã lỗi riêng của từng cửa.
    PERFORM app_private.copilot_action_gate_v1(v_hanh_dong, p_organization_id);

    IF v_reg.executor_kind = 'nonce_abi_v1' THEN
      -- Tên hàm ĐẾN TỪ REGISTRY (CHECK regex + hai CHECK theo hàng), không bao
      -- giờ từ client. Tham số đi vào bằng $1/$2, không bao giờ nối chuỗi.
      BEGIN
        EXECUTE format('SELECT public.%I($1, $2)', v_reg.preview_rpc)
           INTO v_kq
          USING p_organization_id, v_du_lieu;
      EXCEPTION WHEN others THEN
        GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
        RAISE EXCEPTION 'step_preview_failed:%:%', v_i + 1, v_message USING ERRCODE = '22023';
      END;

      v_canonical := v_kq -> 'canonical';
      v_preview := v_kq -> 'preview';
      v_nonce_hex := v_kq ->> 'confirmation_nonce';
      IF jsonb_typeof(COALESCE(v_canonical, 'null'::jsonb)) <> 'object' THEN
        RAISE EXCEPTION 'step_preview_failed:%:canonical_missing', v_i + 1
          USING ERRCODE = '22023';
      END IF;

      -- NONCE MỒ CÔI. Lời gọi xem trước vừa sinh ra một hàng xác nhận còn hạn 5
      -- phút cho một thao tác mà chưa ai đồng ý. Xoá NGAY, theo digest của chính
      -- nonce vừa nhận. Nonce thô chưa từng rời server nên hàng đó không dùng
      -- được nữa; để lại chỉ là 8 chiếc chìa khoá ghi tiền nằm chờ vô ích.
      IF v_nonce_hex ~ '^[0-9a-fA-F]{64}$' THEN
        DELETE FROM app_private.copilot_write_confirmations
         WHERE nonce_digest = extensions.digest(decode(v_nonce_hex, 'hex'), 'sha256');
      END IF;
      v_nonce_hex := NULL;

      v_digest := app_private.copilot_payload_hash_v1(v_canonical);
      v_ref := NULL;

    ELSIF v_reg.executor_kind = 'maker_submit_v1' THEN
      IF v_du_lieu ? '$ref_step' THEN
        BEGIN
          v_ref := (v_du_lieu ->> '$ref_step')::int;
        EXCEPTION WHEN others THEN
          RAISE EXCEPTION 'step_ref_invalid:%', v_i + 1 USING ERRCODE = '22023';
        END;
        -- Chỉ tham chiếu NGƯỢC được: bước n phải nằm trước bước này, nếu không
        -- kế hoạch có thể tự vòng lại chính nó.
        IF v_ref IS NULL OR v_ref < 1 OR v_ref > v_i THEN
          RAISE EXCEPTION 'step_ref_invalid:%', v_i + 1 USING ERRCODE = '22023';
        END IF;
        -- Bước được trỏ tới phải SINH RA đúng loại thực thể mà bước này TIÊU THỤ.
        --
        -- Hai vế NULL phải chặn TRƯỚC phép so. `IS DISTINCT FROM` coi
        -- `NULL <-> NULL` là BẰNG NHAU, nên một action khai thiếu
        -- `produces_entity_table` nối được với một action khai thiếu
        -- `consumes_ref_table` — hai ô trống khớp nhau và chuỗi bước được duyệt
        -- mà không ai nói được nó nối cái gì vào cái gì.
        IF v_reg.consumes_ref_table IS NULL
           OR (v_gom -> (v_ref - 1) ->> 'produces_entity_table') IS NULL
           OR (v_gom -> (v_ref - 1) ->> 'produces_entity_table')
                IS DISTINCT FROM v_reg.consumes_ref_table THEN
          RAISE EXCEPTION 'step_ref_incompatible:%', v_i + 1 USING ERRCODE = '22023';
        END IF;
        v_canonical := jsonb_build_object('$ref_step', v_ref);
        v_preview := jsonb_build_object(
          'loai',       'nop_ho_so',
          'nguon',      'ket qua cua buoc ' || v_ref::text,
          'trang_thai', 'Se nop vao hang cho duyet — AI KHONG duyet');
      ELSIF v_du_lieu ? 'voucher_id' THEN
        BEGIN
          v_voucher := (v_du_lieu ->> 'voucher_id')::uuid;
        EXCEPTION WHEN others THEN
          RAISE EXCEPTION 'step_voucher_invalid:%', v_i + 1 USING ERRCODE = '22023';
        END;
        SELECT * INTO v_ie
          FROM public.income_expenses ie
         WHERE ie.id = v_voucher
           AND ie.deleted_at IS NULL
           AND ie.organization_id = p_organization_id
           AND ie.user_id = v_actor
           AND ie.approval_status = 'UNAPPROVED'
           AND ie.posting_status = 'UNPOSTED';
        -- Hai điều kiện tách làm hai câu lệnh có chủ ý: `FOUND` là biến ngầm của
        -- lệnh TRƯỚC đó, và gộp nó vào cùng một biểu thức với một truy vấn con
        -- là đúng kiểu viết mà người đọc sau phải dừng lại đoán.
        IF NOT FOUND THEN
          RAISE EXCEPTION 'step_voucher_invalid:%', v_i + 1 USING ERRCODE = '22023';
        END IF;
        IF EXISTS (
          SELECT 1 FROM public.approval_requests a
           WHERE a.subject_type = 'FINANCIAL_VOUCHER'
             AND a.subject_id = v_voucher
             AND a.state IN ('PENDING_APPROVAL', 'POSTED')
        ) THEN
          RAISE EXCEPTION 'step_voucher_invalid:%', v_i + 1 USING ERRCODE = '22023';
        END IF;
        v_canonical := jsonb_build_object('voucher_id', v_voucher);
        v_preview := jsonb_build_object(
          'loai',       'nop_ho_so',
          'phieu',      v_ie.name,
          'so_tien',    v_ie.total_amount,
          'trang_thai', 'Se nop vao hang cho duyet — AI KHONG duyet');
        v_ref := NULL;
      ELSE
        RAISE EXCEPTION 'step_invalid:%', v_i + 1 USING ERRCODE = '22023';
      END IF;
      v_digest := app_private.copilot_payload_hash_v1(v_canonical);

    ELSE
      -- `direct_l5_v1` là của Mức 3 (G5-C). Nói thẳng là chưa có, thay vì để nó
      -- rơi vào một nhánh mặc định nào đó.
      RAISE EXCEPTION 'executor_not_supported: %', v_reg.executor_kind USING ERRCODE = '0A000';
    END IF;

    IF (CASE v_reg.risk WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END)
       > (CASE v_max_risk WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END) THEN
      v_max_risk := v_reg.risk;
    END IF;

    v_gom := v_gom || jsonb_build_array(jsonb_build_object(
      'step_no',               v_i + 1,
      'action_id',             v_reg.action_id,
      'action_version',        v_reg.version,
      'label_vi',              v_reg.label_vi,
      'permission_key',        v_reg.permission_key,
      'risk',                  v_reg.risk,
      'executor_kind',         v_reg.executor_kind,
      'produces_entity_table', v_reg.produces_entity_table,
      -- G5-B: co the phu boi uy quyen dung hay khong - doc thang tu registry
      -- luc dung buoc, khong doan lai o buoc soat phu ben duoi.
      'grantable',             v_reg.grantable,
      'payload',               v_du_lieu,
      'canonical',             v_canonical,
      'payload_digest',        encode(v_digest, 'hex'),
      'preview',               v_preview,
      'ref_step',              v_ref));

    -- Đầu vào của `plan_digest`: đúng bốn trường theo brief, theo thứ tự bước.
    -- Mảng được nối theo vòng lặp nên nó ĐÃ sắp theo step_no; không cần ORDER BY.
    v_gom_digest := v_gom_digest || jsonb_build_array(jsonb_build_object(
      'n', v_i + 1,
      'a', v_reg.action_id,
      'v', v_reg.version,
      'd', encode(v_digest, 'hex')));
  END LOOP;

  -- ---------------------------------------------------------------------
  -- DIEM NOI #4 - UY QUYEN DUNG (G5-B). Soat TRUOC khi ghi bat cu gi xuong
  -- copilot_plans: neu van dang mo va MOI buoc deu co mot han muc dung con
  -- hieu luc phu, ke hoach se tu duyet o cuoi ham nay. Mot buoc khong duoc
  -- phu (ke ca vi action grantable = false, nhom phan quyen cua G5-C) dua
  -- toan bo ve duong DRAFT cho bam/PIN nhu truoc G5-B - KHONG co nhanh loi
  -- rieng cho "khong phu du", vi do khong phai mot loi.
  --
  -- KHOA NGAY TU LUOT SOAT, KHONG SOAT-ROI-KHOA-SAU. FOR UPDATE trong vong
  -- lap duoi day giu khoa toi het giao dich (het loi goi ham), nen khong
  -- phien nao khac doi duoc used_today giua luc soat va luc ghi tang o cuoi
  -- ham - khong co cua so de hai ke hoach song song cung tieu mot don vi
  -- han muc.
  SELECT standing_grants_enabled INTO v_standing_enabled
    FROM app_private.copilot_action_policy WHERE id;
  v_standing_ok := COALESCE(v_standing_enabled, false);
  v_grant_locks := '{}'::jsonb;

  IF v_standing_ok THEN
    FOR v_j IN 0 .. v_n - 1 LOOP
      v_step_entry := v_gom -> v_j;
      IF NOT COALESCE((v_step_entry ->> 'grantable')::boolean, false) THEN
        v_standing_ok := false;
        EXIT;
      END IF;

      v_matched_id := NULL;
      FOR v_grant_row IN
        SELECT * FROM app_private.copilot_standing_grants g
         WHERE g.organization_id = p_organization_id
           AND g.action_id = (v_step_entry ->> 'action_id')
           AND g.revoked_at IS NULL
           AND g.expires_at > clock_timestamp()
         ORDER BY g.expires_at ASC
         FOR UPDATE
      LOOP
        v_reset_used := CASE WHEN v_grant_row.used_on IS DISTINCT FROM current_date
                              THEN 0 ELSE v_grant_row.used_today END;
        v_planned := COALESCE((v_grant_locks ->> v_grant_row.id::text)::int, 0);
        IF v_reset_used + v_planned >= v_grant_row.max_per_day THEN
          CONTINUE;
        END IF;

        -- Rang buoc chi SO khi han muc co khai. Khai ma buoc khong mang
        -- truong tuong ung la KHONG khop - thieu du lieu khong phai mot
        -- duong tu do.
        IF v_grant_row.constraints ? 'max_amount' THEN
          IF NOT ((v_step_entry -> 'canonical') ? 'amount')
             OR ((v_step_entry -> 'canonical') ->> 'amount')::numeric
                  > (v_grant_row.constraints ->> 'max_amount')::numeric THEN
            CONTINUE;
          END IF;
        END IF;
        IF v_grant_row.constraints ? 'building_ids' THEN
          IF NOT ((v_step_entry -> 'canonical') ? 'building_id')
             OR NOT ((v_grant_row.constraints -> 'building_ids')
                       ? ((v_step_entry -> 'canonical') ->> 'building_id')) THEN
            CONTINUE;
          END IF;
        END IF;

        v_matched_id := v_grant_row.id;
        v_grant_locks := jsonb_set(v_grant_locks, ARRAY[v_grant_row.id::text],
                                    to_jsonb(v_planned + 1));
        EXIT;
      END LOOP;

      IF v_matched_id IS NULL THEN
        v_standing_ok := false;
        EXIT;
      END IF;
    END LOOP;
  END IF;

  v_plan_digest := app_private.copilot_payload_hash_v1(jsonb_build_object(
    'organization_id',   p_organization_id,
    'actor',             v_actor,
    'registry_revision', v_reg_rev,
    'steps',             v_gom_digest));

  v_het := clock_timestamp() + interval '5 minutes';

  BEGIN
    INSERT INTO app_private.copilot_plans (
      user_id, organization_id, client_request_id, status, version, plan_digest,
      registry_revision, policy_revision, max_risk, step_count, expires_at
    )
    VALUES (
      v_actor, p_organization_id, p_client_request_id, 'DRAFT', 1, v_plan_digest,
      v_reg_rev, v_policy_rev, v_max_risk, v_n, v_het
    )
    RETURNING id INTO v_plan_id;
  EXCEPTION WHEN unique_violation THEN
    -- Hai lời gọi song song cùng `client_request_id`. Kẻ thua trả về kế hoạch của
    -- kẻ thắng, không nonce — đúng như đường chống lặp ở trên.
    SELECT * INTO v_cu
      FROM app_private.copilot_plans
     WHERE user_id = v_actor AND client_request_id = p_client_request_id;
    IF v_cu.organization_id IS DISTINCT FROM p_organization_id THEN
      RAISE EXCEPTION 'client_request_id_reused' USING ERRCODE = '22023';
    END IF;
    RETURN app_private.copilot_plan_summary_v1(v_cu.id)
           || jsonb_build_object(
                'ok',            true,
                'error_code',    NULL,
                'consent_nonce', NULL,
                'da_ton_tai',    true);
  END;

  INSERT INTO app_private.copilot_plan_steps (
    plan_id, step_no, action_id, action_version, permission_key, risk, executor_kind,
    payload, canonical, payload_digest, preview, ref_step, status
  )
  SELECT
    v_plan_id,
    (e ->> 'step_no')::int,
    e ->> 'action_id',
    (e ->> 'action_version')::int,
    e ->> 'permission_key',
    e ->> 'risk',
    e ->> 'executor_kind',
    e -> 'payload',
    e -> 'canonical',
    decode(e ->> 'payload_digest', 'hex'),
    e -> 'preview',
    NULLIF(e ->> 'ref_step', '')::int,
    'PENDING'
    FROM jsonb_array_elements(v_gom) e;

  -- ĐỒNG Ý CẤP KẾ HOẠCH: một hàng trong đúng cái kho nonce mà mọi thao tác ghi
  -- của Copilot đã dùng, chỉ khác `tool`. `copilot_execute_income_expense_v1`
  -- kiểm `tool` nên nonce kế hoạch không bao giờ tiêu được cho một phiếu lẻ, và
  -- ngược lại.
  v_nonce := extensions.gen_random_bytes(32);
  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash, permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'lap_ke_hoach', v_plan_digest, 'copilot.execution_plan', v_het)
  RETURNING id INTO v_consent_id;

  PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',           'plan_created',
    'organization_id', p_organization_id,
    'plan_id',         v_plan_id,
    'plan_version',    1,
    'permission_key',  'copilot.execution_plan',
    'permission_snapshot', jsonb_build_object(
      'registry_revision', v_reg_rev,
      'policy_revision',   v_policy_rev,
      'max_direct_risk',   v_max_direct,
      'plan_max_risk',     v_max_risk,
      'step_count',        v_n,
      'flag_plan',         true,
      'checked_at',        clock_timestamp()),
    'consent_id',      v_consent_id,
    'payload_digest',  encode(v_plan_digest, 'hex'),
    'outcome', jsonb_build_object(
      'plan_status',       'DRAFT',
      'client_request_id', p_client_request_id,
      'actions',           (SELECT jsonb_agg(e ->> 'action_id') FROM jsonb_array_elements(v_gom) e))
  ));

  -- DIEM NOI #4 - TU DUYET THEO UY QUYEN DUNG. Phieu dong y (v_consent_id)
  -- va so plan_created phia tren DA ghi binh thuong - mot ke hoach tu duyet
  -- van phai de lai dung dau vet nhu mot ke hoach cho nguoi bam. Nhanh nay
  -- chi lam them: tang used_today cua cac han muc da khoa, tieu luon phieu
  -- dong y (khong ai can bam nua), va day ke hoach thang sang APPROVED.
  IF v_standing_ok THEN
    v_final_grant_ids := ARRAY(SELECT (jsonb_object_keys(v_grant_locks))::uuid);
    v_first_grant_id := v_final_grant_ids[1];

    FOR v_grant_key, v_grant_val IN SELECT * FROM jsonb_each_text(v_grant_locks) LOOP
      UPDATE app_private.copilot_standing_grants
         SET used_today = (CASE WHEN used_on IS DISTINCT FROM current_date
                                 THEN 0 ELSE used_today END) + v_grant_val::int,
             used_on    = current_date
       WHERE id = v_grant_key::uuid;

      INSERT INTO app_private.copilot_standing_grants_audit (
        grant_id, organization_id, action, actor, detail
      )
      VALUES (
        v_grant_key::uuid, p_organization_id, 'used', v_actor,
        jsonb_build_object('plan_id', v_plan_id, 'used', v_grant_val::int)
      );

      PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
        'event',           'grant_used',
        'organization_id', p_organization_id,
        'plan_id',         v_plan_id,
        'grant_id',        v_grant_key::uuid,
        'outcome',         jsonb_build_object('used', v_grant_val::int)));
    END LOOP;

    -- Tieu nonce cap ke hoach NGAY - khong ai bam, khong ai can no nua; de no
    -- song tiep chi la mot phieu dong y chua dung nam cho vo ich.
    UPDATE app_private.copilot_write_confirmations
       SET consumed_at = clock_timestamp()
     WHERE id = v_consent_id AND consumed_at IS NULL;

    v_han_grant := clock_timestamp() + interval '30 minutes';
    UPDATE app_private.copilot_plans
       SET status                  = 'APPROVED',
           approved_at             = clock_timestamp(),
           execute_deadline        = v_han_grant,
           consent_confirmation_id = v_consent_id,
           consent_kind            = 'standing_grant',
           standing_grant_ids      = v_final_grant_ids,
           version                 = version + 1,
           updated_at              = clock_timestamp()
     WHERE id = v_plan_id
    RETURNING version INTO v_plan_version_moi;

    PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',           'plan_approved',
      'organization_id', p_organization_id,
      'plan_id',         v_plan_id,
      'plan_version',    v_plan_version_moi,
      'permission_key',  'copilot.execution_plan',
      'consent_id',      v_consent_id,
      'consent_kind',    'standing_grant',
      'grant_id',        v_first_grant_id,
      'payload_digest',  encode(v_plan_digest, 'hex'),
      'outcome', jsonb_build_object(
        'plan_status',        'APPROVED',
        'execute_deadline',   v_han_grant,
        'standing_grant_ids', to_jsonb(v_final_grant_ids))));

    RETURN app_private.copilot_plan_summary_v1(v_plan_id)
           || jsonb_build_object(
                'ok',                     true,
                'error_code',             NULL,
                -- KHONG nonce: khong ai can bam duyet nua, mot nonce ra
                -- ngoai o day chi la mot phieu dong y mo coi khong bao gio
                -- duoc tieu boi copilot_plan_approve_v1 (ke hoach khong con
                -- DRAFT).
                'consent_nonce',          NULL,
                'da_ton_tai',             false,
                'tu_duyet_theo_uy_quyen', to_jsonb(v_final_grant_ids));
  END IF;

  RETURN app_private.copilot_plan_summary_v1(v_plan_id)
         || jsonb_build_object(
              'ok',            true,
              'error_code',    NULL,
              -- Nonce thô ra ĐÚNG MỘT LẦN. Client giữ trong bộ nhớ; nó không vào
              -- ngữ cảnh mô hình, không vào lịch sử chat, không vào URL, không log.
              'consent_nonce', encode(v_nonce, 'hex'),
              'da_ton_tai',    false);
END
$lap_ke_hoach$;

-- ---------------------------------------------------------------------------
-- 10. `copilot_plan_execute_step_v1` — CREATE OR REPLACE, chỉ thêm khoá
--     `amount` vào sự kiện `step_done` (đọc từ `v_step.canonical` — canonical
--     đã CHỐT ở bước xem trước, không phải payload thô của client). Thân đọc
--     THẲNG từ production qua Management API; chữ ký 4 tham số không đổi.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.copilot_plan_execute_step_v1(
  p_plan_id               uuid,
  p_step_no               int,
  p_expected_plan_version int,
  p_organization_id       uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $thuc_thi_buoc$
DECLARE
  v_actor       uuid := auth.uid();
  v_plan        app_private.copilot_plans%ROWTYPE;
  v_step        app_private.copilot_plan_steps%ROWTYPE;
  v_reg         app_private.copilot_action_registry%ROWTYPE;
  v_snapshot    jsonb := '{}'::jsonb;
  v_max_direct  text;
  v_policy_rev  bigint;
  v_next        int;
  v_version     int;
  v_kq          jsonb;
  v_ket         jsonb;
  v_canon_moi   jsonb;
  v_nonce       text;
  v_bang        text;
  v_entity_id   uuid;
  v_audit_id    uuid;
  v_trang_thai  text;
  v_after       jsonb;
  v_after_hex   text;
  v_voucher     uuid;
  v_idem        boolean := false;
  v_loi         text := NULL;
  v_chi_tiet    text := NULL;
  v_sqlstate    text := NULL;
  v_su_kien     text := NULL;
  v_ledger_id   uuid;
  v_plan_status text;
  v_buoc_status text;
  v_chan        int[];
  v_j           int;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_plan_id IS NULL OR p_step_no IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;

  BEGIN
    SELECT * INTO v_plan
      FROM app_private.copilot_plans p
     WHERE p.id = p_plan_id AND p.user_id = v_actor
     FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'plan_busy' USING ERRCODE = '55P03';
  END;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Tổ chức đi vào như một tham số RIÊNG và phải khớp kế hoạch. Đây là hàng rào
  -- chống "đổi công ty giữa phiên": client bind org của phiên vào lời gọi, nên
  -- một kế hoạch của công ty A không chạy được từ màn hình công ty B.
  IF p_organization_id IS NULL OR v_plan.organization_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  IF v_plan.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'plan_not_approved: dang o %', v_plan.status USING ERRCODE = '22023';
  END IF;

  -- QUÁ HẠN THỰC THI. Ghi rồi TRẢ VỀ (quyết định 4 ở đầu file): mọi bước còn chờ
  -- thành BLOCKED và kế hoạch thành EXPIRED, nếu không nó nằm mãi ở APPROVED và
  -- hạn mức "3 kế hoạch mở" sẽ đếm nhầm.
  IF COALESCE(v_plan.execute_deadline, v_plan.expires_at) <= clock_timestamp() THEN
    UPDATE app_private.copilot_plan_steps
       SET status = 'BLOCKED', error_code = 'plan_expired'
     WHERE plan_id = v_plan.id AND status = 'PENDING';
    UPDATE app_private.copilot_plans
       SET status = 'EXPIRED', version = version + 1,
           failure_reason = 'plan_expired', updated_at = clock_timestamp()
     WHERE id = v_plan.id
    RETURNING version INTO v_version;
    PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',           'plan_expired',
      'organization_id', v_plan.organization_id,
      'plan_id',         v_plan.id,
      'step_no',         p_step_no,
      'plan_version',    v_version,
      'permission_key',  'copilot.execution_plan',
      'consent_id',      v_plan.consent_confirmation_id,
      'consent_kind',    v_plan.consent_kind,
      'step_up_id',      v_plan.step_up_confirmation_id,
      'error_code',      'plan_expired',
      'outcome',         jsonb_build_object('giai_doan', 'execute')));
    RETURN jsonb_build_object(
      'ok',           false,
      'error_code',   'plan_expired',
      'plan_id',      v_plan.id,
      'plan_version', v_version,
      'plan_status',  'EXPIRED',
      'step', jsonb_build_object(
        'step_no', p_step_no, 'status', 'BLOCKED', 'outcome', NULL,
        'error_code', 'plan_expired'),
      'next_step_no', NULL);
  END IF;

  IF p_expected_plan_version IS NULL OR v_plan.version <> p_expected_plan_version THEN
    RAISE EXCEPTION 'plan_version_stale: dang o %, nguoi goi mong %',
      v_plan.version, p_expected_plan_version
      USING ERRCODE = '40001';
  END IF;

  -- BƯỚC TUYẾN TÍNH. Chỉ bước PENDING nhỏ nhất được chạy, và mọi bước trước nó
  -- phải DONE. Không có đường nhảy cóc: bước 3 thường phụ thuộc kết quả bước 1.
  SELECT min(step_no) INTO v_next
    FROM app_private.copilot_plan_steps
   WHERE plan_id = v_plan.id AND status = 'PENDING';
  IF v_next IS NULL THEN
    RAISE EXCEPTION 'plan_no_pending_step' USING ERRCODE = '22023';
  END IF;
  IF p_step_no IS DISTINCT FROM v_next THEN
    RAISE EXCEPTION 'step_order: buoc ke tiep la %', v_next USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app_private.copilot_plan_steps
     WHERE plan_id = v_plan.id AND step_no < p_step_no AND status <> 'DONE'
  ) THEN
    RAISE EXCEPTION 'step_order: con buoc truoc chua xong' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_step
    FROM app_private.copilot_plan_steps
   WHERE plan_id = v_plan.id AND step_no = p_step_no
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'step_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- ---------------------------------------------------------------------
  -- TẦNG (2) — TIỀN KIỂM, ngay trước khi ghi. Không phải kiểm lại cho vui:
  -- giữa lúc duyệt và lúc bấm chạy có tới 30 phút.
  -- ---------------------------------------------------------------------
  BEGIN
    IF NOT app_private.copilot_action_flag_allows_v1(
             'copilot.execution_plan', v_plan.organization_id) THEN
      RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_reg
      FROM app_private.copilot_action_registry
     WHERE action_id = v_step.action_id;
    IF NOT FOUND OR NOT v_reg.enabled OR v_reg.version <> v_step.action_version THEN
      RAISE EXCEPTION 'registry_changed' USING ERRCODE = '42501';
    END IF;

    -- POLICY, ĐO LẠI NGAY TRƯỚC KHI GHI.
    --
    --   `copilot_action_gate_v1` không biết trần rủi ro và không biết danh sách
    --   vai — nó đo registry + cờ + cấm khẩn cấp + phạm vi quyền. Kế hoạch được
    --   duyệt xong còn 30 phút để chạy, và trong 30 phút đó van có thể bị hạ.
    --   Không hỏi lại nghĩa là một lần hạ trần rủi ro không dừng được thứ đang
    --   chạy dở — đúng lúc người ta hạ trần vì đang có sự cố.
    --
    --   Cả ba vế (revision đã đổi / vai không còn được phép / bước vượt trần)
    --   cùng ném `policy_changed`: với người bấm chúng là một chuyện.
    SELECT max_direct_risk, revision INTO v_max_direct, v_policy_rev
      FROM app_private.copilot_action_policy WHERE id;
    IF v_max_direct IS NULL OR v_policy_rev IS NULL THEN
      RAISE EXCEPTION 'copilot_policy_missing' USING ERRCODE = 'P0002';
    END IF;
    IF v_policy_rev IS DISTINCT FROM v_plan.policy_revision
       OR NOT app_private.copilot_plan_role_allowed_v1(v_plan.organization_id)
       OR (v_reg.executor_kind <> 'maker_submit_v1'
           AND (CASE v_reg.risk WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END)
             > (CASE v_max_direct WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END)) THEN
      RAISE EXCEPTION 'policy_changed' USING ERRCODE = '42501';
    END IF;

    v_snapshot := app_private.copilot_action_gate_v1(v_step.action_id, v_plan.organization_id);

    -- Digest đã duyệt phải còn khớp `canonical` đang lưu. Vế này bắt đúng một
    -- kiểu tấn công: sửa thẳng hàng bước trong database giữa duyệt và chạy.
    IF v_step.canonical IS NULL
       OR v_step.payload_digest IS NULL
       OR app_private.copilot_payload_hash_v1(v_step.canonical)
            IS DISTINCT FROM v_step.payload_digest THEN
      RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
    END IF;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_chi_tiet = MESSAGE_TEXT;
    v_loi := split_part(v_chi_tiet, ':', 1);
    v_su_kien := 'step_blocked';
  END;

  -- ---------------------------------------------------------------------
  -- TẦNG (3) — KHỐI CON THỰC THI. Mọi hiệu ứng ghi nằm trong đây và chỉ
  -- trong đây, nên một lỗi bất kỳ cuốn ngược sạch mà giao dịch ngoài vẫn
  -- sống để ghi sổ.
  -- ---------------------------------------------------------------------
  IF v_loi IS NULL THEN
    BEGIN
      IF v_reg.executor_kind = 'nonce_abi_v1' THEN
        -- XEM TRƯỚC LẠI để lấy nonce MỚI. Nonce này sinh ra và bị tiêu trong
        -- đúng giao dịch này; nó không tồn tại ở đâu khác, không ai cầm được.
        -- Tên hàm đến từ REGISTRY (CHECK regex + hai CHECK theo hàng).
        EXECUTE format('SELECT public.%I($1, $2)', v_reg.preview_rpc)
           INTO v_kq
          USING v_plan.organization_id, v_step.payload;
        v_canon_moi := v_kq -> 'canonical';
        v_nonce := v_kq ->> 'confirmation_nonce';
        -- Thế giới đã đổi (giá, hạng mục, tên toà…) thì `canonical` mới sẽ băm
        -- ra khác. Dừng lại: thứ sắp ghi không còn là thứ người dùng đã duyệt.
        IF jsonb_typeof(COALESCE(v_canon_moi, 'null'::jsonb)) <> 'object'
           OR app_private.copilot_payload_hash_v1(v_canon_moi)
                IS DISTINCT FROM v_step.payload_digest THEN
          RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
        END IF;

        EXECUTE format('SELECT public.%I($1, $2)', v_reg.execute_rpc)
           INTO v_ket
          USING v_nonce, v_canon_moi;

      ELSIF v_reg.executor_kind = 'maker_submit_v1' THEN
        IF v_step.ref_step IS NOT NULL THEN
          -- `{$ref_step: n}`: thực thể do bước n vừa tạo. Đọc từ KẾT QUẢ ĐÃ GHI
          -- của bước đó, không từ payload — payload không biết id sẽ là gì.
          SELECT NULLIF(s.outcome ->> 'entity_id', '')::uuid INTO v_voucher
            FROM app_private.copilot_plan_steps s
           WHERE s.plan_id = v_plan.id
             AND s.step_no = v_step.ref_step
             AND s.status = 'DONE';
          IF v_voucher IS NULL THEN
            RAISE EXCEPTION 'ref_step_unresolved' USING ERRCODE = '22023';
          END IF;
        ELSE
          v_voucher := NULLIF(v_step.canonical ->> 'voucher_id', '')::uuid;
          IF v_voucher IS NULL THEN
            RAISE EXCEPTION 'step_voucher_invalid' USING ERRCODE = '22023';
          END IF;
        END IF;
        v_ket := app_private.copilot_plan_submit_voucher_v1(
                   v_plan.organization_id, v_voucher, v_plan.id, v_step.step_no);

      ELSE
        RAISE EXCEPTION 'executor_not_supported' USING ERRCODE = '0A000';
      END IF;

      v_trang_thai := COALESCE(v_ket ->> 'status', 'da_thuc_hien');
      v_bang := COALESCE(NULLIF(v_ket ->> 'entity_table', ''), v_reg.produces_entity_table);
      v_entity_id := NULLIF(v_ket ->> 'entity_id', '')::uuid;
      v_audit_id := NULLIF(v_ket ->> 'audit_id', '')::uuid;
      -- Chạy lại một bước đã ghi KHÔNG phải lỗi: lớp chống-lặp của chính action
      -- trả về bản ghi cũ. Bước vẫn DONE, chỉ mang cờ `idempotent`.
      v_idem := v_trang_thai IN ('da_thuc_hien_truoc_do', 'da_tao_truoc_do')
                OR COALESCE((v_ket ->> 'idempotent')::boolean, false);

      -- ĐỌC LẠI TỪ BẢNG. Tên bảng đến từ kết quả của RPC đã chạy hoặc từ
      -- registry — KHÔNG từ tham số của người gọi — và vẫn đi qua `%I` cộng một
      -- ràng buộc hình dạng, nên trường hợp xấu nhất là một định danh không tồn
      -- tại (bước FAILED), không phải một câu lệnh chắp nối.
      IF v_entity_id IS NULL OR v_bang IS NULL OR v_bang !~ '^[a-z_][a-z0-9_]*$' THEN
        RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
      END IF;
      EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE t.id = $1', v_bang)
         INTO v_after
        USING v_entity_id;
      IF v_after IS NULL
         OR NULLIF(v_after ->> 'organization_id', '')::uuid
              IS DISTINCT FROM v_plan.organization_id THEN
        RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
      END IF;

      -- Bất biến theo `verify_kind` của registry. Sai ở đây nghĩa là hàng ghi ra
      -- KHÔNG đúng thứ thẻ xem trước đã hứa — cuốn ngược, đừng chữa.
      CASE v_reg.verify_kind
        WHEN 'ie_draft' THEN
          IF v_after ->> 'approval_status' IS DISTINCT FROM 'UNAPPROVED'
             OR v_after ->> 'posting_status' IS DISTINCT FROM 'UNPOSTED'
             OR NULLIF(v_after ->> 'user_id', '')::uuid IS DISTINCT FROM v_actor THEN
            RAISE EXCEPTION 'copilot_draft_invariant_violation' USING ERRCODE = 'P0001';
          END IF;
        WHEN 'approval_request_pending' THEN
          IF v_after ->> 'state' IS DISTINCT FROM 'PENDING_APPROVAL'
             OR NULLIF(v_after ->> 'maker_user_id', '')::uuid IS DISTINCT FROM v_actor THEN
            RAISE EXCEPTION 'copilot_draft_invariant_violation' USING ERRCODE = 'P0001';
          END IF;
        WHEN 'hold_pending_approval' THEN
          IF v_after ->> 'status' IS DISTINCT FROM 'PENDING_APPROVAL' THEN
            RAISE EXCEPTION 'copilot_draft_invariant_violation' USING ERRCODE = 'P0001';
          END IF;
        ELSE
          -- 'readback': tồn tại + đúng tổ chức đã là toàn bộ lời hứa.
          NULL;
      END CASE;
    EXCEPTION WHEN others THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_chi_tiet = MESSAGE_TEXT;
      v_loi := split_part(v_chi_tiet, ':', 1);
      v_su_kien := 'step_failed';
    END;
  END IF;

  -- ---------------------------------------------------------------------
  -- ĐUÔI — chạy ở GIAO DỊCH NGOÀI. Đây là chỗ trạng thái và sổ được ghi, và
  -- đó là lý do chúng sống sót qua lần cuộn ngược của khối con.
  -- ---------------------------------------------------------------------
  IF v_loi IS NULL THEN
    v_after_hex := encode(
      extensions.digest(convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex');

    UPDATE app_private.copilot_plan_steps
       SET status = 'DONE',
           outcome = jsonb_build_object(
             'entity_table', v_bang,
             'entity_id',    v_entity_id,
             'audit_id',     v_audit_id,
             'idempotent',   v_idem,
             'status',       v_trang_thai),
           error_code = NULL,
           error_detail = NULL,
           executed_at = clock_timestamp()
     WHERE plan_id = v_plan.id AND step_no = p_step_no;

    v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',               'step_done',
      'organization_id',     v_plan.organization_id,
      'plan_id',             v_plan.id,
      'step_no',             p_step_no,
      'plan_version',        v_plan.version + 1,
      'action_id',           v_step.action_id,
      'permission_key',      v_step.permission_key,
      'permission_snapshot', v_snapshot,
      'consent_id',          v_plan.consent_confirmation_id,
      'consent_kind',        v_plan.consent_kind,
      'step_up_id',          v_plan.step_up_confirmation_id,
      'payload_digest',      encode(v_step.payload_digest, 'hex'),
      'after_digest',        v_after_hex,
      'entity_table',        v_bang,
      'entity_id',           v_entity_id,
      'audit_id',            v_audit_id,
      -- G5-B: bao cao ngay cua uy quyen dung can tong tien theo ngay. Chi doc
      -- tu canonical DA CHOT o buoc xem truoc lai (v_step.canonical) — khong
      -- bao gio doc tu payload tho cua client.
      'amount',              NULLIF(v_step.canonical ->> 'amount', ''),
      'outcome', jsonb_build_object('status', v_trang_thai, 'idempotent', v_idem)));

    UPDATE app_private.copilot_plan_steps
       SET ledger_id = v_ledger_id
     WHERE plan_id = v_plan.id AND step_no = p_step_no;

    v_buoc_status := 'DONE';
    SELECT min(step_no) INTO v_next
      FROM app_private.copilot_plan_steps
     WHERE plan_id = v_plan.id AND status = 'PENDING';
    v_plan_status := CASE WHEN v_next IS NULL THEN 'DONE' ELSE 'APPROVED' END;

    UPDATE app_private.copilot_plans
       SET status = v_plan_status, version = version + 1, updated_at = clock_timestamp()
     WHERE id = v_plan.id AND version = p_expected_plan_version
    RETURNING version INTO v_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'plan_version_stale' USING ERRCODE = '40001';
    END IF;

  ELSE
    v_buoc_status := CASE WHEN v_su_kien = 'step_blocked' THEN 'BLOCKED' ELSE 'FAILED' END;

    UPDATE app_private.copilot_plan_steps
       SET status = v_buoc_status,
           error_code = v_loi,
           error_detail = left(COALESCE(v_chi_tiet, ''), 1000),
           executed_at = clock_timestamp()
     WHERE plan_id = v_plan.id AND step_no = p_step_no;

    -- Một bước hỏng làm CẢ kế hoạch dừng. Không có "bỏ qua rồi chạy tiếp": bước
    -- sau thường tựa vào kết quả bước trước, và đoán xem cái nào độc lập là đúng
    -- kiểu suy luận mà một hệ ghi tiền không được phép làm.
    SELECT array_agg(step_no ORDER BY step_no) INTO v_chan
      FROM app_private.copilot_plan_steps
     WHERE plan_id = v_plan.id AND status = 'PENDING' AND step_no <> p_step_no;

    UPDATE app_private.copilot_plan_steps
       SET status = 'BLOCKED', error_code = 'plan_failed'
     WHERE plan_id = v_plan.id AND status = 'PENDING' AND step_no <> p_step_no;

    v_plan_status := 'FAILED';
    UPDATE app_private.copilot_plans
       SET status = 'FAILED',
           version = version + 1,
           failure_reason = v_su_kien || ':' || p_step_no::text || ':' || COALESCE(v_loi, '?'),
           updated_at = clock_timestamp()
     WHERE id = v_plan.id AND version = p_expected_plan_version
    RETURNING version INTO v_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'plan_version_stale' USING ERRCODE = '40001';
    END IF;

    v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',               v_su_kien,
      'organization_id',     v_plan.organization_id,
      'plan_id',             v_plan.id,
      'step_no',             p_step_no,
      'plan_version',        v_version,
      'action_id',           v_step.action_id,
      'permission_key',      v_step.permission_key,
      'permission_snapshot', v_snapshot,
      'consent_id',          v_plan.consent_confirmation_id,
      'consent_kind',        v_plan.consent_kind,
      'step_up_id',          v_plan.step_up_confirmation_id,
      'payload_digest',      encode(v_step.payload_digest, 'hex'),
      'error_code',          v_loi,
      'sqlstate',            v_sqlstate,
      -- KHÔNG nhét `SQLERRM` thô vào đây. `copilot_plan_get_v1` trả 20 dòng sổ
      -- cho chủ kế hoạch, nên mọi thứ vào `outcome` là thứ ra tới trình duyệt.
      -- Thông điệp đầy đủ ở lại `copilot_plan_steps.error_detail` — cột mà
      -- `copilot_plan_summary_v1` không đọc.
      'outcome', jsonb_build_object('plan_status', 'FAILED')));

    UPDATE app_private.copilot_plan_steps
       SET ledger_id = v_ledger_id
     WHERE plan_id = v_plan.id AND step_no = p_step_no;

    -- Mỗi bước bị chặn theo có một dòng sổ riêng. Gộp lại thành một dòng sẽ làm
    -- việc dựng lại "bước nào đã không chạy" thành suy đoán.
    IF v_chan IS NOT NULL THEN
      FOREACH v_j IN ARRAY v_chan LOOP
        PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
          'event',           'step_blocked',
          'organization_id', v_plan.organization_id,
          'plan_id',         v_plan.id,
          'step_no',         v_j,
          'plan_version',    v_version,
          'action_id',       (SELECT action_id FROM app_private.copilot_plan_steps
                               WHERE plan_id = v_plan.id AND step_no = v_j),
          'permission_key',  'copilot.execution_plan',
          'consent_id',      v_plan.consent_confirmation_id,
          'consent_kind',    v_plan.consent_kind,
          'step_up_id',      v_plan.step_up_confirmation_id,
          'error_code',      'plan_failed',
          'outcome',         jsonb_build_object('nguyen_nhan_tu_buoc', p_step_no)));
      END LOOP;
    END IF;
    v_next := NULL;
  END IF;

  RETURN jsonb_build_object(
    'ok',           v_loi IS NULL,
    'error_code',   v_loi,
    'plan_id',      v_plan.id,
    'plan_version', v_version,
    'plan_status',  v_plan_status,
    'step', jsonb_build_object(
      'step_no',    p_step_no,
      'status',     v_buoc_status,
      'outcome',    CASE WHEN v_loi IS NULL THEN jsonb_build_object(
                           'entity_table', v_bang,
                           'entity_id',    v_entity_id,
                           'audit_id',     v_audit_id,
                           'idempotent',   v_idem)
                         ELSE NULL END,
      'error_code', v_loi),
    'next_step_no', v_next);
END
$thuc_thi_buoc$;


-- ---------------------------------------------------------------------------
-- NGHIỆM THU — chỉ soi catalog, chạy được trên database rỗng (cùng khuôn
-- 20260903043956/150311).
-- ---------------------------------------------------------------------------
DO $nghiem_thu_grant$
DECLARE
  v_ten   text;
  v_thieu text[] := '{}'::text[];
  v_ho    text[] := '{}'::text[];
BEGIN
  -- (1) Hai bảng mới.
  FOREACH v_ten IN ARRAY ARRAY[
    'copilot_standing_grants',
    'copilot_standing_grants_audit'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'app_private' AND tablename = v_ten
    ) THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu bang G5-B: %', array_to_string(v_thieu, ', ');
  END IF;

  -- (2) Hai cột mới trên bảng cũ.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'app_private' AND table_name = 'copilot_action_registry'
       AND column_name = 'grantable' AND data_type = 'boolean'
  ) THEN
    RAISE EXCEPTION 'thieu cot copilot_action_registry.grantable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'app_private' AND table_name = 'copilot_action_ledger'
       AND column_name = 'amount' AND data_type = 'numeric'
  ) THEN
    RAISE EXCEPTION 'thieu cot copilot_action_ledger.amount';
  END IF;

  -- (3) CHECK theo hàng của bảng grant + CHECK event đã có 3 sự kiện grant_*.
  v_thieu := '{}'::text[];
  FOREACH v_ten IN ARRAY ARRAY[
    'copilot_standing_grants_max_per_day_check',
    'copilot_standing_grants_expires_within_30d',
    'copilot_standing_grants_reason_required',
    'copilot_standing_grants_constraints_object',
    'copilot_standing_grants_used_today_nonneg',
    'copilot_standing_grants_revoked_pair'
  ]
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = v_ten) THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu CHECK bang grant: %', array_to_string(v_thieu, ', ');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'copilot_action_ledger_event_check'
       AND conrelid = 'app_private.copilot_action_ledger'::regclass
       AND pg_get_constraintdef(oid) LIKE '%grant_created%'
       AND pg_get_constraintdef(oid) LIKE '%grant_revoked%'
       AND pg_get_constraintdef(oid) LIKE '%grant_used%'
  ) THEN
    RAISE EXCEPTION 'CHECK event thieu 3 su kien grant_*';
  END IF;

  -- (4) Ba trigger: guard cấp phát + bất biến sổ grant. (Trigger cập nhật
  -- `updated_at`/bất biến của các bảng khác đã được 043956/150311 nghiệm thu.)
  v_thieu := '{}'::text[];
  FOREACH v_ten IN ARRAY ARRAY[
    'trg_copilot_standing_grant_guard',
    'trg_copilot_standing_grants_audit_bat_bien'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'app_private' AND t.tgname = v_ten AND NOT t.tgisinternal
    ) THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu trigger G5-B: %', array_to_string(v_thieu, ', ');
  END IF;

  -- (5) Hàm phải tồn tại đúng chữ ký.
  v_thieu := '{}'::text[];
  FOREACH v_ten IN ARRAY ARRAY[
    'app_private.copilot_standing_grant_guard_v1()',
    'app_private.copilot_standing_grants_audit_bat_bien_v1()',
    'public.copilot_standing_grant_create_v1(uuid, text, jsonb, integer, timestamptz, text, text)',
    'public.copilot_standing_grant_revoke_v1(uuid, text)',
    'public.copilot_standing_grants_revoke_all_v1(uuid, text)',
    'public.copilot_standing_grants_list_v1(uuid)',
    'public.copilot_standing_grants_daily_report_v1(uuid, date)'
  ]
  LOOP
    IF to_regprocedure(v_ten) IS NULL THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu ham G5-B: %', array_to_string(v_thieu, ', ');
  END IF;

  -- (6) `copilot_plan_create_v1`/`copilot_plan_execute_step_v1` vẫn đúng chữ
  -- ký cũ sau CREATE OR REPLACE (điểm nối #4 không được phép đổi ABI).
  IF to_regprocedure('public.copilot_plan_create_v1(uuid, text, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'copilot_plan_create_v1 sai chu ky sau G5-B';
  END IF;
  IF to_regprocedure('public.copilot_plan_execute_step_v1(uuid, integer, integer, uuid)') IS NULL THEN
    RAISE EXCEPTION 'copilot_plan_execute_step_v1 sai chu ky sau G5-B';
  END IF;

  -- (7) Không hàm mới nào của file này được anon gọi.
  IF to_regrole('anon') IS NOT NULL THEN
    FOREACH v_ten IN ARRAY ARRAY[
      'public.copilot_standing_grant_create_v1(uuid, text, jsonb, integer, timestamptz, text, text)',
      'public.copilot_standing_grant_revoke_v1(uuid, text)',
      'public.copilot_standing_grants_revoke_all_v1(uuid, text)',
      'public.copilot_standing_grants_list_v1(uuid)',
      'public.copilot_standing_grants_daily_report_v1(uuid, date)'
    ]
    LOOP
      IF has_function_privilege('anon', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'anon goi duoc ham G5-B: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  -- (8) `authenticated` gọi được cả 5 RPC public (gate super admin nằm TRONG
  -- thân hàm, không phải ở GRANT — cùng khuôn `set_copilot_action_policy_v1`).
  IF to_regrole('authenticated') IS NOT NULL THEN
    v_ho := '{}'::text[];
    FOREACH v_ten IN ARRAY ARRAY[
      'public.copilot_standing_grant_create_v1(uuid, text, jsonb, integer, timestamptz, text, text)',
      'public.copilot_standing_grant_revoke_v1(uuid, text)',
      'public.copilot_standing_grants_revoke_all_v1(uuid, text)',
      'public.copilot_standing_grants_list_v1(uuid)',
      'public.copilot_standing_grants_daily_report_v1(uuid, date)'
    ]
    LOOP
      IF NOT has_function_privilege('authenticated', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'authenticated KHONG goi duoc ham G5-B: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  -- (9) Bảng grant/audit không lộ SELECT cho anon/authenticated.
  IF to_regrole('anon') IS NOT NULL THEN
    IF has_table_privilege('anon', 'app_private.copilot_standing_grants', 'SELECT')
       OR has_table_privilege('anon', 'app_private.copilot_standing_grants_audit', 'SELECT') THEN
      RAISE EXCEPTION 'anon doc duoc bang grant/audit';
    END IF;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    IF has_table_privilege('authenticated', 'app_private.copilot_standing_grants', 'SELECT')
       OR has_table_privilege('authenticated', 'app_private.copilot_standing_grants_audit', 'SELECT') THEN
      RAISE EXCEPTION 'authenticated doc thang duoc bang grant/audit (phai di qua RPC)';
    END IF;
  END IF;

  -- (10) Hàng seed `income_expense.create_draft` (từ 20260903043956) phải kế
  -- thừa mặc định `grantable = true` — cột mới không được âm thầm khoá seed cũ.
  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry
     WHERE action_id = 'income_expense.create_draft' AND grantable
  ) THEN
    RAISE EXCEPTION 'seed income_expense.create_draft khong grantable sau G5-B';
  END IF;
END
$nghiem_thu_grant$;

COMMIT;

NOTIFY pgrst, 'reload schema';

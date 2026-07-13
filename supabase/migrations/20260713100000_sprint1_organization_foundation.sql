-- =============================================================================
-- Sprint 1 — Organization foundation (ADDITIVE / INERT).
-- (AUTHORIZATION-PLAN.md §11.2, §16.2–16.3, §17 Sprint 1)
--
-- Mục tiêu: dựng biên tổ chức first-class. HOÀN TOÀN additive + inert:
--   • Tạo bảng organizations/memberships/invitations/legacy_map/exceptions.
--   • Thêm cột organization_id NULLABLE cho root tables + UNIQUE(org,id) (để
--     Sprint 2 tạo composite FK scope). GIỮ NULLABLE — code INSERT hiện tại KHÔNG
--     set organization_id, ép NOT NULL sẽ phá "tạo toà/sổ quỹ". Không đọc/enforce.
--   • Backfill org cho row hiện có theo owner (demo_user_ids() tách demo/prod).
--   • RLS bảng mới: chỉ super_admin đọc (chưa user-facing).
--
-- KHÔNG đổi RLS/RPC/policy hiện có. KHÔNG enforce. Rollback = DROP cột/bảng (§16.7).
--
-- Mô hình org (hệ thống là "một tổ chức cố định" + dữ liệu demo tách qua
-- demo_user_ids()):
--   • PROD  (aaaa…0001): mọi dữ liệu non-demo (nguyentamca=OWNER; nathan/joey=STAFF;
--            bosshuy=PARTNER). phanboichauthcs (orphan) KHÔNG có membership.
--   • DEMO  (dddd…0001): dữ liệu demo (demo.chunha=OWNER; demo.* khác=STAFF).
--
-- Idempotent.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Bảng organizations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.organizations (
  id                    uuid PRIMARY KEY,
  slug                  text NOT NULL,
  name                  text NOT NULL,
  status                text NOT NULL DEFAULT 'ACTIVE'
                          CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  authorization_version bigint NOT NULL DEFAULT 1,
  is_demo               boolean NOT NULL DEFAULT false,
  created_by            uuid REFERENCES auth.users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_lower_uidx
  ON public.organizations (lower(slug));

-- ---------------------------------------------------------------------------
-- 2) Bảng organization_memberships (mutable + partial-unique active;
--    lịch sử transition để dành organization_membership_events ở sprint sau)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.organization_memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  member_type     text NOT NULL CHECK (member_type IN ('OWNER','STAFF','SHAREHOLDER','PARTNER','SERVICE')),
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('INVITED','ACTIVE','SUSPENDED','REVOKED')),
  valid_from      timestamptz NOT NULL DEFAULT now(),
  valid_to        timestamptz,
  invited_by      uuid,
  activated_at    timestamptz,
  revoked_at      timestamptz,
  version         bigint NOT NULL DEFAULT 1,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
-- Candidate keys cho composite FK cùng org (sprint sau).
CREATE UNIQUE INDEX IF NOT EXISTS org_memberships_org_id_uidx
  ON public.organization_memberships (organization_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS org_memberships_org_id_user_uidx
  ON public.organization_memberships (organization_id, id, user_id);
-- Tối đa MỘT membership INVITED/ACTIVE cho mỗi (org,user).
CREATE UNIQUE INDEX IF NOT EXISTS org_memberships_one_active_uidx
  ON public.organization_memberships (organization_id, user_id)
  WHERE status IN ('INVITED','ACTIVE');
CREATE INDEX IF NOT EXISTS org_memberships_user_status_idx
  ON public.organization_memberships (user_id, status, organization_id);

-- ---------------------------------------------------------------------------
-- 3) organization_invitations (principal chưa có auth.users)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.organization_invitations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  email_normalized text NOT NULL,
  token_hash       text NOT NULL,
  intended_member_type text NOT NULL CHECK (intended_member_type IN ('OWNER','STAFF','SHAREHOLDER','PARTNER','SERVICE')),
  invited_by       uuid REFERENCES auth.users(id),
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','EXPIRED','REVOKED')),
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS org_invitations_pending_uidx
  ON public.organization_invitations (organization_id, lower(email_normalized))
  WHERE status = 'PENDING';

-- ---------------------------------------------------------------------------
-- 4) legacy_owner_organization_map + authorization_migration_exceptions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.legacy_owner_organization_map (
  legacy_owner_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  status          text NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CANDIDATE','CONFIRMED','EXCEPTION')),
  evidence        text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.authorization_migration_exceptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name    text NOT NULL,
  row_id        uuid,
  reason        text NOT NULL,
  details       jsonb,
  resolved      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 5) RLS bảng mới: chỉ super_admin đọc; không client DML (deny-by-default)
-- ---------------------------------------------------------------------------
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organizations','organization_memberships','organization_invitations',
    'legacy_owner_organization_map','authorization_migration_exceptions'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_select_super ON public.%I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_select_super ON public.%I FOR SELECT TO authenticated USING (public.is_super_admin())',
      t, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $rls$;

-- ---------------------------------------------------------------------------
-- 6) Seed 2 org + legacy map + memberships
-- ---------------------------------------------------------------------------
INSERT INTO public.organizations (id, slug, name, is_demo, created_by)
VALUES
  ('aaaa0000-0000-4000-8000-000000000001', 'ihome-prod', 'iHome CRM', false,
   '90450d5f-29b6-4897-bdef-cdb5fb53f339'),
  ('dddd0000-0000-4000-8000-000000000001', 'ihome-demo', 'iHome CRM (Demo)', true,
   'de6f33f3-349f-4bec-bd3d-106192f6715e')
ON CONFLICT (id) DO NOTHING;

-- legacy_owner_organization_map: mọi owner (buildings/accounts/roles/areas) → org theo demo status.
INSERT INTO public.legacy_owner_organization_map (legacy_owner_id, organization_id, status, evidence)
SELECT DISTINCT owner_id,
       CASE WHEN owner_id = ANY(public.demo_user_ids())
            THEN 'dddd0000-0000-4000-8000-000000000001'::uuid
            ELSE 'aaaa0000-0000-4000-8000-000000000001'::uuid END,
       'CONFIRMED',
       'seed Sprint1: owns buildings/accounts/roles/areas; demo split via demo_user_ids()'
FROM (
  SELECT user_id AS owner_id FROM public.buildings WHERE user_id IS NOT NULL
  UNION SELECT user_id FROM public.accounts WHERE user_id IS NOT NULL
  UNION SELECT user_id FROM public.roles WHERE user_id IS NOT NULL
  UNION SELECT user_id FROM public.areas WHERE user_id IS NOT NULL
) o
ON CONFLICT (legacy_owner_id) DO NOTHING;

-- Memberships: mọi user CÓ vai trò (owner/staff/shareholder/partner). Orphan (không
-- vai trò) KHÔNG có membership → khớp fail-closed get_my_permissions.
INSERT INTO public.organization_memberships (organization_id, user_id, member_type, status, activated_at)
SELECT
  CASE WHEN u.id = ANY(public.demo_user_ids())
       THEN 'dddd0000-0000-4000-8000-000000000001'::uuid
       ELSE 'aaaa0000-0000-4000-8000-000000000001'::uuid END AS org_id,
  u.id,
  CASE
    WHEN u.id IN ('90450d5f-29b6-4897-bdef-cdb5fb53f339','de6f33f3-349f-4bec-bd3d-106192f6715e')
      THEN 'OWNER'
    WHEN EXISTS (SELECT 1 FROM public.staff_assignments sa JOIN public.roles r ON r.id=sa.role_id
                 WHERE sa.staff_id=u.id AND sa.user_id<>u.id AND r.name ILIKE '%partner%')
      THEN 'PARTNER'
    WHEN EXISTS (SELECT 1 FROM public.staff_assignments sa WHERE sa.staff_id=u.id AND sa.user_id<>u.id)
      THEN 'STAFF'
    WHEN EXISTS (SELECT 1 FROM public.shareholders sh WHERE sh.auth_user_id=u.id AND sh.deleted_at IS NULL)
      THEN 'SHAREHOLDER'
    ELSE NULL
  END AS mtype,
  'ACTIVE', now()
FROM auth.users u
WHERE (
    u.id IN ('90450d5f-29b6-4897-bdef-cdb5fb53f339','de6f33f3-349f-4bec-bd3d-106192f6715e')
    OR EXISTS (SELECT 1 FROM public.staff_assignments sa WHERE sa.staff_id=u.id AND sa.user_id<>u.id)
    OR EXISTS (SELECT 1 FROM public.shareholders sh WHERE sh.auth_user_id=u.id AND sh.deleted_at IS NULL)
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
    WHERE m.user_id=u.id AND m.status IN ('INVITED','ACTIVE')
  )
  AND CASE
        WHEN u.id IN ('90450d5f-29b6-4897-bdef-cdb5fb53f339','de6f33f3-349f-4bec-bd3d-106192f6715e') THEN true
        WHEN EXISTS (SELECT 1 FROM public.staff_assignments sa WHERE sa.staff_id=u.id AND sa.user_id<>u.id) THEN true
        WHEN EXISTS (SELECT 1 FROM public.shareholders sh WHERE sh.auth_user_id=u.id AND sh.deleted_at IS NULL) THEN true
        ELSE false
      END;

-- ---------------------------------------------------------------------------
-- 7) Thêm organization_id NULLABLE + UNIQUE(org,id) cho ROOT tables + backfill
-- ---------------------------------------------------------------------------
DO $roots$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['buildings','areas','accounts','roles'] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT', t);
    -- Backfill theo owner (user_id) → org qua legacy map; null-owner → PROD.
    EXECUTE format($f$
      UPDATE public.%1$I x
         SET organization_id = COALESCE(
           (SELECT lom.organization_id FROM public.legacy_owner_organization_map lom WHERE lom.legacy_owner_id = x.user_id),
           'aaaa0000-0000-4000-8000-000000000001'::uuid)
       WHERE x.organization_id IS NULL
    $f$, t);
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %1$s_org_id_uidx ON public.%1$I (organization_id, id)', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %1$s_organization_id_idx ON public.%1$I (organization_id)', t);
  END LOOP;
END $roots$;

COMMIT;

-- =============================================================================
-- ROLLBACK (fully reversible — additive/inert):
--   ALTER TABLE public.buildings DROP COLUMN IF EXISTS organization_id;
--   ALTER TABLE public.areas     DROP COLUMN IF EXISTS organization_id;
--   ALTER TABLE public.accounts  DROP COLUMN IF EXISTS organization_id;
--   ALTER TABLE public.roles     DROP COLUMN IF EXISTS organization_id;
--   DROP TABLE IF EXISTS public.authorization_migration_exceptions;
--   DROP TABLE IF EXISTS public.legacy_owner_organization_map;
--   DROP TABLE IF EXISTS public.organization_invitations;
--   DROP TABLE IF EXISTS public.organization_memberships;
--   DROP TABLE IF EXISTS public.organizations;
-- =============================================================================

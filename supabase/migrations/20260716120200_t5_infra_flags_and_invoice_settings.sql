-- T5-infra — Server-enforced feature-flag/canary infrastructure + org invoice setting.
-- Additive thuần, mọi flag mặc định OFF, không writer nào consume ⇒ 0 đổi hành vi.
-- Thiết kế theo docs/authorization/T5-CANONICAL-WRITERS-PER-DOMAIN.md §1 (T5-infra):
--   - private schema, client không có quyền gì;
--   - canary theo ORGANIZATION; cap default 0; missing flag = không bật new path;
--   - append-only event log; CAS qua config_version.
-- organization_invoice_settings: quyết định owner §27.2.1 — auto_approve mặc định ON,
-- backfill mọi org hiện hữu; missing row = writer tương lai phải ABORT (không đoán).
BEGIN;

-- ===== private schema =====
CREATE SCHEMA IF NOT EXISTS app_private;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC, anon, authenticated;

-- ===== rollout flags =====
CREATE TABLE IF NOT EXISTS app_private.server_feature_flags (
  feature_key            text PRIMARY KEY,
  domain                 text NOT NULL,
  risk_class             text NOT NULL DEFAULT 'MONEY'
                         CHECK (risk_class IN ('MONEY','NON_MONEY')),
  mode                   text NOT NULL DEFAULT 'OFF'
                         CHECK (mode IN ('OFF','SHADOW','CANARY','ON')),
  force_freeze           boolean NOT NULL DEFAULT false,
  config_version         bigint NOT NULL DEFAULT 1,
  starts_at              timestamptz,
  ends_at                timestamptz,
  max_operation_count    integer NOT NULL DEFAULT 0,
  max_single_amount_vnd  numeric(15,2) NOT NULL DEFAULT 0,
  max_total_amount_vnd   numeric(15,2) NOT NULL DEFAULT 0,
  commit_sha             text,
  migration_sha256       text,
  maintenance_window_id  text,
  approval_reference     text,
  reason                 text,
  updated_by             uuid,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_private.server_feature_flag_canary_orgs (
  feature_key     text NOT NULL REFERENCES app_private.server_feature_flags(feature_key),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  added_by        uuid,
  added_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (feature_key, organization_id)
);

CREATE TABLE IF NOT EXISTS app_private.server_feature_flag_operations (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  feature_key     text NOT NULL,
  config_version  bigint NOT NULL,
  operation_key   text NOT NULL,
  organization_id uuid NOT NULL,
  amount_vnd      numeric(15,2) NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (feature_key, config_version, operation_key)
);

CREATE TABLE IF NOT EXISTS app_private.server_feature_flag_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  feature_key     text NOT NULL,
  event_type      text NOT NULL,
  before_mode     text,
  after_mode      text,
  before_version  bigint,
  after_version   bigint,
  detail          jsonb,
  actor           uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM PUBLIC, anon, authenticated;

-- ===== evaluator (server-side; client KHÔNG được grant) =====
-- Trả route cho một operation: LEGACY | SHADOW | CANONICAL | FROZEN.
-- Missing/unknown flag => LEGACY (new path không bật). force_freeze => FROZEN.
CREATE OR REPLACE FUNCTION app_private.evaluate_feature_route(
  p_feature_key text,
  p_organization_id uuid
) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $$
DECLARE
  f app_private.server_feature_flags%ROWTYPE;
BEGIN
  SELECT * INTO f FROM app_private.server_feature_flags WHERE feature_key = p_feature_key;
  IF NOT FOUND THEN RETURN 'LEGACY'; END IF;
  IF f.force_freeze THEN RETURN 'FROZEN'; END IF;
  IF f.mode = 'OFF' THEN RETURN 'LEGACY'; END IF;
  IF f.mode = 'SHADOW' THEN RETURN 'SHADOW'; END IF;
  IF f.mode = 'ON' THEN RETURN 'CANONICAL'; END IF;
  -- CANARY:
  IF NOT EXISTS (
    SELECT 1 FROM app_private.server_feature_flag_canary_orgs c
    WHERE c.feature_key = p_feature_key AND c.organization_id = p_organization_id
  ) THEN RETURN 'LEGACY'; END IF;
  IF f.starts_at IS NOT NULL AND now() < f.starts_at THEN RETURN 'LEGACY'; END IF;
  IF f.ends_at IS NOT NULL AND now() > f.ends_at THEN RETURN 'FROZEN'; END IF;
  IF f.max_operation_count <= 0 THEN RETURN 'FROZEN'; END IF;
  IF (SELECT count(*) FROM app_private.server_feature_flag_operations o
      WHERE o.feature_key = p_feature_key AND o.config_version = f.config_version)
     >= f.max_operation_count THEN RETURN 'FROZEN'; END IF;
  RETURN 'CANONICAL';
END;
$$;
REVOKE ALL ON FUNCTION app_private.evaluate_feature_route(text, uuid)
  FROM PUBLIC, anon, authenticated;

-- ===== organization_invoice_settings (business setting, KHÔNG phải rollout flag) =====
CREATE TABLE IF NOT EXISTS public.organization_invoice_settings (
  organization_id      uuid PRIMARY KEY REFERENCES public.organizations(id),
  auto_approve_invoice boolean NOT NULL DEFAULT true,
  version              bigint NOT NULL DEFAULT 1,
  updated_by           uuid,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.organization_invoice_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.organization_invoice_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.organization_invoice_settings TO authenticated;

DROP POLICY IF EXISTS organization_invoice_settings_select_own
  ON public.organization_invoice_settings;
CREATE POLICY organization_invoice_settings_select_own
  ON public.organization_invoice_settings FOR SELECT TO authenticated
  USING ((SELECT public.is_super_admin())
         OR organization_id IN (SELECT unnest(public.my_org_ids())));
-- Không policy INSERT/UPDATE/DELETE: mutation chỉ qua RPC exact-permission (T5 slice sau).

-- Backfill mọi org hiện hữu = ON (quyết định 27.2.1); org mới do bootstrap T2 tạo row.
INSERT INTO public.organization_invoice_settings (organization_id, auto_approve_invoice)
SELECT id, true FROM public.organizations
ON CONFLICT (organization_id) DO NOTHING;

COMMIT;

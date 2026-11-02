-- Platform surface the camera alert evaluator touches beyond the Network Center
-- bootstrap. Shapes are copied from supabase/baseline/schema.sql (columns the
-- evaluator or the real helpers read); the helper FUNCTIONS themselves are not
-- here: the harness loads their shipped bodies right after this file.

-- authorize_tenant_action_v3 / ie_actor_is_company_owner_v1 read these columns.
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS authorization_version bigint NOT NULL DEFAULT 1;
ALTER TABLE public.organization_roles ADD COLUMN IF NOT EXISTS status text DEFAULT 'ACTIVE';
ALTER TABLE public.organization_roles ADD COLUMN IF NOT EXISTS system_key text;
CREATE TABLE IF NOT EXISTS public.accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  deleted_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.area_buildings (
  organization_id uuid NOT NULL,
  area_id uuid NOT NULL,
  building_id uuid NOT NULL
);
CREATE TABLE IF NOT EXISTS public.role_binding_scopes (
  organization_id uuid NOT NULL,
  role_binding_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  PRIMARY KEY (role_binding_id, scope_id)
);
CREATE TABLE IF NOT EXISTS app_private.tenant_emergency_denies (
  organization_id uuid NOT NULL,
  permission_key text,
  active_from timestamptz NOT NULL,
  expires_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.cashbook_possession_bindings (
  organization_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  cashbook_id uuid NOT NULL,
  possession_kind text NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz
);
CREATE TABLE IF NOT EXISTS public.organization_timezones (
  organization_id uuid PRIMARY KEY,
  timezone text NOT NULL
);

-- public.notifications (baseline shape, without the unrelated FKs/indexes).
CREATE TYPE public.notification_channel AS ENUM ('IN_APP', 'EMAIL', 'SMS', 'ZALO', 'PUSH');
CREATE TYPE public.notification_status AS ENUM ('PENDING', 'SENT', 'FAILED', 'CANCELLED', 'READ');
CREATE TYPE public.notification_type AS ENUM (
  'NEW_INVOICE', 'PAYMENT_REMINDER', 'OVERDUE_INVOICE', 'CONTRACT_EXPIRING', 'ISSUE_RESOLVED',
  'GENERAL_ANNOUNCEMENT', 'CUSTOM', 'DEPOSIT_SHORTFALL', 'SALARY_BONUS', 'ACTION_REQUIRED', 'APPROVAL_RESULT');
CREATE TABLE public.notifications (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  type public.notification_type NOT NULL,
  channel public.notification_channel NOT NULL,
  subject text,
  content text NOT NULL CHECK (char_length(content) > 0),
  status public.notification_status DEFAULT 'PENDING',
  created_at timestamptz DEFAULT now() NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  organization_id uuid
);
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- pg_net stand-in: records what WOULD be queued (same signature as pg_net).
CREATE SCHEMA net;
CREATE TABLE net.camera_proof_requests (
  id bigserial PRIMARY KEY,
  url text NOT NULL,
  body jsonb NOT NULL,
  headers jsonb NOT NULL,
  timeout_milliseconds integer
);
CREATE FUNCTION net.http_post(
  url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer DEFAULT 5000)
RETURNS bigint LANGUAGE sql AS $fn$
  INSERT INTO net.camera_proof_requests (url, body, headers, timeout_milliseconds)
  VALUES (url, body, headers, timeout_milliseconds) RETURNING id
$fn$;

-- pg_cron stand-in: cron.schedule theo tên là ghi đè, như pg_cron ≥ 1.3. Có nó
-- thì khối lịch của migration chạy thật (bản dựng lại từ baseline và proof
-- readback không có schema cron, nên ở đó nhánh bỏ qua được kiểm).
CREATE SCHEMA cron;
CREATE TABLE cron.job (
  jobid bigserial PRIMARY KEY,
  jobname text UNIQUE,
  schedule text NOT NULL,
  command text NOT NULL,
  active boolean NOT NULL DEFAULT true
);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text)
RETURNS bigint LANGUAGE sql AS $fn$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command, active = true
  RETURNING jobid
$fn$;

-- Supabase Vault stand-in. The proof writes a structurally valid, unsigned
-- token at run time; no credential-shaped literal lives in this repository.
CREATE SCHEMA vault;
CREATE TABLE vault.decrypted_secrets (
  name text PRIMARY KEY,
  decrypted_secret text
);

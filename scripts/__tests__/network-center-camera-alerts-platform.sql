-- Bề mặt nền tảng mà bộ cảnh báo camera v2 đụng tới, ngoài bootstrap Network
-- Center. Hình bảng chép từ supabase/baseline/schema.sql và các migration Zalo /
-- thông báo (chỉ các cột bộ cảnh báo hoặc helper thật đọc/ghi). Thân helper
-- (authorize_tenant_action_v3, ie_actor_is_company_owner_v1, org_timezone_v1,
-- demo_user_ids…) KHÔNG ở đây: harness nạp nguyên văn từ nguồn đã phát hành.

-- authorize_tenant_action_v3 / ie_actor_is_company_owner_v1 đọc các cột này.
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
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY,
  full_name text,
  email text
);

-- public.notifications (hình baseline + cột push của 20261021171249).
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
  organization_id uuid,
  push_state text,
  push_attempts integer NOT NULL DEFAULT 0,
  push_leased_at timestamptz,
  push_idem_key text
);
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Zalo (hình baseline + các cột/ràng buộc mà worker và zalo_guard_relations_v1
-- dựa vào). Ràng buộc quan hệ của guard thật được kiểm bằng assert ở ca 14.
CREATE TABLE public.zalo_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  organization_id uuid,
  kind text NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal', 'oa')),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('connected', 'disconnected', 'error', 'connecting', 'waiting_scan'))
);
CREATE TABLE public.zalo_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  account_id uuid REFERENCES public.zalo_accounts(id),
  organization_id uuid,
  thread_id text,
  thread_type text NOT NULL DEFAULT 'user' CHECK (thread_type IN ('user', 'group')),
  peer_name text NOT NULL,
  last_message_text text,
  last_message_at timestamptz,
  last_message_dir text
);
CREATE TABLE public.zalo_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES public.zalo_conversations(id),
  account_id uuid,
  organization_id uuid,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  msg_type text NOT NULL DEFAULT 'text' CHECK (msg_type IN ('text', 'image', 'file', 'sticker', 'sys', 'video')),
  body text,
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('pending', 'sent', 'delivered', 'seen', 'failed')),
  zalo_msg_id text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  client_dedup_key text,
  UNIQUE (conversation_id, client_dedup_key)
);
CREATE TABLE public.zalo_send_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  organization_id uuid,
  conversation_id uuid REFERENCES public.zalo_conversations(id),
  message_id uuid REFERENCES public.zalo_messages(id),
  account_id uuid,
  channel text NOT NULL DEFAULT 'personal' CHECK (channel IN ('personal', 'oa')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  not_before timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

-- pg_cron stand-in: cron.schedule theo tên là ghi đè, như pg_cron ≥ 1.3. Có nó
-- thì khối lịch của migration chạy thật (cụm dựng từ bootstrap không có cron,
-- nên lượt áp đầu tiên kiểm nhánh bỏ qua).
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

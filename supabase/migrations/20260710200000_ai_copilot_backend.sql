-- =============================================================
-- AI Copilot Phase 1 (docs/ai-copilot/PLAN.md v2.1 §Phase 1)
-- settings singleton + entitlements + providers + usage logs + chat schema
-- + RPC reserve_ai_usage / finalize_ai_usage (atomic, service_role-only)
--
-- Điểm thiết kế đã chốt:
-- - Entitlement server-owned (F14): permission KHÔNG phải kill switch vì owner
--   sentinel __superadmin + /register public → mọi check nằm TRONG reserve RPC,
--   không cache, thu hồi hiệu lực ngay.
-- - Khoá race: pg_advisory_xact_lock theo NGÀY VN toàn cục → serialize mọi
--   reservation (cap user + tenant + global đều chính xác dưới burst).
-- - ai_chat_messages.seq = identity toàn cục + order (thread_id, seq)
--   → không cần RPC append, không race giữa 2 tab (chốt câu hỏi mở #2).
-- - Reservation expired (>5') VẪN tính quota đến hết ngày (không giải phóng sớm).
-- - Write các bảng cấu hình = is_super_admin() (is_admin() là admin per-tenant).
-- =============================================================

BEGIN;

-- ── 1. Settings singleton ────────────────────────────────────
CREATE TABLE public.ai_copilot_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),   -- đúng 1 dòng
  chat_enabled boolean NOT NULL DEFAULT false,       -- kill switch GLOBAL
  ui_control_enabled boolean NOT NULL DEFAULT false,
  rate_per_min int NOT NULL DEFAULT 20,
  daily_usd_cap_user numeric(10,4) NOT NULL DEFAULT 2.0,
  daily_usd_cap_tenant numeric(10,4) NOT NULL DEFAULT 10.0,
  daily_usd_cap_global numeric(10,4) NOT NULL DEFAULT 30.0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ai_copilot_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_copilot_settings_select ON public.ai_copilot_settings
  FOR SELECT TO authenticated USING (true);
CREATE POLICY ai_copilot_settings_write ON public.ai_copilot_settings
  FOR ALL TO authenticated
  USING ((SELECT public.is_super_admin()))
  WITH CHECK ((SELECT public.is_super_admin()));

-- ── 2. Entitlements (opt-in tường minh — KHÔNG có dòng = KHÔNG được dùng) ──
CREATE TABLE public.ai_copilot_entitlements (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  chat_enabled boolean NOT NULL DEFAULT true,
  ui_control_enabled boolean NOT NULL DEFAULT false,  -- pilot allowlist
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ai_copilot_entitlements ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_copilot_entitlements_select_own ON public.ai_copilot_entitlements
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR (SELECT public.is_super_admin()));
CREATE POLICY ai_copilot_entitlements_write ON public.ai_copilot_entitlements
  FOR ALL TO authenticated
  USING ((SELECT public.is_super_admin()))
  WITH CHECK ((SELECT public.is_super_admin()));

-- ── 3. Providers (GLOBAL — write chỉ super admin, KHÔNG is_admin) ──
CREATE TABLE public.ai_providers (
  provider text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  label text NOT NULL,
  models jsonb NOT NULL DEFAULT '[]',   -- [{id,label,input_price,output_price}] USD/1M tokens
  default_model text,
  data_class text NOT NULL DEFAULT 'cloud' CHECK (data_class IN ('cloud','local_only')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ai_providers ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_providers_select ON public.ai_providers
  FOR SELECT TO authenticated USING (true);
CREATE POLICY ai_providers_write ON public.ai_providers
  FOR ALL TO authenticated
  USING ((SELECT public.is_super_admin()))
  WITH CHECK ((SELECT public.is_super_admin()));

-- ── 4. Usage logs ────────────────────────────────────────────
CREATE TABLE public.ai_usage_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  owner_id uuid,                        -- tenant attribution (staff→owner, owner→chính mình)
  provider text NOT NULL,
  model text NOT NULL,
  feature text NOT NULL DEFAULT 'chat',
  task_id text,
  prompt_tokens int NOT NULL DEFAULT 0,
  completion_tokens int NOT NULL DEFAULT 0,
  total_tokens int NOT NULL DEFAULT 0,
  cached_tokens int NOT NULL DEFAULT 0,
  reserved_cost_usd numeric(10,6) NOT NULL DEFAULT 0,
  cost_usd numeric(10,6),
  latency_ms int,
  status text NOT NULL DEFAULT 'pending',  -- pending|ok|upstream_error|expired
  error_detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_usage_logs_user_created ON public.ai_usage_logs (user_id, created_at);
CREATE INDEX idx_ai_usage_logs_owner_created ON public.ai_usage_logs (owner_id, created_at);
CREATE INDEX idx_ai_usage_logs_status_pending ON public.ai_usage_logs (created_at) WHERE status = 'pending';
ALTER TABLE public.ai_usage_logs ENABLE ROW LEVEL SECURITY;
-- user xem của mình; OWNER xem cả đội (owner_id = mình); super admin xem hết.
CREATE POLICY ai_usage_logs_select ON public.ai_usage_logs
  FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR owner_id = (SELECT auth.uid())
    OR (SELECT public.is_super_admin())
  );
-- KHÔNG policy INSERT/UPDATE — chỉ ghi qua RPC (service_role bypass RLS).

-- ── 5. Chat schema ───────────────────────────────────────────
CREATE TABLE public.ai_chat_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_chat_threads_user ON public.ai_chat_threads (user_id, updated_at DESC);

CREATE TABLE public.ai_chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES public.ai_chat_threads(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- identity TOÀN CỤC đơn điệu → order (thread_id, seq) không race giữa 2 tab
  seq bigint GENERATED ALWAYS AS IDENTITY,
  role text NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content text,
  tool_calls jsonb,
  tool_call_id text,
  model text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_chat_messages_thread_seq ON public.ai_chat_messages (thread_id, seq);

ALTER TABLE public.ai_chat_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_chat_threads_own ON public.ai_chat_threads
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY ai_chat_messages_select_own ON public.ai_chat_messages
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY ai_chat_messages_insert_own ON public.ai_chat_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND EXISTS (SELECT 1 FROM public.ai_chat_threads t
                WHERE t.id = thread_id AND t.user_id = (SELECT auth.uid()))
  );

-- Trigger bump thread.updated_at khi có message mới
CREATE OR REPLACE FUNCTION public.ai_chat_bump_thread()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.ai_chat_threads SET updated_at = now() WHERE id = NEW.thread_id;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_ai_chat_bump_thread
  AFTER INSERT ON public.ai_chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.ai_chat_bump_thread();

-- ── 6. Helper: permissions của MỘT user (mirror get_my_permissions theo p_user) ──
-- CHỈ service_role gọi (bên trong reserve). Nếu get_my_permissions đổi logic,
-- PHẢI đồng bộ hàm này (lưu ý trong cả 2 nơi).
CREATE OR REPLACE FUNCTION public.ai_copilot_perms_for(p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_perms jsonb;
  v_is_shareholder boolean;
  v_is_manager boolean;
  v_sh_perms jsonb := jsonb_build_object('shareholder_profit', jsonb_build_object('view', true));
BEGIN
  IF p_user IS NULL THEN RETURN '{}'::jsonb; END IF;

  IF EXISTS (SELECT 1 FROM public.super_admins WHERE user_id = p_user) THEN
    RETURN '{"__superadmin": true}'::jsonb;
  END IF;

  SELECT COALESCE(sa.permissions, r.permissions) INTO v_perms
  FROM public.staff_assignments sa
  JOIN public.roles r ON r.id = sa.role_id
  WHERE sa.staff_id = p_user AND sa.user_id <> p_user
  ORDER BY (sa.building_id IS NULL) DESC, sa.created_at ASC
  LIMIT 1;

  v_is_shareholder := EXISTS (SELECT 1 FROM public.shareholders WHERE auth_user_id = p_user AND deleted_at IS NULL);
  v_is_manager     := EXISTS (SELECT 1 FROM public.profit_managers WHERE auth_user_id = p_user AND deleted_at IS NULL);

  IF v_is_shareholder OR v_is_manager THEN
    IF v_perms IS NULL THEN RETURN v_sh_perms; END IF;
    RETURN v_sh_perms || v_perms;
  END IF;

  IF v_perms IS NULL THEN RETURN '{"__superadmin": true}'::jsonb; END IF;
  RETURN v_perms;
END $$;
REVOKE ALL ON FUNCTION public.ai_copilot_perms_for(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_copilot_perms_for(uuid) TO service_role;

-- ── 7. reserve_ai_usage — TOÀN BỘ gate trong 1 transaction atomic ──
-- Thứ tự: kill switch → entitlement → permission → rate → quota 3 cấp → insert pending.
-- Lỗi raise bằng message code: copilot_disabled | not_entitled | not_permitted |
-- rate_limited | daily_quota (proxy map sang HTTP status).
CREATE OR REPLACE FUNCTION public.reserve_ai_usage(
  p_user_id uuid,
  p_feature text,
  p_provider text,
  p_model text,
  p_task_id text,
  p_est_cost_usd numeric
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_day date := (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
  v_settings public.ai_copilot_settings%ROWTYPE;
  v_ent public.ai_copilot_entitlements%ROWTYPE;
  v_perms jsonb;
  v_owner uuid;
  v_sum numeric;
  v_id uuid;
  v_est numeric := GREATEST(COALESCE(p_est_cost_usd, 0), 0);
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'not_entitled'; END IF;
  IF p_feature NOT IN ('chat','ui_control') THEN RAISE EXCEPTION 'copilot_disabled'; END IF;

  -- Serialize mọi reservation trong ngày (VN) → cap user/tenant/global chính xác
  PERFORM pg_advisory_xact_lock(hashtext('ai_usage_reserve_' || v_day::text));

  -- a. Kill switch global
  SELECT * INTO v_settings FROM public.ai_copilot_settings WHERE id = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'copilot_disabled'; END IF;
  IF p_feature = 'chat' AND NOT v_settings.chat_enabled THEN RAISE EXCEPTION 'copilot_disabled'; END IF;
  IF p_feature = 'ui_control' AND NOT v_settings.ui_control_enabled THEN RAISE EXCEPTION 'copilot_disabled'; END IF;

  -- b. Entitlement opt-in (không có dòng = không được dùng)
  SELECT * INTO v_ent FROM public.ai_copilot_entitlements WHERE user_id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_entitled'; END IF;
  IF p_feature = 'chat' AND NOT v_ent.chat_enabled THEN RAISE EXCEPTION 'not_entitled'; END IF;
  IF p_feature = 'ui_control' AND NOT v_ent.ui_control_enabled THEN RAISE EXCEPTION 'not_entitled'; END IF;

  -- c. Permission (granular cho staff; owner sentinel pass — entitlement mới là gate thật)
  v_perms := public.ai_copilot_perms_for(p_user_id);
  IF NOT (v_perms ? '__superadmin') THEN
    IF p_feature = 'chat' AND COALESCE(v_perms->'ai_copilot'->>'view','') <> 'true' THEN
      RAISE EXCEPTION 'not_permitted';
    END IF;
    IF p_feature = 'ui_control' AND COALESCE(v_perms->'ai_copilot'->>'ui_control','') <> 'true' THEN
      RAISE EXCEPTION 'not_permitted';
    END IF;
  END IF;

  -- d. Mark expired: pending quá 5' → 'expired' (VẪN tính quota đến hết ngày)
  UPDATE public.ai_usage_logs SET status = 'expired'
  WHERE status = 'pending' AND created_at < now() - interval '5 minutes';

  -- e. Rate limit theo user (mọi request 60s gần nhất, kể cả lỗi)
  IF (SELECT count(*) FROM public.ai_usage_logs
      WHERE user_id = p_user_id AND created_at > now() - interval '60 seconds')
     >= v_settings.rate_per_min THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  -- f. Resolve owner (tenant): staff → owner đầu tiên (full-scope ưu tiên); owner → chính mình
  SELECT sa.user_id INTO v_owner
  FROM public.staff_assignments sa
  WHERE sa.staff_id = p_user_id AND sa.user_id <> p_user_id
  ORDER BY (sa.building_id IS NULL) DESC, sa.created_at ASC
  LIMIT 1;
  IF v_owner IS NULL THEN v_owner := p_user_id; END IF;

  -- g. Quota 3 cấp (ngày VN; cost = COALESCE(cost thật, reserved); pending+expired đều tính; so sánh >=)
  SELECT COALESCE(sum(COALESCE(cost_usd, reserved_cost_usd)), 0) INTO v_sum
  FROM public.ai_usage_logs
  WHERE user_id = p_user_id AND (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = v_day;
  IF v_sum + v_est >= v_settings.daily_usd_cap_user AND v_settings.daily_usd_cap_user > 0 THEN
    RAISE EXCEPTION 'daily_quota';
  END IF;

  SELECT COALESCE(sum(COALESCE(cost_usd, reserved_cost_usd)), 0) INTO v_sum
  FROM public.ai_usage_logs
  WHERE owner_id = v_owner AND (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = v_day;
  IF v_sum + v_est >= v_settings.daily_usd_cap_tenant AND v_settings.daily_usd_cap_tenant > 0 THEN
    RAISE EXCEPTION 'daily_quota';
  END IF;

  SELECT COALESCE(sum(COALESCE(cost_usd, reserved_cost_usd)), 0) INTO v_sum
  FROM public.ai_usage_logs
  WHERE (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = v_day;
  IF v_sum + v_est >= v_settings.daily_usd_cap_global AND v_settings.daily_usd_cap_global > 0 THEN
    RAISE EXCEPTION 'daily_quota';
  END IF;

  -- h. Insert pending reservation
  INSERT INTO public.ai_usage_logs
    (user_id, owner_id, provider, model, feature, task_id, reserved_cost_usd, status)
  VALUES
    (p_user_id, v_owner, p_provider, p_model, p_feature, p_task_id, v_est, 'pending')
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.reserve_ai_usage(uuid, text, text, text, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_ai_usage(uuid, text, text, text, text, numeric) TO service_role;

-- ── 8. finalize_ai_usage ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.finalize_ai_usage(
  p_id uuid,
  p_prompt_tokens int,
  p_completion_tokens int,
  p_total_tokens int,
  p_cached_tokens int,
  p_cost_usd numeric,
  p_latency_ms int,
  p_status text,
  p_error text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.ai_usage_logs SET
    prompt_tokens     = COALESCE(p_prompt_tokens, 0),
    completion_tokens = COALESCE(p_completion_tokens, 0),
    total_tokens      = COALESCE(p_total_tokens, 0),
    cached_tokens     = COALESCE(p_cached_tokens, 0),
    cost_usd          = p_cost_usd,
    latency_ms        = p_latency_ms,
    status            = COALESCE(p_status, 'ok'),
    error_detail      = p_error
  WHERE id = p_id;
END $$;
REVOKE ALL ON FUNCTION public.finalize_ai_usage(uuid, int, int, int, int, numeric, int, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_ai_usage(uuid, int, int, int, int, numeric, int, text, text) TO service_role;

-- ── 9. Seed ──────────────────────────────────────────────────
-- Settings: bật chat + ui_control (pilot dev); cap mặc định theo plan.
INSERT INTO public.ai_copilot_settings (id, chat_enabled, ui_control_enabled)
VALUES (true, true, true)
ON CONFLICT (id) DO NOTHING;

-- Providers: openrouter bật với model free đã verify (SPIKE-RESULTS.md);
-- mock CHỈ để dev/test (vẫn sau entitlement+JWT+quota — tắt ở Phase 4);
-- còn lại tạo sẵn nhưng TẮT (bật khi có key trong secrets).
INSERT INTO public.ai_providers (provider, enabled, label, models, default_model, data_class) VALUES
  ('openrouter', true, 'OpenRouter',
   '[{"id":"nvidia/nemotron-3-super-120b-a12b:free","label":"Nemotron 3 Super 120B (free)","input_price":0,"output_price":0},
     {"id":"qwen/qwen3-next-80b-a3b-instruct:free","label":"Qwen3 Next 80B (free)","input_price":0,"output_price":0},
     {"id":"openai/gpt-oss-120b:free","label":"GPT-OSS 120B (free)","input_price":0,"output_price":0}]'::jsonb,
   'nvidia/nemotron-3-super-120b-a12b:free', 'cloud'),
  ('mock', true, 'Mock (dev/test only)', '[]'::jsonb, 'done', 'cloud'),
  ('openai',    false, 'OpenAI',   '[]'::jsonb, NULL, 'cloud'),
  ('anthropic', false, 'Anthropic','[]'::jsonb, NULL, 'cloud'),
  ('gemini',    false, 'Google Gemini', '[]'::jsonb, NULL, 'cloud'),
  ('qwen',      false, 'Qwen (DashScope)', '[]'::jsonb, NULL, 'cloud'),
  ('deepseek',  false, 'DeepSeek', '[]'::jsonb, NULL, 'cloud'),
  ('groq',      false, 'Groq',     '[]'::jsonb, NULL, 'cloud'),
  ('ollama',    false, 'Ollama (local)', '[]'::jsonb, NULL, 'local_only')
ON CONFLICT (provider) DO NOTHING;

-- Entitlement pilot: super admin/test account
INSERT INTO public.ai_copilot_entitlements (user_id, chat_enabled, ui_control_enabled)
SELECT id, true, true FROM auth.users WHERE email = 'nguyentamca165@gmail.com'
ON CONFLICT (user_id) DO NOTHING;

COMMIT;

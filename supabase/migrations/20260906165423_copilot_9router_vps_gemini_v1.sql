-- User-selected VPS models: Gemini 3.6 first; 3.7/3.8 are explicit choices.
-- This is only the global model allowlist. Upstream URL/key remain Edge secrets.
-- No provider accounts, user preferences, quotas or organization data are moved.
BEGIN;
SET LOCAL lock_timeout = '15s';

-- ai_providers has PRIMARY KEY(provider), with NULL org for global config.
-- Serialize the precondition with config writes; never silently re-scope a row.
LOCK TABLE public.ai_providers IN SHARE ROW EXCLUSIVE MODE;
DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.ai_providers
    WHERE provider = '9router' AND organization_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION '9router must be a global provider; review organization scope before applying';
  END IF;
END
$preflight$;

-- UPSERT also supports a clean schema-only restore with no provider seed data.
-- Zero token prices denote self_hosted routing, not a claim that upstream is free.
INSERT INTO public.ai_providers AS current_provider
  (provider, enabled, label, models, default_model, data_class, organization_id)
VALUES (
  '9router', true, '9Router (VPS)',
  '[
    {"id":"ag/gemini-3.6-flash-high(high)","label":"Gemini 3.6 Flash High (high)","input_price":0,"output_price":0,"pricing_mode":"self_hosted"},
    {"id":"ag/gemini-3.7-flash-high(high)","label":"Gemini 3.7 Flash High (high)","input_price":0,"output_price":0,"pricing_mode":"self_hosted"},
    {"id":"ag/gemini-3.8-flash(high)","label":"Gemini 3.8 Flash (high)","input_price":0,"output_price":0,"pricing_mode":"self_hosted"}
  ]'::jsonb,
  'ag/gemini-3.6-flash-high(high)', 'cloud', NULL
)
ON CONFLICT (provider) DO UPDATE SET
  enabled = EXCLUDED.enabled,
  label = EXCLUDED.label,
  models = EXCLUDED.models,
  default_model = EXCLUDED.default_model,
  data_class = EXCLUDED.data_class,
  updated_at = now()
WHERE (current_provider.enabled, current_provider.label, current_provider.models,
       current_provider.default_model, current_provider.data_class)
  IS DISTINCT FROM
      (EXCLUDED.enabled, EXCLUDED.label, EXCLUDED.models,
       EXCLUDED.default_model, EXCLUDED.data_class);

COMMIT;

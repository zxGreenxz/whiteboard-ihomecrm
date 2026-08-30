-- Enforce explicit provider model pricing metadata at the database boundary.
BEGIN;
SET LOCAL lock_timeout = '15s';

-- Classify existing provider seeds before installing the write guard.
UPDATE public.ai_providers
SET models = COALESCE((
  SELECT jsonb_agg(CASE WHEN model ? 'pricing_mode' THEN model ELSE jsonb_set(model, '{pricing_mode}', to_jsonb('free'::text)) END)
  FROM jsonb_array_elements(models) AS item(model)
  WHERE jsonb_typeof(model) = 'object'
), '[]'::jsonb)
WHERE provider = 'openrouter';

UPDATE public.ai_providers
SET models = COALESCE((
  SELECT jsonb_agg(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          model,
          '{pricing_mode}',
          to_jsonb('self_hosted'::text)
        ),
        '{input_price}',
        to_jsonb(0::numeric)
      ),
      '{output_price}',
      to_jsonb(0::numeric)
    )
  )
  FROM jsonb_array_elements(models) AS item(model)
  WHERE jsonb_typeof(model) = 'object'
), '[]'::jsonb)
WHERE provider = '9router';

UPDATE public.ai_providers
SET models = COALESCE((
  SELECT jsonb_agg(CASE WHEN model ? 'pricing_mode' THEN model ELSE jsonb_set(model, '{pricing_mode}', to_jsonb('unknown'::text)) END)
  FROM jsonb_array_elements(models) AS item(model)
  WHERE jsonb_typeof(model) = 'object'
), '[]'::jsonb)
WHERE provider NOT IN ('openrouter', '9router', 'mock');

UPDATE public.ai_providers
SET enabled = false
WHERE enabled
  AND provider NOT IN ('openrouter', '9router', 'mock')
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(models) AS item(model) WHERE model->>'pricing_mode' = 'unknown');

CREATE OR REPLACE FUNCTION public.validate_ai_provider_pricing_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  model jsonb;
  model_id text;
  model_mode text;
  model_input jsonb;
  model_output jsonb;
  seen_ids text[] := ARRAY[]::text[];
BEGIN
  IF jsonb_typeof(NEW.models) <> 'array' THEN
    RAISE EXCEPTION 'ai_providers.models must be a JSON array';
  END IF;

  FOR model IN SELECT value FROM jsonb_array_elements(NEW.models) AS item(value) LOOP
    IF jsonb_typeof(model) <> 'object' THEN
      RAISE EXCEPTION 'each ai provider model must be a JSON object';
    END IF;
    model_id := NULLIF(btrim(model->>'id'), '');
    IF model_id IS NULL THEN
      RAISE EXCEPTION 'each ai provider model requires a non-empty id';
    END IF;
    IF model_id = ANY(seen_ids) THEN
      RAISE EXCEPTION 'duplicate ai provider model id: %', model_id;
    END IF;
    seen_ids := array_append(seen_ids, model_id);

    model_mode := model->>'pricing_mode';
    IF model_mode IS NULL OR model_mode NOT IN ('metered', 'free', 'self_hosted', 'unknown') THEN
      RAISE EXCEPTION '%: pricing_mode must be metered, free, self_hosted, or unknown', model_id;
    END IF;
    model_input := model->'input_price';
    model_output := model->'output_price';
    IF jsonb_typeof(model_input) <> 'number' OR jsonb_typeof(model_output) <> 'number' THEN
      RAISE EXCEPTION '%: input_price and output_price must be finite JSON numbers', model_id;
    END IF;
    IF (model_input #>> '{}')::numeric < 0 OR (model_output #>> '{}')::numeric < 0 THEN
      RAISE EXCEPTION '%: prices cannot be negative', model_id;
    END IF;
    IF model_mode = 'metered' AND ((model_input #>> '{}')::numeric <= 0 OR (model_output #>> '{}')::numeric <= 0) THEN
      RAISE EXCEPTION '%: metered pricing requires positive prices', model_id;
    END IF;
    IF NEW.enabled AND model_mode = 'unknown' THEN
      RAISE EXCEPTION '%: enabled provider cannot contain unknown pricing', model_id;
    END IF;
  END LOOP;

  IF NEW.provider <> 'mock' AND NEW.default_model IS NOT NULL AND NEW.default_model <> ''
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.models) AS item(value) WHERE value->>'id' = NEW.default_model) THEN
    RAISE EXCEPTION 'default_model must match a model id';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_providers_pricing_policy_v1 ON public.ai_providers;
CREATE TRIGGER ai_providers_pricing_policy_v1
  BEFORE INSERT OR UPDATE OF models, default_model, enabled ON public.ai_providers
  FOR EACH ROW EXECUTE FUNCTION public.validate_ai_provider_pricing_v1();

REVOKE ALL ON FUNCTION public.validate_ai_provider_pricing_v1() FROM PUBLIC, anon, authenticated;
COMMIT;

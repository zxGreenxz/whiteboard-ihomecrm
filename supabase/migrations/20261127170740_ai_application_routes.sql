-- Global inference routing. Only backend services read or modify these records.
-- The management Edge function authenticates a platform superadministrator.
BEGIN;
CREATE TABLE IF NOT EXISTS public.ai_route_catalogs (
  provider text PRIMARY KEY CHECK (provider IN ('nous','9router')),
  models jsonb NOT NULL CHECK (jsonb_typeof(models) = 'array'),
  synced_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.ai_application_routes (
  app text PRIMARY KEY CHECK (app IN ('quick_read','wallet_read','quick_stt','meter_vision')),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  routes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(routes) = 'array' AND jsonb_array_length(routes) IN (0,2))
);
ALTER TABLE public.ai_application_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_route_catalogs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_application_routes, public.ai_route_catalogs FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON public.ai_application_routes TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.ai_route_catalogs TO service_role;
INSERT INTO public.ai_application_routes (app)
VALUES ('quick_read'), ('wallet_read'), ('quick_stt'), ('meter_vision') ON CONFLICT DO NOTHING;
-- Lock the catalog row while tagging one probe. An older run cannot mark a newer snapshot.
CREATE OR REPLACE FUNCTION public.record_ai_route_probe(p_provider text, p_synced_at timestamptz, p_model text, p_passed boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  items jsonb;
  slot integer;
BEGIN
  SELECT models INTO items FROM public.ai_route_catalogs
  WHERE provider = p_provider AND synced_at = p_synced_at FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT (ordinality - 1)::integer INTO slot FROM jsonb_array_elements(items) WITH ORDINALITY AS m(item, ordinality)
  WHERE item->>'id' = p_model;
  IF slot IS NULL THEN RETURN false; END IF;
  UPDATE public.ai_route_catalogs SET models = jsonb_set(items, ARRAY[slot::text],
    (items->slot) || jsonb_build_object('tested', true, 'verified', p_passed))
  WHERE provider = p_provider;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.record_ai_route_probe(text,timestamptz,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_ai_route_probe(text,timestamptz,text,boolean) TO service_role;
COMMIT;

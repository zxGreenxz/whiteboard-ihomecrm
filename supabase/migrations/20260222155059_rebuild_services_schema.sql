-- 1. Create fee_type enum
CREATE TYPE public.fee_type AS ENUM (
  'TIEN_PHI_DICH_VU',
  'TIEN_DIEN',
  'TIEN_NUOC',
  'TIEN_PHI_KHAC',
  'TIEN_VE_SINH'
);

-- 2. Create pricing_type enum
CREATE TYPE public.pricing_type AS ENUM (
  'DON_GIA_CO_DINH_THANG',
  'DON_GIA_CO_DINH_DONG_HO',
  'DON_GIA_BIEN_DONG',
  'DON_GIA_THEO_NGUOI',
  'DON_GIA_THEO_PHONG'
);

-- 3. Add new columns to services table
ALTER TABLE public.services
  ADD COLUMN fee_type public.fee_type,
  ADD COLUMN pricing_type public.pricing_type,
  ADD COLUMN tax_rate numeric DEFAULT 0,
  ADD COLUMN quota_id uuid REFERENCES public.service_quotas(id) ON DELETE SET NULL;

-- 4. Create service_buildings junction table
CREATE TABLE public.service_buildings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES public.services(id) ON DELETE CASCADE,
  building_id uuid NOT NULL REFERENCES public.buildings(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(service_id, building_id)
);

ALTER TABLE public.service_buildings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_buildings_select" ON public.service_buildings
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.services s
      WHERE s.id = service_buildings.service_id
      AND s.user_id = auth.uid()
    )
  );

CREATE POLICY "service_buildings_insert" ON public.service_buildings
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.services s
      WHERE s.id = service_buildings.service_id
      AND s.user_id = auth.uid()
    )
  );

CREATE POLICY "service_buildings_delete" ON public.service_buildings
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.services s
      WHERE s.id = service_buildings.service_id
      AND s.user_id = auth.uid()
    )
  );

-- 5. Restructure service_quotas: drop old structure, rebuild as tiered quota system
-- First drop the old service_quotas and recreate
DROP TABLE IF EXISTS public.service_quotas CASCADE;

CREATE TABLE public.service_quotas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  name text NOT NULL,
  description text,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.service_quotas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_quotas_select" ON public.service_quotas
  FOR SELECT USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "service_quotas_insert" ON public.service_quotas
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "service_quotas_update" ON public.service_quotas
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "service_quotas_delete" ON public.service_quotas
  FOR DELETE USING (auth.uid() = user_id);

-- 6. Create service_quota_tiers for tiered pricing
CREATE TABLE public.service_quota_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quota_id uuid NOT NULL REFERENCES public.service_quotas(id) ON DELETE CASCADE,
  tier_number integer NOT NULL,
  from_value numeric NOT NULL DEFAULT 0,
  to_value numeric,
  unit_price numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(quota_id, tier_number)
);

ALTER TABLE public.service_quota_tiers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "quota_tiers_select" ON public.service_quota_tiers
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.service_quotas q
      WHERE q.id = service_quota_tiers.quota_id
      AND q.user_id = auth.uid()
    )
  );

CREATE POLICY "quota_tiers_insert" ON public.service_quota_tiers
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.service_quotas q
      WHERE q.id = service_quota_tiers.quota_id
      AND q.user_id = auth.uid()
    )
  );

CREATE POLICY "quota_tiers_update" ON public.service_quota_tiers
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.service_quotas q
      WHERE q.id = service_quota_tiers.quota_id
      AND q.user_id = auth.uid()
    )
  );

CREATE POLICY "quota_tiers_delete" ON public.service_quota_tiers
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.service_quotas q
      WHERE q.id = service_quota_tiers.quota_id
      AND q.user_id = auth.uid()
    )
  );

-- 7. Re-add quota_id FK on services (was dropped with CASCADE)
ALTER TABLE public.services
  DROP COLUMN IF EXISTS quota_id;

ALTER TABLE public.services
  ADD COLUMN quota_id uuid REFERENCES public.service_quotas(id) ON DELETE SET NULL;

-- 8. Migrate existing service type data to new fee_type/pricing_type
UPDATE public.services SET
  fee_type = CASE
    WHEN type = 'METER_READING' AND lower(name) LIKE '%điện%' THEN 'TIEN_DIEN'::public.fee_type
    WHEN type = 'METER_READING' AND lower(name) LIKE '%nước%' THEN 'TIEN_NUOC'::public.fee_type
    WHEN type = 'METER_READING' THEN 'TIEN_PHI_KHAC'::public.fee_type
    ELSE 'TIEN_PHI_DICH_VU'::public.fee_type
  END,
  pricing_type = CASE
    WHEN type = 'FIXED' THEN 'DON_GIA_CO_DINH_THANG'::public.pricing_type
    WHEN type = 'PER_PERSON' THEN 'DON_GIA_THEO_NGUOI'::public.pricing_type
    WHEN type = 'PER_ROOM' THEN 'DON_GIA_THEO_PHONG'::public.pricing_type
    WHEN type = 'METER_READING' THEN 'DON_GIA_CO_DINH_DONG_HO'::public.pricing_type
    ELSE 'DON_GIA_CO_DINH_THANG'::public.pricing_type
  END
WHERE fee_type IS NULL;
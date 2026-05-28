-- Recreate areas table
CREATE TABLE IF NOT EXISTS areas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_areas_user_id ON areas(user_id);
CREATE INDEX IF NOT EXISTS idx_areas_status ON areas(status);
CREATE INDEX IF NOT EXISTS idx_areas_code ON areas(code);

-- RLS
ALTER TABLE areas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own areas"
  ON areas FOR SELECT
  USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "Users can insert own areas"
  ON areas FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own areas"
  ON areas FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own areas"
  ON areas FOR DELETE
  USING (auth.uid() = user_id);

-- Add area_id back to buildings
ALTER TABLE buildings ADD COLUMN IF NOT EXISTS area_id UUID REFERENCES areas(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_buildings_area_id ON buildings(area_id);

-- Trigger for updated_at (reuse existing function if available)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column') THEN
    CREATE TRIGGER set_areas_updated_at
      BEFORE UPDATE ON areas
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  END IF;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;
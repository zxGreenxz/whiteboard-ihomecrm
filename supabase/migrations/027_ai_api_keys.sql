-- =============================================
-- AI API KEYS MANAGEMENT
-- Store encrypted API keys for different AI providers
-- =============================================

-- Table to store user's AI API keys
CREATE TABLE ai_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Provider info
  provider TEXT NOT NULL, -- 'openai', 'gemini', 'deepseek', 'anthropic'
  api_key TEXT NOT NULL, -- Encrypted API key

  -- Settings
  is_active BOOLEAN DEFAULT true,
  is_default BOOLEAN DEFAULT false,

  -- Usage tracking
  last_used_at TIMESTAMPTZ,
  total_requests INTEGER DEFAULT 0,

  -- Metadata
  display_name TEXT, -- Optional custom name
  notes TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT ai_api_keys_provider_valid CHECK (provider IN ('openai', 'gemini', 'deepseek', 'anthropic')),
  CONSTRAINT ai_api_keys_unique_provider UNIQUE(user_id, provider)
);

-- Indexes
CREATE INDEX idx_ai_api_keys_user_id ON ai_api_keys(user_id);
CREATE INDEX idx_ai_api_keys_provider ON ai_api_keys(provider);
CREATE INDEX idx_ai_api_keys_is_active ON ai_api_keys(is_active);
CREATE INDEX idx_ai_api_keys_is_default ON ai_api_keys(is_default);

-- Row Level Security
ALTER TABLE ai_api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own API keys"
  ON ai_api_keys FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own API keys"
  ON ai_api_keys FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own API keys"
  ON ai_api_keys FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own API keys"
  ON ai_api_keys FOR DELETE
  USING (auth.uid() = user_id);

-- Trigger to update updated_at
CREATE TRIGGER set_ai_api_keys_updated_at
  BEFORE UPDATE ON ai_api_keys
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Function to ensure only one default per user
CREATE OR REPLACE FUNCTION ensure_single_default_api_key()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_default = true THEN
    -- Unset all other defaults for this user
    UPDATE ai_api_keys
    SET is_default = false
    WHERE user_id = NEW.user_id
      AND id != NEW.id
      AND provider = NEW.provider;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ensure_single_default_api_key_trigger
  BEFORE INSERT OR UPDATE ON ai_api_keys
  FOR EACH ROW
  WHEN (NEW.is_default = true)
  EXECUTE FUNCTION ensure_single_default_api_key();

-- Function to get active API key for a provider
CREATE OR REPLACE FUNCTION get_active_api_key(
  p_user_id UUID,
  p_provider TEXT
)
RETURNS TABLE (
  id UUID,
  api_key TEXT,
  display_name TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    a.id,
    a.api_key,
    a.display_name
  FROM ai_api_keys a
  WHERE a.user_id = p_user_id
    AND a.provider = p_provider
    AND a.is_active = true
  ORDER BY a.is_default DESC, a.created_at DESC
  LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- Add provider and model columns to ai_messages
ALTER TABLE ai_messages
  ADD COLUMN IF NOT EXISTS provider TEXT,
  ADD COLUMN IF NOT EXISTS model_version TEXT;

-- Comments
COMMENT ON TABLE ai_api_keys IS 'Store encrypted API keys for different AI providers';
COMMENT ON FUNCTION get_active_api_key IS 'Get the active API key for a specific provider and user';

-- =============================================
-- Migration: Create subscription_plans and user_subscriptions tables
-- Description: Subscription/pricing plan management
-- Requirements: 38.9, 34.2
-- =============================================

-- 1. SUBSCRIPTION_PLANS TABLE (Gói cước)
CREATE TABLE subscription_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  price NUMERIC NOT NULL,
  duration_months INTEGER NOT NULL,
  max_rooms INTEGER,
  max_buildings INTEGER,
  features JSONB DEFAULT '[]'::jsonb,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT subscription_plans_name_not_empty CHECK (char_length(name) > 0),
  CONSTRAINT subscription_plans_price_non_negative CHECK (price >= 0),
  CONSTRAINT subscription_plans_duration_positive CHECK (duration_months > 0)
);

-- subscription_plans is a global table (no user_id), readable by all authenticated users
ALTER TABLE subscription_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "subscription_plans_select" ON subscription_plans
  FOR SELECT USING (auth.role() = 'authenticated');

COMMENT ON TABLE subscription_plans IS 'Available subscription plans (Gói cước)';


-- 2. USER_SUBSCRIPTIONS TABLE (Đăng ký gói cước)
CREATE TABLE user_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES subscription_plans(id) ON DELETE RESTRICT,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_user_subscriptions_user_id ON user_subscriptions(user_id);
CREATE INDEX idx_user_subscriptions_plan_id ON user_subscriptions(plan_id);
CREATE INDEX idx_user_subscriptions_status ON user_subscriptions(status);

ALTER TABLE user_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_subscriptions_select" ON user_subscriptions
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "user_subscriptions_insert" ON user_subscriptions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "user_subscriptions_update" ON user_subscriptions
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "user_subscriptions_delete" ON user_subscriptions
  FOR DELETE USING (auth.uid() = user_id);

COMMENT ON TABLE user_subscriptions IS 'User subscription records (Đăng ký gói cước)';

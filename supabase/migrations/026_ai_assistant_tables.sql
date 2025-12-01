-- =============================================
-- AI ASSISTANT TABLES
-- Long-term memory storage for AI conversations
-- =============================================

-- Enable pgvector extension for semantic search
CREATE EXTENSION IF NOT EXISTS vector;

-- =============================================
-- 1. AI_CONVERSATIONS
-- Store conversation sessions
-- =============================================
CREATE TABLE ai_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  
  -- Conversation info
  title TEXT NOT NULL, -- Auto-generated from first message
  summary TEXT, -- Brief summary of conversation
  
  -- Metadata
  message_count INTEGER DEFAULT 0,
  total_tokens_used INTEGER DEFAULT 0,
  
  -- Context tracking
  referenced_entities JSONB DEFAULT '[]'::jsonb, -- [{type: 'contract', id: 'xxx', name: 'HD001'}, ...]
  tags JSONB DEFAULT '[]'::jsonb, -- ['billing', 'contracts', 'reports']
  
  -- Status
  is_pinned BOOLEAN DEFAULT false,
  is_archived BOOLEAN DEFAULT false,
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  
  CONSTRAINT ai_conversations_title_not_empty CHECK (char_length(title) > 0)
);

-- Indexes
CREATE INDEX idx_ai_conversations_user_id ON ai_conversations(user_id);
CREATE INDEX idx_ai_conversations_created_at ON ai_conversations(created_at DESC);
CREATE INDEX idx_ai_conversations_last_message_at ON ai_conversations(last_message_at DESC);
CREATE INDEX idx_ai_conversations_is_pinned ON ai_conversations(is_pinned);
CREATE INDEX idx_ai_conversations_is_archived ON ai_conversations(is_archived);
CREATE INDEX idx_ai_conversations_deleted_at ON ai_conversations(deleted_at);

-- Full-text search on title and summary
CREATE INDEX idx_ai_conversations_search ON ai_conversations USING GIN (
  to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(summary, ''))
);

-- =============================================
-- 2. AI_MESSAGES
-- Store individual messages in conversations
-- =============================================
CREATE TYPE ai_message_role AS ENUM ('user', 'assistant', 'system');

CREATE TABLE ai_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  
  -- Message info
  role ai_message_role NOT NULL,
  content TEXT NOT NULL,
  
  -- Token tracking
  tokens_used INTEGER DEFAULT 0,
  
  -- Context used for this message
  context_used JSONB DEFAULT '[]'::jsonb, -- Data retrieved from DB for this message
  
  -- Referenced entities in this message
  referenced_entities JSONB DEFAULT '[]'::jsonb,
  
  -- Metadata
  model TEXT, -- e.g., 'gpt-4', 'gpt-3.5-turbo'
  temperature DECIMAL(3, 2),
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  CONSTRAINT ai_messages_content_not_empty CHECK (char_length(content) > 0)
);

-- Indexes
CREATE INDEX idx_ai_messages_conversation_id ON ai_messages(conversation_id);
CREATE INDEX idx_ai_messages_created_at ON ai_messages(created_at);
CREATE INDEX idx_ai_messages_role ON ai_messages(role);

-- Full-text search on content
CREATE INDEX idx_ai_messages_search ON ai_messages USING GIN (
  to_tsvector('simple', content)
);

-- =============================================
-- 3. AI_MEMORY_EMBEDDINGS
-- Store semantic embeddings for long-term memory
-- =============================================
CREATE TABLE ai_memory_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES ai_conversations(id) ON DELETE CASCADE,
  message_id UUID REFERENCES ai_messages(id) ON DELETE CASCADE,
  
  -- Content
  content TEXT NOT NULL,
  embedding vector(1536), -- OpenAI ada-002 embedding dimension
  
  -- Entity reference (optional)
  entity_type TEXT, -- 'contract', 'tenant', 'building', 'room', 'invoice', etc.
  entity_id UUID,
  entity_name TEXT,
  
  -- Metadata
  importance_score DECIMAL(3, 2) DEFAULT 0.5, -- 0.0 to 1.0
  access_count INTEGER DEFAULT 0, -- How many times this memory was retrieved
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_accessed_at TIMESTAMPTZ,
  
  CONSTRAINT ai_memory_embeddings_content_not_empty CHECK (char_length(content) > 0),
  CONSTRAINT ai_memory_embeddings_importance_valid CHECK (importance_score >= 0 AND importance_score <= 1)
);

-- Indexes
CREATE INDEX idx_ai_memory_embeddings_user_id ON ai_memory_embeddings(user_id);
CREATE INDEX idx_ai_memory_embeddings_conversation_id ON ai_memory_embeddings(conversation_id);
CREATE INDEX idx_ai_memory_embeddings_entity_type ON ai_memory_embeddings(entity_type);
CREATE INDEX idx_ai_memory_embeddings_entity_id ON ai_memory_embeddings(entity_id);
CREATE INDEX idx_ai_memory_embeddings_importance_score ON ai_memory_embeddings(importance_score DESC);
CREATE INDEX idx_ai_memory_embeddings_created_at ON ai_memory_embeddings(created_at DESC);

-- Vector similarity search index (HNSW for fast approximate nearest neighbor search)
CREATE INDEX idx_ai_memory_embeddings_vector ON ai_memory_embeddings 
  USING hnsw (embedding vector_cosine_ops);

-- =============================================
-- 4. AI_USAGE_STATS
-- Track AI usage for billing/limits
-- =============================================
CREATE TABLE ai_usage_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  
  -- Period
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  
  -- Usage metrics
  total_conversations INTEGER DEFAULT 0,
  total_messages INTEGER DEFAULT 0,
  total_tokens_used INTEGER DEFAULT 0,
  total_embeddings_created INTEGER DEFAULT 0,
  
  -- Costs (if applicable)
  estimated_cost DECIMAL(10, 4) DEFAULT 0,
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  UNIQUE(user_id, period_start, period_end)
);

-- Indexes
CREATE INDEX idx_ai_usage_stats_user_id ON ai_usage_stats(user_id);
CREATE INDEX idx_ai_usage_stats_period ON ai_usage_stats(period_start, period_end);

-- =============================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================

-- ai_conversations
ALTER TABLE ai_conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own conversations"
  ON ai_conversations FOR SELECT
  USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "Users can insert own conversations"
  ON ai_conversations FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own conversations"
  ON ai_conversations FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own conversations"
  ON ai_conversations FOR DELETE
  USING (auth.uid() = user_id);

-- ai_messages
ALTER TABLE ai_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view messages of own conversations"
  ON ai_messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM ai_conversations
      WHERE ai_conversations.id = ai_messages.conversation_id
        AND ai_conversations.user_id = auth.uid()
        AND ai_conversations.deleted_at IS NULL
    )
  );

CREATE POLICY "Users can insert messages to own conversations"
  ON ai_messages FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM ai_conversations
      WHERE ai_conversations.id = ai_messages.conversation_id
        AND ai_conversations.user_id = auth.uid()
    )
  );

-- ai_memory_embeddings
ALTER TABLE ai_memory_embeddings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own memory embeddings"
  ON ai_memory_embeddings FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own memory embeddings"
  ON ai_memory_embeddings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own memory embeddings"
  ON ai_memory_embeddings FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own memory embeddings"
  ON ai_memory_embeddings FOR DELETE
  USING (auth.uid() = user_id);

-- ai_usage_stats
ALTER TABLE ai_usage_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own usage stats"
  ON ai_usage_stats FOR SELECT
  USING (auth.uid() = user_id);

-- =============================================
-- TRIGGERS & FUNCTIONS
-- =============================================

-- Auto update updated_at on ai_conversations
CREATE TRIGGER set_ai_conversations_updated_at
  BEFORE UPDATE ON ai_conversations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Auto update updated_at on ai_usage_stats
CREATE TRIGGER set_ai_usage_stats_updated_at
  BEFORE UPDATE ON ai_usage_stats
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Update conversation stats when message is added
CREATE OR REPLACE FUNCTION update_conversation_stats_on_message()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE ai_conversations
  SET 
    message_count = message_count + 1,
    total_tokens_used = total_tokens_used + COALESCE(NEW.tokens_used, 0),
    last_message_at = NEW.created_at,
    updated_at = NOW()
  WHERE id = NEW.conversation_id;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_conversation_stats_on_message_trigger
  AFTER INSERT ON ai_messages
  FOR EACH ROW
  EXECUTE FUNCTION update_conversation_stats_on_message();

-- Auto-generate conversation title from first message
CREATE OR REPLACE FUNCTION auto_generate_conversation_title()
RETURNS TRIGGER AS $$
DECLARE
  first_message TEXT;
  generated_title TEXT;
BEGIN
  -- Only generate if this is the first user message and title is default
  IF NEW.role = 'user' AND 
     (SELECT title FROM ai_conversations WHERE id = NEW.conversation_id) = 'Cuộc trò chuyện mới' THEN
    
    -- Get first 50 characters of message
    first_message := LEFT(NEW.content, 50);
    
    -- Clean up and add ellipsis if truncated
    IF LENGTH(NEW.content) > 50 THEN
      generated_title := first_message || '...';
    ELSE
      generated_title := first_message;
    END IF;
    
    -- Update conversation title
    UPDATE ai_conversations
    SET title = generated_title
    WHERE id = NEW.conversation_id;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER auto_generate_conversation_title_trigger
  AFTER INSERT ON ai_messages
  FOR EACH ROW
  EXECUTE FUNCTION auto_generate_conversation_title();

-- Function to search similar memories using vector similarity
CREATE OR REPLACE FUNCTION search_similar_memories(
  p_user_id UUID,
  p_query_embedding vector(1536),
  p_limit INTEGER DEFAULT 5,
  p_similarity_threshold DECIMAL DEFAULT 0.7
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  entity_type TEXT,
  entity_id UUID,
  entity_name TEXT,
  similarity DECIMAL,
  conversation_id UUID,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    m.id,
    m.content,
    m.entity_type,
    m.entity_id,
    m.entity_name,
    (1 - (m.embedding <=> p_query_embedding))::DECIMAL as similarity,
    m.conversation_id,
    m.created_at
  FROM ai_memory_embeddings m
  WHERE m.user_id = p_user_id
    AND (1 - (m.embedding <=> p_query_embedding)) >= p_similarity_threshold
  ORDER BY m.embedding <=> p_query_embedding
  LIMIT p_limit;
  
  -- Update access count and last_accessed_at
  UPDATE ai_memory_embeddings
  SET 
    access_count = access_count + 1,
    last_accessed_at = NOW()
  WHERE id IN (
    SELECT m.id
    FROM ai_memory_embeddings m
    WHERE m.user_id = p_user_id
      AND (1 - (m.embedding <=> p_query_embedding)) >= p_similarity_threshold
    ORDER BY m.embedding <=> p_query_embedding
    LIMIT p_limit
  );
END;
$$ LANGUAGE plpgsql;

-- Function to get conversation context (recent messages + relevant memories)
CREATE OR REPLACE FUNCTION get_conversation_context(
  p_conversation_id UUID,
  p_recent_messages_limit INTEGER DEFAULT 10
)
RETURNS TABLE (
  message_id UUID,
  role TEXT,
  content TEXT,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    m.id as message_id,
    m.role::TEXT,
    m.content,
    m.created_at
  FROM ai_messages m
  WHERE m.conversation_id = p_conversation_id
  ORDER BY m.created_at DESC
  LIMIT p_recent_messages_limit;
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- COMMENTS
-- =============================================

COMMENT ON TABLE ai_conversations IS 'Store AI conversation sessions with metadata';
COMMENT ON TABLE ai_messages IS 'Store individual messages in AI conversations';
COMMENT ON TABLE ai_memory_embeddings IS 'Store semantic embeddings for long-term memory and RAG';
COMMENT ON TABLE ai_usage_stats IS 'Track AI usage metrics for billing and limits';

COMMENT ON FUNCTION search_similar_memories IS 'Search for similar memories using vector similarity (cosine distance)';
COMMENT ON FUNCTION get_conversation_context IS 'Get recent messages from a conversation for context';
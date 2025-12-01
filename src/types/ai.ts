// =============================================
// AI ASSISTANT TYPES
// =============================================

export type AIMessageRole = 'user' | 'assistant' | 'system';

export interface AIConversation {
  id: string;
  user_id: string;
  title: string;
  summary?: string;
  message_count: number;
  total_tokens_used: number;
  referenced_entities: ReferencedEntity[];
  tags: string[];
  is_pinned: boolean;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  last_message_at?: string;
  deleted_at?: string;
}

export interface AIMessage {
  id: string;
  conversation_id: string;
  role: AIMessageRole;
  content: string;
  tokens_used: number;
  context_used: any[];
  referenced_entities: ReferencedEntity[];
  model?: string;
  temperature?: number;
  created_at: string;
}

export interface ReferencedEntity {
  type: 'contract' | 'tenant' | 'building' | 'room' | 'invoice' | 'payment' | 'issue' | 'asset';
  id: string;
  name: string;
  metadata?: Record<string, any>;
}

export interface AIMemoryEmbedding {
  id: string;
  user_id: string;
  conversation_id?: string;
  message_id?: string;
  content: string;
  embedding: number[];
  entity_type?: string;
  entity_id?: string;
  entity_name?: string;
  importance_score: number;
  access_count: number;
  created_at: string;
  last_accessed_at?: string;
}

export interface AIUsageStats {
  id: string;
  user_id: string;
  period_start: string;
  period_end: string;
  total_conversations: number;
  total_messages: number;
  total_tokens_used: number;
  total_embeddings_created: number;
  estimated_cost: number;
  created_at: string;
  updated_at: string;
}

export interface SimilarMemory {
  id: string;
  content: string;
  entity_type?: string;
  entity_id?: string;
  entity_name?: string;
  similarity: number;
  conversation_id?: string;
  created_at: string;
}

// Request/Response types for API
export interface SendMessageRequest {
  conversation_id?: string; // If null, create new conversation
  message: string;
  include_context?: boolean;
  context_types?: string[]; // ['contracts', 'tenants', 'buildings']
}

export interface SendMessageResponse {
  conversation_id: string;
  message: AIMessage;
  assistant_message: AIMessage;
  context_used: any[];
}

export interface CreateConversationRequest {
  title?: string;
  initial_message?: string;
}

export interface SearchConversationsRequest {
  query: string;
  limit?: number;
  include_archived?: boolean;
}

export interface ConversationStats {
  total_conversations: number;
  total_messages: number;
  total_tokens_used: number;
  conversations_this_month: number;
  messages_this_month: number;
  tokens_this_month: number;
}
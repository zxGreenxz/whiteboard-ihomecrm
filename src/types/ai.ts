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

// API Keys Management
export type AIProvider = 'openai' | 'gemini' | 'deepseek' | 'anthropic';

export interface AIApiKey {
  id: string;
  user_id: string;
  provider: AIProvider;
  api_key: string;
  is_active: boolean;
  is_default: boolean;
  last_used_at?: string;
  total_requests: number;
  display_name?: string;
  notes?: string;
  created_at: string;
  updated_at: string;
}

export interface AIProviderConfig {
  provider: AIProvider;
  name: string;
  description: string;
  models: AIModelConfig[];
  keyPattern: RegExp;
  keyExample: string;
  docsUrl: string;
}

export interface AIModelConfig {
  id: string;
  name: string;
  description: string;
  contextWindow: number;
  costPer1MInput: number;
  costPer1MOutput: number;
}

export const AI_PROVIDERS: AIProviderConfig[] = [
  {
    provider: 'openai',
    name: 'OpenAI',
    description: 'GPT-4, GPT-3.5 và các model của OpenAI',
    models: [
      {
        id: 'gpt-4o-mini',
        name: 'GPT-4o Mini',
        description: 'Nhanh, rẻ, phù hợp cho hầu hết tasks',
        contextWindow: 128000,
        costPer1MInput: 0.15,
        costPer1MOutput: 0.60,
      },
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        description: 'Mạnh nhất, phù hợp cho tasks phức tạp',
        contextWindow: 128000,
        costPer1MInput: 2.50,
        costPer1MOutput: 10.00,
      },
    ],
    keyPattern: /^sk-[A-Za-z0-9]{32,}$/,
    keyExample: 'sk-...',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  {
    provider: 'gemini',
    name: 'Google Gemini',
    description: 'Gemini Pro và Flash của Google',
    models: [
      {
        id: 'gemini-1.5-flash',
        name: 'Gemini 1.5 Flash',
        description: 'Nhanh nhất, miễn phí đến 15 requests/phút',
        contextWindow: 1000000,
        costPer1MInput: 0.075,
        costPer1MOutput: 0.30,
      },
      {
        id: 'gemini-1.5-pro',
        name: 'Gemini 1.5 Pro',
        description: 'Mạnh hơn, context window lớn nhất',
        contextWindow: 2000000,
        costPer1MInput: 1.25,
        costPer1MOutput: 5.00,
      },
    ],
    keyPattern: /^AIza[A-Za-z0-9_-]{35}$/,
    keyExample: 'AIza...',
    docsUrl: 'https://aistudio.google.com/app/apikey',
  },
  {
    provider: 'deepseek',
    name: 'DeepSeek',
    description: 'DeepSeek Chat - rẻ nhất, hiệu quả cao',
    models: [
      {
        id: 'deepseek-chat',
        name: 'DeepSeek Chat',
        description: 'Rất rẻ, hiệu suất tốt cho tiếng Việt',
        contextWindow: 64000,
        costPer1MInput: 0.14,
        costPer1MOutput: 0.28,
      },
    ],
    keyPattern: /^sk-[A-Za-z0-9]{32,}$/,
    keyExample: 'sk-...',
    docsUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    provider: 'anthropic',
    name: 'Anthropic Claude',
    description: 'Claude 3.5 Sonnet - tốt nhất cho coding',
    models: [
      {
        id: 'claude-3-5-sonnet-20241022',
        name: 'Claude 3.5 Sonnet',
        description: 'Tốt nhất cho coding và analysis',
        contextWindow: 200000,
        costPer1MInput: 3.00,
        costPer1MOutput: 15.00,
      },
    ],
    keyPattern: /^sk-ant-[A-Za-z0-9_-]{95,}$/,
    keyExample: 'sk-ant-...',
    docsUrl: 'https://console.anthropic.com/settings/keys',
  },
];
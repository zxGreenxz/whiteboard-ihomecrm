# Supabase Edge Functions - AI Assistant

Hệ thống Edge Functions cho tính năng AI Assistant với khả năng:
- Chat với AI (OpenAI GPT-4)
- RAG (Retrieval Augmented Generation) với vector embeddings
- Quản lý Knowledge Base

## Cấu trúc

```
supabase/functions/
├── ai-chat/          # Edge Function xử lý chat với AI
│   └── index.ts      # Chính xử lý chat + RAG
├── ai-embeddings/    # Edge Function tạo embeddings
│   └── index.ts      # Tạo vector embeddings cho knowledge base
└── README.md         # Tài liệu này
```

## Cài đặt

### 1. Cài đặt Supabase CLI

```bash
npm install -g supabase
```

### 2. Link với Supabase project

```bash
supabase link --project-ref tryymsxyyckgbrmmvozx
```

### 3. Cấu hình Environment Variables

Trên Supabase Dashboard → Edge Functions → Secrets, thêm:

```
OPENAI_API_KEY=sk-xxx...
```

### 4. Deploy Edge Functions

```bash
# Deploy tất cả functions
supabase functions deploy

# Hoặc deploy từng function riêng lẻ
supabase functions deploy ai-chat
supabase functions deploy ai-embeddings
```

## Chạy local (development)

### 1. Tạo file .env.local

```bash
# supabase/.env.local
OPENAI_API_KEY=sk-xxx...
```

### 2. Start local functions

```bash
supabase functions serve --env-file supabase/.env.local
```

Functions sẽ chạy tại: `http://localhost:54321/functions/v1/`

## API Documentation

### 1. AI Chat (`/ai-chat`)

**Endpoint:** `POST /functions/v1/ai-chat`

**Headers:**
```
Authorization: Bearer {supabase_access_token}
Content-Type: application/json
```

**Request Body:**
```json
{
  "conversation_id": "uuid-optional",
  "message": "Tôi muốn biết về hợp đồng thuê...",
  "include_context": true,
  "temperature": 0.7
}
```

**Response:**
```json
{
  "success": true,
  "conversation_id": "uuid",
  "user_message": {...},
  "assistant_message": {...},
  "context_used": 3
}
```

**Tính năng:**
- Tự động tạo conversation mới nếu chưa có
- Lưu user message vào database
- Sử dụng RAG để tìm kiếm context từ Knowledge Base
- Gọi OpenAI API với context
- Lưu AI response vào database
- Tự động cập nhật conversation stats

### 2. Create Embeddings (`/ai-embeddings`)

**Endpoint:** `POST /functions/v1/ai-embeddings`

**Headers:**
```
Authorization: Bearer {supabase_access_token}
Content-Type: application/json
```

**Request Body:**
```json
{
  "content": "Chính sách giảm giá cho khách thuê dài hạn...",
  "entity_type": "policy",
  "entity_id": "uuid-optional",
  "entity_name": "Giảm giá dài hạn",
  "importance_score": 0.8
}
```

**Response:**
```json
{
  "success": true,
  "embedding_id": "uuid",
  "message": "Embedding created successfully"
}
```

**Tính năng:**
- Tạo vector embedding từ text
- Lưu vào bảng ai_memory_embeddings
- Hỗ trợ tìm kiếm semantic similarity

## Database Schema

### ai_conversations
Lưu các cuộc trò chuyện của user

### ai_messages
Lưu các tin nhắn (user + assistant)

### ai_memory_embeddings
Lưu knowledge base dưới dạng vector embeddings (1536 dimensions)

### Functions
- `search_similar_memories()`: Tìm kiếm memories tương tự bằng vector similarity
- `get_conversation_context()`: Lấy context của conversation

## RAG (Retrieval Augmented Generation)

Hệ thống sử dụng RAG để cải thiện chất lượng trả lời:

1. **User gửi câu hỏi**
2. **Tạo embedding** cho câu hỏi
3. **Tìm kiếm** 5 memories tương tự nhất từ Knowledge Base (similarity > 0.7)
4. **Ghép context** vào system message
5. **Gọi OpenAI** với full context
6. **Lưu response** và cập nhật access_count

## Models được sử dụng

- **Chat:** GPT-4 Mini (`gpt-4o-mini`) - Nhanh, rẻ, chất lượng tốt
- **Embeddings:** text-embedding-3-small - 1536 dimensions

## Cost Estimation

**GPT-4o-mini pricing:**
- Input: $0.15 / 1M tokens
- Output: $0.60 / 1M tokens

**Embeddings pricing:**
- $0.02 / 1M tokens

Trung bình 1 cuộc trò chuyện (10 messages, có RAG):
- Tokens: ~5,000 tokens
- Cost: ~$0.003

## Troubleshooting

### Error: "Missing OPENAI_API_KEY"
→ Kiểm tra secrets trên Supabase Dashboard

### Error: "relation does not exist"
→ Chạy migration 026_ai_assistant_tables.sql

### Error: "User not authenticated"
→ Kiểm tra Authorization header có đúng format không

### Embeddings search không trả về kết quả
→ Kiểm tra similarity threshold (mặc định 0.7, có thể giảm xuống 0.5)

## Tối ưu hóa

### 1. Giảm token cost
- Giới hạn conversation history (hiện tại: 20 messages)
- Sử dụng temperature thấp hơn cho câu trả lời ổn định hơn

### 2. Tăng tốc độ
- Cache embeddings
- Sử dụng HNSW index cho vector search (đã có)

### 3. Cải thiện chất lượng
- Tăng số lượng similar memories (hiện tại: 5)
- Fine-tune similarity threshold
- Thêm metadata vào embeddings

## Security

- ✅ Row Level Security (RLS) được bật
- ✅ User chỉ truy cập được dữ liệu của mình
- ✅ OPENAI_API_KEY được lưu an toàn trong Supabase Secrets
- ✅ CORS được cấu hình đúng

## References

- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [OpenAI API](https://platform.openai.com/docs)
- [pgvector](https://github.com/pgvector/pgvector)

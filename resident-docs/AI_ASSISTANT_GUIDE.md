# AI Assistant - Hướng Dẫn Sử Dụng

## 📚 Giới thiệu

AI Assistant là trợ lý AI cá nhân thông minh được tích hợp vào hệ thống iHomeCRM với các tính năng:

- ✅ **Chat thông minh**: Trò chuyện với AI về dữ liệu hợp đồng, khách thuê, tòa nhà, hóa đơn
- ✅ **Bộ nhớ dài hạn**: AI ghi nhớ các cuộc trò chuyện trước đó
- ✅ **Knowledge Base**: Quản lý thông tin tham khảo để AI hỗ trợ tốt hơn
- ✅ **RAG (Retrieval Augmented Generation)**: Tự động tìm kiếm context liên quan
- ✅ **Vector Search**: Tìm kiếm semantic similarity với pgvector

## 🏗️ Kiến trúc

```
┌─────────────────────────────────────────────────────────────┐
│                        Frontend (React)                      │
│  ┌─────────────────┐          ┌──────────────────────┐     │
│  │ AIAssistantPage │          │  Knowledge Base UI   │     │
│  │  - Chat UI      │          │  - Add/Delete Entry  │     │
│  │  - History      │          │  - View Stats        │     │
│  └────────┬────────┘          └──────────┬───────────┘     │
│           │                               │                  │
│  ┌────────┴───────────────────────────────┴──────────┐     │
│  │         useAIAssistant Hooks                      │     │
│  │  - useConversations, useMessages                  │     │
│  │  - useKnowledgeBase, useCreateKnowledgeEntry      │     │
│  └────────┬──────────────────────────────────────────┘     │
└───────────┼──────────────────────────────────────────────────┘
            │
    ┌───────┴────────┐
    │ Supabase Client│
    └───────┬────────┘
            │
┌───────────┴──────────────────────────────────────────────────┐
│                    Supabase Backend                           │
│                                                               │
│  ┌──────────────────┐         ┌──────────────────────┐      │
│  │  Edge Functions  │         │     PostgreSQL       │      │
│  │                  │         │                      │      │
│  │ ┌──────────────┐ │         │ ┌──────────────────┐ │      │
│  │ │  ai-chat     │─┼────────▶│ │ ai_conversations │ │      │
│  │ │  - RAG       │ │         │ │ ai_messages      │ │      │
│  │ │  - OpenAI    │ │         │ │ ai_memory_       │ │      │
│  │ └──────────────┘ │         │ │   embeddings     │ │      │
│  │                  │         │ │                  │ │      │
│  │ ┌──────────────┐ │         │ │ + pgvector       │ │      │
│  │ │ai-embeddings │─┼────────▶│ └──────────────────┘ │      │
│  │ │- Create vec  │ │         │                      │      │
│  │ └──────────────┘ │         └──────────────────────┘      │
│  └──────────────────┘                                        │
│           │                                                   │
│  ┌────────┴────────┐                                         │
│  │  OpenAI API     │                                         │
│  │  - GPT-4o-mini  │                                         │
│  │  - Embeddings   │                                         │
│  └─────────────────┘                                         │
└───────────────────────────────────────────────────────────────┘
```

## 📦 Database Schema

### 1. `ai_conversations`
Lưu trữ các cuộc trò chuyện

```sql
- id: UUID (PK)
- user_id: UUID (FK → auth.users)
- title: TEXT
- summary: TEXT
- message_count: INTEGER
- total_tokens_used: INTEGER
- referenced_entities: JSONB
- tags: JSONB
- is_pinned: BOOLEAN
- is_archived: BOOLEAN
- created_at, updated_at, last_message_at
```

### 2. `ai_messages`
Lưu trữ tin nhắn trong các cuộc trò chuyện

```sql
- id: UUID (PK)
- conversation_id: UUID (FK → ai_conversations)
- role: ENUM('user', 'assistant', 'system')
- content: TEXT
- tokens_used: INTEGER
- context_used: JSONB
- model: TEXT
- temperature: DECIMAL
- created_at
```

### 3. `ai_memory_embeddings`
Lưu trữ Knowledge Base dưới dạng vector embeddings

```sql
- id: UUID (PK)
- user_id: UUID (FK → auth.users)
- conversation_id: UUID (optional)
- message_id: UUID (optional)
- content: TEXT
- embedding: VECTOR(1536)  -- OpenAI embedding dimensions
- entity_type: TEXT
- entity_id: UUID
- entity_name: TEXT
- importance_score: DECIMAL(0-1)
- access_count: INTEGER
- created_at, last_accessed_at
```

### 4. Database Functions

#### `search_similar_memories(user_id, query_embedding, limit, threshold)`
Tìm kiếm memories tương tự bằng vector cosine similarity

#### `get_conversation_context(conversation_id, limit)`
Lấy N tin nhắn gần nhất trong conversation

## 🚀 Setup & Deployment

### Bước 1: Chạy Migration

Vào **Supabase Dashboard** → **SQL Editor** và chạy:

```sql
-- File: supabase/migrations/026_ai_assistant_tables.sql
```

Hoặc sử dụng CLI:

```bash
supabase db push
```

### Bước 2: Cấu hình OpenAI API Key

1. Lấy API key từ [OpenAI Platform](https://platform.openai.com/api-keys)
2. Vào **Supabase Dashboard** → **Edge Functions** → **Secrets**
3. Thêm secret:
   ```
   OPENAI_API_KEY=sk-xxx...
   ```

### Bước 3: Deploy Edge Functions

```bash
# Install Supabase CLI
npm install -g supabase

# Link project
supabase link --project-ref tryymsxyyckgbrmmvozx

# Deploy functions
supabase functions deploy ai-chat
supabase functions deploy ai-embeddings
```

### Bước 4: Test

1. Mở app tại: `https://ihomecrm.vercel.app/settings/ai-assistant`
2. Tạo cuộc trò chuyện mới
3. Gửi tin nhắn test
4. Thêm kiến thức vào Knowledge Base

## 💡 Cách sử dụng

### Chat với AI

1. **Tạo cuộc trò chuyện mới**
   - Click nút "+" trong sidebar
   - Hoặc bắt đầu gửi tin nhắn

2. **Gửi câu hỏi**
   ```
   "Có bao nhiêu hợp đồng đang hoạt động?"
   "Cho tôi biết về tòa nhà A"
   "Tạo báo cáo doanh thu tháng này"
   ```

3. **AI sẽ:**
   - Tìm kiếm context từ Knowledge Base
   - Kết hợp với lịch sử trò chuyện
   - Trả lời câu hỏi một cách chính xác

### Quản lý Knowledge Base

1. **Thêm kiến thức mới**
   - Chuyển sang tab "Kho kiến thức"
   - Click "Thêm kiến thức"
   - Nhập nội dung (VD: chính sách, quy trình, FAQ)
   - Chọn loại (tùy chọn): policy, guideline, faq...

2. **Ví dụ:**
   ```
   Nội dung: "Chính sách giảm giá cho khách thuê dài hạn (>12 tháng) là 10%"
   Loại: policy
   ```

3. **AI sẽ tự động:**
   - Tạo vector embedding
   - Lưu vào database
   - Sử dụng trong các cuộc trò chuyện tiếp theo

### Tips & Tricks

**🎯 Để AI trả lời tốt hơn:**

1. **Cung cấp context rõ ràng**
   ```
   ❌ "Thống kê"
   ✅ "Cho tôi thống kê số lượng hợp đồng theo trạng thái trong tháng 12/2024"
   ```

2. **Thêm nhiều kiến thức vào Knowledge Base**
   - Chính sách công ty
   - Quy trình làm việc
   - FAQ thường gặp
   - Thông tin quan trọng

3. **Sử dụng cuộc trò chuyện riêng cho từng chủ đề**
   - Một cuộc cho "Báo cáo tài chính"
   - Một cuộc cho "Quản lý hợp đồng"
   - Một cuộc cho "Hỗ trợ khách hàng"

## 🔧 Troubleshooting

### "Cần chạy Database Migration"
→ Chạy file `026_ai_assistant_tables.sql` trong Supabase Dashboard

### "Lỗi khi gửi tin nhắn"
→ Kiểm tra:
1. Edge Functions đã deploy chưa?
2. OPENAI_API_KEY đã cấu hình chưa?
3. Network connection có ổn định không?

### AI không sử dụng Knowledge Base
→ Kiểm tra:
1. Knowledge Base có entries chưa?
2. Similarity threshold có quá cao không? (mặc định 0.7)
3. Nội dung có liên quan không?

### Chi phí quá cao
→ Tối ưu:
1. Giảm số lượng conversation history (mặc định 20)
2. Sử dụng temperature thấp hơn
3. Giới hạn số lượng embeddings được tìm kiếm

## 📊 Thống kê & Giám sát

### Dashboard hiển thị:
- **Tổng số cuộc trò chuyện**
- **Tổng số tin nhắn**
- **Tokens đã sử dụng**

### Trên mỗi Knowledge entry:
- **Số lần được sử dụng** (access_count)
- **Thời gian tạo**
- **Loại kiến thức**

## 🔐 Security

### Row Level Security (RLS)
- ✅ User chỉ thấy conversations của mình
- ✅ User chỉ thấy messages của conversations mình tạo
- ✅ User chỉ thấy knowledge base của mình

### API Security
- ✅ Tất cả requests cần Authorization header
- ✅ OPENAI_API_KEY được lưu an toàn trong Supabase Secrets
- ✅ CORS được cấu hình đúng

## 💰 Cost Estimation

### OpenAI Pricing (tháng 12/2024)

**GPT-4o-mini:**
- Input: $0.15 / 1M tokens
- Output: $0.60 / 1M tokens

**text-embedding-3-small:**
- $0.02 / 1M tokens

### Ước tính chi phí:

**100 cuộc trò chuyện/tháng:**
- Messages: ~1,000 messages
- Tokens: ~500K tokens
- Cost: ~$0.30/tháng

**Knowledge Base:**
- 100 entries × 200 tokens = 20K tokens
- Cost: ~$0.0004 (một lần)

**→ Tổng: ~$0.30/tháng cho 100 conversations**

## 🎯 Roadmap

### Phase 1 (Hiện tại) ✅
- [x] Chat cơ bản với AI
- [x] Lưu trữ conversations & messages
- [x] Knowledge Base management
- [x] RAG với vector search

### Phase 2 (Sắp tới)
- [ ] Tích hợp trực tiếp với dữ liệu CRM
- [ ] Auto-generate embeddings từ contracts, invoices
- [ ] Bulk import Knowledge Base
- [ ] Export conversations to PDF
- [ ] Voice input/output

### Phase 3 (Tương lai)
- [ ] Multi-modal (hình ảnh, file)
- [ ] Agents tự động thực hiện tasks
- [ ] Analytics dashboard chi tiết
- [ ] Fine-tuned model cho domain-specific

## 📚 References

- [OpenAI API Documentation](https://platform.openai.com/docs)
- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [pgvector](https://github.com/pgvector/pgvector)
- [RAG Pattern](https://www.pinecone.io/learn/retrieval-augmented-generation/)

## 🆘 Support

Nếu gặp vấn đề, hãy:
1. Kiểm tra [Troubleshooting](#-troubleshooting)
2. Xem logs trong Supabase Dashboard → Edge Functions → Logs
3. Liên hệ team development

---

**Phiên bản:** 1.0.0
**Cập nhật:** 01/12/2024

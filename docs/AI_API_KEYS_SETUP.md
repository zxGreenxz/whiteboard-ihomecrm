# Hướng Dẫn Setup API Keys cho AI Assistant

## 📋 Tổng quan

Tính năng API Keys Management cho phép bạn:
- ✅ Sử dụng nhiều AI providers: OpenAI, Google Gemini, DeepSeek, Anthropic Claude
- ✅ Quản lý API keys trực tiếp trên UI
- ✅ Bật/tắt từng provider
- ✅ Theo dõi usage và cost

## 🚀 Bước 1: Chạy Migration

Vào **Supabase Dashboard** → **SQL Editor** và chạy:

```bash
# File migration
supabase/migrations/027_ai_api_keys.sql
```

Migration này tạo:
- Bảng `ai_api_keys` - Lưu API keys
- RLS policies - Bảo mật
- Functions - Get active API key
- Thêm columns vào `ai_messages` - Track provider/model

## 🔑 Bước 2: Lấy API Keys

### OpenAI
1. Vào: https://platform.openai.com/api-keys
2. Click "Create new secret key"
3. Copy key (format: `sk-...`)
4. **Models:** gpt-4o-mini, gpt-4o

### Google Gemini
1. Vào: https://aistudio.google.com/app/apikey
2. Click "Create API key"
3. Copy key (format: `AIza...`)
4. **Models:** gemini-1.5-flash, gemini-1.5-pro
5. **Free tier:** 15 requests/phút

### DeepSeek (Khuyên dùng - rẻ nhất!)
1. Vào: https://platform.deepseek.com/api_keys
2. Đăng ký account
3. Click "Create API Key"
4. Copy key (format: `sk-...`)
5. **Models:** deepseek-chat
6. **Giá:** $0.14/$0.28 per 1M tokens (rẻ nhất!)

### Anthropic Claude
1. Vào: https://console.anthropic.com/settings/keys
2. Click "Create Key"
3. Copy key (format: `sk-ant-...`)
4. **Models:** claude-3-5-sonnet-20241022

## 🎨 Bước 3: Thêm API Keys vào UI

1. Mở app: `https://ihomecrm.vercel.app/settings/ai-assistant`
2. Chuyển sang tab **"Cài đặt API"**
3. Click **"Thêm API Key"**
4. Chọn provider
5. Nhập API key
6. Click **"Lưu"**

## 💰 So sánh giá các providers

| Provider | Model | Input (1M tokens) | Output (1M tokens) | Context Window |
|----------|-------|-------------------|-------------------|----------------|
| **DeepSeek** | deepseek-chat | $0.14 | $0.28 | 64K |
| OpenAI | gpt-4o-mini | $0.15 | $0.60 | 128K |
| Gemini | 1.5-flash | $0.075 | $0.30 | 1M |
| Gemini | 1.5-pro | $1.25 | $5.00 | 2M |
| OpenAI | gpt-4o | $2.50 | $10.00 | 128K |
| Anthropic | claude-3.5-sonnet | $3.00 | $15.00 | 200K |

### 🏆 Khuyến nghị:

**DeepSeek** - Tốt nhất cho tiếng Việt và rẻ nhất:
- Chi phí: ~$0.42 cho 1M tokens (trung bình)
- Performance tốt với tiếng Việt
- Context window 64K (đủ cho hầu hết use cases)

**Gemini 1.5 Flash** - Tốt nhất cho FREE tier:
- Free: 15 requests/phút
- Context window 1M (lớn nhất!)
- Nhanh nhất

**OpenAI GPT-4o Mini** - Cân bằng tốt:
- Performance ổn định
- Ecosystem lớn
- Chi phí vừa phải

## 📊 Ước tính chi phí thực tế

### Scenario: 100 conversations/tháng với DeepSeek

```
Average conversation:
- 10 messages
- ~500 tokens/message
- Total: 5,000 tokens/conversation

Monthly usage:
- 100 conversations × 5,000 tokens = 500,000 tokens
- Input: 250K tokens = $0.035
- Output: 250K tokens = $0.070
- Total: $0.105/tháng (~2,500 VNĐ)
```

### So sánh với OpenAI:
```
Same usage with GPT-4o-mini:
- Input: 250K × $0.15 = $0.0375
- Output: 250K × $0.60 = $0.150
- Total: $0.1875/tháng (~4,600 VNĐ)

Chênh lệch: 79% rẻ hơn!
```

## 🔐 Bảo mật

### API Keys được bảo vệ:
- ✅ Lưu trong database với RLS
- ✅ Chỉ user mới thấy keys của mình
- ✅ Không expose ra client-side
- ✅ Edge Functions gọi trực tiếp

### Best practices:
1. **Không share API keys**
2. **Rotate keys định kỳ** (3-6 tháng)
3. **Monitor usage** qua provider dashboard
4. **Set spending limits** trên provider dashboard

## 🎯 Sử dụng

### 1. Trong chat interface:
- Sẽ tự động sử dụng provider **active** đầu tiên
- Nếu nhiều providers active → ưu tiên theo thứ tự: OpenAI → Gemini → DeepSeek → Anthropic

### 2. Chọn provider cụ thể:
*(Tính năng sắp có)*
- Model selector trong chat interface
- Cho phép chọn provider + model cho từng conversation

## 🛠️ Troubleshooting

### "API key không đúng định dạng"
→ Kiểm tra format theo từng provider (xem table ở trên)

### "Provider không hoạt động"
→ Kiểm tra:
1. API key đúng chưa?
2. Provider có active không?
3. Còn quota không? (check provider dashboard)

### "Chi phí cao bất thường"
→ Giải pháp:
1. Set spending limits trên provider dashboard
2. Chuyển sang DeepSeek (rẻ nhất)
3. Giới hạn context window

## 🔄 Update Edge Functions (Sắp có)

Hiện tại Edge Functions vẫn dùng hard-code OpenAI. Update sắp tới sẽ:
- ✅ Tự động detect provider từ database
- ✅ Hỗ trợ tất cả 4 providers
- ✅ Fallback nếu provider lỗi
- ✅ Load balancing giữa providers

## 📚 Models detail

### OpenAI
```typescript
{
  'gpt-4o-mini': {
    contextWindow: 128000,
    bestFor: 'General tasks, fast responses'
  },
  'gpt-4o': {
    contextWindow: 128000,
    bestFor: 'Complex reasoning, coding'
  }
}
```

### Gemini
```typescript
{
  'gemini-1.5-flash': {
    contextWindow: 1000000, // 1M!
    bestFor: 'Large documents, FREE tier'
  },
  'gemini-1.5-pro': {
    contextWindow: 2000000, // 2M!
    bestFor: 'Very large documents, best quality'
  }
}
```

### DeepSeek
```typescript
{
  'deepseek-chat': {
    contextWindow: 64000,
    bestFor: 'Vietnamese, cost-effective'
  }
}
```

### Anthropic
```typescript
{
  'claude-3-5-sonnet-20241022': {
    contextWindow: 200000,
    bestFor: 'Coding, technical writing'
  }
}
```

## 🎁 Bonus: Gemini Free Tier

Gemini 1.5 Flash FREE tier:
- **15 requests per minute**
- **1,500 requests per day**
- **Perfect cho development và testing**

Cách tối ưu:
```typescript
// Sử dụng Gemini Flash cho dev
// DeepSeek cho production (rẻ + tốt)
// OpenAI cho fallback
```

## 📞 Support

Nếu gặp vấn đề:
1. Check migration đã chạy chưa
2. Check API key format
3. Check provider dashboard
4. Liên hệ team development

---

**Version:** 1.0.0
**Updated:** 01/12/2024

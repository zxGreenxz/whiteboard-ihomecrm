# AI Copilot

> **Current through:** 2026-08-12  
> **Status:** chat có streaming, đọc ảnh, gọi tool song song; tra tài liệu bằng BM25 theo mục; bản đồ hệ thống theo quyền; 10 tool đọc + 1 write tool draft-first; UI-control có gate và KHÔNG cầm tool ghi.

## Bề mặt đang chạy

- Nút Copilot chỉ hiện khi có session, entitlement và quyền `ai_copilot.view`.
- Chat gọi model cloud qua Edge Function `llm-proxy`; provider/key/quota/log nằm server-side. Ollama local được browser gọi trực tiếp khi bật.
- Tool đọc hiện có: phòng trống, khách hàng, hoá đơn, hợp đồng sắp hết hạn, KQKD tháng, tỉ lệ lấp đầy, công nợ hoá đơn, cọc đang giữ, sổ quỹ; tra tài liệu (`huong_dan`, `liet_ke_chu_de`) và bản đồ hệ thống (`ban_do_he_thong`).
- Chat đi qua `src/copilot/llmClient.ts` — client OpenAI-compat mỏng nói thẳng với proxy, hỗ trợ SSE, `content` multimodal và mảng `tool_calls`. `@page-agent/llms` chỉ còn phục vụ UI-control; ba giới hạn của nó (không stream, `content` chỉ là chuỗi, `toolCall` số ít) là lý do tách ra.
- Tra tài liệu: chunk theo heading, BM25 hai trường (thân + đường dẫn heading), bỏ dấu + bigram âm tiết + bảng đồng nghĩa + bảng hư từ. Index dựng LÚC CHẠY, chỉ từ tài liệu phiên có quyền đọc.
- System prompt mang ngày hôm nay và trang người dùng đang xem.
- Ảnh: nén client về 1024/JPEG, gửi kèm request, KHÔNG lưu.
- UI-control chỉ chạy khi entitlement + quyền `ai_copilot.ui_control` hợp lệ; agent có thể điều hướng, lọc và điền form trên route allowlist, nhưng nút Lưu/Xác nhận/Submit và hành động nguy hiểm bị loại khỏi vùng tương tác.
- Tool ghi `tao_phieu_thu_chi_nhap` bắt buộc trả bản xem trước và chờ người dùng xác nhận rõ ở lượt sau; kết quả là phiếu `UNAPPROVED`, không gắn sổ.
- Luồng ghi gồm ba bước: INSERT `ai_write_audit` (client) → RPC `ie_compat_insert_v2` (server, tạo phiếu **và** hạng mục trong một call, tự ép `UNAPPROVED`/`PENDING` và stamp maker) → UPDATE `entity_id` vào audit (client). Bước giữa nguyên tử, nhưng **ba bước không nằm chung một transaction**: hỏng giữa chừng để lại audit thiếu `entity_id`, hoặc phiếu đã tạo mà audit chưa trỏ tới. Không còn khả năng để lại phiếu thiếu hạng mục như luồng DML rời trước Stage-7. Audit key chặn tạo trùng khi thử lại.

## Giới hạn đã biết

- Gate xác nhận hai bước của write tool hiện dựa vào boolean `xac_nhan` do model truyền; ứng dụng/server chưa lưu state độc lập để chứng minh đã có preview và câu đồng ý của người dùng ở lượt trước. Vì vậy đây là guardrail theo prompt/schema, không phải authorization boundary cứng.
- Proxy kiểm cả provider lẫn `modelId`: model không có trong `ai_providers.models` bị từ chối 400 `bad_model` **trước khi** reserve, nên sửa request hoặc sửa `profiles.ui_preferences.copilotModel` không còn chọn được model admin chưa bật. Ngoại lệ có chủ ý: provider `mock`, vì `modelId` của nó là tên kịch bản dev/test — công tắc của nó là `ai_providers.enabled`.
- Model đã bật nhưng khai `input_price`/`output_price` bằng `0` vẫn được tính chi phí `0`. Hạn mức USD ba cấp chỉ chính xác bằng metadata giá, nên các cap vẫn là guardrail vận hành cho tới khi mọi model đang bật đều điền giá thật; thứ chặn chắc chắn hiện nay là `rate_per_min`.
- Bốn bảng RAG legacy `ai_conversations`, `ai_messages`, `ai_memory_embeddings`, `ai_usage_stats` và RPC/trigger liên quan đã bị drop bởi migration `20260710190000_drop_legacy_ai_assistant.sql`; runtime hiện dùng schema Copilot mới.

## Tài liệu

- [../AI-SYSTEM-AUDIT-OPTIMIZATION-ROADMAP-2026-07-20.md](../AI-SYSTEM-AUDIT-OPTIMIZATION-ROADMAP-2026-07-20.md) — audit/roadmap snapshot bất biến; không dùng số liệu cũ trong đó thay cho runtime hiện tại.
- [PLAN.md](PLAN.md) — thiết kế v2.1 và rationale; các câu “sẽ làm” cũ phải đọc cùng README này.
- [SPIKE-RESULTS.md](SPIKE-RESULTS.md) — bằng chứng spike ngày 10/07, không phải status vận hành.
- Tham chiếu hệ thống: [../he-thong/21-ai-copilot.md](../he-thong/21-ai-copilot.md).

## Nguồn sự thật

Runtime nằm ở `src/copilot/**`, backend tại `supabase/functions/llm-proxy`, schema/type trong generated types và migrations `20260710*ai_copilot*` + `20260711050000_ai_write_audit.sql`.

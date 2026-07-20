# AI Copilot

> **Current through:** 2026-07-20  
> **Status:** đã triển khai chat, UI-control có gate (điều hướng/lọc/điền form nhưng không submit), tool nghiệp vụ đọc và một write tool draft-first.

## Bề mặt đang chạy

- Nút Copilot chỉ hiện khi có session, entitlement và quyền `ai_copilot.view`.
- Chat gọi model cloud qua Edge Function `llm-proxy`; provider/key/quota/log nằm server-side. Ollama local được browser gọi trực tiếp khi bật.
- Tool đọc hiện có: phòng trống, khách hàng, hóa đơn, hợp đồng sắp hết hạn, KQKD tháng và tra cứu `docs/he-thong/*.md`.
- UI-control chỉ chạy khi entitlement + quyền `ai_copilot.ui_control` hợp lệ; agent có thể điều hướng, lọc và điền form trên route allowlist, nhưng nút Lưu/Xác nhận/Submit và hành động nguy hiểm bị loại khỏi vùng tương tác.
- Tool ghi `tao_phieu_thu_chi_nhap` bắt buộc trả bản xem trước và chờ người dùng xác nhận rõ ở lượt sau; kết quả là phiếu `UNAPPROVED`, không gắn sổ.
- Luồng ghi hiện là nhiều DML client rời nhau (`ai_write_audit` → phiếu → hạng mục → cập nhật audit), **không nằm trong một transaction/RPC**. Audit key chỉ giảm tạo trùng; lỗi giữa chừng có thể để lại audit hoặc phiếu thiếu hạng mục, nên phải kiểm tra màn Thu chi trước khi thử lại.

## Giới hạn đã biết

- Gate xác nhận hai bước của write tool hiện dựa vào boolean `xac_nhan` do model truyền; ứng dụng/server chưa lưu state độc lập để chứng minh đã có preview và câu đồng ý của người dùng ở lượt trước. Vì vậy đây là guardrail theo prompt/schema, không phải authorization boundary cứng.
- Proxy kiểm provider có bật nhưng chưa bắt buộc `modelId` thuộc `ai_providers.models`; model lạ/stale vẫn có thể được gửi upstream nếu request hoặc preference bị sửa.
- Model không có metadata giá được tính giá `0`, nên reservation/quota và log chi phí có thể thấp hơn thực tế. Các cap hiện là guardrail vận hành, chưa phải ranh giới billing cứng cho model chưa được xác thực.
- Bốn bảng RAG legacy `ai_conversations`, `ai_messages`, `ai_memory_embeddings`, `ai_usage_stats` và RPC/trigger liên quan đã bị drop bởi migration `20260710190000_drop_legacy_ai_assistant.sql`; runtime hiện dùng schema Copilot mới.

## Tài liệu

- [../AI-SYSTEM-AUDIT-OPTIMIZATION-ROADMAP-2026-07-20.md](../AI-SYSTEM-AUDIT-OPTIMIZATION-ROADMAP-2026-07-20.md) — audit/roadmap snapshot bất biến; không dùng số liệu cũ trong đó thay cho runtime hiện tại.
- [PLAN.md](PLAN.md) — thiết kế v2.1 và rationale; các câu “sẽ làm” cũ phải đọc cùng README này.
- [SPIKE-RESULTS.md](SPIKE-RESULTS.md) — bằng chứng spike ngày 10/07, không phải status vận hành.
- Tham chiếu hệ thống: [../he-thong/21-ai-copilot.md](../he-thong/21-ai-copilot.md).

## Nguồn sự thật

Runtime nằm ở `src/copilot/**`, backend tại `supabase/functions/llm-proxy`, schema/type trong generated types và migrations `20260710*ai_copilot*` + `20260711050000_ai_write_audit.sql`.

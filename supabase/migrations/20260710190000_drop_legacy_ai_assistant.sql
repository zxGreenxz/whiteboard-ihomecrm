-- Phase 0b AI Copilot (docs/ai-copilot/PLAN.md): XOÁ TOÀN BỘ AI assistant cũ
-- (migration 026_ai_assistant_tables.sql) sau khi spike page-agent PASS toàn bộ gate
-- (docs/ai-copilot/SPIKE-RESULTS.md).
--
-- Audit trước khi drop (10/07/2026, script audit-old-ai.mjs qua Management API):
--   - 4 bảng đều 0 dòng (n_live_tup=0) → KHÔNG cần backup dữ liệu
--   - Không có view/rule ngoài phụ thuộc (pg_depend qua pg_rewrite: rỗng)
--   - Không có FK từ bảng khác trỏ vào: rỗng
--   - FE không còn code tham chiếu (chỉ types.ts generated)
--   - 2 edge function ai-chat/ai-embeddings xoá riêng qua Management API
--
-- LƯU Ý: KHÔNG drop extension vector — để lại, vô hại và tránh vỡ nếu nơi khác dùng.

-- Trigger functions + RPC cũ (drop trước cho gọn; CASCADE bảng sẽ gỡ trigger)
DROP FUNCTION IF EXISTS public.update_conversation_stats_on_message() CASCADE;
DROP FUNCTION IF EXISTS public.auto_generate_conversation_title() CASCADE;
DROP FUNCTION IF EXISTS public.search_similar_memories CASCADE;
DROP FUNCTION IF EXISTS public.get_conversation_context CASCADE;

-- 4 bảng (CASCADE gỡ policies/indexes/triggers còn lại)
DROP TABLE IF EXISTS public.ai_messages CASCADE;
DROP TABLE IF EXISTS public.ai_memory_embeddings CASCADE;
DROP TABLE IF EXISTS public.ai_usage_stats CASCADE;
DROP TABLE IF EXISTS public.ai_conversations CASCADE;

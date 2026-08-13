-- =============================================================================
-- Chat Zalo — vá ACL: RPC không được cho anon/PUBLIC execute.
--
-- Gate CI `check-definer-acl` bắt đúng lỗi ở đợt 20260813100000..130000:
-- 16 hàm SECURITY DEFINER mới/đổi-chữ-ký bị anon-executable. Nguyên nhân:
-- Postgres mặc định GRANT EXECUTE cho PUBLIC khi CREATE FUNCTION; các file
-- trước chỉ `REVOKE ... FROM anon` — vô dụng vì anon vẫn THỪA KẾ quyền từ
-- PUBLIC. Phải revoke PUBLIC (và anon cho tường minh) rồi grant lại đúng vai.
--
-- Toàn bộ RPC zalo là API cho NGƯỜI ĐĂNG NHẬP của công ty (guard zalo_can
-- RBAC v3 bên trong) — không có endpoint công khai nào ở đây, nên câu trả lời
-- đúng là REVOKE, không phải allowlist.
-- Idempotent.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

DO $acl$
DECLARE
  sig text;
  sigs constant text[] := ARRAY[
    'public.zalo_backfill_crm_links(uuid)',
    'public.zalo_delete_message_for_me(uuid)',
    'public.zalo_delete_template(uuid)',
    'public.zalo_get_crm_summary(uuid)',
    'public.zalo_link_conversation(uuid,uuid,uuid)',
    'public.zalo_request_connect(uuid,text,uuid)',
    'public.zalo_save_template(text,text,uuid,text,text,integer,boolean,uuid)',
    'public.zalo_send_media(uuid,text,jsonb,text,text,jsonb)',
    'public.zalo_send_message(uuid,text,text,text,jsonb,text,jsonb,uuid)',
    'public.zalo_send_seen(uuid)',
    'public.zalo_send_typing(uuid)',
    'public.zalo_set_conversation_flags(uuid,boolean,boolean,boolean)',
    'public.zalo_start_chat_by_phone(uuid,text)',
    'public.zalo_sticker_search(uuid,text)',
    'public.zalo_toggle_automation(text,boolean,uuid)',
    'public.zalo_unlink_conversation(uuid)',
    -- 6 hàm ĐỜI CŨ (20260626) giữ nguyên chữ ký qua CREATE OR REPLACE nên giữ
    -- luôn ACL lỗi từ đầu — gate không flag vì đã nằm trong baseline, nhưng
    -- nghiệm thu dưới đây (nghiêm hơn gate) bắt được: anon thừa kế PUBLIC.
    'public.zalo_broadcast(uuid[],text)',
    'public.zalo_disconnect_account(uuid)',
    'public.zalo_load_history(uuid,integer)',
    'public.zalo_mark_read(uuid)',
    'public.zalo_react_message(uuid,text)',
    'public.zalo_recall_message(uuid)',
    -- vét luôn các hàm nền cùng đợt (một số đã revoke đúng — chạy lại vô hại)
    'public.zalo_authorized_org_ids(text)',
    'public.zalo_can(text)',
    'public.zalo_can(text,uuid)',
    'public.zalo_match_conversation_crm(uuid)',
    'public.phone_digits(text)'
  ];
BEGIN
  FOREACH sig IN ARRAY sigs LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', sig);
  END LOOP;
  -- hai hàm KHÔNG dành cho người dùng thường:
  EXECUTE 'REVOKE ALL ON FUNCTION public.zalo_match_conversation_crm(uuid) FROM authenticated';
END
$acl$;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU: anon không còn EXECUTE được bất kỳ hàm nào trong danh sách.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND (p.proname LIKE 'zalo\_%' OR p.proname = 'phone_digits')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Còn % hàm zalo mà anon EXECUTE được. DỪNG.', v_bad;
  END IF;
  RAISE NOTICE 'Nghiệm thu đạt: anon không execute được hàm zalo nào.';
END
$nghiem_thu$;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- ROLLBACK (tay): GRANT EXECUTE ... TO PUBLIC cho từng hàm (không khuyến nghị).

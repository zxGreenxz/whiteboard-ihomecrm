-- =============================================================================
-- Trang công khai "Phòng trống" — LỚP GHI chịu lỗi từng dòng
-- =============================================================================
-- Vì sao đổi: `log_public_room_events` cũ ghi cả batch bằng MỘT `INSERT … SELECT`
-- rồi bọc `EXCEPTION WHEN others THEN RETURN 0` ở ngoài. Hệ quả đo được: chỉ cần
-- MỘT sự kiện hỏng (session_id quá dài, metadata kiểu lạ, trigger org từ chối…)
-- là CẢ batch tối đa 50 sự kiện bị cuộn lại, client nhận số 0 trông y hệt
-- "token sai" và nuốt luôn — mất trắng, không dấu vết ở cả hai đầu.
--
-- Sửa: lặp từng dòng, mỗi dòng một sub-transaction (BEGIN … EXCEPTION bên trong
-- LOOP). Dòng hỏng chỉ mất chính nó; 49 dòng còn lại vẫn vào bảng. Trần 50
-- sự kiện/batch giữ nguyên nên số sub-transaction bị chặn cứng, không có đường
-- cho anon ép server mở vô hạn savepoint.
--
-- Đổi thứ hai: clamp metadata > 8192 ký tự trước đây thay TOÀN BỘ object bằng
-- `{"_truncated": true}` — dòng vẫn được đếm là một lỗi nhưng mất sạch kind/msg,
-- tức là một lỗi vô danh không phân tích được. Nay hạ cấp có chọn lọc: giữ các
-- khóa quyết định việc gộp nhóm (kind, msg, fp, source, n, is_staff) và bỏ phần
-- cồng kềnh (stack, ua…).
--
-- Chữ ký `(text, jsonb)` GIỮ NGUYÊN — chỉ thay thân hàm — nên ACL baseline của
-- definer function không đổi (scripts/definer-acl-baseline.json).
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.log_public_room_events(
  p_token  text,
  p_events jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_owner   uuid;
  v_count   int := 0;
  v_meta    jsonb;
  r         record;
  v_allowed CONSTANT text[] := ARRAY[
    'session','impression','building_select','view_mode','room_open','image_view',
    'floorplan_view','contact_click','share','download','directions','favorite',
    'deposit_dialog','error'
  ];
BEGIN
  IF p_token IS NULL OR p_token = '' THEN
    RETURN 0;
  END IF;

  -- Token phải tồn tại & chưa thu hồi → resolve owner_id phía server.
  SELECT owner_id INTO v_owner
  FROM public.public_room_share_tokens
  WHERE token = p_token AND revoked = false;
  IF v_owner IS NULL THEN
    RETURN 0;  -- token sai/thu hồi: no-op im lặng
  END IF;

  IF p_events IS NULL
     OR jsonb_typeof(p_events) <> 'array'
     OR jsonb_array_length(p_events) = 0 THEN
    RETURN 0;
  END IF;

  FOR r IN
    SELECT t.e
    FROM jsonb_array_elements(p_events) WITH ORDINALITY AS t(e, ord)
    WHERE t.ord <= 50                              -- cắt cứng 50 sự kiện / batch
      AND jsonb_typeof(t.e) = 'object'
      AND NULLIF(t.e->>'session_id','') IS NOT NULL
      AND t.e->>'event_type' = ANY(v_allowed)      -- lọc event_type lạ (tránh CHECK abort)
  LOOP
    BEGIN
      v_meta := CASE
        WHEN r.e->'metadata' IS NULL OR jsonb_typeof(r.e->'metadata') <> 'object'
          THEN '{}'::jsonb
        WHEN length((r.e->'metadata')::text) > 8192
          -- Hạ cấp có chọn lọc: giữ đúng những khóa mà báo cáo cần để gộp nhóm.
          THEN jsonb_strip_nulls(jsonb_build_object(
                 'kind',      r.e->'metadata'->>'kind',
                 'msg',       left(r.e->'metadata'->>'msg', 500),
                 'fp',        r.e->'metadata'->>'fp',
                 'source',    r.e->'metadata'->>'source',
                 'n',         r.e->'metadata'->'n',
                 'is_staff',  r.e->'metadata'->'is_staff',
                 '_truncated', to_jsonb(true)
               ))
        ELSE r.e->'metadata'
      END;

      INSERT INTO public.public_room_events (
        token, owner_id, session_id, event_type,
        room_id, room_name, room_code, building_id, building_name,
        duration_ms, dwell_ms, metadata, created_at
      )
      VALUES (
        p_token,
        v_owner,                                   -- server-resolved; bỏ qua client owner_id
        left(NULLIF(r.e->>'session_id',''), 64),
        r.e->>'event_type',
        CASE WHEN (r.e->>'room_id')     ~ '^[0-9a-fA-F-]{36}$' THEN (r.e->>'room_id')::uuid     END,
        left(r.e->>'room_name', 200),
        left(r.e->>'room_code', 64),
        CASE WHEN (r.e->>'building_id') ~ '^[0-9a-fA-F-]{36}$' THEN (r.e->>'building_id')::uuid END,
        left(r.e->>'building_name', 200),
        CASE WHEN jsonb_typeof(r.e->'duration_ms')='number'
             THEN LEAST(GREATEST((r.e->>'duration_ms')::numeric::int, 0), 86400000) END,
        CASE WHEN jsonb_typeof(r.e->'dwell_ms')='number'
             THEN LEAST(GREATEST((r.e->>'dwell_ms')::numeric::int, 0), 86400000) END,
        v_meta,
        now()                                      -- tin đồng hồ server; bỏ qua client created_at
      );
      v_count := v_count + 1;
    EXCEPTION
      WHEN others THEN
        -- Dòng hỏng chỉ mất chính nó. Đây là điểm khác cốt lõi so với bản cũ:
        -- không được để một sự kiện dị dạng kéo theo cả batch.
        NULL;
    END;
  END LOOP;

  RETURN v_count;
EXCEPTION
  WHEN others THEN
    RETURN 0;  -- không bao giờ lộ nội bộ cho anon
END;
$fn$;

COMMENT ON FUNCTION public.log_public_room_events(text, jsonb) IS
'Anon batch logger cho /r/:token. Validate token (chưa revoke), resolve owner_id
server-side, cắt batch <=50, clamp string/duration, lọc event_type lạ. Ghi TỪNG
DÒNG trong sub-transaction: dòng hỏng chỉ mất chính nó, batch vẫn sống. Metadata
> 8192 ký tự bị hạ cấp còn kind/msg/fp/source/n để báo cáo vẫn gộp nhóm được.
Trả số dòng ghi. KHÔNG tin owner_id/created_at từ client.';

REVOKE ALL ON FUNCTION public.log_public_room_events(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_public_room_events(text, jsonb) TO anon, authenticated;

COMMIT;

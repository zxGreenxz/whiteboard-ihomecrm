-- =============================================================================
-- Bộ đo đếm trang công khai "Phòng trống" (/r/:token) — LỚP GHI SỰ KIỆN
-- =============================================================================
-- - Bảng `public_room_events`: 1 bảng "wide" ghi mọi sự kiện của khách ẩn danh
--   trên trang /r/:token (lượt xem, hiển thị phòng, mở chi tiết, thời gian, lỗi…).
-- - room_id/building_id KHÔNG FK (phòng có thể bị xoá; bảng anon-ghi không nên FK
--   vào rooms) — kèm snapshot room_name/room_code/building_name để báo cáo sống sót
--   khi phòng bị xoá.
-- - owner_id denormalize từ token (resolve server-side) cho RLS + truy vấn nhanh.
-- - RPC ghi `log_public_room_events` (SECURITY DEFINER, anon) nhận BATCH jsonb,
--   validate token, chống lạm dụng (cắt ≤50/batch, clamp text/duration/metadata,
--   lọc event_type lạ). RLS bật nhưng ghi đi qua RPC (bypass), chỉ SELECT cho chủ.
-- - Áp qua Supabase Management API (Node UTF-8), KHÔNG `db push`.
-- =============================================================================

-- 1) Bảng sự kiện -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.public_room_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token         text NOT NULL,                 -- link chia sẻ nào (attribution)
  owner_id      uuid NOT NULL,                 -- resolve từ token; RLS + report
  session_id    text NOT NULL,                 -- client tạo (1 / lượt truy cập / tab)
  event_type    text NOT NULL,
  room_id       uuid,                          -- KHÔNG FK (phòng có thể bị xoá)
  room_name     text,                          -- snapshot
  room_code     text,                          -- snapshot
  building_id   uuid,                          -- KHÔNG FK
  building_name text,                          -- snapshot
  duration_ms   integer,                       -- tổng thời gian xem trang (event 'session')
  dwell_ms      integer,                       -- thời gian ở lại 1 phòng (event 'room_open')
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,  -- ua, referrer, view_mode, is_staff, error{...}
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT public_room_events_event_type_chk CHECK (event_type IN (
    'session','impression','building_select','view_mode','room_open','image_view',
    'floorplan_view','contact_click','share','download','directions','favorite',
    'deposit_dialog','error'
  ))
);

COMMENT ON TABLE public.public_room_events IS
'Sự kiện đo đếm trang công khai Phòng trống (/r/:token). Ghi ẩn danh qua RPC
log_public_room_events (SECURITY DEFINER). owner_id resolve từ token; room/building
KHÔNG FK + có snapshot name/code để báo cáo sống sót khi phòng bị xoá.';

-- 2) Indexes ------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS pre_owner_created_idx
  ON public.public_room_events (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pre_token_created_idx
  ON public.public_room_events (token, created_at DESC);
CREATE INDEX IF NOT EXISTS pre_owner_room_idx
  ON public.public_room_events (owner_id, room_id) WHERE room_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pre_owner_type_idx
  ON public.public_room_events (owner_id, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS pre_owner_session_idx
  ON public.public_room_events (owner_id, session_id);

-- 3) RLS ----------------------------------------------------------------------
-- Ghi đi qua RPC SECURITY DEFINER (bypass RLS) → KHÔNG cần INSERT policy / grant anon.
-- SELECT chỉ cho chủ (self / employer-staff symmetric / admin / super admin).
ALTER TABLE public.public_room_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS public_room_events_select ON public.public_room_events;
CREATE POLICY public_room_events_select ON public.public_room_events
  FOR SELECT TO authenticated
  USING (
    owner_id = auth.uid()
    OR public.is_super_admin()
    OR public.is_admin()
    OR owner_id = ANY (public.current_visible_owner_ids())
  );

REVOKE ALL ON public.public_room_events FROM anon;
GRANT SELECT ON public.public_room_events TO authenticated, service_role;

-- 4) RPC ghi (anon, BATCH) ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.log_public_room_events(
  p_token  text,
  p_events jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner   uuid;
  v_count   int;
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

  WITH raw AS (
    SELECT t.e
    FROM jsonb_array_elements(p_events) WITH ORDINALITY AS t(e, ord)
    WHERE t.ord <= 50                            -- cắt cứng 50 sự kiện / batch
      AND jsonb_typeof(t.e) = 'object'
  ),
  ins AS (
    INSERT INTO public.public_room_events (
      token, owner_id, session_id, event_type,
      room_id, room_name, room_code, building_id, building_name,
      duration_ms, dwell_ms, metadata, created_at
    )
    SELECT
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
      CASE
        WHEN r.e->'metadata' IS NULL OR jsonb_typeof(r.e->'metadata') <> 'object'
          THEN '{}'::jsonb
        WHEN length((r.e->'metadata')::text) > 8192
          THEN jsonb_build_object('_truncated', true)
        ELSE r.e->'metadata'
      END,
      now()                                      -- tin đồng hồ server; bỏ qua client created_at
    FROM raw r
    WHERE NULLIF(r.e->>'session_id','') IS NOT NULL
      AND r.e->>'event_type' = ANY(v_allowed)    -- lọc bỏ event_type lạ (tránh CHECK abort)
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM ins;

  RETURN COALESCE(v_count, 0);
EXCEPTION
  WHEN others THEN
    RETURN 0;  -- không bao giờ lộ nội bộ cho anon
END;
$$;

COMMENT ON FUNCTION public.log_public_room_events(text, jsonb) IS
'Anon batch logger cho /r/:token. Validate token (chưa revoke), resolve owner_id
server-side, cắt batch ≤50, clamp string/duration/metadata, lọc event_type lạ.
Trả số dòng ghi. KHÔNG tin owner_id/created_at từ client.';

REVOKE ALL ON FUNCTION public.log_public_room_events(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_public_room_events(text, jsonb) TO anon, authenticated;

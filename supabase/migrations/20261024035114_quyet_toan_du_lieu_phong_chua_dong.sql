-- =============================================================================
-- quyet_toan_du_lieu_phong_chua_dong — Quyết toán vận hành: danh sách Khoản thu hiện ĐỦ MỌI PHÒNG của toà như
-- Báo cáo Lợi Nhuận; phòng chưa đóng ghi "chưa đóng", phòng trống ghi lý do (chủ nhắn 24/10/2026: "paris 2
-- chưa đóng tiền mà không thấy hiện, tham khảo lại cách sắp xếp của báo cáo lợi nhuận").
-- =============================================================================
-- VÌ SAO
--   Báo cáo LN dựng ghi chú phòng ở web (useVacantRoomNotes) từ bảng rooms / contracts / invoices /
--   contract_terminations / contract_transfers. Link chủ nhà /qt chạy bằng anon — không đọc được các bảng đó.
--   Luật nằm DUY NHẤT ở hàm thuần src/lib/vacantRoomNotes.ts (Báo cáo LN và quyết toán cùng gọi); server chỉ trả
--   DỮ LIỆU THÔ của đúng một toà × tháng.
--
-- LÀM GÌ
--   1. app_private.landlord_room_data_v1(p_building_id, p_month, p_public) → jsonb {rooms, contracts, invoices,
--      terminations, transfers} của toà, CHÉP đúng bộ lọc của useVacantRoomNotes: phòng chưa xoá; HĐ chưa xoá
--      (mọi status) của các phòng đó; hoá đơn kỳ billing_month = tháng, chưa xoá, status ≠ CANCELLED, của các HĐ
--      đó; thanh lý của các HĐ đó; chuyển phòng có old_room_id thuộc toà, status APPROVED/COMPLETED. Id thật
--      thay bằng MÃ TẠM trong gói (p1, h1, d1…) — đủ để khớp phòng ↔ HĐ ↔ hoá đơn, không lộ id. Link chủ nhà
--      (p_public) không có số HĐ. Không tên khách, không SĐT.
--   2. app_private.landlord_settlement_month_payload_v1 (DỰNG TỪ THÂN production md5 c172acff…, file
--      20261023142407): thêm 'room_data' (dữ liệu sống, không vào ảnh chốt; tháng NOT_APPLICABLE ⇒ null).
--   Không đổi: công thức, ảnh chốt, chuỗi băm, quyền gọi RPC (public_v1 / month_v1 gọi month_payload như cũ).
--
-- ĐƯỜNG LÙI
--   CREATE OR REPLACE landlord_settlement_month_payload_v1 bằng thân của 20261023142407; DROP FUNCTION
--   app_private.landlord_room_data_v1(uuid, date, boolean).
--
-- Chạy được hai lượt liên tiếp và trên DB rỗng của Restore Drill (không đòi dữ liệu).
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 0. Thân đang chạy phải đúng bản đã rà (hoặc đã là bản của file này — lượt hai).
DO $truoc$
DECLARE
  v_sig  text;
  v_md5  text;
  v_ghim text[];
BEGIN
  FOR v_sig, v_ghim IN
    SELECT x.sig, x.ghim FROM (VALUES
      ('app_private.landlord_settlement_month_payload_v1(uuid,date,boolean)',
       ARRAY['c172acff6a3488ae6d26c1b71d9f8693', '55c57c02dea842cf444b16428a13634c']),
      -- hàm KHÔNG thay — gọi gói tháng; đổi thì rà lại trước khi áp
      ('public.landlord_settlement_public_v1(text,date)',
       ARRAY['1c3a19568446c14b0ab694e75e235c76']),
      ('public.landlord_settlement_month_v1(uuid,date)',
       ARRAY['94ff223a4cf13641bb1427b17b6a8bed'])
    ) AS x(sig, ghim)
  LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'Thiếu % — DỪNG.', v_sig USING ERRCODE = '55000';
    END IF;
    v_md5 := md5(pg_get_functiondef(v_sig::regprocedure));
    IF v_md5 <> ALL (v_ghim) THEN
      RAISE EXCEPTION '% KHÁC bản đã rà (md5 %) — DỪNG, chụp lại pg_get_functiondef rồi rà lại.', v_sig, v_md5
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  -- hàm mới: lượt hai phải đúng bản của file này
  IF to_regprocedure('app_private.landlord_room_data_v1(uuid,date,boolean)') IS NOT NULL THEN
    v_md5 := md5(pg_get_functiondef('app_private.landlord_room_data_v1(uuid,date,boolean)'::regprocedure));
    IF v_md5 <> 'ab6c8d7fb64e91e8f1502695e6a422e0' THEN
      RAISE EXCEPTION 'app_private.landlord_room_data_v1 KHÁC bản của file này (md5 %) — DỪNG.', v_md5 USING ERRCODE = '55000';
    END IF;
  END IF;
END
$truoc$;

-- ---------------------------------------------------------------------------
-- 1. Dữ liệu thô cho ghi chú phòng (luật ở src/lib/vacantRoomNotes.ts). Không kiểm quyền: chỉ gói tháng gọi,
--    sau khi đã kiểm (chủ công ty / super admin, hoặc token link chủ nhà).
CREATE OR REPLACE FUNCTION app_private.landlord_room_data_v1(
  p_building_id uuid,
  p_month       date,
  p_public      boolean
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO ''
AS $fn$
  WITH ky AS (
    SELECT pg_catalog.to_char(pg_catalog.date_trunc('month', p_month), 'YYYY-MM') AS ym
  ),
  phong AS (
    SELECT r.id, r.name, r.status::text AS status,
           'p' || pg_catalog.row_number() OVER (ORDER BY r.id) AS ma
      FROM public.rooms r
     WHERE r.building_id = p_building_id
       AND r.deleted_at IS NULL
  ),
  hd AS (
    SELECT c.id, c.room_id, c.status::text AS status, c.start_date, c.start_billing_date, c.end_date,
           c.actual_end_date, c.contract_number,
           'h' || pg_catalog.row_number() OVER (ORDER BY c.id) AS ma
      FROM public.contracts c
      JOIN phong p ON p.id = c.room_id
     WHERE c.deleted_at IS NULL
  ),
  hoa_don AS (
    SELECT i.id, i.contract_id, i.status::text AS status, i.kind::text AS kind, i.total_amount, i.paid_amount,
           -- is_overdue là cột suy PostgREST (hàm public.is_overdue(invoices)), không phải cột thật
           i.remaining_amount, public.is_overdue(i) AS is_overdue,
           'd' || pg_catalog.row_number() OVER (ORDER BY i.id) AS ma
      FROM public.invoices i
      JOIN hd ON hd.id = i.contract_id
     CROSS JOIN ky
     WHERE i.billing_month = ky.ym
       AND i.deleted_at IS NULL
       AND i.status::text <> 'CANCELLED'
  )
  SELECT pg_catalog.jsonb_build_object(
    'rooms', COALESCE((
       SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', p.ma, 'name', p.name, 'status', p.status)
                                   ORDER BY p.name, p.ma)
         FROM phong p), '[]'::jsonb),
    'contracts', COALESCE((
       SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'id', h.ma, 'room_id', p.ma, 'status', h.status, 'start_date', h.start_date,
                'start_billing_date', h.start_billing_date, 'end_date', h.end_date,
                'actual_end_date', h.actual_end_date,
                'contract_number', CASE WHEN p_public THEN NULL ELSE h.contract_number END) ORDER BY h.ma)
         FROM hd h JOIN phong p ON p.id = h.room_id), '[]'::jsonb),
    'invoices', COALESCE((
       SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'id', d.ma, 'contract_id', h.ma, 'status', d.status, 'kind', d.kind,
                'total_amount', d.total_amount, 'paid_amount', d.paid_amount,
                'remaining_amount', d.remaining_amount, 'is_overdue', d.is_overdue) ORDER BY d.ma)
         FROM hoa_don d JOIN hd h ON h.id = d.contract_id), '[]'::jsonb),
    'terminations', COALESCE((
       SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'contract_id', h.ma, 'termination_type', t.termination_type::text,
                'termination_date', t.termination_date, 'actual_move_out_date', t.actual_move_out_date,
                'status', t.status::text) ORDER BY h.ma, t.termination_date)
         FROM public.contract_terminations t JOIN hd h ON h.id = t.contract_id), '[]'::jsonb),
    'transfers', COALESCE((
       SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'old_room_id', p.ma, 'transfer_type', tr.transfer_type::text, 'transfer_date', tr.transfer_date,
                'status', tr.status::text) ORDER BY p.ma, tr.transfer_date)
         FROM public.contract_transfers tr JOIN phong p ON p.id = tr.old_room_id
        WHERE tr.status::text IN ('APPROVED', 'COMPLETED')), '[]'::jsonb));
$fn$;

REVOKE ALL ON FUNCTION app_private.landlord_room_data_v1(uuid, date, boolean) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Gói một tháng: thân production (20261023142407) + 'room_data'.
CREATE OR REPLACE FUNCTION app_private.landlord_settlement_month_payload_v1(
  p_building_id uuid,
  p_month       date,
  p_public      boolean
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO ''
AS $fn$
DECLARE
  v_cfg      app_private.landlord_operations%ROWTYPE;
  v_month    date := pg_catalog.date_trunc('month', p_month)::date;
  v_now      date := app_private.landlord_current_month_v1();
  v_name     text;
  v_live     jsonb;
  v_last     app_private.landlord_settlement_closes%ROWTYPE;
  v_has_last boolean;
  v_status   text;
  v_stmt     jsonb;
  v_blockers jsonb := '[]'::jsonb;
  v_closed   jsonb;
  v_note     text;
  v_note_at  timestamptz;
  v_confirm  jsonb;
BEGIN
  SELECT * INTO v_cfg FROM app_private.landlord_operations o WHERE o.building_id = p_building_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT b.name INTO v_name FROM public.buildings b WHERE b.id = p_building_id;

  IF v_month IS NULL OR v_month < v_cfg.effective_from OR v_month > v_now THEN
    RETURN pg_catalog.jsonb_build_object(
      'building_name', v_name,
      'landlord_name', v_cfg.landlord_name,
      'period_month', v_month,
      'status', 'NOT_APPLICABLE',
      'effective_from', v_cfg.effective_from,
      'is_current_month', false,
      'statement', NULL,
      'is_stale', false,
      'closed', NULL,
      'confirmation', NULL,
      'can_close', false,
      'close_blockers', '[]'::jsonb,
      'warnings', NULL,
      'kqkd_bridge', NULL,
      'room_data', NULL);
  END IF;

  v_live := app_private.landlord_settlement_compute_v1(p_building_id, v_month);
  SELECT * INTO v_last
    FROM app_private.landlord_settlement_closes c
   WHERE c.building_id = p_building_id AND c.period_month = v_month
   ORDER BY c.revision DESC
   LIMIT 1;
  v_has_last := FOUND;

  IF v_has_last AND v_last.action = 'CLOSE' THEN
    v_status := 'CLOSED';
    v_stmt := v_last.snapshot;
    -- ghi chú bàn giao hiện hành: bản sửa mới nhất của lần chốt này, chưa sửa thì ghi chú lúc chốt
    SELECT h.note, h.created_at INTO v_note, v_note_at
      FROM app_private.landlord_settlement_handovers h
     WHERE h.building_id = p_building_id AND h.period_month = v_month AND h.close_revision = v_last.revision
     ORDER BY h.created_at DESC, h.id DESC
     LIMIT 1;
    IF NOT FOUND THEN
      v_note := v_last.reason;
      v_note_at := NULL;
    END IF;
    v_closed := pg_catalog.jsonb_build_object(
      'revision', v_last.revision,
      'closed_at', v_last.created_at,
      'note', v_note,
      'note_updated_at', v_note_at,
      'closed_by_name', CASE WHEN p_public THEN NULL ELSE (
         SELECT COALESCE(NULLIF(pg_catalog.btrim(p.full_name), ''), p.email)
           FROM public.profiles p WHERE p.id = v_last.actor) END);
    SELECT pg_catalog.jsonb_build_object('confirmed_at', k.confirmed_at, 'note', k.note) INTO v_confirm
      FROM app_private.landlord_settlement_confirmations k
     WHERE k.building_id = p_building_id AND k.period_month = v_month AND k.close_revision = v_last.revision;
  ELSE
    v_status := 'OPEN';
    v_stmt := v_live;
    v_closed := NULL;
    v_confirm := NULL;
  END IF;

  IF v_status = 'OPEN' THEN
    v_blockers := app_private.landlord_close_blockers_v1(p_building_id, v_month, v_live);
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'building_name', v_name,
    'landlord_name', v_cfg.landlord_name,
    'period_month', v_month,
    'status', v_status,
    'effective_from', v_cfg.effective_from,
    'is_current_month', v_month = v_now,
    'statement', CASE WHEN p_public THEN app_private.landlord_strip_public_v1(v_stmt) ELSE v_stmt END,
    'live_hash', CASE WHEN p_public THEN NULL ELSE v_live->>'source_hash' END,
    -- điều khoản tháng đã chốt không sửa được (landlord_operation_upsert_v1 chặn) ⇒ lệch hash
    -- chỉ có thể do phiếu đổi sau khi chốt
    'is_stale', v_status = 'CLOSED' AND v_last.source_hash IS DISTINCT FROM (v_live->>'source_hash'),
    'closed', v_closed,
    'confirmation', v_confirm,
    -- dữ liệu thô cho ghi chú phòng (phòng chưa đóng / trống) — sống, không vào ảnh chốt
    'room_data', app_private.landlord_room_data_v1(p_building_id, v_month, p_public),
    'can_close', NOT p_public AND v_status = 'OPEN' AND pg_catalog.jsonb_array_length(v_blockers) = 0,
    'close_blockers', CASE WHEN p_public THEN '[]'::jsonb ELSE v_blockers END,
    'warnings', CASE WHEN p_public THEN NULL ELSE pg_catalog.jsonb_build_object(
       'missing_fixed_expenses', app_private.landlord_missing_fixed_v1(p_building_id, v_month),
       'related_elsewhere', app_private.landlord_related_elsewhere_v1(p_building_id, v_month),
       'landlord_account_elsewhere', app_private.landlord_account_elsewhere_v1(p_building_id, v_month),
       'pre_start_pending', CASE WHEN v_month = v_cfg.effective_from
                                 THEN app_private.landlord_pre_start_pending_v1(p_building_id) END,
       'pre_start_period', CASE WHEN v_month = v_cfg.effective_from
                                THEN app_private.landlord_pre_start_period_v1(p_building_id) END) END,
    'kqkd_bridge', CASE WHEN p_public THEN NULL
                        ELSE app_private.landlord_kqkd_bridge_v1(p_building_id, v_month, v_stmt,
                               v_status = 'CLOSED' AND v_last.source_hash IS DISTINCT FROM (v_live->>'source_hash')) END);
END
$fn$;

REVOKE ALL ON FUNCTION app_private.landlord_settlement_month_payload_v1(uuid, date, boolean) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Hậu kiểm.
DO $sau$
BEGIN
  IF to_regprocedure('app_private.landlord_room_data_v1(uuid,date,boolean)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu app_private.landlord_room_data_v1' USING ERRCODE = 'XX000';
  END IF;
END
$sau$;

COMMIT;
NOTIFY pgrst, 'reload schema';

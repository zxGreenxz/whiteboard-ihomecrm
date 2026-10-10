-- Giữ phòng từ danh sách phòng trống — chủ chốt 10/10/2026.
--  (1) Bỏ "Giữ chỗ 0 đồng" khỏi giao diện: giữ phòng không thu tiền chỉ còn Lock tạm.
--  (2) Lock tạm 6/12/24 giờ (quyền mới sale_phong.lock_room): khoá bán không khách, không tiền,
--      không phiếu. Hết giờ tự nhả: reader so expires_at với now(), không cần cron. Tạo giữ chỗ
--      trên phòng thì gỡ lock trong cùng giao dịch.
--  (3) Phiếu cọc CÓ TIỀN nhận tên khách gợi nhớ thay cho khách trong danh bạ. Người nộp trên
--      phiếu = tên gợi nhớ (hoàn cọc đọc payer_name nên vẫn hoàn được), ô ghi chú phiếu nhắc gắn
--      khách. Ký hợp đồng vẫn đòi khách thật: assert ký báo rõ khi customer_id NULL; thêm RPC
--      gắn khách.
-- Thân hàm sửa chép từ bản đang chạy (pg_get_functiondef production 10/10/2026 khớp
-- 20260928021213, 20260928025848, 20261010022101 sau chuẩn hoá khoảng trắng); chỗ đổi có ghi
-- chú "10/10". Không đổi kiểu trả về/ACL hàm cũ. Phòng bị lock vẫn là status_public 'rented',
-- sale_state 'RENTED' (zod giao diện cũ có enum cố định); chỉ reader trong app có thêm sale_lock.
-- Production chưa có dòng room_reservations nào khi viết migration này.

-- ── 1. Quyền ────────────────────────────────────────────────────────
-- authorize_tenant_action_v3 fail-closed với khoá lạ ⇒ khoá phải có trước writer (cùng giao dịch).
INSERT INTO public.permission_definitions (key, resource, action, sensitivity, permission_domain, scope_kinds, is_active)
VALUES ('sale_phong.lock_room', 'sale_phong', 'lock_room', 'ELEVATED', 'TENANT', ARRAY['ORGANIZATION','AREA','BUILDING']::text[], true)
ON CONFLICT (key) DO UPDATE
  SET is_active = true, sensitivity = excluded.sensitivity, scope_kinds = excluded.scope_kinds;

-- Vai chủ sở hữu có sẵn như các quyền sale_phong khác; vai khác chủ tự gán ở Phân quyền.
INSERT INTO public.role_permissions (organization_id, role_id, permission_key, effect)
SELECT r.organization_id, r.id, 'sale_phong.lock_room', 'ALLOW'
FROM public.organization_roles r
WHERE r.system_key = 'TENANT_OWNER' OR r.name = 'Chủ sở hữu tổ chức'
ON CONFLICT (organization_id, role_id, permission_key) DO NOTHING;

-- ── 2. Bảng lock tạm ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.room_sale_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  building_id uuid NOT NULL REFERENCES public.buildings(id),
  room_id uuid NOT NULL REFERENCES public.rooms(id),
  hours integer NOT NULL CHECK (hours IN (6, 12, 24)),
  note text CHECK (note IS NULL OR char_length(note) <= 300),
  locked_by uuid NOT NULL REFERENCES auth.users(id),
  locked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  released_by uuid REFERENCES auth.users(id),
  release_reason text CHECK (release_reason IN ('MANUAL', 'RESERVED', 'EXPIRED')),
  reservation_id uuid REFERENCES public.room_reservations(id),
  CONSTRAINT room_sale_locks_expiry CHECK (expires_at = locked_at + make_interval(hours => hours)),
  CONSTRAINT room_sale_locks_release_pair CHECK ((released_at IS NULL) = (release_reason IS NULL)),
  CONSTRAINT room_sale_locks_release_after CHECK (released_at IS NULL OR released_at >= locked_at),
  CONSTRAINT room_sale_locks_reserved_link CHECK ((release_reason IS NOT DISTINCT FROM 'RESERVED') = (reservation_id IS NOT NULL))
);
-- Một lock mở mỗi phòng. Lock hết giờ được đóng (EXPIRED, released_at = expires_at) ngay trước khi
-- lock mới hoặc giữ chỗ ghi, nên chỉ mục này không chặn oan.
CREATE UNIQUE INDEX IF NOT EXISTS room_sale_locks_one_open_idx ON public.room_sale_locks (room_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS room_sale_locks_org_open_idx ON public.room_sale_locks (organization_id, expires_at) WHERE released_at IS NULL;
REVOKE ALL ON public.room_sale_locks FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE public.room_sale_locks ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.room_sale_locks IS
  'Lock tạm phòng khỏi danh sách sale (6/12/24 giờ), không khách/tiền/phiếu. Hết hạn = expires_at <= now(), không cần job. Chỉ đọc/ghi qua RPC lock_room_for_sale_v1, release_room_sale_lock_v1, list_room_sale_locks_v1.';

-- ── 3. Giữ chỗ nhận tên khách gợi nhớ ───────────────────────────────
ALTER TABLE public.room_reservations ADD COLUMN IF NOT EXISTS customer_hint text;
ALTER TABLE public.room_reservations ALTER COLUMN customer_id DROP NOT NULL;
-- Nguồn tiền giữ chỗ bất biến (trigger) ⇒ dòng tạo lúc chưa có khách giữ customer_id NULL mãi;
-- không hàm nào đọc cột này (projection đi theo source_voucher_id).
ALTER TABLE public.reservation_receipts ALTER COLUMN customer_id DROP NOT NULL;
-- Bỏ rồi dựng lại mỗi lượt: một CHECK NULL được coi là đạt, nên COALESCE để thiếu cả khách lẫn
-- tên gợi nhớ bị chặn thật (bảng nhỏ, dựng lại rẻ; lượt chạy lại vẫn idempotent).
ALTER TABLE public.room_reservations DROP CONSTRAINT IF EXISTS room_reservations_party_or_hint;
ALTER TABLE public.room_reservations ADD CONSTRAINT room_reservations_party_or_hint
  CHECK (customer_id IS NOT NULL OR COALESCE(char_length(btrim(customer_hint)), 0) BETWEEN 1 AND 120);
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.room_reservations'::regclass AND conname = 'room_reservations_hint_len') THEN
    ALTER TABLE public.room_reservations ADD CONSTRAINT room_reservations_hint_len
      CHECK (customer_hint IS NULL OR char_length(customer_hint) <= 120);
  END IF;
END
$do$;
COMMENT ON COLUMN public.room_reservations.customer_hint IS
  'Tên khách gợi nhớ gõ tay khi tạo cọc chưa có khách trong danh bạ. Giữ lại sau khi gắn khách thật để còn dấu vết.';

-- ── 4. Sale facts: bản gốc đổi tên, bản cũ thành vỏ bọc thêm lock ────
CREATE OR REPLACE FUNCTION app_private.room_sale_workflow_base_fact_v1(
  p_room_id uuid,p_organization_id uuid,p_room_status text,p_has_pass boolean,p_soon_days integer
)
RETURNS TABLE(status_public text,sale_state text,avail_date date,sale_today date,expected_ready_on date)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
DECLARE v_today date:=public.org_today_v1(p_organization_id);
  v_occupied boolean;v_current_occupied boolean;v_notice date;v_overdue boolean;v_claim boolean:=false;v_turnover public.room_turnovers%ROWTYPE;
BEGIN
  sale_today:=v_today;avail_date:=NULL;expected_ready_on:=NULL;
  -- P9 is installed later in the forward sequence. Once present, a pure hold
  -- blocks sale without changing physical room status or expiring by itself.
  IF to_regclass('public.room_next_claims') IS NOT NULL THEN
    SELECT EXISTS(SELECT 1 FROM public.room_next_claims c
      WHERE c.organization_id=p_organization_id AND c.room_id=p_room_id AND c.status='LIVE') INTO v_claim;
  END IF;
  -- A pass advertisement is not a claim; valid next-customer holds always block sale.
  IF v_claim OR public.room_has_holding_deposit(p_room_id) OR p_room_status='RESERVED' THEN
    status_public:='rented';sale_state:='RENTED';RETURN NEXT;RETURN;
  END IF;
  SELECT count(*)>0,COALESCE(bool_or(c.start_date<=v_today),false),
    min(c.expected_move_out_date) FILTER (WHERE c.start_date<=v_today
      AND isfinite(c.expected_move_out_date) AND c.expected_move_out_date BETWEEN v_today AND v_today+p_soon_days),
    COALESCE(bool_or(c.start_date<=v_today AND isfinite(c.expected_move_out_date) AND c.expected_move_out_date<v_today),false)
    INTO v_occupied,v_current_occupied,v_notice,v_overdue
    FROM public.contracts c
    WHERE c.room_id=p_room_id AND c.organization_id=p_organization_id AND c.deleted_at IS NULL
      AND c.status IN ('ACTIVE','EXTENDED') AND c.actual_end_date IS NULL;
  IF v_occupied THEN
    IF p_has_pass AND v_current_occupied THEN status_public:='pass';sale_state:='PASS';
    ELSIF v_overdue THEN status_public:='soon';sale_state:='NOTICE_OVERDUE';
    ELSIF v_notice IS NOT NULL THEN status_public:='soon';sale_state:='NOTICE';avail_date:=v_notice;
    ELSE status_public:='rented';sale_state:='RENTED';END IF;
    RETURN NEXT;RETURN;
  END IF;
  IF p_room_status='AVAILABLE' THEN
    status_public:='free';sale_state:='READY';
    SELECT * INTO v_turnover FROM public.room_turnovers t
      WHERE t.room_id=p_room_id AND t.organization_id=p_organization_id AND t.status='PENDING';
    IF FOUND THEN sale_state:='PREPARING';expected_ready_on:=v_turnover.expected_ready_on;END IF;
  ELSE status_public:='rented';sale_state:='RENTED';END IF;
  RETURN NEXT;
END;
$function$;
REVOKE ALL ON FUNCTION app_private.room_sale_workflow_base_fact_v1(uuid,uuid,text,boolean,integer) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.room_sale_lock_open_id_v1(p_organization_id uuid,p_room_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
  SELECT l.id FROM public.room_sale_locks l
  WHERE l.organization_id=p_organization_id AND l.room_id=p_room_id AND l.released_at IS NULL AND l.expires_at>now()
$function$;
REVOKE ALL ON FUNCTION app_private.room_sale_lock_open_id_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Cùng chữ ký, cùng ACL (CREATE OR REPLACE giữ REVOKE cũ). Mọi reader (công khai, trong app,
-- Zalo, Copilot) đi qua đây nên phòng đang lock biến khỏi mọi danh sách bán cùng lúc.
CREATE OR REPLACE FUNCTION app_private.room_sale_workflow_fact_v1(
  p_room_id uuid,p_organization_id uuid,p_room_status text,p_has_pass boolean,p_soon_days integer
)
RETURNS TABLE(status_public text,sale_state text,avail_date date,sale_today date,expected_ready_on date)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
DECLARE b record;
BEGIN
  SELECT * INTO b FROM app_private.room_sale_workflow_base_fact_v1(p_room_id,p_organization_id,p_room_status,p_has_pass,p_soon_days);
  status_public:=b.status_public;sale_state:=b.sale_state;avail_date:=b.avail_date;sale_today:=b.sale_today;expected_ready_on:=b.expected_ready_on;
  -- Chỉ phòng đang bán mới bị lock che; phòng đã cọc/đang ở giữ nguyên lý do gốc.
  IF status_public IN ('free','soon') AND app_private.room_sale_lock_open_id_v1(p_organization_id,p_room_id) IS NOT NULL THEN
    status_public:='rented';sale_state:='RENTED';avail_date:=NULL;expected_ready_on:=NULL;
  END IF;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION app_private.room_sale_lock_response_v1(p_lock_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
  SELECT jsonb_build_object('id',l.id,'organization_id',l.organization_id,'building_id',l.building_id,'building_name',b.name,
    'room_id',l.room_id,'room_name',rm.name,'room_code',rm.code,'hours',l.hours,'note',l.note,
    'locked_by',l.locked_by,'locked_by_name',COALESCE(NULLIF(btrim(p.full_name),''),'Người dùng'),
    'locked_at',l.locked_at,'expires_at',l.expires_at,'released_at',l.released_at,'release_reason',l.release_reason,
    'reservation_id',l.reservation_id,'active',l.released_at IS NULL AND l.expires_at>now())
  FROM public.room_sale_locks l
  JOIN public.rooms rm ON rm.id=l.room_id
  JOIN public.buildings b ON b.id=l.building_id
  LEFT JOIN public.profiles p ON p.id=l.locked_by
  WHERE l.id=p_lock_id
$function$;
REVOKE ALL ON FUNCTION app_private.room_sale_lock_response_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Gọi SAU lock_org_for_decision_v1 (hợp đồng của authorize_tenant_action_v3); VOLATILE vì v3 khoá FOR SHARE.
CREATE OR REPLACE FUNCTION app_private.authorize_room_sale_lock_v1(p_org uuid,p_building uuid,p_permission text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
BEGIN
  IF p_permission IS NULL OR p_permission NOT IN ('sale_phong.lock_room','deposits.create') THEN
    RAISE EXCEPTION 'Unknown sale lock authority' USING ERRCODE='42501';END IF;
  RETURN auth.uid() IS NOT NULL AND COALESCE(p_org=ANY(public.my_org_ids()),false) AND COALESCE(public.can_access_building(p_building),false)
    AND COALESCE((SELECT a.allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),p_org,p_permission,p_building,NULL) a),false);
END;
$function$;
REVOKE ALL ON FUNCTION app_private.authorize_room_sale_lock_v1(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;

-- Reader trong app (chép 20261010022101): thêm khoá sale_lock cho phòng bị ẩn chỉ vì lock tạm.
CREATE OR REPLACE FUNCTION public.get_my_available_rooms()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_caller  uuid := auth.uid();
  v_owner   uuid;
  v_soon    int;
  v_hotline uuid;
  v_sale_policy text;
  v_result  jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT sa.user_id INTO v_owner
  FROM public.staff_assignments sa
  WHERE sa.staff_id = v_caller AND sa.user_id <> v_caller
  LIMIT 1;
  IF v_owner IS NULL THEN
    v_owner := v_caller;
  END IF;

  SELECT soon_days, hotline_id, sale_policy INTO v_soon, v_hotline, v_sale_policy
  FROM public.public_room_settings
  WHERE owner_id = v_owner;
  IF v_soon IS NULL THEN v_soon := 30; END IF;

  WITH rms AS (
    SELECT
      rm.id,
      rm.building_id,
      rm.floor,
      rm.name,
      rm.code,
      rm.area,
      rm.rent_price,
      rm.deposit_amount,
      rm.max_occupants,
      COALESCE(rm.amenities, '[]'::jsonb) AS amenities,
      COALESCE(rm.images,    '[]'::jsonb) AS images,
      rm.description,
      rm.sale_note,
      rm.sale_bonus_note,
      rm.room_type,
      -- Phòng khách nhờ sale (overlay). Khi contact_manager → che SĐT/tên khách.
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_name ELSE NULL END AS pass_contact_name,
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_phone ELSE NULL END AS pass_contact_phone,
      CASE WHEN fact.status_public='pass' THEN pl.sale_policy ELSE NULL END AS pass_sale_policy,
      CASE WHEN fact.status_public='pass' THEN pl.pass_price ELSE NULL END AS pass_price,
      CASE WHEN fact.status_public='pass' AND pl.avail_date>=fact.sale_today THEN pl.avail_date ELSE NULL END AS pass_avail_date,
      COALESCE(fact.status_public='pass' AND pl.contact_manager,false) AS pass_contact_manager,
      fact.status_public, fact.sale_state, fact.avail_date, fact.sale_today, fact.expected_ready_on,
      lk.sale_lock
    FROM public.rooms rm
    JOIN public.buildings b ON b.id = rm.building_id AND b.organization_id = rm.organization_id
    LEFT JOIN public.room_pass_listings pl
      ON pl.room_id = rm.id AND pl.user_id = v_owner AND pl.active = true
    CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(rm.id,rm.organization_id,rm.status::text,pl.id IS NOT NULL,v_soon) fact
    -- 10/10: phòng bị ẩn CHỈ vì lock tạm còn hạn ⇒ nhân viên trong app thấy ai lock, còn bao lâu.
    -- Reader công khai/Zalo/Copilot không có khoá này; trạng thái vẫn 'rented' như phòng đã cọc.
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object('id', l.id, 'hours', l.hours, 'note', l.note,
               'locked_at', l.locked_at, 'expires_at', l.expires_at,
               'locked_by_name', COALESCE(NULLIF(btrim(p.full_name), ''), 'Người dùng'),
               'locked_by_me', l.locked_by = v_caller) AS sale_lock
      FROM public.room_sale_locks l
      LEFT JOIN public.profiles p ON p.id = l.locked_by
      WHERE fact.status_public = 'rented'
        AND l.organization_id = rm.organization_id AND l.room_id = rm.id
        AND l.released_at IS NULL AND l.expires_at > now()
        AND EXISTS (
          SELECT 1 FROM app_private.room_sale_workflow_base_fact_v1(rm.id,rm.organization_id,rm.status::text,pl.id IS NOT NULL,v_soon) base
          WHERE base.status_public IN ('free','soon'))
    ) lk ON true
    WHERE b.user_id = v_owner
      AND b.is_virtual = false
      AND b.deleted_at IS NULL
      AND rm.deleted_at IS NULL
  ),
  bld_ids AS (
    SELECT DISTINCT building_id FROM rms WHERE status_public IN ('free','soon','pass') OR sale_lock IS NOT NULL
  ),
  rooms_j AS (
    SELECT jsonb_agg(to_jsonb(rms) ORDER BY rms.floor DESC, rms.name) AS j
    FROM rms
    WHERE rms.building_id IN (SELECT building_id FROM bld_ids)
  ),
  blds_j AS (
    SELECT jsonb_agg(jsonb_build_object(
      'id',           b.id,
      'name',         b.name,
      'code',         b.code,
      'area_ids',     COALESCE((
                        SELECT jsonb_agg(ab.area_id)
                        FROM public.area_buildings ab
                        JOIN public.areas a ON a.id = ab.area_id
                        WHERE ab.building_id = b.id AND a.deleted_at IS NULL
                      ), '[]'::jsonb),
      'district',     b.district,
      'ward',         b.ward,
      'address',      CASE
                        WHEN b.street_address IS NOT NULL AND b.street_address LIKE '%,%'
                          THEN b.street_address
                        ELSE concat_ws(', ',
                               NULLIF(b.street_address, ''),
                               NULLIF(b.ward, ''),
                               NULLIF(b.district, ''),
                               NULLIF(b.province, ''))
                      END,
      'total_floors', b.total_floors,
      'floor_layouts', b.floor_layouts,
      'images',        COALESCE(b.images, '[]'::jsonb),
      'public_contact_name',  b.public_contact_name,
      'public_contact_phone', b.public_contact_phone,
      'public_map_url',       b.public_map_url,
      'public_lift_type',     b.public_lift_type,
      'elec_rate', (
        SELECT COALESCE(bs.unit_price_override, s.unit_price)
        FROM public.building_services bs
        JOIN public.services s ON s.id = bs.service_id
        WHERE bs.building_id = b.id
          AND bs.is_active = true
          AND s.deleted_at IS NULL
          AND s.unit ILIKE 'kwh'
        ORDER BY (s.type = 'FIXED') DESC, s.unit_price
        LIMIT 1
      )
    ) ORDER BY b.name) AS j
    FROM public.buildings b
    WHERE b.id IN (SELECT building_id FROM bld_ids)
  ),
  areas_j AS (
    SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) ORDER BY a.name) AS j
    FROM public.areas a
    WHERE a.user_id = v_owner AND a.deleted_at IS NULL
  ),
  contact_j AS (
    SELECT jsonb_build_object('name', h.name, 'phone', h.phone_number) AS j
    FROM public.hotlines h
    WHERE h.user_id = v_owner
      AND COALESCE(h.is_active, true) = true
      AND (v_hotline IS NULL OR h.id = v_hotline)
    ORDER BY (h.id = v_hotline) DESC NULLS LAST, h.created_at
    LIMIT 1
  )
  SELECT jsonb_build_object(
    'areas',     COALESCE((SELECT j FROM areas_j), '[]'::jsonb),
    'buildings', COALESCE((SELECT j FROM blds_j), '[]'::jsonb),
    'rooms',     COALESCE((SELECT j FROM rooms_j), '[]'::jsonb),
    'contact',   (SELECT j FROM contact_j),
    'sale_policy', NULLIF(btrim(v_sale_policy), '')
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

-- ── 5. RPC lock tạm ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.lock_room_for_sale_v1(p_organization_id uuid,p_room_id uuid,p_hours integer,p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
DECLARE r public.rooms%ROWTYPE;l public.room_sale_locks%ROWTYPE;v_owner uuid;v_soon integer;v_pass boolean;v_fact record;
  v_note text:=NULLIF(btrim(COALESCE(p_note,'')),'');v_at timestamptz;
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Chưa chọn tổ chức được phép' USING ERRCODE='42501';END IF;
  IF p_hours IS NULL OR p_hours NOT IN (6,12,24) THEN RAISE EXCEPTION 'Chỉ lock tạm 6, 12 hoặc 24 giờ' USING ERRCODE='22023';END IF;
  IF char_length(v_note)>300 THEN RAISE EXCEPTION 'Ghi chú lock tạm tối đa 300 ký tự' USING ERRCODE='22023';END IF;
  -- Cùng thứ tự khoá với create_room_reservation_v1: dòng phòng trước, tổ chức sau.
  SELECT * INTO r FROM public.rooms WHERE id=p_room_id AND organization_id=p_organization_id AND deleted_at IS NULL FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy phòng trong tổ chức' USING ERRCODE='42501';END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  IF NOT app_private.authorize_room_sale_lock_v1(p_organization_id,r.building_id,'sale_phong.lock_room') THEN
    RAISE EXCEPTION 'Không có quyền lock tạm phòng ở tòa này' USING ERRCODE='42501';END IF;
  v_at:=clock_timestamp();
  UPDATE public.room_sale_locks SET released_at=expires_at,release_reason='EXPIRED'
   WHERE organization_id=p_organization_id AND room_id=r.id AND released_at IS NULL AND expires_at<=v_at;
  SELECT * INTO l FROM public.room_sale_locks WHERE organization_id=p_organization_id AND room_id=r.id AND released_at IS NULL FOR UPDATE;
  IF FOUND THEN
    -- Bấm lại đúng nội dung ngay sau khi đã lưu (mạng chập chờn) ⇒ trả lại lock đó, không báo lỗi giả.
    IF l.locked_by=auth.uid() AND l.hours=p_hours AND l.note IS NOT DISTINCT FROM v_note AND l.locked_at>v_at-interval '2 minutes' THEN
      RETURN app_private.room_sale_lock_response_v1(l.id);END IF;
    RAISE EXCEPTION 'Phòng đang được lock tạm. Tải lại danh sách.' USING ERRCODE='55000';
  END IF;
  -- Chỉ phòng đang hiện trên danh sách bán (trống hoặc sắp trống) mới lock được.
  SELECT b.user_id INTO v_owner FROM public.buildings b WHERE b.id=r.building_id;
  SELECT s.soon_days INTO v_soon FROM public.public_room_settings s WHERE s.owner_id=v_owner LIMIT 1;
  SELECT EXISTS(SELECT 1 FROM public.room_pass_listings pl WHERE pl.room_id=r.id AND pl.user_id=v_owner AND pl.active) INTO v_pass;
  SELECT * INTO v_fact FROM app_private.room_sale_workflow_fact_v1(r.id,p_organization_id,r.status::text,COALESCE(v_pass,false),COALESCE(v_soon,30));
  IF COALESCE(v_fact.status_public,'') NOT IN ('free','soon') THEN
    RAISE EXCEPTION 'Phòng không còn trên danh sách bán (đã cọc, đang giữ chỗ hoặc đang có khách ở)' USING ERRCODE='55000';END IF;
  INSERT INTO public.room_sale_locks(organization_id,building_id,room_id,hours,note,locked_by,locked_at,expires_at)
  VALUES(p_organization_id,r.building_id,r.id,p_hours,v_note,auth.uid(),v_at,v_at+make_interval(hours=>p_hours)) RETURNING * INTO l;
  RETURN app_private.room_sale_lock_response_v1(l.id);
END;
$function$;

-- Người đã lock (còn quyền lock) hoặc người được tạo cọc ở tòa gỡ được. Gỡ lại lock đã đóng trả về
-- trạng thái hiện tại, không báo lỗi.
CREATE OR REPLACE FUNCTION public.release_room_sale_lock_v1(p_organization_id uuid,p_lock_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
DECLARE l public.room_sale_locks%ROWTYPE;v_at timestamptz;
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Chưa chọn tổ chức được phép' USING ERRCODE='42501';END IF;
  SELECT * INTO l FROM public.room_sale_locks WHERE id=p_lock_id AND organization_id=p_organization_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy lock tạm trong tổ chức' USING ERRCODE='42501';END IF;
  PERFORM 1 FROM public.rooms WHERE id=l.room_id FOR NO KEY UPDATE;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  IF NOT((l.locked_by=auth.uid() AND app_private.authorize_room_sale_lock_v1(p_organization_id,l.building_id,'sale_phong.lock_room'))
     OR app_private.authorize_room_sale_lock_v1(p_organization_id,l.building_id,'deposits.create')) THEN
    RAISE EXCEPTION 'Chỉ người đã lock hoặc người được tạo cọc ở tòa này mới gỡ được lock' USING ERRCODE='42501';END IF;
  SELECT * INTO l FROM public.room_sale_locks WHERE id=p_lock_id FOR UPDATE;
  v_at:=clock_timestamp();
  IF l.released_at IS NULL AND l.expires_at<=v_at THEN
    UPDATE public.room_sale_locks SET released_at=expires_at,release_reason='EXPIRED' WHERE id=l.id;
  ELSIF l.released_at IS NULL THEN
    UPDATE public.room_sale_locks SET released_at=v_at,released_by=auth.uid(),release_reason='MANUAL' WHERE id=l.id;
  END IF;
  RETURN app_private.room_sale_lock_response_v1(l.id);
END;
$function$;

-- Lock còn hạn cho Quản lý cọc: ai xem cọc hoặc được lock ở tòa thì thấy. Chỉ liệt kê phòng bị ẩn
-- CHỈ vì lock (sale fact gốc còn trống/sắp trống) — phòng đã cọc/ký theo đường khác không còn "chờ tạo phiếu".
CREATE OR REPLACE FUNCTION public.list_room_sale_locks_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false)
    OR (public.is_super_admin() AND COALESCE(p_organization_id=ANY(public.sandbox_org_ids()),false)) THEN
    RAISE EXCEPTION 'Không có quyền đọc lock tạm trong tổ chức' USING ERRCODE='42501';END IF;
  RETURN jsonb_build_object('server_now',now(),'locks',COALESCE((
    SELECT jsonb_agg(app_private.room_sale_lock_response_v1(l.id) ORDER BY l.expires_at,l.id)
    FROM public.room_sale_locks l
    JOIN public.rooms rm ON rm.id=l.room_id
    JOIN public.buildings b ON b.id=l.building_id
    WHERE l.organization_id=p_organization_id AND l.released_at IS NULL AND l.expires_at>now()
      AND public.can_access_building(l.building_id)
      AND (public.can_do_on_building('deposits','view',l.building_id) OR public.can_do_on_building('sale_phong','lock_room',l.building_id))
      AND EXISTS(SELECT 1 FROM app_private.room_sale_workflow_base_fact_v1(l.room_id,l.organization_id,rm.status::text,
        EXISTS(SELECT 1 FROM public.room_pass_listings pl WHERE pl.room_id=l.room_id AND pl.user_id=b.user_id AND pl.active),
        COALESCE((SELECT s.soon_days FROM public.public_room_settings s WHERE s.owner_id=b.user_id LIMIT 1),30)) f
        WHERE f.status_public IN ('free','soon'))
  ),'[]'::jsonb));
END;
$function$;

-- ── 6. Giữ chỗ: phản hồi, phiếu nguồn, tạo, kiểm ký ─────────────────
CREATE OR REPLACE FUNCTION app_private.room_reservation_response_v1(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
 SELECT jsonb_build_object('id',r.id,'organization_id',r.organization_id,'building_id',r.building_id,'room_id',r.room_id,'customer_id',r.customer_id,
 'customer_name',COALESCE(c.full_name,r.customer_hint),'customer_phone',c.phone,'customer_hint',r.customer_hint,'building_name',b.name,'room_name',rm.name,'status',r.status,'claim_status',cl.status,'revision',r.revision,
 'hold_until',r.hold_until,'intended_move_in_on',r.intended_move_in_on,'topup_due_on',r.topup_due_on,'deposit_target',r.deposit_target,'notes',r.notes,
 'converted_contract_id',r.converted_contract_id,'overdue',r.status='HOLD' AND COALESCE(r.hold_until<public.org_today_v1(r.organization_id),false),
 'received_amount',COALESCE((SELECT sum(p.amount) FROM app_private.reservation_receipt_projection_v1(r.id) p WHERE p.received),0),
 'source_voucher_ids',COALESCE((SELECT jsonb_agg(v ORDER BY v) FROM(SELECT DISTINCT p.source_voucher_id v FROM app_private.reservation_receipt_projection_v1(r.id) p WHERE p.received) s),'[]'::jsonb),
 'receipts',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.source_voucher_id,p.source_item_id) FROM app_private.reservation_receipt_projection_v1(r.id) p),'[]'::jsonb),
 'created_at',r.created_at,'updated_at',r.updated_at,'history',COALESCE((SELECT jsonb_agg(jsonb_build_object('revision',h.revision,'action',h.action,'changed_by',h.actor_id,'changed_at',h.changed_at) ORDER BY h.revision) FROM app_private.room_reservation_history h WHERE h.reservation_id=r.id),'[]'::jsonb))
 FROM public.room_reservations r JOIN public.room_next_claims cl ON cl.reservation_id=r.id LEFT JOIN public.customers c ON c.id=r.customer_id
 JOIN public.rooms rm ON rm.id=r.room_id JOIN public.buildings b ON b.id=r.building_id WHERE r.id=p_id
$fn$;

CREATE OR REPLACE FUNCTION app_private.create_reservation_source_receipt_v1(p_reservation uuid,p_receipt jsonb,p_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE r public.room_reservations%ROWTYPE;v public.income_expenses%ROWTYPE;type_id uuid;account_id uuid;amt numeric;day date;items jsonb;customer_name text;result jsonb;
 error_code text;error_message text;voucher_notes text;
BEGIN
 IF jsonb_typeof(p_receipt) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_receipt) k WHERE k NOT IN ('amount','account_id','voucher_date','name','description','attachments'))
  OR jsonb_typeof(p_receipt->'amount') IS DISTINCT FROM 'number' OR jsonb_typeof(COALESCE(p_receipt->'attachments','[]'::jsonb))<>'array' THEN RAISE EXCEPTION 'Invalid positive deposit receipt' USING ERRCODE='22023';END IF;
 amt:=(p_receipt->>'amount')::numeric;day:=(p_receipt->>'voucher_date')::date;account_id:=NULLIF(p_receipt->>'account_id','')::uuid;
 IF amt IS NULL OR amt<=0 OR amt>9007199254740991 OR amt<>trunc(amt) OR amt::text IN ('NaN','Infinity','-Infinity') OR day IS NULL THEN
  RAISE EXCEPTION 'Cọc phải là số tiền VND dương thực tế; giữ chỗ 0 đồng không tạo phiếu' USING ERRCODE='22023';END IF;
 SELECT * INTO STRICT r FROM public.room_reservations WHERE id=p_reservation;
 SELECT full_name INTO customer_name FROM public.customers WHERE id=r.customer_id AND organization_id=r.organization_id;
 -- 10/10: chưa có khách trong danh bạ ⇒ người nộp là tên gợi nhớ (hoàn cọc đọc payer_name),
 -- và ô ghi chú phiếu nhắc phải gắn khách trước khi ký.
 IF r.customer_id IS NULL THEN
  customer_name:=r.customer_hint;
  voucher_notes:='Khách gợi nhớ lúc nhận cọc: '||r.customer_hint||'. Hồ sơ giữ chỗ phải gắn khách trong danh bạ trước khi ký hợp đồng.';
 END IF;
 IF account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.accounts WHERE id=account_id AND organization_id=r.organization_id AND deleted_at IS NULL) THEN RAISE EXCEPTION 'Sổ quỹ không thuộc tổ chức' USING ERRCODE='42501';END IF;
 SELECT id INTO type_id FROM public.income_expense_types WHERE organization_id=r.organization_id AND lower(type)='income' AND is_deposit ORDER BY id LIMIT 1;
 IF type_id IS NULL THEN RAISE EXCEPTION 'Tổ chức chưa có hạng mục thu cọc hiện hành' USING ERRCODE='55000';END IF;
 items:=jsonb_build_array(jsonb_build_object('income_expense_type_id',type_id,'description',p_receipt->>'description','quantity',1,'unit_price',amt,'start_date',day,'end_date',day));
 -- Exact current frontend canonical/fallback dispatch, including the two
 -- existing cashbook fallback messages. All other denial/conflict errors rise.
 BEGIN
  v:=public.create_income_expense_v1('INCOME',COALESCE(NULLIF(btrim(p_receipt->>'name'),''),'Cọc giữ chỗ'),r.building_id,r.room_id,NULL,NULL,customer_name,NULL,NULL,account_id,
    COALESCE(p_receipt->'attachments','[]'::jsonb),NULL,voucher_notes,day,items,p_key);
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS error_code=RETURNED_SQLSTATE,error_message=MESSAGE_TEXT;
  IF NOT(error_code='0A000' OR (error_code='55000' AND position('chưa bật' IN error_message)>0)
   OR (error_code='42501' AND error_message ~ '(Không có quyền sử dụng sổ quỹ này|Quyền sử dụng sổ quỹ đã bị thu hồi)')) THEN RAISE;END IF;
  result:=public.ie_compat_insert_v2(jsonb_build_object('type','INCOME','name',COALESCE(NULLIF(btrim(p_receipt->>'name'),''),'Cọc giữ chỗ'),
   'building_id',r.building_id,'room_id',r.room_id,'tenant_id',NULL,'contract_id',NULL,'payer_name',customer_name,'account_id',account_id,'attachments',COALESCE(p_receipt->'attachments','[]'::jsonb),
   'voucher_date',day,'business_result_accounting',NULL,'repeat_cycle','NONE','repeat_infinity',false,'repeat_count',0,'notes',voucher_notes),
   jsonb_build_array((items->0)||jsonb_build_object('accounting_class','DEPOSIT')));
  SELECT * INTO v FROM public.income_expenses WHERE id=(result->>'id')::uuid;
 END;
 IF v.id IS NULL THEN RAISE EXCEPTION 'Writer cọc không trả phiếu nguồn' USING ERRCODE='55000';END IF;
 PERFORM app_private.bind_reservation_source_voucher_v1(r.id,v.id);RETURN v.id;
END $fn$;

CREATE OR REPLACE FUNCTION public.create_room_reservation_v1(p_organization_id uuid,p_idempotency_key text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE r public.rooms%ROWTYPE;res public.room_reservations%ROWTYPE;cust uuid;hint text;rid uuid;hash text;response jsonb;ids uuid[];v uuid;
BEGIN
 IF p_organization_id IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Chưa chọn tổ chức được phép' USING ERRCODE='42501';END IF;
 IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('room_id','customer_id','customer_hint','hold_until','intended_move_in_on','topup_due_on','deposit_target','notes','receipt','existing_voucher_ids')) THEN RAISE EXCEPTION 'Invalid reservation intent' USING ERRCODE='22023';END IF;
 SELECT * INTO r FROM public.rooms WHERE id=(p_payload->>'room_id')::uuid AND organization_id=p_organization_id AND deleted_at IS NULL FOR NO KEY UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy phòng trong tổ chức' USING ERRCODE='42501';END IF;
 PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
 PERFORM app_private.authorize_room_reservation_writer_v1(p_organization_id,r.building_id,'deposits.create');
 -- 10/10: khách trong danh bạ HOẶC tên gợi nhớ (chỉ khi có tiền, kiểm ở dưới). Thiếu cả hai
 -- vẫn rơi vào đúng lỗi cũ "Phải chọn khách cụ thể".
 cust:=NULLIF(p_payload->>'customer_id','')::uuid;hint:=NULLIF(btrim(COALESCE(p_payload->>'customer_hint','')),'');
 IF cust IS NOT NULL AND hint IS NOT NULL THEN RAISE EXCEPTION 'Chọn khách trong danh bạ hoặc gõ tên gợi nhớ, không cả hai' USING ERRCODE='22023';END IF;
 IF cust IS NOT NULL OR hint IS NULL THEN
  PERFORM 1 FROM public.customers WHERE id=cust AND organization_id=p_organization_id AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Phải chọn khách cụ thể trong tổ chức' USING ERRCODE='42501';END IF;
 ELSIF char_length(hint)>120 THEN RAISE EXCEPTION 'Tên khách gợi nhớ tối đa 120 ký tự' USING ERRCODE='22023';END IF;
 hash:=md5(p_payload::text);
 SELECT * INTO res FROM public.room_reservations WHERE organization_id=p_organization_id AND created_by=auth.uid() AND idempotency_key=p_idempotency_key FOR UPDATE;
 IF FOUND THEN IF res.payload_hash<>hash THEN RAISE EXCEPTION 'Khóa giữ chỗ đã dùng cho nội dung khác' USING ERRCODE='23505';END IF;RETURN res.initial_response;END IF;
 IF EXISTS(SELECT 1 FROM public.room_next_claims WHERE organization_id=p_organization_id AND room_id=r.id AND status='LIVE') THEN RAISE EXCEPTION 'Phòng đã có khách giữ chỗ tiếp theo' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT 1 FROM public.contracts WHERE organization_id=p_organization_id AND room_id=r.id AND deleted_at IS NULL AND status IN ('ACTIVE','EXTENDED')) THEN
  IF r.status NOT IN ('AVAILABLE','RESERVED','OCCUPIED') OR (p_payload->>'intended_move_in_on')::date IS NULL
   OR (SELECT count(*) FROM public.contracts WHERE organization_id=p_organization_id AND room_id=r.id AND deleted_at IS NULL AND status IN ('ACTIVE','EXTENDED'))<>1
   OR EXISTS(SELECT 1 FROM public.contracts c WHERE c.organization_id=p_organization_id AND c.room_id=r.id AND c.deleted_at IS NULL AND c.status IN ('ACTIVE','EXTENDED')
    AND (c.expected_move_out_date IS NULL OR c.actual_end_date IS NOT NULL OR (p_payload->>'intended_move_in_on')::date<c.expected_move_out_date)) THEN
   RAISE EXCEPTION 'Phòng đang có khách: cần báo trả rõ ràng và ngày dự kiến vào từ ngày báo trả trở đi' USING ERRCODE='55000';END IF;
 ELSE
  IF r.status NOT IN ('AVAILABLE','RESERVED') THEN RAISE EXCEPTION 'Phòng chưa sẵn sàng để giữ chỗ' USING ERRCODE='55000';END IF;
 END IF;
 IF jsonb_typeof(COALESCE(p_payload->'existing_voucher_ids','[]'::jsonb))<>'array' THEN RAISE EXCEPTION 'Invalid source voucher IDs' USING ERRCODE='22023';END IF;
 SELECT COALESCE(array_agg((value#>>'{}')::uuid),'{}'::uuid[]) INTO ids FROM jsonb_array_elements(COALESCE(p_payload->'existing_voucher_ids','[]'::jsonb));
 IF cardinality(ids)<>(SELECT count(DISTINCT x) FROM unnest(ids) x) THEN RAISE EXCEPTION 'Duplicate source voucher IDs' USING ERRCODE='22023';END IF;
 IF cust IS NULL AND NOT(p_payload?'receipt') AND cardinality(ids)=0 THEN
  RAISE EXCEPTION 'Tên khách gợi nhớ chỉ dùng cho phiếu cọc có tiền. Giữ phòng không thu tiền thì dùng Lock tạm.' USING ERRCODE='22023';END IF;
 IF NOT(p_payload?'receipt') AND cardinality(ids)=0 AND NULLIF(p_payload->>'hold_until','') IS NULL THEN
  RAISE EXCEPTION 'Giữ chỗ chưa nhận tiền phải chọn hạn giữ chỗ' USING ERRCODE='22023';END IF;
 PERFORM app_private.assert_room_reservation_legacy_sources_v1(p_organization_id,r.id,ids);
 INSERT INTO public.room_reservations(organization_id,building_id,room_id,customer_id,customer_hint,hold_until,intended_move_in_on,topup_due_on,deposit_target,notes,created_by,idempotency_key,payload_hash)
 VALUES(p_organization_id,r.building_id,r.id,cust,CASE WHEN cust IS NULL THEN hint END,(p_payload->>'hold_until')::date,(p_payload->>'intended_move_in_on')::date,(p_payload->>'topup_due_on')::date,(p_payload->>'deposit_target')::numeric,p_payload->>'notes',auth.uid(),p_idempotency_key,hash) RETURNING id INTO rid;
 INSERT INTO public.room_next_claims(organization_id,room_id,reservation_id) VALUES(p_organization_id,r.id,rid);
 FOREACH v IN ARRAY ids LOOP PERFORM app_private.bind_reservation_source_voucher_v1(rid,v);END LOOP;
 IF p_payload ? 'receipt' THEN PERFORM app_private.create_reservation_source_receipt_v1(rid,p_payload->'receipt','res-deposit-'||rid::text);END IF;
 -- 10/10: lock tạm của phòng (nếu có) nhường chỗ cho giữ chỗ thật trong cùng giao dịch.
 UPDATE public.room_sale_locks SET released_at=expires_at,release_reason='EXPIRED'
  WHERE organization_id=p_organization_id AND room_id=r.id AND released_at IS NULL AND expires_at<=clock_timestamp();
 UPDATE public.room_sale_locks SET released_at=clock_timestamp(),released_by=auth.uid(),release_reason='RESERVED',reservation_id=rid
  WHERE organization_id=p_organization_id AND room_id=r.id AND released_at IS NULL;
 response:=app_private.room_reservation_response_v1(rid);
 INSERT INTO app_private.room_reservation_history(reservation_id,revision,action,actor_id,idempotency_key,payload_hash,response) VALUES(rid,1,'CREATE',auth.uid(),p_idempotency_key,hash,response);
 response:=app_private.room_reservation_response_v1(rid);UPDATE public.room_reservations SET initial_response=response WHERE id=rid;RETURN response;
END $fn$;

CREATE OR REPLACE FUNCTION app_private.assert_room_next_claim_for_signing_v1(p_org uuid,p_room uuid,p_reservation uuid,p_expected_revision bigint,p_customer_ids uuid[],p_voucher_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE roomrow public.rooms%ROWTYPE;r public.room_reservations%ROWTYPE;expected uuid[];provided uuid[];
BEGIN
 SELECT * INTO roomrow FROM public.rooms WHERE id=p_room AND organization_id=p_org AND deleted_at IS NULL FOR NO KEY UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Phòng ký không thuộc tổ chức' USING ERRCODE='42501';END IF;
 PERFORM app_private.lock_org_for_decision_v1(p_org);
 PERFORM app_private.authorize_room_reservation_writer_v1(p_org,roomrow.building_id,'contracts.create');
 SELECT r0.* INTO r FROM public.room_next_claims c JOIN public.room_reservations r0 ON r0.id=c.reservation_id WHERE c.organization_id=p_org AND c.room_id=p_room AND c.status='LIVE' FOR UPDATE OF c,r0;
 IF NOT FOUND THEN
  IF p_reservation IS NOT NULL THEN RAISE EXCEPTION 'Claim giữ chỗ không còn hiệu lực' USING ERRCODE='55000';END IF;
  PERFORM app_private.assert_room_reservation_legacy_sources_v1(p_org,p_room,COALESCE(p_voucher_ids,'{}'::uuid[]));RETURN;
 END IF;
 -- 10/10: giữ chỗ chỉ có tên gợi nhớ chưa ký được; báo đúng việc cần làm thay cho "khách không khớp".
 IF r.customer_id IS NULL THEN RAISE EXCEPTION 'Giữ chỗ mới có tên khách gợi nhớ, chưa gắn khách trong danh bạ. Gắn khách ở Quản lý cọc trước khi ký.' USING ERRCODE='55000';END IF;
 IF p_reservation IS NULL OR r.id<>p_reservation THEN RAISE EXCEPTION 'Phải chọn đúng khách đang giữ chỗ phòng này' USING ERRCODE='55000';END IF;
 IF p_expected_revision IS NULL OR r.revision<>p_expected_revision THEN RAISE EXCEPTION 'Claim giữ chỗ đã thay đổi' USING ERRCODE='PT409';END IF;
 IF r.status<>'HOLD' OR NOT COALESCE(r.customer_id=ANY(p_customer_ids),false) THEN RAISE EXCEPTION 'Khách ký không khớp khách giữ chỗ' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.income_expenses v WHERE v.id IN(SELECT source_voucher_id FROM public.reservation_receipts WHERE reservation_id=r.id) ORDER BY v.id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM app_private.reservation_receipt_projection_v1(r.id) p WHERE NOT p.released AND NOT p.received) THEN RAISE EXCEPTION 'Cọc giữ chỗ còn chờ duyệt/chưa nhận. Xử lý nguồn hiện tại trước khi ký.' USING ERRCODE='55000';END IF;
 SELECT COALESCE(array_agg(DISTINCT p.source_voucher_id ORDER BY p.source_voucher_id),'{}'::uuid[]) INTO expected FROM app_private.reservation_receipt_projection_v1(r.id) p WHERE p.received;
 SELECT COALESCE(array_agg(DISTINCT x ORDER BY x),'{}'::uuid[]) INTO provided FROM unnest(COALESCE(p_voucher_ids,'{}'::uuid[])) x;
 IF cardinality(provided)<>cardinality(COALESCE(p_voucher_ids,'{}'::uuid[])) OR provided<>expected THEN RAISE EXCEPTION 'Nguồn cọc ký phải khớp đúng hồ sơ giữ chỗ' USING ERRCODE='55000';END IF;
 PERFORM app_private.assert_room_reservation_legacy_sources_v1(p_org,p_room,expected);
END $fn$;

-- ── 7. Gắn khách thật cho giữ chỗ chỉ có tên gợi nhớ ────────────────
-- Cùng khuôn update_room_reservation_v1: phòng → tổ chức → quyền; revision chống ghi đè;
-- khoá idempotency theo lịch sử (bất biến). Phiếu nguồn giữ nguyên người nộp đã ghi.
CREATE OR REPLACE FUNCTION public.assign_room_reservation_customer_v1(p_organization_id uuid,p_reservation_id uuid,p_expected_revision bigint,p_customer_id uuid,p_idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $function$
DECLARE r public.room_reservations%ROWTYPE;h app_private.room_reservation_history%ROWTYPE;hash text;response jsonb;changed_at timestamptz:=clock_timestamp();
BEGIN
  IF p_organization_id IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Chưa chọn tổ chức được phép' USING ERRCODE='42501';END IF;
  IF p_reservation_id IS NULL OR p_customer_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision<1
    OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN RAISE EXCEPTION 'Invalid reservation change' USING ERRCODE='22023';END IF;
  SELECT * INTO r FROM public.room_reservations WHERE id=p_reservation_id AND organization_id=p_organization_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy giữ chỗ trong tổ chức' USING ERRCODE='42501';END IF;
  PERFORM app_private.assert_room_reservation_scope_v1(p_organization_id,r.building_id,'deposits.edit');
  PERFORM 1 FROM public.rooms WHERE id=r.room_id FOR NO KEY UPDATE;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  PERFORM app_private.authorize_room_reservation_writer_v1(p_organization_id,r.building_id,'deposits.edit');
  SELECT * INTO r FROM public.room_reservations WHERE id=p_reservation_id FOR UPDATE;
  hash:=md5(jsonb_build_object('revision',p_expected_revision,'action','ASSIGN_CUSTOMER','customer_id',p_customer_id)::text);
  SELECT * INTO h FROM app_private.room_reservation_history WHERE reservation_id=r.id AND actor_id=auth.uid() AND idempotency_key=p_idempotency_key;
  IF FOUND THEN IF h.payload_hash<>hash THEN RAISE EXCEPTION 'Khóa sửa giữ chỗ đã dùng với nội dung khác' USING ERRCODE='23505';END IF;RETURN h.response;END IF;
  IF r.revision<>p_expected_revision THEN RAISE EXCEPTION 'Giữ chỗ đã thay đổi' USING ERRCODE='PT409';END IF;
  IF r.status<>'HOLD' OR NOT EXISTS(SELECT 1 FROM public.room_next_claims WHERE reservation_id=r.id AND status='LIVE') THEN RAISE EXCEPTION 'Giữ chỗ đã được xử lý' USING ERRCODE='55000';END IF;
  IF r.customer_id IS NOT NULL THEN RAISE EXCEPTION 'Giữ chỗ đã gắn khách trong danh bạ' USING ERRCODE='55000';END IF;
  PERFORM 1 FROM public.customers WHERE id=p_customer_id AND organization_id=p_organization_id AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Phải chọn khách cụ thể trong tổ chức' USING ERRCODE='42501';END IF;
  UPDATE public.room_reservations SET customer_id=p_customer_id,revision=revision+1,updated_at=clock_timestamp() WHERE id=r.id;
  response:=app_private.room_reservation_response_v1(r.id);
  response:=jsonb_set(response,'{history}',(response->'history')||jsonb_build_array(jsonb_build_object('revision',r.revision+1,'action','ASSIGN_CUSTOMER','changed_by',auth.uid(),'changed_at',changed_at)));
  INSERT INTO app_private.room_reservation_history(reservation_id,revision,action,actor_id,idempotency_key,payload_hash,response,changed_at)
  VALUES(r.id,r.revision+1,'ASSIGN_CUSTOMER',auth.uid(),p_idempotency_key,hash,response,changed_at);
  RETURN response;
END;
$function$;

-- ── 8. ACL hàm mới (hàm cũ giữ ACL qua CREATE OR REPLACE) ───────────
REVOKE ALL ON FUNCTION public.lock_room_for_sale_v1(uuid,uuid,integer,text),public.release_room_sale_lock_v1(uuid,uuid),
  public.list_room_sale_locks_v1(uuid),public.assign_room_reservation_customer_v1(uuid,uuid,bigint,uuid,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.lock_room_for_sale_v1(uuid,uuid,integer,text),public.release_room_sale_lock_v1(uuid,uuid),
  public.list_room_sale_locks_v1(uuid),public.assign_room_reservation_customer_v1(uuid,uuid,bigint,uuid,text) TO authenticated;

-- ── 9. Tự kiểm trước khi commit ─────────────────────────────────────
DO $assert$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.permission_definitions WHERE key='sale_phong.lock_room' AND permission_domain='TENANT' AND is_active) THEN
    RAISE EXCEPTION 'Thiếu khoá sale_phong.lock_room — authorize_tenant_action_v3 sẽ fail-closed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.room_reservations'::regclass AND attname='customer_id' AND attnotnull) THEN
    RAISE EXCEPTION 'room_reservations.customer_id vẫn NOT NULL';
  END IF;
  IF position('room_sale_lock_open_id_v1' IN pg_get_functiondef('app_private.room_sale_workflow_fact_v1(uuid,uuid,text,boolean,integer)'::regprocedure))=0 THEN
    RAISE EXCEPTION 'Sale fact chưa đọc lock tạm';
  END IF;
  IF has_function_privilege('anon','public.lock_room_for_sale_v1(uuid,uuid,integer,text)','EXECUTE')
    OR has_function_privilege('anon','public.assign_room_reservation_customer_v1(uuid,uuid,bigint,uuid,text)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.room_sale_workflow_base_fact_v1(uuid,uuid,text,boolean,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'ACL hàm lock/gắn khách mở quá rộng';
  END IF;
END
$assert$;

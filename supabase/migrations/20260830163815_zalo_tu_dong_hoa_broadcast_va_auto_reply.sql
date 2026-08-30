-- =============================================================================
-- Chat Zalo — TỰ ĐỘNG HOÁ: broadcast phòng trống định kỳ + auto-reply cho sale.
--
-- Bảng `zalo_automations` đã tồn tại từ 20260626000001 với đúng hai `kind`
-- (`broadcast_vacant`, `auto_reply`) và đã org-scoped ở 20260813100000, nhưng
-- tới nay nó CHỈ là công tắc: `zalo_toggle_automation` lật mỗi cột `enabled`,
-- còn `config`/`stats` chưa ai ghi và KHÔNG có tiến trình nào đọc `enabled`.
-- Tab "Tự động hoá" trên web hiển thị lịch/từ khoá hard-code. Migration này cấp
-- phần schema còn thiếu để worker zca-js thành engine thật:
--
--   1. `zalo_conversations.is_sale_partner` — đánh dấu THỦ CÔNG hội thoại nào là
--      sale/môi giới. Đây là cái van an toàn của cả hai tính năng: broadcast chỉ
--      bắn vào hội thoại được chọn, auto-reply chỉ trả lời hội thoại có cờ này.
--      CỐ Ý không suy tự động từ `kind`/nhãn: đoán sai nghĩa là bắn bảng giá vào
--      mặt một khách đang khiếu nại.
--
--   2. `zalo_automation_runs` — nhật ký mỗi lần engine chạy, kể cả lần quyết định
--      KHÔNG gửi. Nó phục vụ ba việc, không phải chỉ để xem cho vui:
--        • người dùng thấy máy còn sống (worker rớt phiên QR thì automation chết
--          IM LẶNG — không có nhật ký thì không ai biết);
--        • worker tra cooldown auto-reply theo hội thoại (cột conversation_id);
--        • worker đếm trần tin/ngày.
--      Chỉ service_role ghi. Người dùng chỉ ĐỌC — nhật ký sửa được là nhật ký vô giá trị.
--
--   3. `zalo_luu_tu_dong_hoa` — RPC ghi cả `enabled` LẪN `config`.
--      KHÔNG sửa `zalo_toggle_automation` (thêm tham số buộc phải DROP rồi
--      CREATE, mà bản cũ đang được web gọi) — thêm RPC mới cạnh nó.
--
--   4. `zalo_danh_dau_sale` — bật/tắt cờ ở (1). Đòi quyền `manage_automation`
--      chứ không phải `send`: gắn cờ = thêm người vào danh sách nhận tin tự
--      động, đó là hành vi quản trị chứ không phải thao tác chat thường ngày.
--
--   5. `zalo_phong_trong_cho_worker_v1` — nguồn dữ liệu phòng trống CHO WORKER.
--      Vì sao phải có RPC riêng: `copilot_available_rooms_v1` gọi
--      `copilot_org_scope_buildings_v1`, hàm này `RAISE not_permitted` khi
--      `auth.uid() IS NULL`; `get_my_available_rooms` cũng đòi `auth.uid()`.
--      Worker chạy bằng service-role KHÔNG có JWT người dùng nên cả hai đều
--      không gọi được. Hàm này scope theo `organization_id` (đúng ranh giới của
--      broadcast: tin là của CÔNG TY) thay vì theo quyền một cá nhân — đo thật
--      trên production: một org có 19 toà thuộc 2 owner khác nhau, nên scope
--      theo owner như bản public sẽ thiếu toà.
--      KHÔNG trả `sale_bonus_note`: đó là tiền thưởng sale, dữ liệu NỘI BỘ. Tin
--      broadcast đi vào group Zalo hàng chục người — thứ gì không được ra khỏi
--      công ty thì không đưa vào payload, chứ không dựa vào tầng trên nhớ lọc.
--
-- ⚠️ THỨ TỰ TRIỂN KHAI — MIGRATION TRƯỚC, DEPLOY WEB SAU.
--    `useZaloChat.ts` đưa `is_sale_partner` vào hằng CONV_COLS, tức truy vấn
--    danh sách hội thoại của trang /chat-zalo sẽ SELECT cột này. Deploy web khi
--    cột chưa tồn tại thì PostgREST trả `42703: column "is_sale_partner" does
--    not exist` và TOÀN BỘ danh sách hội thoại trống — không phải hỏng riêng
--    tính năng mới, mà hỏng cả màn chat đang chạy. Đã đo bằng truy vấn thật
--    trên production 31/08/2026.
--
-- Idempotent. Chạy SAU 20260813140000. Khối nghiệm thu chỉ soi catalog nên chạy
-- được trên database RỖNG (CI "Migration Restore Drill" replay lên baseline
-- schema-only — smoke đòi dữ liệu thật sẽ làm cuộn cả file, mất luôn object).
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. Cờ "hội thoại này là sale/môi giới"
-- ---------------------------------------------------------------------------
ALTER TABLE public.zalo_conversations
  ADD COLUMN IF NOT EXISTS is_sale_partner boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.zalo_conversations.is_sale_partner IS
  'Bật THỦ CÔNG: hội thoại này là sale/môi giới. Điều kiện CẦN để nhận broadcast phòng trống và để auto-reply trả lời. Không suy tự động từ kind/nhãn — đoán sai là bắn bảng giá vào khách đang khiếu nại.';

-- Engine quét "ai nhận broadcast" theo org → index đúng vệt truy vấn đó.
CREATE INDEX IF NOT EXISTS zalo_conversations_sale_partner_idx
  ON public.zalo_conversations(organization_id)
  WHERE is_sale_partner;

-- ---------------------------------------------------------------------------
-- 2. Nhật ký chạy tự động hoá
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.zalo_automation_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  -- Nullable + SET NULL: nhật ký phải sống lâu hơn tài khoản Zalo đã gỡ. Nhưng
  -- lúc INSERT thì worker LUÔN truyền — trigger autofill lấy org từ account_id.
  account_id       uuid REFERENCES public.zalo_accounts(id) ON DELETE SET NULL,
  conversation_id  uuid REFERENCES public.zalo_conversations(id) ON DELETE SET NULL,
  kind             text NOT NULL CHECK (kind IN ('broadcast_vacant','auto_reply')),
  mode             text NOT NULL CHECK (mode IN ('full','compact','event','reply','skipped','off','failed')),
  reason           text,
  recipients_count integer NOT NULL DEFAULT 0,
  messages_count   integer NOT NULL DEFAULT 0,
  detail           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.zalo_automation_runs IS
  'Nhật ký mỗi lượt engine tự động hoá chạy, KỂ CẢ lượt quyết định không gửi (mode=skipped/off). Worker ghi (service_role); người dùng chỉ đọc.';
COMMENT ON COLUMN public.zalo_automation_runs.mode IS
  'full/compact = hai chế độ broadcast · event = gửi bổ sung khi có phòng mới trống trong ngày · reply = auto-reply · skipped = tới giờ nhưng bỏ lượt · off = lịch tắt ngày đó · failed = lỗi.';
COMMENT ON COLUMN public.zalo_automation_runs.reason IS
  'Vì sao chọn chế độ đó / vì sao bỏ lượt — hiển thị nguyên văn cho người dùng, nên viết bằng tiếng Việt đọc được.';
COMMENT ON COLUMN public.zalo_automation_runs.conversation_id IS
  'Chỉ cho mode=reply: hội thoại đã trả lời. Worker tra cooldown chống lặp bằng chính cột này.';

CREATE INDEX IF NOT EXISTS zalo_automation_runs_org_created_idx
  ON public.zalo_automation_runs(organization_id, created_at DESC);
-- Cooldown auto-reply: "hội thoại này được trả lời lần cuối lúc nào".
CREATE INDEX IF NOT EXISTS zalo_automation_runs_conv_created_idx
  ON public.zalo_automation_runs(conversation_id, created_at DESC)
  WHERE conversation_id IS NOT NULL;

-- Trigger org RIÊNG cho bảng này — CỐ Ý không dùng `app_private.autofill_org_zalo()`
-- như sáu bảng zalo_* kia. Lý do đo được, không phải sở thích:
--
--   Hàm dùng chung đọc `COALESCE(NEW.user_id, auth.uid())` ở nhánh "client tự
--   khai". Bảng này KHÔNG có cột `user_id` (nhật ký là của công ty, không của
--   người), nên khi `account_id` rỗng nó nổ `42703: record "new" has no field
--   "user_id"` — nghĩa là đúng lúc engine gặp sự cố và gọi ghi nhật ký mà không
--   kèm được account thì CHÍNH VIỆC GHI SỔ cũng hỏng. Mất đúng dòng cần nhất.
--
--   Thêm một cột `user_id` giả để chiều hàm chung cũng không cứu được: worker
--   chạy service_role nên `auth.uid()` NULL, nhánh đó lại nổ `42501`.
--
-- Bản riêng dưới đây giữ nguyên phần bảo vệ THẬT SỰ có giá trị ở đây — không
-- cho ghi chéo công ty — và bỏ phần suy-org-theo-người vốn không áp dụng.
CREATE OR REPLACE FUNCTION app_private.zalo_runs_kiem_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE v_org uuid;
BEGIN
  IF NEW.account_id IS NOT NULL THEN
    SELECT a.organization_id INTO v_org FROM public.zalo_accounts a WHERE a.id = NEW.account_id;
    IF v_org IS NULL THEN
      RAISE EXCEPTION 'zalo_automation_runs: account_id % không tồn tại.', NEW.account_id
        USING ERRCODE = '23503';
    END IF;
    IF NEW.organization_id IS NOT NULL AND NEW.organization_id IS DISTINCT FROM v_org THEN
      RAISE EXCEPTION 'zalo_automation_runs: dòng khai tổ chức % nhưng tài khoản thuộc tổ chức % — từ chối ghi chéo công ty.',
        NEW.organization_id, v_org USING ERRCODE = '42501';
    END IF;
    NEW.organization_id := v_org;
  END IF;
  -- Không có account_id: `organization_id NOT NULL` của cột đã là ràng buộc đủ.
  -- Chỉ service_role ghi được bảng này (authenticated không có INSERT — khối
  -- nghiệm thu đo lại điều đó), nên không có đường cho client bịa org.
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.zalo_runs_kiem_org() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.zalo_runs_kiem_org() FROM anon;
REVOKE ALL ON FUNCTION app_private.zalo_runs_kiem_org() FROM authenticated;

DROP TRIGGER IF EXISTS trg_autofill_org_zalo ON public.zalo_automation_runs;
DROP TRIGGER IF EXISTS trg_zalo_runs_kiem_org ON public.zalo_automation_runs;
CREATE TRIGGER trg_zalo_runs_kiem_org
  BEFORE INSERT ON public.zalo_automation_runs
  FOR EACH ROW EXECUTE FUNCTION app_private.zalo_runs_kiem_org();

ALTER TABLE public.zalo_automation_runs ENABLE ROW LEVEL SECURITY;

-- Đọc: ai xem được Chat Zalo của org thì xem được nhật ký của org đó.
DROP POLICY IF EXISTS zalo_automation_runs_org_select ON public.zalo_automation_runs;
CREATE POLICY zalo_automation_runs_org_select
  ON public.zalo_automation_runs FOR SELECT TO authenticated
  USING (
    (SELECT public.is_super_admin())
    OR organization_id IN (SELECT public.zalo_authorized_org_ids('view'))
  );

-- CỐ Ý không có policy INSERT/UPDATE/DELETE cho authenticated: nhật ký chỉ do
-- worker (service_role, bypass RLS) ghi. Sổ mà người bị ghi sổ sửa được thì
-- không còn là bằng chứng.

DROP POLICY IF EXISTS zalo_automation_runs_org_boundary ON public.zalo_automation_runs;
CREATE POLICY zalo_automation_runs_org_boundary
  ON public.zalo_automation_runs AS RESTRICTIVE FOR ALL TO authenticated
  USING (
    (SELECT public.is_super_admin())
    OR organization_id IN (SELECT unnest(public.my_org_ids()))
  )
  WITH CHECK (
    (SELECT public.is_super_admin())
    OR organization_id IN (SELECT unnest(public.my_org_ids()))
  );

DROP POLICY IF EXISTS zalo_automation_runs_hide_sandbox_admin ON public.zalo_automation_runs;
CREATE POLICY zalo_automation_runs_hide_sandbox_admin
  ON public.zalo_automation_runs AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    NOT ((SELECT public.is_super_admin())
         AND COALESCE(organization_id = ANY (public.sandbox_org_ids()), false))
  );

-- Schema `public` trên Supabase có DEFAULT PRIVILEGES cấp thẳng INSERT/UPDATE/
-- DELETE cho anon + authenticated trên MỌI bảng mới. `GRANT SELECT` không thu
-- hồi phần đã được cấp sẵn đó — phải REVOKE ALL trước rồi mới cấp lại đúng phần
-- muốn cho. Đo bằng has_table_privilege ở khối nghiệm thu, đừng tin câu GRANT.
REVOKE ALL ON public.zalo_automation_runs FROM anon;
REVOKE ALL ON public.zalo_automation_runs FROM authenticated;
GRANT SELECT ON public.zalo_automation_runs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.zalo_automation_runs TO service_role;

-- ---------------------------------------------------------------------------
-- 3. RPC: lưu cấu hình tự động hoá (enabled + config)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.zalo_luu_tu_dong_hoa(
  p_kind            text,
  p_enabled         boolean,
  p_config          jsonb DEFAULT NULL,
  p_organization_id uuid  DEFAULT NULL
)
RETURNS public.zalo_automations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_row  public.zalo_automations;
  v_org  uuid;
  v_orgs uuid[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('broadcast_vacant','auto_reply') THEN
    RAISE EXCEPTION 'Loại tự động hoá không hợp lệ: %', p_kind USING ERRCODE = '22023';
  END IF;
  -- config phải là OBJECT: mảng/số/chuỗi lọt vào đây thì worker đọc ra rác và
  -- im lặng dùng mặc định — hỏng kiểu ở biên thì chặn ngay tại biên.
  IF p_config IS NOT NULL AND jsonb_typeof(p_config) <> 'object' THEN
    RAISE EXCEPTION 'Cấu hình phải là đối tượng JSON (nhận: %)', jsonb_typeof(p_config) USING ERRCODE = '22023';
  END IF;

  IF p_organization_id IS NOT NULL THEN
    IF NOT public.zalo_can('manage_automation', p_organization_id) THEN
      RAISE EXCEPTION 'Bạn không có quyền quản lý tự động hoá trong tổ chức này' USING ERRCODE = '42501';
    END IF;
    v_org := p_organization_id;
  ELSE
    SELECT array_agg(o) INTO v_orgs FROM public.zalo_authorized_org_ids('manage_automation') o;
    IF v_orgs IS NULL OR array_length(v_orgs, 1) IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'Không xác định được tổ chức — truyền p_organization_id (bạn thuộc nhiều tổ chức hoặc chưa được cấp quyền).' USING ERRCODE = '23502';
    END IF;
    v_org := v_orgs[1];
  END IF;

  INSERT INTO public.zalo_automations(user_id, organization_id, kind, enabled, config)
  VALUES (auth.uid(), v_org, p_kind, p_enabled, COALESCE(p_config, '{}'::jsonb))
  ON CONFLICT (organization_id, kind) DO UPDATE
    SET enabled    = EXCLUDED.enabled,
        -- Không truyền config = chỉ bật/tắt, GIỮ NGUYÊN cấu hình cũ.
        config     = COALESCE(p_config, public.zalo_automations.config),
        updated_at = now()
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_luu_tu_dong_hoa(text, boolean, jsonb, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.zalo_luu_tu_dong_hoa(text, boolean, jsonb, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.zalo_luu_tu_dong_hoa(text, boolean, jsonb, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_luu_tu_dong_hoa(text, boolean, jsonb, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. RPC: đánh dấu hội thoại là sale/môi giới
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.zalo_danh_dau_sale(
  p_conversation_id uuid,
  p_is_sale         boolean
)
RETURNS public.zalo_conversations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_conv public.zalo_conversations;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_conv FROM public.zalo_conversations WHERE id = p_conversation_id;
  IF NOT FOUND THEN
    -- Không gắn ERRCODE riêng: mọi RPC zalo_* anh em đều để P0001 mặc định ở
    -- nhánh này, và src/lib/contracts/errors.ts phân loại theo danh sách mã
    -- ĐÓNG — thêm mã mới ở đây làm gate errors.test.ts đỏ mà chẳng đổi được
    -- gì cho người dùng.
    RAISE EXCEPTION 'Hội thoại không tồn tại';
  END IF;
  IF NOT public.zalo_can('manage_automation', v_conv.organization_id) THEN
    RAISE EXCEPTION 'Bạn không có quyền quản lý tự động hoá trong tổ chức này' USING ERRCODE = '42501';
  END IF;

  UPDATE public.zalo_conversations
     SET is_sale_partner = COALESCE(p_is_sale, false), updated_at = now()
   WHERE id = p_conversation_id
  RETURNING * INTO v_conv;
  RETURN v_conv;
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_danh_dau_sale(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.zalo_danh_dau_sale(uuid, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.zalo_danh_dau_sale(uuid, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_danh_dau_sale(uuid, boolean) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. RPC: phòng trống của một tổ chức — DÀNH RIÊNG cho worker (service_role)
--
--    Cùng định nghĩa "trống" với trang chia sẻ công khai
--    (20260606120000_public_room_share_phong_trong.sql): pass > cọc-giữ-chỗ >
--    sắp-trống > đã-thuê > AVAILABLE. Khác đúng ba chỗ, đều có lý do:
--      • scope theo organization_id, không theo owner_id;
--      • KHÔNG trả sale_bonus_note (nội bộ);
--      • chỉ service_role gọi được.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.zalo_phong_trong_cho_worker_v1(p_organization_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_soon    int;
  v_hotline uuid;
  v_today   date;
  v_result  jsonb;
BEGIN
  IF p_organization_id IS NULL THEN
    RETURN jsonb_build_object('areas','[]'::jsonb,'buildings','[]'::jsonb,'rooms','[]'::jsonb,'contact',NULL);
  END IF;

  SELECT prs.soon_days, prs.hotline_id INTO v_soon, v_hotline
    FROM public.public_room_settings prs
   WHERE prs.organization_id = p_organization_id
   LIMIT 1;
  IF v_soon IS NULL THEN v_soon := 30; END IF;

  v_today := public.org_today_v1(p_organization_id);

  WITH rms AS (
    SELECT
      rm.id, rm.building_id, rm.floor, rm.name, rm.code, rm.area,
      rm.rent_price, rm.deposit_amount, rm.max_occupants,
      COALESCE(rm.amenities, '[]'::jsonb) AS amenities,
      COALESCE(rm.images,    '[]'::jsonb) AS images,
      rm.description, rm.sale_note, rm.room_type,
      -- contact_manager = che liên hệ của khách, chỉ để lại "liên hệ quản lý".
      CASE WHEN pl.contact_manager THEN NULL ELSE pl.contact_name  END AS pass_contact_name,
      CASE WHEN pl.contact_manager THEN NULL ELSE pl.contact_phone END AS pass_contact_phone,
      pl.sale_policy AS pass_sale_policy,
      pl.pass_price  AS pass_price,
      pl.avail_date  AS pass_avail_date,
      COALESCE(pl.contact_manager, false) AS pass_contact_manager,
      CASE
        WHEN pl.id IS NOT NULL THEN 'pass'
        WHEN public.room_has_holding_deposit(rm.id) THEN 'rented'
        WHEN EXISTS (
          SELECT 1 FROM public.contracts c
           WHERE c.room_id = rm.id AND c.deleted_at IS NULL
             AND c.status IN ('ACTIVE','EXTENDED')
             AND ((c.expected_move_out_date IS NOT NULL
                   AND c.expected_move_out_date BETWEEN v_today AND v_today + v_soon)
                  OR COALESCE(c.actual_end_date, c.end_date) BETWEEN v_today AND v_today + v_soon)
        ) THEN 'soon'
        WHEN EXISTS (
          SELECT 1 FROM public.contracts c
           WHERE c.room_id = rm.id AND c.deleted_at IS NULL
             AND c.status IN ('ACTIVE','EXTENDED')
        ) THEN 'rented'
        WHEN rm.status = 'AVAILABLE' THEN 'free'
        ELSE 'rented'
      END AS status_public,
      (
        SELECT MIN(CASE
                     WHEN c.expected_move_out_date IS NOT NULL
                       AND c.expected_move_out_date BETWEEN v_today AND v_today + v_soon
                       THEN c.expected_move_out_date
                     ELSE COALESCE(c.actual_end_date, c.end_date)
                   END)
          FROM public.contracts c
         WHERE c.room_id = rm.id AND c.deleted_at IS NULL
           AND c.status IN ('ACTIVE','EXTENDED')
           AND ((c.expected_move_out_date IS NOT NULL
                 AND c.expected_move_out_date BETWEEN v_today AND v_today + v_soon)
                OR COALESCE(c.actual_end_date, c.end_date) BETWEEN v_today AND v_today + v_soon)
      ) AS avail_date
    FROM public.rooms rm
    JOIN public.buildings b ON b.id = rm.building_id
    LEFT JOIN public.room_pass_listings pl
      ON pl.room_id = rm.id
     AND pl.active = true
     AND (pl.organization_id = p_organization_id OR pl.organization_id IS NULL)
    WHERE b.organization_id = p_organization_id
      AND b.is_virtual = false
      AND b.deleted_at IS NULL
      AND rm.deleted_at IS NULL
  ),
  bld_ids AS (
    SELECT DISTINCT building_id FROM rms WHERE status_public IN ('free','soon','pass')
  ),
  rooms_j AS (
    SELECT jsonb_agg(to_jsonb(rms) ORDER BY rms.floor DESC, rms.name) AS j
      FROM rms
     WHERE rms.building_id IN (SELECT building_id FROM bld_ids)
       AND rms.status_public IN ('free','soon','pass')
  ),
  blds_j AS (
    SELECT jsonb_agg(jsonb_build_object(
      'id', b.id, 'name', b.name, 'code', b.code,
      'area_ids', COALESCE((SELECT jsonb_agg(ab.area_id)
                              FROM public.area_buildings ab
                              JOIN public.areas a ON a.id = ab.area_id
                             WHERE ab.building_id = b.id AND a.deleted_at IS NULL), '[]'::jsonb),
      'district', b.district, 'ward', b.ward,
      'address', CASE
                   WHEN b.street_address IS NOT NULL AND b.street_address LIKE '%,%' THEN b.street_address
                   ELSE concat_ws(', ', NULLIF(b.street_address,''), NULLIF(b.ward,''),
                                        NULLIF(b.district,''), NULLIF(b.province,''))
                 END,
      'total_floors', b.total_floors,
      'images', COALESCE(b.images, '[]'::jsonb),
      'public_contact_name',  b.public_contact_name,
      'public_contact_phone', b.public_contact_phone,
      'public_map_url',       b.public_map_url,
      'public_lift_type',     b.public_lift_type,
      'elec_rate', (
        SELECT COALESCE(bs.unit_price_override, s.unit_price)
          FROM public.building_services bs
          JOIN public.services s ON s.id = bs.service_id
         WHERE bs.building_id = b.id AND bs.is_active = true
           AND s.deleted_at IS NULL AND s.unit ILIKE 'kwh'
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
     WHERE a.organization_id = p_organization_id AND a.deleted_at IS NULL
  ),
  contact_j AS (
    SELECT jsonb_build_object('name', h.name, 'phone', h.phone_number) AS j
      FROM public.hotlines h
     WHERE h.organization_id = p_organization_id
       AND COALESCE(h.is_active, true) = true
       AND (v_hotline IS NULL OR h.id = v_hotline)
     ORDER BY (h.id = v_hotline) DESC NULLS LAST, h.created_at
     LIMIT 1
  )
  SELECT jsonb_build_object(
    'areas',     COALESCE((SELECT j FROM areas_j), '[]'::jsonb),
    'buildings', COALESCE((SELECT j FROM blds_j),  '[]'::jsonb),
    'rooms',     COALESCE((SELECT j FROM rooms_j), '[]'::jsonb),
    'contact',   (SELECT j FROM contact_j)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.zalo_phong_trong_cho_worker_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.zalo_phong_trong_cho_worker_v1(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.zalo_phong_trong_cho_worker_v1(uuid) FROM authenticated;
-- CHỈ worker. Người dùng web đã có get_my_available_rooms cho đúng phạm vi quyền
-- của họ; mở hàm này cho authenticated là mở đường xem phòng vượt phân quyền toà.
GRANT EXECUTE ON FUNCTION public.zalo_phong_trong_cho_worker_v1(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — chỉ soi catalog nên chạy được trên database rỗng.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_n bigint;
BEGIN
  -- (a) cột cờ sale + index
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='zalo_conversations'
                    AND column_name='is_sale_partner') THEN
    RAISE EXCEPTION 'Thiếu cột zalo_conversations.is_sale_partner. DỪNG.';
  END IF;

  -- (b) bảng nhật ký: RLS bật, KHÔNG có policy ghi cho authenticated
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='public' AND c.relname='zalo_automation_runs'
                    AND c.relrowsecurity) THEN
    RAISE EXCEPTION 'zalo_automation_runs chưa bật RLS. DỪNG.';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname='public' AND tablename='zalo_automation_runs' AND cmd <> 'SELECT';
  IF v_n <> 1 THEN
    -- đúng 1: policy RESTRICTIVE org_boundary (FOR ALL). Bất kỳ policy PERMISSIVE
    -- ghi nào lọt vào đây là mở đường cho người dùng sửa nhật ký của chính mình.
    RAISE EXCEPTION 'zalo_automation_runs phải có ĐÚNG 1 policy không-SELECT (org_boundary), thấy %. DỪNG.', v_n;
  END IF;
  -- Vai anon/authenticated do Supabase tạo. Database trần (Restore Drill dựng
  -- Postgres sạch) có thể chưa có — thiếu vai thì bỏ qua phép đo, đừng nổ.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    IF has_table_privilege('authenticated', 'public.zalo_automation_runs', 'INSERT')
       OR has_table_privilege('authenticated', 'public.zalo_automation_runs', 'UPDATE')
       OR has_table_privilege('authenticated', 'public.zalo_automation_runs', 'DELETE') THEN
      RAISE EXCEPTION 'authenticated không được có quyền ghi zalo_automation_runs. DỪNG.';
    END IF;
  END IF;

  -- (c) trigger org đã gắn, và là bản RIÊNG chứ không phải hàm dùng chung
  --     (hàm chung đọc NEW.user_id — cột bảng này không có — nên nổ 42703 đúng
  --     lúc engine ghi nhật ký lỗi mà không kèm được account).
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                   JOIN pg_class c ON c.oid=t.tgrelid
                   JOIN pg_proc p ON p.oid=t.tgfoid
                  WHERE c.relname='zalo_automation_runs'
                    AND p.proname='zalo_runs_kiem_org' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'zalo_automation_runs thiếu trigger zalo_runs_kiem_org. DỪNG.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger t
               JOIN pg_class c ON c.oid=t.tgrelid
               JOIN pg_proc p ON p.oid=t.tgfoid
              WHERE c.relname='zalo_automation_runs'
                AND p.proname='autofill_org_zalo' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'zalo_automation_runs KHÔNG được dùng autofill_org_zalo (nổ 42703 khi thiếu account_id). DỪNG.';
  END IF;

  -- (d) ba RPC mới, mỗi cái đúng MỘT bản (overload làm PostgREST chọn nhầm)
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND p.proname IN ('zalo_luu_tu_dong_hoa','zalo_danh_dau_sale','zalo_phong_trong_cho_worker_v1');
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'Phải có đúng 3 RPC mới (mỗi tên 1 bản), đếm được %. DỪNG.', v_n;
  END IF;

  -- (e) hàm SECURITY DEFINER mới KHÔNG được anon-executable.
  --     REVOKE FROM PUBLIC không cắt được GRANT riêng cho anon trên Supabase —
  --     phải đo, đừng tin mỗi câu REVOKE đã viết ở trên.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    SELECT count(*) INTO v_n
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public'
       AND p.proname IN ('zalo_luu_tu_dong_hoa','zalo_danh_dau_sale','zalo_phong_trong_cho_worker_v1')
       AND has_function_privilege('anon', p.oid, 'EXECUTE');
    IF v_n <> 0 THEN
      RAISE EXCEPTION '% RPC mới còn anon-executable. DỪNG.', v_n;
    END IF;
  END IF;

  -- (f) RPC dành riêng worker KHÔNG được lộ cho authenticated
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'public' AND p.proname = 'zalo_phong_trong_cho_worker_v1'
                    AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'zalo_phong_trong_cho_worker_v1 phải CHỈ dành cho service_role. DỪNG.';
  END IF;

  -- (g) GHI ĐƯỢC nhật ký khi KHÔNG có account_id. Đây là ca đã cắn thật:
  --     engine gọi ghi nhật ký ở nhánh lỗi cấp công ty, lúc đó có thể không tìm
  --     ra tài khoản nào đang có phiên. Nếu đường ghi đó hỏng thì đúng dòng cần
  --     nhất là dòng biến mất. Chèn thật rồi xoá — chạy được trên database rỗng
  --     vì không phụ thuộc dữ liệu có sẵn nào.
  INSERT INTO public.zalo_automation_runs(organization_id, kind, mode, reason)
  SELECT o.id, 'broadcast_vacant', 'failed', 'zz nghiệm thu — ghi không kèm account'
    FROM public.organizations o LIMIT 1;
  DELETE FROM public.zalo_automation_runs WHERE reason = 'zz nghiệm thu — ghi không kèm account';

  RAISE NOTICE 'Nghiệm thu tự-động-hoá-Zalo đạt: cờ sale, nhật ký kín (chỉ worker ghi) và ghi được cả khi thiếu account, trigger org riêng, 3 RPC đúng 1 bản, ACL sạch anon.';
END
$nghiem_thu$;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- =============================================================================
-- ROLLBACK (tay):
--   DROP FUNCTION public.zalo_phong_trong_cho_worker_v1(uuid);
--   DROP FUNCTION public.zalo_danh_dau_sale(uuid, boolean);
--   DROP FUNCTION public.zalo_luu_tu_dong_hoa(text, boolean, jsonb, uuid);
--   DROP TABLE public.zalo_automation_runs;           -- kéo theo 3 policy + trigger
--   DROP FUNCTION app_private.zalo_runs_kiem_org();   -- sau khi bảng đã DROP
--   DROP INDEX public.zalo_conversations_sale_partner_idx;
--   ALTER TABLE public.zalo_conversations DROP COLUMN is_sale_partner;
--
-- Lùi được sạch: migration này CHỈ THÊM (một cột có DEFAULT false, một bảng
-- mới, bốn hàm mới). Không sửa, không xoá, không đụng dữ liệu đang có — nên
-- đường lùi chỉ là bỏ đi phần vừa thêm.
-- =============================================================================

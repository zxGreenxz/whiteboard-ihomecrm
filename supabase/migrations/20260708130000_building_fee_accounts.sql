-- =============================================================================
-- Đóng tiền Tập trung theo Kỳ — building_fee_accounts (cấu hình phí theo tòa)
--
-- Tổng quát hóa building_utility_accounts: lưu mã NCC + tên đăng ký + SỐ TIỀN
-- MẶC ĐỊNH + sổ ghi chi mặc định theo (tòa × hạng mục phí). Dùng để pre-fill ô
-- tiền và so "phải đóng" vs "đã đóng" cho lưới GRID (Tiền nhà, Internet, Quản Lý,
-- Vệ sinh, Công An, Rác, Thang máy, và cả Điện/Nước).
--
-- fee_category = registry key: 'tien_nha','dien','nuoc','internet','quan_ly',
--                've_sinh','cong_an','rac','thang_may'.
-- RLS: SELECT-only (owner OR can_access_building OR ie_all_buildings_scope OR admin).
-- Mọi GHI qua RPC SECURITY DEFINER (upsert_building_fee_account / pay_period_fee).
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.building_fee_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id        uuid NOT NULL REFERENCES public.buildings(id) ON DELETE CASCADE,
  fee_category       text NOT NULL,
  provider_code      text,
  account_holder     text,
  default_amount     numeric(15,2),
  default_account_id uuid REFERENCES public.accounts(id),
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,  -- = buildings.user_id (owner)
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bfa_building_category
  ON public.building_fee_accounts(building_id, fee_category) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bfa_building ON public.building_fee_accounts(building_id);
CREATE INDEX IF NOT EXISTS idx_bfa_user ON public.building_fee_accounts(user_id);

DROP TRIGGER IF EXISTS trg_bfa_updated_at ON public.building_fee_accounts;
CREATE TRIGGER trg_bfa_updated_at BEFORE UPDATE ON public.building_fee_accounts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.building_fee_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bfa_select ON public.building_fee_accounts;
CREATE POLICY bfa_select ON public.building_fee_accounts
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.can_access_building(building_id)
    OR public.ie_all_buildings_scope(building_id)
    OR public.is_admin() OR public.is_super_admin()
  );

-- ── Copy cấu hình điện/nước cũ (building_utility_accounts) → fee accounts ──
-- Multi-meter: 1 tòa có thể nhiều đồng hồ 1 loại → lấy đồng hồ ĐẦU TIÊN làm carrier
-- cấu hình mặc định (mã NCC/chủ hộ) cho hạng mục dien/nuoc.
INSERT INTO public.building_fee_accounts
  (building_id, fee_category, provider_code, account_holder, user_id, created_at)
SELECT DISTINCT ON (bua.building_id, bua.utility_type)
       bua.building_id,
       CASE bua.utility_type WHEN 'ELECTRIC' THEN 'dien' WHEN 'WATER' THEN 'nuoc' END,
       bua.provider_code, bua.account_holder, bua.user_id, bua.created_at
  FROM public.building_utility_accounts bua
 WHERE bua.deleted_at IS NULL
 ORDER BY bua.building_id, bua.utility_type, bua.created_at ASC
ON CONFLICT (building_id, fee_category) WHERE deleted_at IS NULL DO NOTHING;

-- ── RPC ghi cấu hình (mirror upsert_building_utility_account) ──
CREATE OR REPLACE FUNCTION public.upsert_building_fee_account(
  p_building_id       uuid,
  p_fee_category      text,
  p_provider_code     text    DEFAULT NULL,
  p_account_holder    text    DEFAULT NULL,
  p_default_amount    numeric DEFAULT NULL,
  p_default_account_id uuid   DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid;
  v_id    uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_fee_category NOT IN ('tien_nha','dien','nuoc','internet','quan_ly','ve_sinh','cong_an','rac','thang_may') THEN
    RAISE EXCEPTION 'Hạng mục phí không hợp lệ: %', p_fee_category;
  END IF;

  SELECT b.user_id INTO v_owner FROM buildings b
   WHERE b.id = p_building_id AND b.deleted_at IS NULL;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Không tìm thấy toà nhà'; END IF;
  IF NOT (public.can_access_building(p_building_id)
          OR public.ie_all_buildings_scope(p_building_id)
          OR v_owner = auth.uid()
          OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền cấu hình toà này' USING ERRCODE = '42501';
  END IF;

  INSERT INTO building_fee_accounts
    (building_id, fee_category, provider_code, account_holder, default_amount, default_account_id, user_id)
  VALUES
    (p_building_id, p_fee_category,
     NULLIF(btrim(p_provider_code), ''), NULLIF(btrim(p_account_holder), ''),
     p_default_amount, p_default_account_id, v_owner)
  ON CONFLICT (building_id, fee_category) WHERE deleted_at IS NULL
  DO UPDATE SET
    provider_code      = COALESCE(NULLIF(btrim(EXCLUDED.provider_code), ''),  building_fee_accounts.provider_code),
    account_holder     = COALESCE(NULLIF(btrim(EXCLUDED.account_holder), ''), building_fee_accounts.account_holder),
    default_amount     = COALESCE(EXCLUDED.default_amount,     building_fee_accounts.default_amount),
    default_account_id = COALESCE(EXCLUDED.default_account_id, building_fee_accounts.default_account_id),
    updated_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_building_fee_account(uuid,text,text,text,numeric,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_building_fee_account(uuid,text,text,text,numeric,uuid) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';

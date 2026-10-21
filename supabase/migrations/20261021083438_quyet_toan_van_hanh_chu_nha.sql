-- =============================================================================
-- quyet_toan_van_hanh_chu_nha — quyết toán tháng cho toà VẬN HÀNH CHO CHỦ NHÀ
-- Ngày 21/10/2026 · chủ chốt trong ngày:
--   · Một số toà chủ nhà sở hữu, iHome vận hành và nhận % lợi nhuận tháng theo
--     thoả thuận riêng từng toà — không thuê lại, không có tiền nhà.
--   · Lợi nhuận tháng = doanh thu − chi phí ghi vào toà (đúng các khoản tính KQKD
--     của toà); chi phí chung ở toà ảo không trừ.
--   · Tháng lỗ: phần quản lý = 0đ ("lỗ thì không tính"), lỗ không chuyển kỳ.
--   · Áp dụng từ tháng 10/2026.
--   · Doanh thu mặc định vào sổ quỹ của chủ nhà; cọc do quản lý giữ để trả cọc và
--     thanh lý nội bộ. Khoản lọt vào sổ quản lý (cọc lố tiền phòng, chuyển nhầm,
--     cấn cọc khi thanh lý) và khoản quản lý chi hộ được bù trừ khi quyết toán.
--   · Chủ nhà xem cùng trang quyết toán (link riêng, chỉ đọc), không qua trang
--     chia lợi nhuận.
-- =============================================================================
-- VÌ SAO
--   Máy chốt LN tháng (profit_close_v2) chia LN cho cổ đông rồi CÔNG TY chi trả.
--   Toà vận hành ngược chiều: tiền nằm ở sổ chủ nhà, quản lý mới là bên nhận %.
--   Ngoài phần %, mỗi tháng còn phải bù trừ tiền hai bên đang giữ hộ nhau — thứ mà
--   allocation cổ đông không diễn tả được.
--
-- CÔNG THỨC (một nơi duy nhất: app_private.landlord_settlement_compute_v1)
--   Phiếu của toà, ngày phiếu trong tháng, đã duyệt; dòng tính như KQKD canonical
--   (fa_accrual_allocations): business_result_accounting IS DISTINCT FROM false và
--   (business_result_accounting IS TRUE OR accounting_class = 'PNL'); phiếu không có
--   dòng hạng mục thì lấy total_amount. Khác KQKD đúng một điểm: chia THÁNG theo
--   NGÀY PHIẾU (tiền thực thu/chi), vì quyết toán là bàn giao tiền.
--   Bên giữ tiền: sổ quỹ của phiếu thuộc danh sách sổ chủ nhà ⇒ CHỦ NHÀ; còn lại
--   (kể cả sổ ảo cấn trừ thanh lý, phiếu không sổ) ⇒ QUẢN LÝ.
--     doanh_thu = chu_nha_thu + quan_ly_thu
--     chi_phi   = chu_nha_chi + quan_ly_chi
--     loi_nhuan = doanh_thu − chi_phi
--     phan_quan_ly = loi_nhuan > 0 ? round(loi_nhuan × % / 100) : 0
--     phan_chu_nha = loi_nhuan − phan_quan_ly
--     chu_nha_tra_quan_ly = phan_quan_ly + quan_ly_chi − quan_ly_thu
--       (> 0: chủ nhà trả quản lý; < 0: quản lý trả lại chủ nhà)
--   Chứng minh: chủ nhà đang giữ chu_nha_thu − chu_nha_chi, được hưởng
--   phan_chu_nha; phần chênh = phan_quan_ly + quan_ly_chi − quan_ly_thu.
--   Cọc (accounting_class DEPOSIT) chỉ hiển thị, không vào quyết toán.
--
-- LÀM GÌ
--   1. app_private.landlord_operations (+ landlord_operation_changes): cấu hình
--      toà vận hành — tên chủ nhà, % quản lý, tháng áp dụng, sổ quỹ chủ nhà.
--   2. app_private.landlord_settlement_closes: chốt/mở chốt tháng, append-only,
--      chụp nguyên bảng quyết toán + source_hash.
--   3. app_private.landlord_settlement_payments: hai bên đã trả nhau bao nhiêu.
--   4. app_private.landlord_share_links: link chỉ đọc cho chủ nhà (/qt/:token).
--   5. RPC cho chủ công ty/super admin + một RPC công khai theo link.
--
-- KHÔNG ĐỤNG
--   Không writer nào đọc bảng mới. Không sửa phiếu, sổ quỹ, hoá đơn, KQKD, chốt LN,
--   bộ máy chi. Không khoá phiếu khi chốt — chốt chỉ chụp số; phiếu đổi sau đó thì
--   màn báo "đã thay đổi sau khi chốt" và phải mở chốt rồi chốt lại.
--
-- ĐƯỜNG LÙI
--   REVOKE EXECUTE các RPC public khỏi anon/authenticated. Bảng để nguyên (không ai
--   đọc). Không có dữ liệu khởi tạo: cấu hình toà do chủ nhập trên màn.
--
-- Chạy được hai lượt liên tiếp và trên DB rỗng của Restore Drill.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Nền phải có.
DO $truoc$
BEGIN
  IF to_regprocedure('app_private.ie_actor_is_company_owner_v1(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu app_private.ie_actor_is_company_owner_v1' USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('public.can_access_building(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu public.can_access_building' USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('public.is_super_admin()') IS NULL THEN
    RAISE EXCEPTION 'Thiếu public.is_super_admin' USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('extensions.gen_random_bytes(integer)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu extensions.gen_random_bytes (pgcrypto)' USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- ---------------------------------------------------------------------------
-- 1. Cấu hình toà vận hành — một dòng cho mỗi toà.
CREATE TABLE IF NOT EXISTS app_private.landlord_operations (
  building_id          uuid PRIMARY KEY REFERENCES public.buildings(id) ON DELETE RESTRICT,
  organization_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  landlord_name        text NOT NULL CHECK (length(btrim(landlord_name)) BETWEEN 1 AND 120),
  manager_percent      numeric(5,2) NOT NULL CHECK (manager_percent >= 0 AND manager_percent <= 100),
  -- ngày 1 của tháng bắt đầu áp dụng thoả thuận
  effective_from       date NOT NULL CHECK (effective_from = date_trunc('month', effective_from)::date),
  -- sổ quỹ (public.accounts) của chủ nhà; phiếu ghi vào sổ khác là bên quản lý
  landlord_account_ids uuid[] NOT NULL CHECK (cardinality(landlord_account_ids) BETWEEN 1 AND 20),
  note                 text CHECK (note IS NULL OR length(note) <= 500),
  is_active            boolean NOT NULL DEFAULT true,
  created_by           uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by           uuid NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS landlord_operations_org
  ON app_private.landlord_operations (organization_id);

-- Sổ thay đổi cấu hình (append-only): ai đổi %, đổi sổ quỹ, lúc nào.
CREATE TABLE IF NOT EXISTS app_private.landlord_operation_changes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  building_id     uuid NOT NULL REFERENCES public.buildings(id) ON DELETE RESTRICT,
  actor           uuid NOT NULL,
  before          jsonb,
  after           jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS landlord_operation_changes_toa
  ON app_private.landlord_operation_changes (building_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. Chốt tháng — append-only. Trạng thái tháng = dòng có revision lớn nhất.
CREATE TABLE IF NOT EXISTS app_private.landlord_settlement_closes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  building_id     uuid NOT NULL REFERENCES public.buildings(id) ON DELETE RESTRICT,
  period_month    date NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  revision        integer NOT NULL CHECK (revision >= 1),
  action          text NOT NULL CHECK (action IN ('CLOSE', 'REOPEN')),
  snapshot        jsonb,
  source_hash     text,
  -- > 0: chủ nhà trả quản lý; < 0: quản lý trả lại chủ nhà
  net_amount      numeric(16,2),
  reason          text CHECK (reason IS NULL OR length(reason) <= 1000),
  actor           uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (building_id, period_month, revision),
  CHECK ((action = 'CLOSE') = (snapshot IS NOT NULL AND source_hash IS NOT NULL AND net_amount IS NOT NULL)),
  CHECK (action = 'CLOSE' OR length(btrim(coalesce(reason, ''))) >= 8)
);
CREATE INDEX IF NOT EXISTS landlord_settlement_closes_org
  ON app_private.landlord_settlement_closes (organization_id, period_month);

-- ---------------------------------------------------------------------------
-- 3. Thanh toán quyết toán giữa chủ nhà và quản lý. Không xoá — chỉ huỷ có lý do.
CREATE TABLE IF NOT EXISTS app_private.landlord_settlement_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  building_id     uuid NOT NULL REFERENCES public.buildings(id) ON DELETE RESTRICT,
  paid_on         date NOT NULL,
  direction       text NOT NULL CHECK (direction IN ('LANDLORD_TO_MANAGER', 'MANAGER_TO_LANDLORD')),
  amount          numeric(16,2) NOT NULL CHECK (amount > 0 AND amount = round(amount)),
  note            text CHECK (note IS NULL OR length(note) <= 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  voided_by       uuid,
  voided_at       timestamptz,
  void_reason     text CHECK (void_reason IS NULL OR length(void_reason) <= 1000),
  UNIQUE (organization_id, idempotency_key),
  CHECK ((voided_at IS NULL) = (voided_by IS NULL)),
  CHECK (voided_at IS NULL OR length(btrim(coalesce(void_reason, ''))) >= 8)
);
CREATE INDEX IF NOT EXISTS landlord_settlement_payments_toa
  ON app_private.landlord_settlement_payments (building_id, paid_on);

-- ---------------------------------------------------------------------------
-- 4. Link chỉ đọc cho chủ nhà. Token ngẫu nhiên 32 ký tự url-safe; thu hồi được.
CREATE TABLE IF NOT EXISTS app_private.landlord_share_links (
  token           text PRIMARY KEY CHECK (token ~ '^[A-Za-z0-9_-]{32,64}$'),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  building_id     uuid NOT NULL REFERENCES public.buildings(id) ON DELETE RESTRICT,
  label           text CHECK (label IS NULL OR length(label) <= 120),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_by      uuid,
  revoked_at      timestamptz,
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX IF NOT EXISTS landlord_share_links_toa
  ON app_private.landlord_share_links (building_id);

REVOKE ALL ON app_private.landlord_operations, app_private.landlord_operation_changes,
  app_private.landlord_settlement_closes, app_private.landlord_settlement_payments,
  app_private.landlord_share_links
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE app_private.landlord_operations IS
  'Toà vận hành cho chủ nhà: chủ nhà sở hữu, quản lý nhận % LN tháng (lỗ thì 0đ). landlord_account_ids = sổ quỹ của chủ nhà; phiếu ở sổ khác là bên quản lý giữ. Chủ chốt 21/10/2026.';
COMMENT ON TABLE app_private.landlord_settlement_closes IS
  'Chốt/mở chốt quyết toán tháng của toà vận hành, append-only. Trạng thái tháng = dòng revision lớn nhất; CLOSE chụp nguyên bảng quyết toán và source_hash để phát hiện phiếu đổi sau khi chốt.';
COMMENT ON TABLE app_private.landlord_settlement_payments IS
  'Tiền chủ nhà và quản lý đã trả nhau khi quyết toán. Không xoá; huỷ phải có lý do. Còn lại = tổng quyết toán các tháng đã chốt − chủ nhà đã trả + quản lý đã trả.';
COMMENT ON TABLE app_private.landlord_share_links IS
  'Link chỉ đọc /qt/:token cho chủ nhà xem quyết toán toà của mình. revoked_at khác NULL = đã thu hồi.';

-- ---------------------------------------------------------------------------
-- 5. Hàm nền.

-- Tháng hiện tại theo giờ Việt Nam.
CREATE OR REPLACE FUNCTION app_private.landlord_current_month_v1()
RETURNS date
LANGUAGE sql
STABLE
SET search_path TO ''
AS $fn$
  SELECT date_trunc('month', pg_catalog.timezone('Asia/Ho_Chi_Minh', pg_catalog.now()))::date;
$fn$;

-- Người đang gọi có quản được quyết toán của toà không: chủ công ty của đúng
-- công ty sở hữu toà, hoặc super admin; và vẫn phải vào được toà.
CREATE OR REPLACE FUNCTION app_private.landlord_actor_can_manage_v1(p_building_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_org   uuid;
BEGIN
  IF v_actor IS NULL OR p_building_id IS NULL THEN
    RETURN false;
  END IF;
  SELECT b.organization_id INTO v_org
    FROM public.buildings b
   WHERE b.id = p_building_id
     AND b.deleted_at IS NULL
     AND NOT COALESCE(b.is_virtual, false);
  IF v_org IS NULL THEN
    RETURN false;
  END IF;
  RETURN (public.is_super_admin() OR app_private.ie_actor_is_company_owner_v1(v_org, v_actor))
     AND public.can_access_building(p_building_id);
END
$fn$;

-- ---------------------------------------------------------------------------
-- 6. CÔNG THỨC — nơi duy nhất tính quyết toán tháng. Không kiểm quyền: chỉ các
--    hàm SECURITY DEFINER bên dưới gọi, sau khi đã kiểm.
CREATE OR REPLACE FUNCTION app_private.landlord_settlement_compute_v1(
  p_building_id uuid,
  p_month       date
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO ''
AS $fn$
  WITH cfg AS (
    SELECT o.building_id, o.manager_percent, o.landlord_account_ids, o.effective_from
      FROM app_private.landlord_operations o
     WHERE o.building_id = p_building_id
  ),
  ky AS (
    SELECT pg_catalog.date_trunc('month', p_month)::date AS dau,
           (pg_catalog.date_trunc('month', p_month) + interval '1 month')::date AS sau
  ),
  phieu AS (
    SELECT v.id, v.code, v.voucher_date, v.type::text AS loai, v.name,
           v.account_id, a.name AS so_quy, v.approval_status,
           v.business_result_accounting AS kqkd, v.total_amount,
           COALESCE(v.account_id = ANY (cfg.landlord_account_ids), false) AS ben_chu_nha
      FROM cfg
      CROSS JOIN ky
      JOIN public.income_expenses v
        ON v.building_id = cfg.building_id
       AND v.deleted_at IS NULL
       AND v.voucher_date >= ky.dau
       AND v.voucher_date < ky.sau
       AND v.approval_status IN ('APPROVED', 'UNAPPROVED')
      LEFT JOIN public.accounts a ON a.id = v.account_id
  ),
  dong AS (
    -- dòng tính KQKD, đúng vị ngữ của fa_accrual_allocations
    SELECT p.id, 'KQKD'::text AS nhom,
           COALESCE(i.amount, i.unit_price * i.quantity)::numeric AS so_tien
      FROM phieu p
      JOIN public.income_expense_items i ON i.income_expense_id = p.id
     WHERE p.kqkd IS DISTINCT FROM false
       AND (p.kqkd IS TRUE OR i.accounting_class = 'PNL')
    UNION ALL
    -- phiếu không có dòng hạng mục: lấy cả phiếu, như canonical
    SELECT p.id, 'KQKD'::text, COALESCE(p.total_amount, 0)::numeric
      FROM phieu p
     WHERE p.kqkd IS DISTINCT FROM false
       AND NOT EXISTS (SELECT 1 FROM public.income_expense_items i WHERE i.income_expense_id = p.id)
    UNION ALL
    -- cọc: chỉ để hiển thị, không vào quyết toán
    SELECT p.id, 'COC'::text, COALESCE(i.amount, i.unit_price * i.quantity)::numeric
      FROM phieu p
      JOIN public.income_expense_items i ON i.income_expense_id = p.id
     WHERE i.accounting_class = 'DEPOSIT'
       AND p.kqkd IS NOT TRUE
  ),
  gop AS (
    SELECT d.id, d.nhom, sum(d.so_tien) AS so_tien
      FROM dong d
     GROUP BY d.id, d.nhom
  ),
  ct AS (
    SELECT p.id, p.code, p.voucher_date, p.loai, p.name, p.account_id, p.so_quy,
           p.approval_status, p.ben_chu_nha, g.nhom, g.so_tien
      FROM phieu p
      JOIN gop g ON g.id = p.id
  ),
  so AS (
    SELECT
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'APPROVED' AND loai = 'INCOME'  AND ben_chu_nha), 0)     AS chu_nha_thu,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'APPROVED' AND loai = 'INCOME'  AND NOT ben_chu_nha), 0) AS quan_ly_thu,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'APPROVED' AND loai = 'EXPENSE' AND ben_chu_nha), 0)     AS chu_nha_chi,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'APPROVED' AND loai = 'EXPENSE' AND NOT ben_chu_nha), 0) AS quan_ly_chi,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'COC' AND approval_status = 'APPROVED' AND loai = 'INCOME'), 0)  AS coc_thu,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'COC' AND approval_status = 'APPROVED' AND loai = 'EXPENSE'), 0) AS coc_chi,
      count(DISTINCT id) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'UNAPPROVED') AS cho_duyet_so_phieu,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'UNAPPROVED' AND loai = 'INCOME'), 0)  AS cho_duyet_thu,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'UNAPPROVED' AND loai = 'EXPENSE'), 0) AS cho_duyet_chi
      FROM ct
  ),
  kq AS (
    SELECT so.*,
           so.chu_nha_thu + so.quan_ly_thu AS doanh_thu,
           so.chu_nha_chi + so.quan_ly_chi AS chi_phi,
           so.chu_nha_thu + so.quan_ly_thu - so.chu_nha_chi - so.quan_ly_chi AS loi_nhuan,
           cfg.manager_percent
      FROM so CROSS JOIN cfg
  ),
  chia AS (
    SELECT kq.*,
           CASE WHEN kq.loi_nhuan > 0
                THEN pg_catalog.round(kq.loi_nhuan * kq.manager_percent / 100)
                ELSE 0::numeric END AS phan_quan_ly
      FROM kq
  ),
  vet AS (
    SELECT pg_catalog.md5(
             COALESCE((SELECT pg_catalog.string_agg(
                         pg_catalog.concat_ws('|', ct.id, ct.approval_status, ct.account_id,
                                              ct.loai, ct.nhom, ct.so_tien, ct.voucher_date),
                         ';' ORDER BY ct.id, ct.nhom)
                         FROM ct), '')
             || '#' ||
             (SELECT pg_catalog.concat_ws('|', cfg.manager_percent,
                       pg_catalog.array_to_string(
                         ARRAY(SELECT x FROM pg_catalog.unnest(cfg.landlord_account_ids) AS x ORDER BY x), ','))
                FROM cfg)
           ) AS source_hash
  )
  SELECT pg_catalog.jsonb_build_object(
           'building_id', p_building_id,
           'period_month', (SELECT dau FROM ky),
           'manager_percent', chia.manager_percent,
           'totals', pg_catalog.jsonb_build_object(
              'landlord_collected', chia.chu_nha_thu,
              'manager_collected',  chia.quan_ly_thu,
              'revenue',            chia.doanh_thu,
              'landlord_paid',      chia.chu_nha_chi,
              'manager_paid',       chia.quan_ly_chi,
              'expense',            chia.chi_phi,
              'profit',             chia.loi_nhuan,
              'manager_share',      chia.phan_quan_ly,
              'landlord_share',     chia.loi_nhuan - chia.phan_quan_ly,
              'landlord_owes_manager', chia.phan_quan_ly + chia.quan_ly_chi - chia.quan_ly_thu),
           'deposits', pg_catalog.jsonb_build_object(
              'received', chia.coc_thu,
              'paid_out', chia.coc_chi),
           'pending', pg_catalog.jsonb_build_object(
              'voucher_count', chia.cho_duyet_so_phieu,
              'income', chia.cho_duyet_thu,
              'expense', chia.cho_duyet_chi),
           'vouchers', COALESCE((
              SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                       'id', ct.id,
                       'code', ct.code,
                       'voucher_date', ct.voucher_date,
                       'type', ct.loai,
                       'name', ct.name,
                       'account_name', ct.so_quy,
                       'side', CASE WHEN ct.ben_chu_nha THEN 'LANDLORD' ELSE 'MANAGER' END,
                       'group', CASE WHEN ct.nhom = 'COC' THEN 'DEPOSIT' ELSE 'PNL' END,
                       'status', ct.approval_status,
                       'amount', ct.so_tien)
                     ORDER BY ct.voucher_date, ct.code, ct.nhom)
                FROM ct), '[]'::jsonb),
           'source_hash', vet.source_hash)
    FROM chia CROSS JOIN vet;
$fn$;

REVOKE ALL ON FUNCTION app_private.landlord_current_month_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.landlord_actor_can_manage_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.landlord_settlement_compute_v1(uuid, date) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Dựng gói dữ liệu cho màn (dùng chung cho màn quản trị và link chủ nhà).
--    p_public = true: bỏ id nội bộ (phiếu, người thao tác) khỏi gói.

CREATE OR REPLACE FUNCTION app_private.landlord_strip_public_v1(p_statement jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path TO ''
AS $fn$
  SELECT CASE
    WHEN p_statement IS NULL THEN NULL
    ELSE pg_catalog.jsonb_set(
           p_statement - 'building_id',
           '{vouchers}',
           COALESCE((SELECT pg_catalog.jsonb_agg(e.value - 'id' ORDER BY e.ordinality)
                       FROM pg_catalog.jsonb_array_elements(p_statement->'vouchers') WITH ORDINALITY AS e),
                    '[]'::jsonb))
  END;
$fn$;

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
  v_pending  integer;
  v_blockers jsonb := '[]'::jsonb;
  v_closed   jsonb;
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
      'can_close', false,
      'close_blockers', '[]'::jsonb);
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
    v_closed := pg_catalog.jsonb_build_object(
      'revision', v_last.revision,
      'closed_at', v_last.created_at,
      'note', v_last.reason,
      'closed_by_name', CASE WHEN p_public THEN NULL ELSE (
         SELECT COALESCE(NULLIF(pg_catalog.btrim(p.full_name), ''), p.email)
           FROM public.profiles p WHERE p.id = v_last.actor) END);
  ELSE
    v_status := 'OPEN';
    v_stmt := v_live;
    v_closed := NULL;
  END IF;

  v_pending := COALESCE((v_live->'pending'->>'voucher_count')::integer, 0);
  IF v_status = 'OPEN' THEN
    IF v_month >= v_now THEN
      v_blockers := v_blockers || pg_catalog.to_jsonb('MONTH_NOT_ENDED'::text);
    END IF;
    IF v_pending > 0 THEN
      v_blockers := v_blockers || pg_catalog.to_jsonb('PENDING_VOUCHERS'::text);
    END IF;
    IF NOT v_cfg.is_active THEN
      v_blockers := v_blockers || pg_catalog.to_jsonb('INACTIVE'::text);
    END IF;
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
    'is_stale', v_status = 'CLOSED' AND v_last.source_hash IS DISTINCT FROM (v_live->>'source_hash'),
    'closed', v_closed,
    'can_close', NOT p_public AND v_status = 'OPEN' AND pg_catalog.jsonb_array_length(v_blockers) = 0,
    'close_blockers', CASE WHEN p_public THEN '[]'::jsonb ELSE v_blockers END);
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.landlord_settlement_overview_payload_v1(
  p_building_id uuid,
  p_public      boolean
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO ''
AS $fn$
DECLARE
  v_cfg          app_private.landlord_operations%ROWTYPE;
  v_now          date := app_private.landlord_current_month_v1();
  v_name         text;
  v_m            date;
  v_live         jsonb;
  v_last         app_private.landlord_settlement_closes%ROWTYPE;
  v_closed       boolean;
  v_stmt         jsonb;
  v_net          numeric;
  v_months       jsonb := '[]'::jsonb;
  v_closed_net   numeric := 0;
  v_open_net     numeric := 0;
  v_paid_l       numeric;
  v_paid_m       numeric;
  v_payments     jsonb;
BEGIN
  SELECT * INTO v_cfg FROM app_private.landlord_operations o WHERE o.building_id = p_building_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT b.name INTO v_name FROM public.buildings b WHERE b.id = p_building_id;

  v_m := v_cfg.effective_from;
  WHILE v_m <= v_now LOOP
    v_live := app_private.landlord_settlement_compute_v1(p_building_id, v_m);
    SELECT * INTO v_last
      FROM app_private.landlord_settlement_closes c
     WHERE c.building_id = p_building_id AND c.period_month = v_m
     ORDER BY c.revision DESC
     LIMIT 1;
    v_closed := FOUND AND v_last.action = 'CLOSE';
    v_stmt := CASE WHEN v_closed THEN v_last.snapshot ELSE v_live END;
    v_net := COALESCE((v_stmt->'totals'->>'landlord_owes_manager')::numeric, 0);
    IF v_closed THEN
      v_closed_net := v_closed_net + v_net;
    ELSE
      v_open_net := v_open_net + v_net;
    END IF;
    v_months := v_months || pg_catalog.jsonb_build_object(
      'period_month', v_m,
      'status', CASE WHEN v_closed THEN 'CLOSED' ELSE 'OPEN' END,
      'is_stale', v_closed AND v_last.source_hash IS DISTINCT FROM (v_live->>'source_hash'),
      'is_current_month', v_m = v_now,
      'revenue', v_stmt->'totals'->'revenue',
      'expense', v_stmt->'totals'->'expense',
      'profit', v_stmt->'totals'->'profit',
      'manager_share', v_stmt->'totals'->'manager_share',
      'landlord_owes_manager', v_net,
      'pending_count', COALESCE((v_live->'pending'->>'voucher_count')::integer, 0));
    v_m := (v_m + interval '1 month')::date;
  END LOOP;

  SELECT COALESCE(sum(p.amount) FILTER (WHERE p.direction = 'LANDLORD_TO_MANAGER'), 0),
         COALESCE(sum(p.amount) FILTER (WHERE p.direction = 'MANAGER_TO_LANDLORD'), 0)
    INTO v_paid_l, v_paid_m
    FROM app_private.landlord_settlement_payments p
   WHERE p.building_id = p_building_id AND p.voided_at IS NULL;

  SELECT COALESCE(pg_catalog.jsonb_agg(
           CASE WHEN p_public THEN
             pg_catalog.jsonb_build_object(
               'paid_on', p.paid_on, 'direction', p.direction, 'amount', p.amount, 'note', p.note)
           ELSE
             pg_catalog.jsonb_build_object(
               'id', p.id, 'paid_on', p.paid_on, 'direction', p.direction, 'amount', p.amount,
               'note', p.note, 'created_at', p.created_at,
               'voided', p.voided_at IS NOT NULL, 'void_reason', p.void_reason)
           END
           ORDER BY p.paid_on, p.created_at), '[]'::jsonb)
    INTO v_payments
    FROM app_private.landlord_settlement_payments p
   WHERE p.building_id = p_building_id
     AND (NOT p_public OR p.voided_at IS NULL);

  RETURN pg_catalog.jsonb_build_object(
    'building_name', v_name,
    'landlord_name', v_cfg.landlord_name,
    'manager_percent', v_cfg.manager_percent,
    'effective_from', v_cfg.effective_from,
    'is_active', v_cfg.is_active,
    'current_month', v_now,
    'months', v_months,
    'payments', v_payments,
    'totals', pg_catalog.jsonb_build_object(
      'closed_net', v_closed_net,
      'open_net', v_open_net,
      'paid_by_landlord', v_paid_l,
      'paid_by_manager', v_paid_m,
      'balance_closed', v_closed_net - v_paid_l + v_paid_m,
      'balance_with_open', v_closed_net + v_open_net - v_paid_l + v_paid_m));
END
$fn$;

REVOKE ALL ON FUNCTION app_private.landlord_strip_public_v1(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.landlord_settlement_month_payload_v1(uuid, date, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.landlord_settlement_overview_payload_v1(uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. RPC đọc cho chủ công ty / super admin.

CREATE OR REPLACE FUNCTION public.landlord_operations_list_v1()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_super boolean;
  v_candidates jsonb;
  v_operations jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  v_super := public.is_super_admin();

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'building_id', b.id,
           'building_name', b.name,
           'organization_id', b.organization_id,
           'configured', o.building_id IS NOT NULL) ORDER BY b.name_sort NULLS LAST, b.name), '[]'::jsonb)
    INTO v_candidates
    FROM public.buildings b
    LEFT JOIN app_private.landlord_operations o ON o.building_id = b.id
   WHERE b.deleted_at IS NULL
     AND NOT COALESCE(b.is_virtual, false)
     AND (v_super OR COALESCE(b.organization_id = ANY (public.my_org_ids()), false))
     AND app_private.landlord_actor_can_manage_v1(b.id);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'building_id', o.building_id,
           'building_name', b.name,
           'organization_id', o.organization_id,
           'landlord_name', o.landlord_name,
           'manager_percent', o.manager_percent,
           'effective_from', o.effective_from,
           'is_active', o.is_active) ORDER BY b.name_sort NULLS LAST, b.name), '[]'::jsonb)
    INTO v_operations
    FROM app_private.landlord_operations o
    JOIN public.buildings b ON b.id = o.building_id AND b.deleted_at IS NULL
   WHERE app_private.landlord_actor_can_manage_v1(o.building_id);

  RETURN jsonb_build_object(
    'can_manage', jsonb_array_length(v_candidates) > 0,
    'operations', v_operations,
    'candidate_buildings', v_candidates);
END
$fn$;

CREATE OR REPLACE FUNCTION public.landlord_operation_options_v1(p_building_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_org uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT app_private.landlord_actor_can_manage_v1(p_building_id) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xem và quyết toán toà vận hành'
      USING ERRCODE = '42501';
  END IF;
  SELECT b.organization_id INTO v_org FROM public.buildings b WHERE b.id = p_building_id;

  RETURN jsonb_build_object(
    'current', (
      SELECT jsonb_build_object(
               'landlord_name', o.landlord_name,
               'manager_percent', o.manager_percent,
               'effective_from', o.effective_from,
               'landlord_account_ids', to_jsonb(o.landlord_account_ids),
               'note', o.note,
               'is_active', o.is_active,
               'updated_at', o.updated_at)
        FROM app_private.landlord_operations o WHERE o.building_id = p_building_id),
    -- gợi ý sổ chủ nhà: sổ nhận nhiều phiếu thu của toà trong 120 ngày gần nhất lên đầu
    'accounts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', a.id,
               'name', a.name,
               'code', a.code,
               'is_virtual', COALESCE(a.is_virtual, false),
               'income_count_120d', u.n) ORDER BY u.n DESC, a.name)
        FROM public.accounts a
        CROSS JOIN LATERAL (
          SELECT count(*)::integer AS n
            FROM public.income_expenses v
           WHERE v.account_id = a.id
             AND v.building_id = p_building_id
             AND v.type::text = 'INCOME'
             AND v.deleted_at IS NULL
             AND v.voucher_date >= (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 120
        ) u
       WHERE a.organization_id = v_org
         AND a.deleted_at IS NULL), '[]'::jsonb),
    'history', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'created_at', h.created_at,
               'actor_name', (SELECT COALESCE(NULLIF(btrim(p.full_name), ''), p.email)
                                FROM public.profiles p WHERE p.id = h.actor),
               'before', h.before,
               'after', h.after) ORDER BY h.created_at DESC)
        FROM (SELECT * FROM app_private.landlord_operation_changes c
               WHERE c.building_id = p_building_id
               ORDER BY c.created_at DESC LIMIT 20) h), '[]'::jsonb));
END
$fn$;

CREATE OR REPLACE FUNCTION public.landlord_settlement_month_v1(p_building_id uuid, p_month date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_payload jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT app_private.landlord_actor_can_manage_v1(p_building_id) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xem và quyết toán toà vận hành'
      USING ERRCODE = '42501';
  END IF;
  v_payload := app_private.landlord_settlement_month_payload_v1(p_building_id, p_month, false);
  IF v_payload IS NULL THEN
    RAISE EXCEPTION 'Toà này chưa cài đặt vận hành cho chủ nhà' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_payload;
END
$fn$;

CREATE OR REPLACE FUNCTION public.landlord_settlement_overview_v1(p_building_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_payload jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT app_private.landlord_actor_can_manage_v1(p_building_id) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xem và quyết toán toà vận hành'
      USING ERRCODE = '42501';
  END IF;
  v_payload := app_private.landlord_settlement_overview_payload_v1(p_building_id, false);
  IF v_payload IS NULL THEN
    RAISE EXCEPTION 'Toà này chưa cài đặt vận hành cho chủ nhà' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_payload;
END
$fn$;

CREATE OR REPLACE FUNCTION public.landlord_share_links_v1(p_building_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
BEGIN
  IF auth.uid() IS NULL OR NOT app_private.landlord_actor_can_manage_v1(p_building_id) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xem và quyết toán toà vận hành'
      USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'token', l.token,
             'label', l.label,
             'created_at', l.created_at,
             'revoked_at', l.revoked_at) ORDER BY l.created_at DESC)
      FROM app_private.landlord_share_links l
     WHERE l.building_id = p_building_id), '[]'::jsonb);
END
$fn$;

-- ---------------------------------------------------------------------------
-- 9. RPC ghi cho chủ công ty / super admin.

CREATE OR REPLACE FUNCTION public.landlord_operation_upsert_v1(
  p_building_id          uuid,
  p_landlord_name        text,
  p_manager_percent      numeric,
  p_effective_from       date,
  p_landlord_account_ids uuid[],
  p_note                 text DEFAULT NULL,
  p_is_active            boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_name    text := NULLIF(btrim(COALESCE(p_landlord_name, '')), '');
  v_note    text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_from    date := date_trunc('month', p_effective_from)::date;
  v_ids     uuid[];
  v_bad     integer;
  v_before  jsonb;
  v_after   jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT app_private.landlord_actor_can_manage_v1(p_building_id) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xem và quyết toán toà vận hành'
      USING ERRCODE = '42501';
  END IF;
  SELECT b.organization_id INTO v_org FROM public.buildings b WHERE b.id = p_building_id;

  IF v_name IS NULL OR length(v_name) > 120 THEN
    RAISE EXCEPTION 'Tên chủ nhà phải có, tối đa 120 ký tự' USING ERRCODE = '22023';
  END IF;
  IF p_manager_percent IS NULL OR p_manager_percent < 0 OR p_manager_percent > 100
     OR p_manager_percent <> round(p_manager_percent, 2) THEN
    RAISE EXCEPTION 'Tỷ lệ quản lý phải từ 0 đến 100, tối đa 2 chữ số thập phân' USING ERRCODE = '22023';
  END IF;
  IF v_from IS NULL THEN
    RAISE EXCEPTION 'Thiếu tháng bắt đầu áp dụng' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN
    RAISE EXCEPTION 'Ghi chú tối đa 500 ký tự' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}'::uuid[]) INTO v_ids
    FROM unnest(COALESCE(p_landlord_account_ids, '{}'::uuid[])) AS x
   WHERE x IS NOT NULL;
  IF cardinality(v_ids) = 0 OR cardinality(v_ids) > 20 THEN
    RAISE EXCEPTION 'Chọn từ 1 đến 20 sổ quỹ của chủ nhà' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_bad
    FROM unnest(v_ids) AS x
   WHERE NOT EXISTS (SELECT 1 FROM public.accounts a
                      WHERE a.id = x AND a.organization_id = v_org AND a.deleted_at IS NULL);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Có sổ quỹ không thuộc công ty của toà hoặc đã xoá' USING ERRCODE = '22023';
  END IF;

  -- khoá cùng chìa với chốt tháng: không đổi cấu hình giữa lúc đang chốt
  PERFORM pg_advisory_xact_lock(hashtextextended('landlord_settlement:' || p_building_id::text, 0));

  SELECT to_jsonb(o) - 'created_by' - 'updated_by' INTO v_before
    FROM app_private.landlord_operations o WHERE o.building_id = p_building_id;

  INSERT INTO app_private.landlord_operations AS o
    (building_id, organization_id, landlord_name, manager_percent, effective_from,
     landlord_account_ids, note, is_active, created_by, updated_by)
  VALUES
    (p_building_id, v_org, v_name, p_manager_percent, v_from,
     v_ids, v_note, COALESCE(p_is_active, true), v_actor, v_actor)
  ON CONFLICT (building_id) DO UPDATE
     SET landlord_name = EXCLUDED.landlord_name,
         manager_percent = EXCLUDED.manager_percent,
         effective_from = EXCLUDED.effective_from,
         landlord_account_ids = EXCLUDED.landlord_account_ids,
         note = EXCLUDED.note,
         is_active = EXCLUDED.is_active,
         updated_by = v_actor,
         updated_at = clock_timestamp();

  SELECT to_jsonb(o) - 'created_by' - 'updated_by' INTO v_after
    FROM app_private.landlord_operations o WHERE o.building_id = p_building_id;

  IF v_before IS DISTINCT FROM v_after THEN
    INSERT INTO app_private.landlord_operation_changes (organization_id, building_id, actor, before, after)
    VALUES (v_org, p_building_id, v_actor, v_before, v_after);
  END IF;

  RETURN jsonb_build_object('building_id', p_building_id, 'created', v_before IS NULL);
END
$fn$;

CREATE OR REPLACE FUNCTION public.landlord_settlement_close_v1(
  p_building_id   uuid,
  p_month         date,
  p_expected_hash text,
  p_note          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_month date := date_trunc('month', p_month)::date;
  v_now   date := app_private.landlord_current_month_v1();
  v_cfg   app_private.landlord_operations%ROWTYPE;
  v_live  jsonb;
  v_last  app_private.landlord_settlement_closes%ROWTYPE;
  v_has   boolean;
  v_note  text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_rev   integer;
  v_pending integer;
BEGIN
  IF auth.uid() IS NULL OR NOT app_private.landlord_actor_can_manage_v1(p_building_id) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xem và quyết toán toà vận hành'
      USING ERRCODE = '42501';
  END IF;
  IF v_month IS NULL THEN
    RAISE EXCEPTION 'Thiếu tháng cần chốt' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN
    RAISE EXCEPTION 'Ghi chú tối đa 1000 ký tự' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('landlord_settlement:' || p_building_id::text, 0));

  SELECT * INTO v_cfg FROM app_private.landlord_operations o WHERE o.building_id = p_building_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Toà này chưa cài đặt vận hành cho chủ nhà' USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_cfg.is_active THEN
    RAISE EXCEPTION 'Toà đang ngừng áp dụng vận hành cho chủ nhà' USING ERRCODE = '55000';
  END IF;
  IF v_month < v_cfg.effective_from THEN
    RAISE EXCEPTION 'Tháng % trước tháng bắt đầu áp dụng', to_char(v_month, 'MM/YYYY') USING ERRCODE = '22023';
  END IF;
  IF v_month >= v_now THEN
    RAISE EXCEPTION 'Tháng % chưa kết thúc — chỉ chốt được tháng đã qua', to_char(v_month, 'MM/YYYY')
      USING ERRCODE = '55000';
  END IF;

  v_live := app_private.landlord_settlement_compute_v1(p_building_id, v_month);
  v_pending := COALESCE((v_live->'pending'->>'voucher_count')::integer, 0);

  SELECT * INTO v_last
    FROM app_private.landlord_settlement_closes c
   WHERE c.building_id = p_building_id AND c.period_month = v_month
   ORDER BY c.revision DESC
   LIMIT 1;
  v_has := FOUND;

  IF v_has AND v_last.action = 'CLOSE' THEN
    IF v_last.source_hash = v_live->>'source_hash' THEN
      RETURN jsonb_build_object('status', 'ALREADY_CLOSED', 'revision', v_last.revision);
    END IF;
    RAISE EXCEPTION 'Tháng % đã chốt nhưng phiếu đã thay đổi — mở chốt rồi chốt lại', to_char(v_month, 'MM/YYYY')
      USING ERRCODE = '55000';
  END IF;
  IF v_pending > 0 THEN
    RAISE EXCEPTION 'Còn % phiếu chờ duyệt trong tháng % — duyệt hoặc huỷ trước khi chốt',
      v_pending, to_char(v_month, 'MM/YYYY') USING ERRCODE = '55000';
  END IF;
  IF p_expected_hash IS DISTINCT FROM v_live->>'source_hash' THEN
    RAISE EXCEPTION 'Số liệu vừa thay đổi — tải lại màn rồi chốt' USING ERRCODE = '40001';
  END IF;

  v_rev := COALESCE(CASE WHEN v_has THEN v_last.revision END, 0) + 1;
  INSERT INTO app_private.landlord_settlement_closes
    (organization_id, building_id, period_month, revision, action,
     snapshot, source_hash, net_amount, reason, actor)
  VALUES
    (v_cfg.organization_id, p_building_id, v_month, v_rev, 'CLOSE',
     v_live, v_live->>'source_hash', (v_live->'totals'->>'landlord_owes_manager')::numeric, v_note, v_actor);

  RETURN jsonb_build_object('status', 'CLOSED', 'revision', v_rev);
END
$fn$;

CREATE OR REPLACE FUNCTION public.landlord_settlement_reopen_v1(
  p_building_id uuid,
  p_month       date,
  p_reason      text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor  uuid := auth.uid();
  v_month  date := date_trunc('month', p_month)::date;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_last   app_private.landlord_settlement_closes%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT app_private.landlord_actor_can_manage_v1(p_building_id) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xem và quyết toán toà vận hành'
      USING ERRCODE = '42501';
  END IF;
  IF v_reason IS NULL OR length(v_reason) < 8 OR length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'Lý do mở chốt từ 8 đến 1000 ký tự' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('landlord_settlement:' || p_building_id::text, 0));

  SELECT * INTO v_last
    FROM app_private.landlord_settlement_closes c
   WHERE c.building_id = p_building_id AND c.period_month = v_month
   ORDER BY c.revision DESC
   LIMIT 1;
  IF NOT FOUND OR v_last.action <> 'CLOSE' THEN
    RETURN jsonb_build_object('status', 'ALREADY_OPEN');
  END IF;

  INSERT INTO app_private.landlord_settlement_closes
    (organization_id, building_id, period_month, revision, action, reason, actor)
  VALUES
    (v_last.organization_id, p_building_id, v_month, v_last.revision + 1, 'REOPEN', v_reason, v_actor);

  RETURN jsonb_build_object('status', 'REOPENED', 'revision', v_last.revision + 1);
END
$fn$;

CREATE OR REPLACE FUNCTION public.landlord_settlement_add_payment_v1(
  p_building_id     uuid,
  p_paid_on         date,
  p_direction       text,
  p_amount          numeric,
  p_note            text,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_cfg   app_private.landlord_operations%ROWTYPE;
  v_note  text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_key   text := btrim(COALESCE(p_idempotency_key, ''));
  v_old   app_private.landlord_settlement_payments%ROWTYPE;
  v_id    uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT app_private.landlord_actor_can_manage_v1(p_building_id) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xem và quyết toán toà vận hành'
      USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_cfg FROM app_private.landlord_operations o WHERE o.building_id = p_building_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Toà này chưa cài đặt vận hành cho chủ nhà' USING ERRCODE = 'P0002';
  END IF;
  IF p_direction IS NULL OR p_direction NOT IN ('LANDLORD_TO_MANAGER', 'MANAGER_TO_LANDLORD') THEN
    RAISE EXCEPTION 'Chiều thanh toán không hợp lệ' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount) THEN
    RAISE EXCEPTION 'Số tiền phải là số nguyên đồng lớn hơn 0' USING ERRCODE = '22023';
  END IF;
  IF p_paid_on IS NULL THEN
    RAISE EXCEPTION 'Thiếu ngày thanh toán' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN
    RAISE EXCEPTION 'Ghi chú tối đa 500 ký tự' USING ERRCODE = '22023';
  END IF;
  IF length(v_key) < 8 OR length(v_key) > 200 THEN
    RAISE EXCEPTION 'Thiếu khoá chống bấm trùng' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_old
    FROM app_private.landlord_settlement_payments p
   WHERE p.organization_id = v_cfg.organization_id AND p.idempotency_key = v_key;
  IF FOUND THEN
    IF v_old.building_id = p_building_id AND v_old.paid_on = p_paid_on
       AND v_old.direction = p_direction AND v_old.amount = p_amount
       AND v_old.note IS NOT DISTINCT FROM v_note THEN
      RETURN jsonb_build_object('id', v_old.id, 'status', 'REPLAYED');
    END IF;
    RAISE EXCEPTION 'Khoá chống bấm trùng đã dùng cho một lần ghi khác' USING ERRCODE = '23505';
  END IF;

  BEGIN
    INSERT INTO app_private.landlord_settlement_payments
      (organization_id, building_id, paid_on, direction, amount, note, idempotency_key, created_by)
    VALUES
      (v_cfg.organization_id, p_building_id, p_paid_on, p_direction, p_amount, v_note, v_key, v_actor)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    -- hai lần bấm cùng khoá chạy song song: lần sau đọc lại kết quả lần trước
    SELECT * INTO v_old
      FROM app_private.landlord_settlement_payments p
     WHERE p.organization_id = v_cfg.organization_id AND p.idempotency_key = v_key;
    IF FOUND AND v_old.building_id = p_building_id AND v_old.paid_on = p_paid_on
       AND v_old.direction = p_direction AND v_old.amount = p_amount
       AND v_old.note IS NOT DISTINCT FROM v_note THEN
      RETURN jsonb_build_object('id', v_old.id, 'status', 'REPLAYED');
    END IF;
    RAISE EXCEPTION 'Khoá chống bấm trùng đã dùng cho một lần ghi khác' USING ERRCODE = '23505';
  END;

  RETURN jsonb_build_object('id', v_id, 'status', 'CREATED');
END
$fn$;

CREATE OR REPLACE FUNCTION public.landlord_settlement_void_payment_v1(
  p_payment_id uuid,
  p_reason     text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor  uuid := auth.uid();
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_row    app_private.landlord_settlement_payments%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM app_private.landlord_settlement_payments p WHERE p.id = p_payment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy khoản thanh toán' USING ERRCODE = 'P0002';
  END IF;
  IF auth.uid() IS NULL OR NOT app_private.landlord_actor_can_manage_v1(v_row.building_id) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xem và quyết toán toà vận hành'
      USING ERRCODE = '42501';
  END IF;
  IF v_row.voided_at IS NOT NULL THEN
    RETURN jsonb_build_object('id', v_row.id, 'status', 'ALREADY_VOIDED');
  END IF;
  IF v_reason IS NULL OR length(v_reason) < 8 OR length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'Lý do huỷ từ 8 đến 1000 ký tự' USING ERRCODE = '22023';
  END IF;

  UPDATE app_private.landlord_settlement_payments
     SET voided_by = v_actor, voided_at = clock_timestamp(), void_reason = v_reason
   WHERE id = v_row.id AND voided_at IS NULL;

  RETURN jsonb_build_object('id', v_row.id, 'status', 'VOIDED');
END
$fn$;

CREATE OR REPLACE FUNCTION public.landlord_share_link_create_v1(
  p_building_id uuid,
  p_label       text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_cfg   app_private.landlord_operations%ROWTYPE;
  v_label text := NULLIF(btrim(COALESCE(p_label, '')), '');
  v_token text;
BEGIN
  IF auth.uid() IS NULL OR NOT app_private.landlord_actor_can_manage_v1(p_building_id) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xem và quyết toán toà vận hành'
      USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_cfg FROM app_private.landlord_operations o WHERE o.building_id = p_building_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Toà này chưa cài đặt vận hành cho chủ nhà' USING ERRCODE = 'P0002';
  END IF;
  IF v_label IS NOT NULL AND length(v_label) > 120 THEN
    RAISE EXCEPTION 'Nhãn tối đa 120 ký tự' USING ERRCODE = '22023';
  END IF;

  -- 24 byte ngẫu nhiên ⇒ 32 ký tự base64 url-safe, không đệm
  v_token := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_');

  INSERT INTO app_private.landlord_share_links (token, organization_id, building_id, label, created_by)
  VALUES (v_token, v_cfg.organization_id, p_building_id, v_label, v_actor);

  RETURN jsonb_build_object('token', v_token);
END
$fn$;

CREATE OR REPLACE FUNCTION public.landlord_share_link_revoke_v1(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_row   app_private.landlord_share_links%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM app_private.landlord_share_links l WHERE l.token = p_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy link' USING ERRCODE = 'P0002';
  END IF;
  IF auth.uid() IS NULL OR NOT app_private.landlord_actor_can_manage_v1(v_row.building_id) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xem và quyết toán toà vận hành'
      USING ERRCODE = '42501';
  END IF;
  IF v_row.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'ALREADY_REVOKED');
  END IF;
  UPDATE app_private.landlord_share_links
     SET revoked_by = v_actor, revoked_at = clock_timestamp()
   WHERE token = p_token AND revoked_at IS NULL;
  RETURN jsonb_build_object('status', 'REVOKED');
END
$fn$;

-- ---------------------------------------------------------------------------
-- 10. RPC công khai cho chủ nhà — chỉ đọc, theo link. Token sai/thu hồi ⇒ NULL.
CREATE OR REPLACE FUNCTION public.landlord_settlement_public_v1(
  p_token text,
  p_month date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_link  app_private.landlord_share_links%ROWTYPE;
  v_cfg   app_private.landlord_operations%ROWTYPE;
  v_now   date := app_private.landlord_current_month_v1();
  v_month date;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{32,64}$' THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_link
    FROM app_private.landlord_share_links l
   WHERE l.token = p_token AND l.revoked_at IS NULL;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_cfg
    FROM app_private.landlord_operations o
   WHERE o.building_id = v_link.building_id AND o.is_active;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_month := COALESCE(date_trunc('month', p_month)::date, v_now);
  IF v_month < v_cfg.effective_from THEN
    v_month := v_cfg.effective_from;
  ELSIF v_month > v_now THEN
    v_month := v_now;
  END IF;

  RETURN jsonb_build_object(
    'overview', app_private.landlord_settlement_overview_payload_v1(v_link.building_id, true),
    'month', app_private.landlord_settlement_month_payload_v1(v_link.building_id, v_month, true));
END
$fn$;

-- ---------------------------------------------------------------------------
-- 11. Quyền gọi.
REVOKE ALL ON FUNCTION public.landlord_operations_list_v1() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_operation_options_v1(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_settlement_month_v1(uuid, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_settlement_overview_v1(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_share_links_v1(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_operation_upsert_v1(uuid, text, numeric, date, uuid[], text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_settlement_close_v1(uuid, date, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_settlement_reopen_v1(uuid, date, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_settlement_add_payment_v1(uuid, date, text, numeric, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_settlement_void_payment_v1(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_share_link_create_v1(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_share_link_revoke_v1(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_settlement_public_v1(text, date) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.landlord_operations_list_v1() TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_operation_options_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_settlement_month_v1(uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_settlement_overview_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_share_links_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_operation_upsert_v1(uuid, text, numeric, date, uuid[], text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_settlement_close_v1(uuid, date, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_settlement_reopen_v1(uuid, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_settlement_add_payment_v1(uuid, date, text, numeric, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_settlement_void_payment_v1(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_share_link_create_v1(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_share_link_revoke_v1(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_settlement_public_v1(text, date) TO anon, authenticated;

COMMIT;
NOTIFY pgrst, 'reload schema';

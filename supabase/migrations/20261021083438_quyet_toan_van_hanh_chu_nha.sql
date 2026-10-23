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
--     coc_chu_nha_giu = cọc/tiền khách trả thừa vào sổ chủ nhà − cọc/trả thừa chi từ sổ chủ nhà
--     chu_nha_tra_quan_ly = phan_quan_ly + quan_ly_chi − quan_ly_thu + coc_chu_nha_giu
--       (> 0: chủ nhà trả quản lý; < 0: quản lý trả lại chủ nhà)
--   Chứng minh: chủ nhà đang giữ (chu_nha_thu − chu_nha_chi + coc_chu_nha_giu), chỉ được
--   hưởng phan_chu_nha; cọc là tiền quản lý giữ để hoàn cho khách ⇒ phần chênh như trên.
--   Cọc/trả thừa (DEPOSIT, CUSTOMER_CREDIT) ở sổ quản lý không đổi quyết toán, chỉ hiển thị.
--   Thanh lý: cấn cọc vào khoản khách phải trả (termination.revenue) và bỏ cọc
--   (termination.forfeit_revenue) là doanh thu ở sổ ảo cấn trừ ⇒ bên quản lý (tiền cọc nằm ở
--   sổ quản lý); tiền trả thêm cho khách ngoài cọc (dòng PNL của termination.refund) là quản
--   lý chi; hoàn cọc (dòng DEPOSIT) không tính. Dòng không tính KQKD (nội bộ, tắt KQKD) vẫn
--   được liệt kê ở nhóm "không tính" để không khoản nào biến mất khỏi màn.
--   % quản lý và sổ chủ nhà theo PHIÊN BẢN tháng (landlord_operation_terms): đổi tỷ lệ chỉ áp
--   từ một tháng chưa chốt trở đi, tháng đã chốt giữ nguyên điều khoản của nó.
--   Màn quản trị kèm khối đối chiếu với KQKD toà (fa_accrual_allocations, theo kỳ) liệt kê từng
--   phiếu làm hai con số khác nhau, và cảnh báo: khoản chi cố định chưa có phiếu, phiếu ở toà
--   khác có nhắc tên toà, phiếu dùng sổ chủ nhà của toà khác, phiếu chờ duyệt trước tháng áp dụng.
--   Chặn chốt thêm khi: phiếu đã duyệt mà chưa ghi sổ quỹ, phiếu toà khác ghi vào sổ chủ nhà toà
--   này, số dư đầu kỳ chưa đối chiếu hoặc xác nhận đã hết hiệu lực (xác nhận gắn với tháng áp dụng
--   + cọc trước kỳ lúc xác nhận).
--
-- LÀM GÌ
--   1. app_private.landlord_operations (+ landlord_operation_terms, landlord_operation_changes):
--      cấu hình toà vận hành — tên chủ nhà, tháng áp dụng, số dư đầu kỳ; % quản lý và sổ quỹ
--      chủ nhà theo từng phiên bản tháng.
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
  IF to_regprocedure('public.fa_accrual_allocations(date,date,uuid[])') IS NULL THEN
    RAISE EXCEPTION 'Thiếu public.fa_accrual_allocations (đối chiếu KQKD)' USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('public.nrm_vn(text)') IS NULL
     OR to_regprocedure('public.fee_type_matches(text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu public.nrm_vn / public.fee_type_matches' USING ERRCODE = '55000';
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
  -- ngày 1 của tháng bắt đầu áp dụng thoả thuận
  effective_from       date NOT NULL CHECK (effective_from = date_trunc('month', effective_from)::date),
  note                 text CHECK (note IS NULL OR length(note) <= 500),
  is_active            boolean NOT NULL DEFAULT true,
  -- Số dư đầu kỳ (dương: chủ nhà còn phải trả quản lý) — vd cọc khách đã chuyển vào sổ chủ nhà
  -- TRƯỚC tháng áp dụng mà quản lý phải hoàn, hoặc phần hai bên còn nợ nhau trước thoả thuận.
  opening_balance      numeric(16,2) NOT NULL DEFAULT 0,
  -- đã đối chiếu số dư đầu kỳ với chủ nhà, KÈM CƠ SỞ lúc xác nhận (tháng áp dụng + cọc trước kỳ ở
  -- sổ chủ nhà). Số dư đổi, dời tháng áp dụng, hay cọc trước kỳ đổi (phiếu nhập muộn, đổi sổ) ⇒
  -- xác nhận cũ hết hiệu lực, phải đối chiếu lại.
  opening_confirmed_at timestamptz,
  opening_confirmed_by uuid,
  opening_confirmed_from date,
  opening_confirmed_pre_start numeric(16,2),
  created_by           uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by           uuid NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((opening_confirmed_at IS NULL) = (opening_confirmed_by IS NULL)),
  CHECK ((opening_confirmed_at IS NULL) = (opening_confirmed_from IS NULL)),
  CHECK ((opening_confirmed_at IS NULL) = (opening_confirmed_pre_start IS NULL))
);
CREATE INDEX IF NOT EXISTS landlord_operations_org
  ON app_private.landlord_operations (organization_id);

-- % quản lý và sổ quỹ chủ nhà theo phiên bản tháng: tháng M dùng dòng valid_from lớn nhất ≤ M.
-- Dòng sớm nhất luôn trùng effective_from. Đổi điều khoản chỉ từ một tháng chưa chốt trở đi.
CREATE TABLE IF NOT EXISTS app_private.landlord_operation_terms (
  building_id          uuid NOT NULL REFERENCES app_private.landlord_operations(building_id) ON DELETE RESTRICT,
  valid_from           date NOT NULL CHECK (valid_from = date_trunc('month', valid_from)::date),
  manager_percent      numeric(5,2) NOT NULL CHECK (manager_percent >= 0 AND manager_percent <= 100),
  -- sổ quỹ (public.accounts) của chủ nhà; phiếu ghi vào sổ khác là bên quản lý
  landlord_account_ids uuid[] NOT NULL CHECK (cardinality(landlord_account_ids) BETWEEN 1 AND 20),
  created_by           uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (building_id, valid_from)
);

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

REVOKE ALL ON app_private.landlord_operations, app_private.landlord_operation_terms,
  app_private.landlord_operation_changes,
  app_private.landlord_settlement_closes, app_private.landlord_settlement_payments,
  app_private.landlord_share_links
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE app_private.landlord_operations IS
  'Toà vận hành cho chủ nhà: chủ nhà sở hữu, quản lý nhận % LN tháng (lỗ thì 0đ). % và sổ chủ nhà ở landlord_operation_terms. Chủ chốt 21/10/2026.';
COMMENT ON TABLE app_private.landlord_operation_terms IS
  'Điều khoản theo tháng của toà vận hành: tháng M dùng dòng valid_from lớn nhất ≤ M. landlord_account_ids = sổ quỹ của chủ nhà; phiếu ở sổ khác là bên quản lý giữ. Không đổi được điều khoản của tháng đã chốt.';
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

-- Các tháng đang ở trạng thái ĐÃ CHỐT (dòng revision lớn nhất là CLOSE).
CREATE OR REPLACE FUNCTION app_private.landlord_closed_months_v1(p_building_id uuid)
RETURNS SETOF date
LANGUAGE sql
STABLE
SET search_path TO ''
AS $fn$
  SELECT c.period_month
    FROM (SELECT DISTINCT ON (x.period_month) x.period_month, x.action
            FROM app_private.landlord_settlement_closes x
           WHERE x.building_id = p_building_id
           ORDER BY x.period_month, x.revision DESC) c
   WHERE c.action = 'CLOSE';
$fn$;

-- Cọc / tiền khách trả thừa đã nằm ở sổ chủ nhà TRƯỚC tháng áp dụng (chủ nhà giữ hộ khoản quản
-- lý phải hoàn) — gợi ý số dư đầu kỳ; khác 0 thì phải xác nhận số dư đầu kỳ trước khi chốt.
CREATE OR REPLACE FUNCTION app_private.landlord_pre_start_deposits_v1(p_building_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path TO ''
AS $fn$
  SELECT COALESCE(sum(COALESCE(i.amount, i.unit_price * i.quantity)
                      * CASE WHEN v.type::text = 'EXPENSE' THEN -1 ELSE 1 END), 0)
    FROM app_private.landlord_operations o
    JOIN app_private.landlord_operation_terms t
      ON t.building_id = o.building_id AND t.valid_from = o.effective_from
    JOIN public.income_expenses v
      ON v.building_id = o.building_id
     AND v.deleted_at IS NULL
     AND v.approval_status = 'APPROVED'
     AND v.voucher_date < o.effective_from
     AND v.account_id = ANY (t.landlord_account_ids)
     AND v.business_result_accounting IS NOT TRUE
    JOIN public.income_expense_items i
      ON i.income_expense_id = v.id
     AND i.accounting_class IN ('DEPOSIT', 'CUSTOMER_CREDIT')
   WHERE o.building_id = p_building_id;
$fn$;

-- Trạng thái xác nhận số dư đầu kỳ: còn hiệu lực khi đúng tháng áp dụng và đúng số cọc trước kỳ
-- lúc xác nhận. needs_confirm = có thứ cần đối chiếu (số dư hoặc cọc trước kỳ khác 0) mà chưa có
-- xác nhận còn hiệu lực ⇒ chặn chốt.
CREATE OR REPLACE FUNCTION app_private.landlord_opening_check_v1(p_building_id uuid)
RETURNS TABLE (pre_start numeric, confirmed boolean, stale boolean, needs_confirm boolean)
LANGUAGE sql
STABLE
SET search_path TO ''
AS $fn$
  SELECT x.pre,
         o.opening_confirmed_at IS NOT NULL AND NOT s.stale,
         s.stale,
         (o.opening_balance <> 0 OR x.pre <> 0) AND (o.opening_confirmed_at IS NULL OR s.stale)
    FROM app_private.landlord_operations o
    CROSS JOIN LATERAL (SELECT app_private.landlord_pre_start_deposits_v1(o.building_id) AS pre) x
    CROSS JOIN LATERAL (
      SELECT o.opening_confirmed_at IS NOT NULL
             AND (o.opening_confirmed_from IS DISTINCT FROM o.effective_from
                  OR o.opening_confirmed_pre_start IS DISTINCT FROM x.pre) AS stale) s
   WHERE o.building_id = p_building_id;
$fn$;

-- Phiếu trong tháng của TOÀ KHÁC (kể cả toà ảo) mà ghi vào SỔ CHỦ NHÀ của toà này (điều khoản đang áp):
-- tiền trong sổ chủ nhà đổi mà quyết toán toà này không thấy ⇒ chặn chốt. Trừ phiếu của toà vận hành
-- khác cũng khai sổ đó là sổ chủ nhà của mình (cùng một chủ nhà dùng chung sổ).
CREATE OR REPLACE FUNCTION app_private.landlord_account_elsewhere_v1(p_building_id uuid, p_month date)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO ''
AS $fn$
  WITH so AS (
    SELECT o.organization_id, t.landlord_account_ids
      FROM app_private.landlord_operations o
      JOIN LATERAL (
        SELECT t.landlord_account_ids
          FROM app_private.landlord_operation_terms t
         WHERE t.building_id = o.building_id
           AND t.valid_from <= pg_catalog.date_trunc('month', p_month)::date
         ORDER BY t.valid_from DESC
         LIMIT 1) t ON true
     WHERE o.building_id = p_building_id
  ),
  p AS (
    SELECT v.code, v.voucher_date, v.type::text AS loai, v.name, ob.name AS toa_ghi,
           COALESCE(v.total_amount, 0) AS so_tien, v.approval_status
      FROM so
      JOIN public.income_expenses v
        ON v.account_id = ANY (so.landlord_account_ids)
       AND v.deleted_at IS NULL
       AND v.approval_status IN ('APPROVED', 'UNAPPROVED')
       AND v.voucher_date >= pg_catalog.date_trunc('month', p_month)::date
       AND v.voucher_date < (pg_catalog.date_trunc('month', p_month) + interval '1 month')::date
       AND v.building_id IS DISTINCT FROM p_building_id
      LEFT JOIN public.buildings ob ON ob.id = v.building_id
     -- loại trừ: toà vận hành khác mà điều khoản ĐANG ÁP ở tháng của phiếu khai sổ đó là sổ chủ nhà
     WHERE NOT EXISTS (
       SELECT 1 FROM app_private.landlord_operation_terms t2
        WHERE t2.building_id = v.building_id
          AND t2.valid_from = (SELECT max(t3.valid_from) FROM app_private.landlord_operation_terms t3
                                WHERE t3.building_id = v.building_id
                                  AND t3.valid_from <= pg_catalog.date_trunc('month', v.voucher_date)::date)
          AND v.account_id = ANY (t2.landlord_account_ids))
  )
  SELECT pg_catalog.jsonb_build_object(
           'voucher_count', (SELECT count(*) FROM p),
           'vouchers', COALESCE((
              SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                       'code', x.code, 'voucher_date', x.voucher_date, 'type', x.loai, 'name', x.name,
                       'building_name', x.toa_ghi, 'amount', x.so_tien, 'status', x.approval_status)
                     ORDER BY x.voucher_date, x.code)
                FROM (SELECT * FROM p ORDER BY p.voucher_date, p.code LIMIT 30) x), '[]'::jsonb));
$fn$;

-- Dòng KQKD của MỘT toà chia theo KỲ (chủ chốt 22/10: lợi nhuận chia % lấy theo kỳ ghi trên hạng mục,
-- khớp Báo cáo LN). BẢN CHÉP đúng luật xếp tháng của public.fa_accrual_allocations (nguồn KQKD / Báo cáo
-- LN / Chốt LN): hoá đơn hợp lệ ⇒ tháng hoá đơn; hạng mục có kỳ ⇒ chia đều theo tháng của kỳ (làm tròn
-- như canonical); kỳ ngược ⇒ tháng bắt đầu; không kỳ / phiếu không dòng ⇒ tháng của ngày phiếu; dòng có
-- hạng mục không tồn tại bị canonical bỏ (JOIN) nên ở đây cũng bỏ. Khác canonical ĐÚNG HAI điểm: không xét
-- quyền người gọi (link công khai của chủ nhà không đăng nhập — quyền do hàm gọi kiểm) và có cả phiếu chờ
-- duyệt (cột approval_status). Test PGlite so từng đồng với định nghĩa SỐNG của fa_accrual_allocations —
-- sửa luật xếp tháng ở đó mà quên sửa ở đây thì test đỏ.
CREATE OR REPLACE FUNCTION app_private.landlord_kqkd_lines_v1(
  p_building_id uuid,
  p_from        date,
  p_to          date
)
RETURNS TABLE (month date, voucher_id uuid, approval_status text, side text, amount numeric)
LANGUAGE sql
STABLE
SET search_path TO ''
AS $fn$
  WITH win AS (
    SELECT pg_catalog.date_trunc('month', p_from)::date AS w_start,
           pg_catalog.date_trunc('month', p_to)::date AS w_end
  ),
  vouchers AS (
    SELECT v.id, v.type::text AS side, v.voucher_date, v.approval_status::text AS st,
           v.total_amount, v.business_result_accounting AS override,
           CASE
             WHEN v.invoice_id IS NOT NULL AND inv.billing_month ~ '^\d{4}-\d{2}$'
             THEN pg_catalog.to_date(inv.billing_month, 'YYYY-MM')
           END AS inv_month
      FROM public.buildings b
      JOIN public.income_expenses v ON v.building_id = b.id
      LEFT JOIN public.invoices inv ON inv.id = v.invoice_id AND inv.deleted_at IS NULL
     WHERE b.id = p_building_id
       AND b.deleted_at IS NULL
       AND v.deleted_at IS NULL
       AND v.approval_status::text IN ('APPROVED', 'UNAPPROVED')
       AND v.business_result_accounting IS DISTINCT FROM false
  ),
  invoice_items AS (
    SELECT vo.inv_month AS m, vo.id, vo.st, vo.side,
           COALESCE(i.amount, i.unit_price * i.quantity)::numeric AS amt
      FROM vouchers vo
      JOIN public.income_expense_items i ON i.income_expense_id = vo.id
      JOIN public.income_expense_types t ON t.id = i.income_expense_type_id
     WHERE vo.inv_month IS NOT NULL
       AND (vo.override IS TRUE OR i.accounting_class = 'PNL')
  ),
  invoice_no_item AS (
    SELECT vo.inv_month AS m, vo.id, vo.st, vo.side, vo.total_amount AS amt
      FROM vouchers vo
     WHERE vo.inv_month IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.income_expense_items i WHERE i.income_expense_id = vo.id)
  ),
  period_items AS (
    SELECT (pg_catalog.date_trunc('month', i.start_date) + (s.k || ' month')::interval)::date AS m,
           vo.id, vo.st, vo.side,
           (pg_catalog.round(COALESCE(i.amount, i.unit_price * i.quantity) * (s.k + 1) / c.n)
            - pg_catalog.round(COALESCE(i.amount, i.unit_price * i.quantity) * s.k / c.n))::numeric AS amt
      FROM vouchers vo
      JOIN public.income_expense_items i ON i.income_expense_id = vo.id
      JOIN public.income_expense_types t ON t.id = i.income_expense_type_id
     CROSS JOIN LATERAL (
       SELECT GREATEST(
         EXTRACT(year FROM i.end_date)::int * 12 + EXTRACT(month FROM i.end_date)::int
         - EXTRACT(year FROM i.start_date)::int * 12 - EXTRACT(month FROM i.start_date)::int + 1,
         1) AS n) c
     CROSS JOIN LATERAL pg_catalog.generate_series(0, c.n - 1) AS s(k)
     WHERE vo.inv_month IS NULL
       AND (vo.override IS TRUE OR i.accounting_class = 'PNL')
       AND i.start_date IS NOT NULL
       AND i.end_date IS NOT NULL
       AND i.end_date >= i.start_date
  ),
  invalid_period_items AS (
    SELECT pg_catalog.date_trunc('month', i.start_date)::date AS m, vo.id, vo.st, vo.side,
           COALESCE(i.amount, i.unit_price * i.quantity)::numeric AS amt
      FROM vouchers vo
      JOIN public.income_expense_items i ON i.income_expense_id = vo.id
      JOIN public.income_expense_types t ON t.id = i.income_expense_type_id
     WHERE vo.inv_month IS NULL
       AND (vo.override IS TRUE OR i.accounting_class = 'PNL')
       AND i.start_date IS NOT NULL
       AND i.end_date IS NOT NULL
       AND i.end_date < i.start_date
  ),
  no_period_items AS (
    SELECT pg_catalog.date_trunc('month', vo.voucher_date)::date AS m, vo.id, vo.st, vo.side,
           COALESCE(i.amount, i.unit_price * i.quantity)::numeric AS amt
      FROM vouchers vo
      JOIN public.income_expense_items i ON i.income_expense_id = vo.id
      JOIN public.income_expense_types t ON t.id = i.income_expense_type_id
     WHERE vo.inv_month IS NULL
       AND (vo.override IS TRUE OR i.accounting_class = 'PNL')
       AND (i.start_date IS NULL OR i.end_date IS NULL)
  ),
  no_item AS (
    SELECT pg_catalog.date_trunc('month', vo.voucher_date)::date AS m, vo.id, vo.st, vo.side,
           vo.total_amount AS amt
      FROM vouchers vo
     WHERE vo.inv_month IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.income_expense_items i WHERE i.income_expense_id = vo.id)
  ),
  unioned AS (
    SELECT * FROM invoice_items
    UNION ALL SELECT * FROM invoice_no_item
    UNION ALL SELECT * FROM period_items
    UNION ALL SELECT * FROM invalid_period_items
    UNION ALL SELECT * FROM no_period_items
    UNION ALL SELECT * FROM no_item
  )
  SELECT u.m, u.id, u.st, u.side, u.amt
    FROM unioned u, win
   WHERE u.m BETWEEN win.w_start AND win.w_end;
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
    -- điều khoản (% + sổ chủ nhà) đang áp ở tháng này
    SELECT o.building_id, o.organization_id, o.effective_from,
           t.valid_from AS terms_from, t.manager_percent, t.landlord_account_ids
      FROM app_private.landlord_operations o
      JOIN LATERAL (
        SELECT t.valid_from, t.manager_percent, t.landlord_account_ids
          FROM app_private.landlord_operation_terms t
         WHERE t.building_id = o.building_id
           AND t.valid_from <= pg_catalog.date_trunc('month', p_month)::date
         ORDER BY t.valid_from DESC
         LIMIT 1) t ON true
     WHERE o.building_id = p_building_id
  ),
  -- sổ chủ nhà (MỌI phiên bản điều khoản) của TOÀ VẬN HÀNH KHÁC cùng công ty chưa xoá (kể cả đang ngừng
  -- áp dụng — sổ đó vẫn là tiền của chủ nhà kia):
  -- phiếu toà này dùng sổ đó thì không biết là chủ nhà hay quản lý giữ tiền ⇒ chặn chốt cho tới khi xử lý
  so_toa_khac AS (
    SELECT DISTINCT x.account_id
      FROM cfg
      JOIN app_private.landlord_operations o2
        ON o2.organization_id = cfg.organization_id AND o2.building_id <> cfg.building_id
      JOIN public.buildings b2 ON b2.id = o2.building_id AND b2.deleted_at IS NULL
      JOIN app_private.landlord_operation_terms t2 ON t2.building_id = o2.building_id
      CROSS JOIN LATERAL pg_catalog.unnest(t2.landlord_account_ids) AS x(account_id)
  ),
  ky AS (
    SELECT pg_catalog.date_trunc('month', p_month)::date AS dau,
           (pg_catalog.date_trunc('month', p_month) + interval '1 month')::date AS sau
  ),
  -- phiếu có NGÀY PHIẾU trong tháng: nguồn của dòng cọc / không tính và tiền thối (dòng tiền thật,
  -- không phải lãi lỗ ⇒ theo ngày tiền đi)
  ngay AS (
    SELECT v.id, v.type::text AS loai, v.business_result_accounting AS kqkd, v.total_amount,
           v.approval_status::text AS approval_status, v.change_account_id, v.change_amount
      FROM cfg
      CROSS JOIN ky
      JOIN public.income_expenses v
        ON v.building_id = cfg.building_id
       AND v.deleted_at IS NULL
       AND v.voucher_date >= ky.dau
       AND v.voucher_date < ky.sau
       AND v.approval_status::text IN ('APPROVED', 'UNAPPROVED')
  ),
  dong AS (
    -- MỌI dòng của phiếu đều vào đúng MỘT nhóm — không dòng nào rơi mất im lặng:
    --   KQKD  dòng lãi lỗ, xếp tháng THEO KỲ đúng luật fa_accrual_allocations (khớp Báo cáo LN);
    --   COC   cọc / tiền khách trả thừa — tiền giữ hộ khách, quản lý chịu trách nhiệm hoàn (theo ngày phiếu);
    --   KHAC  không tính (nội bộ, phiếu tắt KQKD, dòng không có hạng mục…) — vẫn liệt kê (theo ngày phiếu).
    SELECT l.voucher_id AS id, 'KQKD'::text AS nhom, NULL::text AS ly_do, l.amount AS so_tien
      FROM app_private.landlord_kqkd_lines_v1(p_building_id, p_month, p_month) AS l
    UNION ALL
    -- phần bù của vị ngữ KQKD canonical: dòng phiếu tắt KQKD, hoặc dòng không phải PNL khi phiếu không ép
    SELECT n.id,
           CASE WHEN i.accounting_class IN ('DEPOSIT', 'CUSTOMER_CREDIT') THEN 'COC' ELSE 'KHAC' END::text,
           CASE WHEN i.accounting_class IN ('DEPOSIT', 'CUSTOMER_CREDIT') THEN NULL
                WHEN n.kqkd IS FALSE THEN 'NOT_KQKD' ELSE 'INTERNAL' END::text,
           COALESCE(i.amount, i.unit_price * i.quantity)::numeric
      FROM ngay n
      JOIN public.income_expense_items i ON i.income_expense_id = n.id
     WHERE NOT (n.kqkd IS DISTINCT FROM false AND (n.kqkd IS TRUE OR COALESCE(i.accounting_class, '') = 'PNL'))
    UNION ALL
    -- dòng đúng vị ngữ KQKD nhưng hạng mục không tồn tại: canonical bỏ (không vào lợi nhuận) ⇒ hiện ở
    -- "không tính" để thấy được, không biến mất
    SELECT n.id, 'KHAC'::text, 'NO_CATEGORY'::text, COALESCE(i.amount, i.unit_price * i.quantity)::numeric
      FROM ngay n
      JOIN public.income_expense_items i ON i.income_expense_id = n.id
     WHERE n.kqkd IS DISTINCT FROM false AND (n.kqkd IS TRUE OR i.accounting_class = 'PNL')
       AND NOT EXISTS (SELECT 1 FROM public.income_expense_types t WHERE t.id = i.income_expense_type_id)
    UNION ALL
    -- phiếu tắt KQKD không có dòng hạng mục: lấy cả phiếu (phiếu KQKD không dòng đã nằm trong KQKD)
    SELECT n.id, 'KHAC'::text, 'NOT_KQKD'::text, COALESCE(n.total_amount, 0)::numeric
      FROM ngay n
     WHERE n.kqkd IS FALSE
       AND NOT EXISTS (SELECT 1 FROM public.income_expense_items i WHERE i.income_expense_id = n.id)
  ),
  gop AS (
    SELECT d.id, d.nhom, max(d.ly_do) AS ly_do, sum(d.so_tien) AS so_tien
      FROM dong d
     GROUP BY d.id, d.nhom
  ),
  phieu AS (
    SELECT v.id, v.code, v.voucher_date, v.type::text AS loai, v.name,
           v.account_id, a.name AS so_quy, v.approval_status::text AS approval_status,
           v.business_result_accounting AS kqkd, v.total_amount,
           COALESCE(v.system_source, '') AS nguon,
           COALESCE(v.posting_status, '') AS but_toan,
           COALESCE(v.has_restricted_item, false) AS han_che,
           COALESCE(v.account_id = ANY (cfg.landlord_account_ids), false) AS ben_chu_nha,
           (NOT COALESCE(v.account_id = ANY (cfg.landlord_account_ids), false)
            AND EXISTS (SELECT 1 FROM so_toa_khac s WHERE s.account_id = v.account_id)) AS so_toa_khac
      FROM (SELECT DISTINCT g.id FROM gop g) x
      CROSS JOIN cfg
      JOIN public.income_expenses v ON v.id = x.id
      LEFT JOIN public.accounts a ON a.id = v.account_id
  ),
  ct AS (
    SELECT p.id, p.code, p.voucher_date, p.loai, p.name, p.account_id, p.so_quy,
           p.approval_status, p.ben_chu_nha, p.nguon, p.kqkd, p.but_toan, p.han_che, p.so_toa_khac,
           g.nhom, g.ly_do, g.so_tien
      FROM phieu p
      JOIN gop g ON g.id = p.id
     WHERE g.so_tien <> 0
  ),
  -- phiếu đã duyệt nhưng bút toán sổ quỹ đã bị đảo (tiền KHÔNG còn ở sổ nào) hoặc chưa ghi sổ
  -- (UNPOSTED: tiền chưa thực vào/ra) ⇒ chặn chốt
  dao AS (
    SELECT count(DISTINCT ct.id) FILTER (WHERE ct.but_toan = 'REVERSED') AS so_phieu_dao,
           count(DISTINCT ct.id) FILTER (WHERE ct.but_toan = 'UNPOSTED') AS so_phieu_chua_ghi
      FROM ct
     WHERE ct.approval_status = 'APPROVED' AND ct.nhom IN ('KQKD', 'COC')
  ),
  du AS (
    -- tiền thối rơi vào sổ chủ nhà (theo ngày phiếu): tiền của khách, chủ nhà giữ hộ. Làm tròn KHÔNG
    -- tính — đó là phần khách trả thiếu được bỏ qua, không phải tiền mặt.
    SELECT COALESCE(sum(CASE WHEN n.change_account_id = ANY (cfg.landlord_account_ids)
                             THEN COALESCE(n.change_amount, 0) ELSE 0 END
                        * CASE WHEN n.loai = 'EXPENSE' THEN -1 ELSE 1 END)
                    FILTER (WHERE n.approval_status = 'APPROVED'), 0) AS du_chu_nha
      FROM ngay n
      CROSS JOIN cfg
  ),
  so AS (
    SELECT
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'APPROVED' AND loai = 'INCOME'  AND ben_chu_nha), 0)     AS chu_nha_thu,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'APPROVED' AND loai = 'INCOME'  AND NOT ben_chu_nha), 0) AS quan_ly_thu,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'APPROVED' AND loai = 'EXPENSE' AND ben_chu_nha), 0)     AS chu_nha_chi,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'APPROVED' AND loai = 'EXPENSE' AND NOT ben_chu_nha), 0) AS quan_ly_chi,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'COC' AND approval_status = 'APPROVED' AND loai = 'INCOME'), 0)  AS coc_thu,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'COC' AND approval_status = 'APPROVED' AND loai = 'EXPENSE'), 0) AS coc_chi,
      -- cọc/tiền trả thừa đi qua SỔ CHỦ NHÀ: chủ nhà đang giữ hộ khoản quản lý phải hoàn cho khách
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'COC' AND approval_status = 'APPROVED' AND loai = 'INCOME'  AND ben_chu_nha), 0) AS coc_chu_nha_thu,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'COC' AND approval_status = 'APPROVED' AND loai = 'EXPENSE' AND ben_chu_nha), 0) AS coc_chu_nha_chi,
      -- thanh lý hợp đồng, tách theo nguồn phiếu hệ thống sinh
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'APPROVED' AND nguon = 'termination.revenue'), 0)         AS tl_doanh_thu_tu_coc,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'APPROVED' AND nguon = 'termination.forfeit_revenue'), 0) AS tl_doanh_thu_bo_coc,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'APPROVED' AND nguon = 'termination.extra_receipt'), 0)   AS tl_khach_tra_them,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'APPROVED' AND nguon = 'termination.refund'), 0)          AS tl_tra_them_ngoai_coc,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'COC'  AND approval_status = 'APPROVED' AND nguon = 'termination.refund'), 0)          AS tl_hoan_coc,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'COC'  AND approval_status = 'APPROVED' AND nguon IN ('termination.offset', 'termination.forfeit_offset')), 0) AS tl_can_coc,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'UNAPPROVED' AND nguon = 'termination.refund'), 0)        AS tl_cho_duyet,
      count(DISTINCT id) FILTER (WHERE approval_status = 'UNAPPROVED'
                                   AND (nhom = 'KQKD' OR (nhom = 'COC' AND ben_chu_nha))) AS cho_duyet_so_phieu,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'UNAPPROVED' AND loai = 'INCOME'), 0)  AS cho_duyet_thu,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'UNAPPROVED' AND loai = 'EXPENSE'), 0) AS cho_duyet_chi,
      COALESCE(sum(CASE WHEN loai = 'EXPENSE' THEN -so_tien ELSE so_tien END)
                 FILTER (WHERE nhom = 'COC' AND approval_status = 'UNAPPROVED' AND ben_chu_nha), 0) AS cho_duyet_coc_chu_nha,
      count(DISTINCT id) FILTER (WHERE so_toa_khac AND nhom IN ('KQKD', 'COC')) AS so_phieu_so_khac,
      count(DISTINCT id) FILTER (WHERE nhom = 'KHAC') AS khac_so_phieu,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KHAC' AND loai = 'INCOME'), 0)  AS khac_thu,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KHAC' AND loai = 'EXPENSE'), 0) AS khac_chi
      FROM ct
  ),
  kq AS (
    SELECT so.*, du.du_chu_nha, dao.so_phieu_dao, dao.so_phieu_chua_ghi,
           so.chu_nha_thu + so.quan_ly_thu AS doanh_thu,
           so.chu_nha_chi + so.quan_ly_chi AS chi_phi,
           so.chu_nha_thu + so.quan_ly_thu - so.chu_nha_chi - so.quan_ly_chi AS loi_nhuan,
           cfg.manager_percent, cfg.terms_from
      FROM so CROSS JOIN cfg CROSS JOIN du CROSS JOIN dao
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
             -- chỉ dòng làm đổi số: KQKD, và cọc/trả thừa ở SỔ CHỦ NHÀ. Cọc ở sổ quản lý và dòng
             -- "không tính" đổi (vd duyệt cọc giữ chỗ) không làm tháng đã chốt hoá cũ.
             COALESCE((SELECT pg_catalog.string_agg(
                         pg_catalog.concat_ws('|', ct.id, ct.approval_status, ct.but_toan, ct.account_id,
                                              ct.loai, ct.nhom, ct.so_tien, ct.voucher_date),
                         ';' ORDER BY ct.id, ct.nhom)
                         FROM ct WHERE ct.nhom = 'KQKD' OR (ct.nhom = 'COC' AND ct.ben_chu_nha)), '')
             || '#' || (SELECT du.du_chu_nha::text FROM du)
             -- phiếu TOÀ KHÁC ghi vào sổ chủ nhà trong tháng: nhập muộn sau khi chốt cũng làm tháng "đã đổi"
             || '#' || pg_catalog.md5(COALESCE(
                  app_private.landlord_account_elsewhere_v1(p_building_id, p_month)::text, ''))
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
           'terms_from', chia.terms_from,
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
              'landlord_held_deposits', chia.coc_chu_nha_thu - chia.coc_chu_nha_chi,
              'landlord_extra_cash', chia.du_chu_nha,
              'landlord_owes_manager', chia.phan_quan_ly + chia.quan_ly_chi - chia.quan_ly_thu
                                       + chia.coc_chu_nha_thu - chia.coc_chu_nha_chi + chia.du_chu_nha),
           'reversed_voucher_count', chia.so_phieu_dao,
           'unposted_voucher_count', chia.so_phieu_chua_ghi,
           'foreign_account_voucher_count', chia.so_phieu_so_khac,
           'deposits', pg_catalog.jsonb_build_object(
              'received', chia.coc_thu,
              'paid_out', chia.coc_chi,
              'landlord_received', chia.coc_chu_nha_thu,
              'landlord_paid_out', chia.coc_chu_nha_chi),
           'termination', pg_catalog.jsonb_build_object(
              'revenue_from_deposit', chia.tl_doanh_thu_tu_coc,
              'forfeit_revenue', chia.tl_doanh_thu_bo_coc,
              'extra_receipt', chia.tl_khach_tra_them,
              'refund_beyond_deposit', chia.tl_tra_them_ngoai_coc,
              'deposit_refunded', chia.tl_hoan_coc,
              'deposit_offset', chia.tl_can_coc,
              'pending_refund', chia.tl_cho_duyet),
           'pending', pg_catalog.jsonb_build_object(
              'voucher_count', chia.cho_duyet_so_phieu,
              'income', chia.cho_duyet_thu,
              'expense', chia.cho_duyet_chi,
              -- cọc/trả thừa chờ duyệt ở sổ chủ nhà (có dấu: vào dương, ra âm)
              'landlord_deposit', chia.cho_duyet_coc_chu_nha),
           'excluded', pg_catalog.jsonb_build_object(
              'voucher_count', chia.khac_so_phieu,
              'income', chia.khac_thu,
              'expense', chia.khac_chi),
           'vouchers', COALESCE((
              SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                       'id', ct.id,
                       'code', ct.code,
                       'voucher_date', ct.voucher_date,
                       'type', ct.loai,
                       'name', ct.name,
                       'account_name', ct.so_quy,
                       'side', CASE WHEN ct.ben_chu_nha THEN 'LANDLORD' ELSE 'MANAGER' END,
                       'group', CASE ct.nhom WHEN 'COC' THEN 'DEPOSIT' WHEN 'KHAC' THEN 'EXCLUDED' ELSE 'PNL' END,
                       'source', CASE
                                   WHEN ct.nguon = 'termination.revenue' THEN 'TERMINATION_REVENUE'
                                   WHEN ct.nguon = 'termination.forfeit_revenue' THEN 'FORFEIT_REVENUE'
                                   WHEN ct.nguon = 'termination.refund' THEN 'TERMINATION_REFUND'
                                   WHEN ct.nguon IN ('termination.offset', 'termination.forfeit_offset') THEN 'DEPOSIT_OFFSET'
                                   WHEN ct.nguon = 'termination.extra_receipt' THEN 'EXTRA_RECEIPT'
                                   WHEN ct.nguon IN ('termination.rent_refund_offset', 'termination.rent_refund_revenue') THEN 'RENT_REFUND_INTERNAL'
                                   ELSE NULL END,
                       'cash_reversed', ct.approval_status = 'APPROVED' AND ct.but_toan = 'REVERSED',
                       'cash_unposted', ct.approval_status = 'APPROVED' AND ct.but_toan = 'UNPOSTED',
                       'foreign_landlord_account', ct.so_toa_khac,
                       'restricted', ct.han_che,
                       'excluded_reason', CASE WHEN ct.nhom <> 'KHAC' THEN NULL
                                               ELSE COALESCE(ct.ly_do, 'INTERNAL') END,
                       'status', ct.approval_status,
                       'amount', ct.so_tien)
                     ORDER BY ct.voucher_date, ct.code, ct.nhom)
                FROM ct), '[]'::jsonb),
           'source_hash', vet.source_hash)
    FROM chia CROSS JOIN vet;
$fn$;

REVOKE ALL ON FUNCTION app_private.landlord_current_month_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.landlord_actor_can_manage_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.landlord_closed_months_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.landlord_pre_start_deposits_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.landlord_opening_check_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.landlord_kqkd_lines_v1(uuid, date, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.landlord_settlement_compute_v1(uuid, date) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Kiểm tra quanh công thức — không đổi số quyết toán, chỉ làm lộ những gì có thể làm sai số.

-- Phiếu chờ duyệt ghi ngày TRƯỚC tháng áp dụng: duyệt xong cũng không rơi vào kỳ nào ⇒ phải
-- xem xét trước khi chốt tháng đầu tiên.
CREATE OR REPLACE FUNCTION app_private.landlord_pre_start_pending_v1(p_building_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO ''
AS $fn$
  WITH p AS (
    SELECT v.code, v.voucher_date, v.type::text AS loai, v.name, COALESCE(v.total_amount, 0) AS so_tien
      FROM app_private.landlord_operations o
      JOIN public.income_expenses v
        ON v.building_id = o.building_id
       AND v.deleted_at IS NULL
       AND v.approval_status = 'UNAPPROVED'
       AND v.voucher_date < o.effective_from
     WHERE o.building_id = p_building_id
  )
  SELECT pg_catalog.jsonb_build_object(
           'voucher_count', (SELECT count(*) FROM p),
           'income', (SELECT COALESCE(sum(p.so_tien) FILTER (WHERE p.loai = 'INCOME'), 0) FROM p),
           'expense', (SELECT COALESCE(sum(p.so_tien) FILTER (WHERE p.loai = 'EXPENSE'), 0) FROM p),
           'vouchers', COALESCE((
              SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                       'code', x.code, 'voucher_date', x.voucher_date, 'type', x.loai,
                       'name', x.name, 'amount', x.so_tien) ORDER BY x.voucher_date, x.code)
                FROM (SELECT * FROM p ORDER BY p.voucher_date DESC, p.code LIMIT 30) x), '[]'::jsonb));
$fn$;


-- Khoản LÃI LỖ có KỲ trước tháng áp dụng nhưng phiếu lập từ tháng áp dụng trở đi (đã duyệt hoặc chờ
-- duyệt): xếp theo kỳ thì thuộc giai đoạn TRƯỚC khi vận hành cho chủ nhà nên không vào tháng nào của
-- quyết toán. Chỉ đưa ra để người quyết toán thấy (vd chi điện tháng trước trả từ sổ chủ nhà) — không
-- tính, không chặn chốt (phiếu đã duyệt thì không bao giờ "xử lý xong", chặn sẽ là chặn vĩnh viễn).
CREATE OR REPLACE FUNCTION app_private.landlord_pre_start_period_v1(p_building_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO ''
AS $fn$
  WITH o AS (
    SELECT o.effective_from FROM app_private.landlord_operations o WHERE o.building_id = p_building_id
  ),
  l AS (
    SELECT l.voucher_id, l.approval_status, l.side, sum(l.amount) AS so_tien
      FROM o
      CROSS JOIN LATERAL app_private.landlord_kqkd_lines_v1(
        p_building_id, DATE '1900-01-01', (o.effective_from - interval '1 month')::date) AS l
     GROUP BY 1, 2, 3
  ),
  p AS (
    SELECT v.code, v.voucher_date, l.side AS loai, v.name, l.so_tien, l.approval_status
      FROM l
      CROSS JOIN o
      JOIN public.income_expenses v ON v.id = l.voucher_id
     WHERE v.voucher_date >= o.effective_from AND l.so_tien <> 0
  )
  SELECT pg_catalog.jsonb_build_object(
           'voucher_count', (SELECT count(*) FROM p),
           'income', (SELECT COALESCE(sum(p.so_tien) FILTER (WHERE p.loai = 'INCOME'), 0) FROM p),
           'expense', (SELECT COALESCE(sum(p.so_tien) FILTER (WHERE p.loai = 'EXPENSE'), 0) FROM p),
           'vouchers', COALESCE((
              SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                       'code', x.code, 'voucher_date', x.voucher_date, 'type', x.loai,
                       'name', x.name, 'amount', x.so_tien, 'status', x.approval_status)
                     ORDER BY x.voucher_date, x.code)
                FROM (SELECT * FROM p ORDER BY p.voucher_date DESC, p.code LIMIT 30) x), '[]'::jsonb));
$fn$;

-- Lý do chưa chốt được tháng (mã). Màn và hàm chốt dùng chung.
CREATE OR REPLACE FUNCTION app_private.landlord_close_blockers_v1(
  p_building_id uuid,
  p_month       date,
  p_live        jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO ''
AS $fn$
DECLARE
  v_cfg   app_private.landlord_operations%ROWTYPE;
  v_month date := pg_catalog.date_trunc('month', p_month)::date;
  v_b     jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_cfg FROM app_private.landlord_operations o WHERE o.building_id = p_building_id;
  IF NOT FOUND THEN
    RETURN v_b;
  END IF;
  IF v_month >= app_private.landlord_current_month_v1() THEN
    v_b := v_b || pg_catalog.to_jsonb('MONTH_NOT_ENDED'::text);
  END IF;
  IF COALESCE((p_live->'pending'->>'voucher_count')::integer, 0) > 0 THEN
    v_b := v_b || pg_catalog.to_jsonb('PENDING_VOUCHERS'::text);
  END IF;
  IF COALESCE((p_live->>'reversed_voucher_count')::integer, 0) > 0 THEN
    v_b := v_b || pg_catalog.to_jsonb('REVERSED_POSTINGS'::text);
  END IF;
  IF COALESCE((p_live->>'unposted_voucher_count')::integer, 0) > 0 THEN
    v_b := v_b || pg_catalog.to_jsonb('UNPOSTED_POSTINGS'::text);
  END IF;
  IF COALESCE((p_live->>'foreign_account_voucher_count')::integer, 0) > 0 THEN
    v_b := v_b || pg_catalog.to_jsonb('FOREIGN_LANDLORD_ACCOUNT'::text);
  END IF;
  IF COALESCE((app_private.landlord_account_elsewhere_v1(p_building_id, v_month)->>'voucher_count')::integer, 0) > 0 THEN
    v_b := v_b || pg_catalog.to_jsonb('LANDLORD_ACCOUNT_ELSEWHERE'::text);
  END IF;
  IF v_month = v_cfg.effective_from
     AND COALESCE((app_private.landlord_pre_start_pending_v1(p_building_id)->>'voucher_count')::integer, 0) > 0 THEN
    v_b := v_b || pg_catalog.to_jsonb('PRE_START_PENDING'::text);
  END IF;
  IF (SELECT c.needs_confirm FROM app_private.landlord_opening_check_v1(p_building_id) AS c) THEN
    v_b := v_b || pg_catalog.to_jsonb('OPENING_UNCONFIRMED'::text);
  END IF;
  IF NOT v_cfg.is_active THEN
    v_b := v_b || pg_catalog.to_jsonb('INACTIVE'::text);
  END IF;
  RETURN v_b;
END
$fn$;

-- Đối chiếu với KQKD toà (fa_accrual_allocations — nguồn Báo cáo LN / Chốt LN). Từ 22/10 quyết toán xếp
-- dòng lãi lỗ theo ĐÚNG luật kỳ đó (landlord_kqkd_lines_v1) nên bình thường khớp từng đồng; còn lệch chỉ
-- có thể do (1) tháng đã chốt mà phiếu đổi sau khi chốt, hoặc (2) luật xếp tháng của fa_accrual_allocations
-- đã đổi mà bản chép chưa đổi theo (lỗi kỹ thuật — màn báo ngay). Liệt kê từng phiếu lệch để không khoản
-- nào "lệch mà không ai thấy". fa_accrual_allocations tự kiểm can_access_building của người gọi.
CREATE OR REPLACE FUNCTION app_private.landlord_kqkd_bridge_v1(
  p_building_id uuid,
  p_month       date,
  p_statement   jsonb,
  p_is_stale    boolean
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO ''
AS $fn$
  WITH qt AS (
    SELECT (e->>'id')::uuid AS id,
           sum(CASE WHEN e->>'type' = 'INCOME' THEN (e->>'amount')::numeric
                    ELSE -(e->>'amount')::numeric END) AS so_tien
      FROM pg_catalog.jsonb_array_elements(COALESCE(p_statement->'vouchers', '[]'::jsonb)) AS e
     WHERE e->>'group' = 'PNL' AND e->>'status' = 'APPROVED'
     GROUP BY 1
  ),
  kq AS (
    SELECT a.voucher_id AS id,
           sum(CASE WHEN pg_catalog.upper(a.side) = 'INCOME' THEN a.amount ELSE -a.amount END) AS so_tien
      FROM public.fa_accrual_allocations(pg_catalog.date_trunc('month', p_month)::date,
                                         pg_catalog.date_trunc('month', p_month)::date,
                                         ARRAY[p_building_id]) AS a
     WHERE a.building_id = p_building_id
     GROUP BY 1
  ),
  lech AS (
    SELECT COALESCE(qt.id, kq.id) AS id,
           COALESCE(qt.so_tien, 0) AS qt_tien,
           COALESCE(kq.so_tien, 0) AS kq_tien
      FROM qt
      FULL JOIN kq ON kq.id = qt.id
     WHERE COALESCE(qt.so_tien, 0) <> COALESCE(kq.so_tien, 0)
  )
  SELECT pg_catalog.jsonb_build_object(
           'kqkd_profit', COALESCE((SELECT sum(kq.so_tien) FROM kq), 0),
           'settlement_profit', COALESCE((SELECT sum(qt.so_tien) FROM qt), 0),
           'rows', COALESCE((
              SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                       'code', v.code,
                       'voucher_date', v.voucher_date,
                       'type', v.type::text,
                       'name', v.name,
                       'settlement_amount', l.qt_tien,
                       'kqkd_amount', l.kq_tien,
                       'reason', CASE WHEN p_is_stale THEN 'CHANGED_AFTER_CLOSE' ELSE 'FORMULA_DRIFT' END)
                     ORDER BY v.voucher_date, v.code)
                FROM lech l
                JOIN public.income_expenses v ON v.id = l.id), '[]'::jsonb));
$fn$;

-- Khoản chi cố định đã khai ở "Phí cố định theo toà" (trừ ô "không áp dụng") — và điện, nước dù chưa
-- khai, trừ khi đánh dấu "không áp dụng" — mà tháng này chưa có phiếu chi nào (đã duyệt hoặc chờ
-- duyệt; ngày phiếu trong tháng hoặc kỳ dịch vụ phủ tháng) ⇒ lợi nhuận có thể đang cao hơn thật.
-- Toà vận hành cho chủ nhà không có tiền nhà ⇒ không đòi phiếu tiền nhà.
CREATE OR REPLACE FUNCTION app_private.landlord_missing_fixed_v1(p_building_id uuid, p_month date)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO ''
AS $fn$
  WITH ky AS (
    SELECT pg_catalog.date_trunc('month', p_month)::date AS dau,
           (pg_catalog.date_trunc('month', p_month) + interval '1 month')::date AS sau
  ),
  khai AS (
    SELECT f.fee_category,
           bool_or(NOT COALESCE(f.not_applicable, false)) AS co_ap_dung,
           bool_or(COALESCE(f.not_applicable, false)) AS co_khong_ap_dung
      FROM public.building_fee_accounts f
     WHERE f.building_id = p_building_id
       AND f.deleted_at IS NULL
     GROUP BY f.fee_category
  ),
  can AS (
    SELECT k.fee_category FROM khai k WHERE k.co_ap_dung AND k.fee_category <> 'tien_nha'
    UNION
    SELECT x.fee_category
      FROM (VALUES ('dien'), ('nuoc')) AS x(fee_category)
     WHERE NOT EXISTS (SELECT 1 FROM khai k
                        WHERE k.fee_category = x.fee_category AND k.co_khong_ap_dung AND NOT k.co_ap_dung)
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(k.fee_category ORDER BY k.fee_category), '[]'::jsonb)
    FROM can k
    CROSS JOIN ky
   WHERE NOT EXISTS (
     SELECT 1
       FROM public.income_expenses v
       JOIN public.income_expense_items i ON i.income_expense_id = v.id
       JOIN public.income_expense_types t ON t.id = i.income_expense_type_id
      WHERE v.building_id = p_building_id
        AND v.deleted_at IS NULL
        AND v.type::text = 'EXPENSE'
        AND v.approval_status IN ('APPROVED', 'UNAPPROVED')
        -- hạng mục đã gắn khoá là nguồn đúng; khớp theo tên chỉ dùng khi công ty CHƯA gắn khoá nào
        -- cho loại phí này (tránh "Mua tủ lạnh" nhóm Điện được coi là đã trả tiền điện)
        AND (t.fee_category = k.fee_category
             OR (t.fee_category IS NULL
                 AND NOT EXISTS (SELECT 1 FROM public.income_expense_types t2
                                  WHERE t2.organization_id = v.organization_id
                                    AND t2.fee_category = k.fee_category)
                 AND public.fee_type_matches(k.fee_category, t.category, t.name)))
        AND ((v.voucher_date >= ky.dau AND v.voucher_date < ky.sau)
             OR (i.start_date IS NOT NULL AND i.end_date IS NOT NULL
                 AND i.start_date < ky.sau AND i.end_date >= ky.dau)));
$fn$;

-- Phiếu trong tháng ở TOÀ KHÁC (kể cả toà ảo) mà tên/ghi chú nhắc mã toà này: có thể là chi phí
-- của toà này ghi nhầm chỗ — không tính, chỉ đưa ra để người quyết toán xem.
CREATE OR REPLACE FUNCTION app_private.landlord_related_elsewhere_v1(p_building_id uuid, p_month date)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO ''
AS $fn$
  WITH ten AS (
    -- bỏ dấu cả hai vế (public.nrm_vn: thường hoá, bỏ dấu, đ→d) rồi chỉ giữ chữ/số
    SELECT b.organization_id,
           pg_catalog.regexp_replace(public.nrm_vn(b.name), '[^0-9a-z]', '', 'g') AS ma
      FROM public.buildings b
     WHERE b.id = p_building_id
  ),
  toa AS (
    -- mẫu cho phép tối đa 3 ký tự phân cách giữa các ký tự: '950NK' khớp "950NK", "950 nk",
    -- "nhà 950 - NK" nhưng không khớp "1950NK"; "Hẻm 15 Khuông Việt" khớp "hem 15 khuong viet".
    -- Mã toàn số thì ranh giới không được là '.' hay ',' (không khớp nhầm số tiền "1.950.000").
    SELECT ten.organization_id,
           (SELECT pg_catalog.string_agg(c.ch, '[^0-9a-z]{0,3}' ORDER BY c.i)
              FROM pg_catalog.regexp_split_to_table(ten.ma, '') WITH ORDINALITY AS c(ch, i)) AS mau,
           CASE WHEN ten.ma ~ '^[0-9]+$' THEN '[^0-9a-z.,]' ELSE '[^0-9a-z]' END AS bien,
           length(ten.ma) AS do_dai
      FROM ten
  ),
  ky AS (
    SELECT pg_catalog.date_trunc('month', p_month)::date AS dau,
           (pg_catalog.date_trunc('month', p_month) + interval '1 month')::date AS sau
  ),
  p AS (
    SELECT v.code, v.voucher_date, v.type::text AS loai, v.name, ob.name AS toa_ghi,
           COALESCE(v.total_amount, 0) AS so_tien, v.approval_status
      FROM toa
      CROSS JOIN ky
      JOIN public.income_expenses v
        ON v.organization_id = toa.organization_id
       AND v.deleted_at IS NULL
       AND v.approval_status IN ('APPROVED', 'UNAPPROVED')
       AND v.voucher_date >= ky.dau
       AND v.voucher_date < ky.sau
       AND v.building_id IS DISTINCT FROM p_building_id
       -- chỉ phiếu có tính KQKD ở đâu đó (bàn giao tiền mặt, chuyển nội bộ… không làm sai lợi nhuận)
       AND v.business_result_accounting IS DISTINCT FROM false
       AND (v.business_result_accounting IS TRUE
            OR EXISTS (SELECT 1 FROM public.income_expense_items i
                        WHERE i.income_expense_id = v.id AND i.accounting_class = 'PNL')
            OR NOT EXISTS (SELECT 1 FROM public.income_expense_items i WHERE i.income_expense_id = v.id))
      LEFT JOIN public.buildings ob ON ob.id = v.building_id
     WHERE toa.do_dai >= 3
       AND public.nrm_vn(COALESCE(v.name, '') || ' ' || COALESCE(v.notes, ''))
           ~ ('(^|' || toa.bien || ')' || toa.mau || '(' || toa.bien || '|$)')
  )
  SELECT pg_catalog.jsonb_build_object(
           'voucher_count', (SELECT count(*) FROM p),
           'vouchers', COALESCE((
              SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                       'code', x.code, 'voucher_date', x.voucher_date, 'type', x.loai, 'name', x.name,
                       'building_name', x.toa_ghi, 'amount', x.so_tien, 'status', x.approval_status)
                     ORDER BY x.voucher_date, x.code)
                FROM (SELECT * FROM p ORDER BY p.voucher_date, p.code LIMIT 30) x), '[]'::jsonb));
$fn$;

REVOKE ALL ON FUNCTION app_private.landlord_pre_start_pending_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.landlord_pre_start_period_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.landlord_account_elsewhere_v1(uuid, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.landlord_close_blockers_v1(uuid, date, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.landlord_kqkd_bridge_v1(uuid, date, jsonb, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.landlord_missing_fixed_v1(uuid, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.landlord_related_elsewhere_v1(uuid, date) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. Dựng gói dữ liệu cho màn (dùng chung cho màn quản trị và link chủ nhà).
--    p_public = true: bỏ id nội bộ, che tên sổ (chỉ nói tiền ở bên nào) và tên phiếu hạn chế;
--    không kèm đối chiếu KQKD, cảnh báo, lý do chưa chốt.

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
           COALESCE((SELECT pg_catalog.jsonb_agg(
                              (e.value - 'id' - 'foreign_landlord_account')
                              || pg_catalog.jsonb_build_object(
                                   'account_name',
                                   CASE
                                     WHEN e.value->>'side' = 'LANDLORD' THEN 'Sổ chủ nhà'
                                     WHEN e.value->>'source' IN ('TERMINATION_REVENUE', 'FORFEIT_REVENUE',
                                                                'DEPOSIT_OFFSET', 'RENT_REFUND_INTERNAL')
                                       THEN 'Cấn trừ cọc (nội bộ)'
                                     ELSE 'Sổ quản lý' END,
                                   'name',
                                   CASE WHEN (e.value->>'restricted')::boolean IS TRUE
                                        THEN pg_catalog.to_jsonb('Khoản hạn chế (ẩn chi tiết)'::text)
                                        ELSE COALESCE(e.value->'name', 'null'::jsonb) END)
                              ORDER BY e.ordinality)
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
      'close_blockers', '[]'::jsonb,
      'warnings', NULL,
      'kqkd_bridge', NULL);
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
  v_closed_count integer := 0;
  v_percent      numeric;
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
      v_closed_count := v_closed_count + 1;
    ELSE
      v_open_net := v_open_net + v_net;
    END IF;
    v_months := v_months || pg_catalog.jsonb_build_object(
      'period_month', v_m,
      'status', CASE WHEN v_closed THEN 'CLOSED' ELSE 'OPEN' END,
      'is_stale', v_closed AND v_last.source_hash IS DISTINCT FROM (v_live->>'source_hash'),
      'is_current_month', v_m = v_now,
      'manager_percent', v_stmt->'manager_percent',
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

  -- tỷ lệ của điều khoản mới nhất (từng tháng có tỷ lệ riêng trong months[])
  SELECT t.manager_percent INTO v_percent
    FROM app_private.landlord_operation_terms t
   WHERE t.building_id = p_building_id
   ORDER BY t.valid_from DESC
   LIMIT 1;

  RETURN pg_catalog.jsonb_build_object(
    'building_name', v_name,
    'landlord_name', v_cfg.landlord_name,
    'manager_percent', v_percent,
    'effective_from', v_cfg.effective_from,
    'is_active', v_cfg.is_active,
    'opening_confirmed', COALESCE((SELECT c.confirmed FROM app_private.landlord_opening_check_v1(p_building_id) AS c), false),
    'current_month', v_now,
    'months', v_months,
    'payments', v_payments,
    'totals', pg_catalog.jsonb_build_object(
      'opening_balance', v_cfg.opening_balance,
      'closed_month_count', v_closed_count,
      'closed_net', v_closed_net,
      'open_net', v_open_net,
      'paid_by_landlord', v_paid_l,
      'paid_by_manager', v_paid_m,
      'balance_closed', v_cfg.opening_balance + v_closed_net - v_paid_l + v_paid_m,
      'balance_with_open', v_cfg.opening_balance + v_closed_net + v_open_net - v_paid_l + v_paid_m));
END
$fn$;

REVOKE ALL ON FUNCTION app_private.landlord_strip_public_v1(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.landlord_settlement_month_payload_v1(uuid, date, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.landlord_settlement_overview_payload_v1(uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. RPC đọc cho chủ công ty / super admin.

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
           'manager_percent', (SELECT t.manager_percent FROM app_private.landlord_operation_terms t
                                WHERE t.building_id = o.building_id
                                ORDER BY t.valid_from DESC LIMIT 1),
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
  v_org         uuid;
  v_selected    uuid[];
  v_last_closed date;
  v_first_closed date;
BEGIN
  IF auth.uid() IS NULL OR NOT app_private.landlord_actor_can_manage_v1(p_building_id) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xem và quyết toán toà vận hành'
      USING ERRCODE = '42501';
  END IF;
  SELECT b.organization_id INTO v_org FROM public.buildings b WHERE b.id = p_building_id;
  -- mọi sổ có mặt ở BẤT KỲ phiên bản điều khoản nào (sổ đã xoá ở phiên bản cũ cũng phải hiện để bỏ chọn)
  SELECT array_agg(DISTINCT x) INTO v_selected
    FROM app_private.landlord_operation_terms t
    CROSS JOIN LATERAL unnest(t.landlord_account_ids) AS x
   WHERE t.building_id = p_building_id;
  SELECT max(m), min(m) INTO v_last_closed, v_first_closed
    FROM app_private.landlord_closed_months_v1(p_building_id) AS m;

  RETURN jsonb_build_object(
    'current', (
      SELECT jsonb_build_object(
               'landlord_name', o.landlord_name,
               'manager_percent', lt.manager_percent,
               'landlord_account_ids', to_jsonb(lt.landlord_account_ids),
               'terms_from', lt.valid_from,
               'effective_from', o.effective_from,
               'note', o.note,
               'is_active', o.is_active,
               'opening_balance', o.opening_balance,
               'opening_confirmed_at', o.opening_confirmed_at,
               -- xác nhận cũ hết hiệu lực vì đã dời tháng áp dụng hoặc cọc trước kỳ đã đổi
               'opening_confirmation_stale', oc.stale,
               'opening_confirmed_pre_start', o.opening_confirmed_pre_start,
               -- gợi ý số dư đầu kỳ: cọc / tiền trả thừa đã nằm ở sổ chủ nhà TRƯỚC tháng áp dụng
               -- (chủ nhà giữ hộ khoản quản lý phải hoàn) — chủ đối chiếu rồi xác nhận
               'pre_start_landlord_deposits', oc.pre_start,
               'first_closed_month', v_first_closed,
               'last_closed_month', v_last_closed,
               -- tháng mặc định cho tỷ lệ / sổ mới: ngay sau tháng chốt gần nhất
               'next_terms_month', CASE WHEN v_last_closed IS NULL THEN o.effective_from
                                        ELSE (v_last_closed + interval '1 month')::date END,
               'terms', COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                           'valid_from', t.valid_from,
                           'manager_percent', t.manager_percent,
                           'landlord_account_ids', to_jsonb(t.landlord_account_ids)) ORDER BY t.valid_from)
                    FROM app_private.landlord_operation_terms t
                   WHERE t.building_id = o.building_id), '[]'::jsonb),
               'updated_at', o.updated_at)
        FROM app_private.landlord_operations o
        CROSS JOIN LATERAL (
          SELECT t.valid_from, t.manager_percent, t.landlord_account_ids
            FROM app_private.landlord_operation_terms t
           WHERE t.building_id = o.building_id
           ORDER BY t.valid_from DESC
           LIMIT 1) lt
        CROSS JOIN LATERAL app_private.landlord_opening_check_v1(o.building_id) AS oc
       WHERE o.building_id = p_building_id),
    -- gợi ý sổ chủ nhà: sổ nhận nhiều phiếu thu của toà trong 120 ngày gần nhất lên đầu, kèm số phiếu
    -- của TOÀ KHÁC trên sổ đó (sổ dùng chung nhiều toà thì không phải sổ riêng của chủ nhà). Sổ đã xoá
    -- mà vẫn đang chọn cũng trả về (is_deleted) để bỏ chọn được.
    'accounts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', a.id,
               'name', a.name,
               'code', a.code,
               'is_virtual', COALESCE(a.is_virtual, false),
               'is_deleted', a.deleted_at IS NOT NULL,
               'income_count_120d', u.n,
               'other_building_count_120d', u.toa_khac) ORDER BY (a.deleted_at IS NOT NULL), u.n DESC, a.name)
        FROM public.accounts a
        CROSS JOIN LATERAL (
          SELECT (count(*) FILTER (WHERE v.building_id = p_building_id AND v.type::text = 'INCOME'))::integer AS n,
                 (count(DISTINCT v.building_id) FILTER (WHERE v.building_id IS DISTINCT FROM p_building_id))::integer AS toa_khac
            FROM public.income_expenses v
           WHERE v.account_id = a.id
             AND v.deleted_at IS NULL
             AND v.voucher_date >= (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 120
        ) u
       WHERE a.organization_id = v_org
         AND (a.deleted_at IS NULL OR a.id = ANY (COALESCE(v_selected, '{}'::uuid[])))), '[]'::jsonb),
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
-- 10. RPC ghi cho chủ công ty / super admin.

-- Ảnh cấu hình để ghi sổ thay đổi: bỏ cột dấu thời gian/người sửa, kèm toàn bộ điều khoản theo tháng.
CREATE OR REPLACE FUNCTION app_private.landlord_operation_state_v1(p_building_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO ''
AS $fn$
  SELECT (pg_catalog.to_jsonb(o) - 'created_by' - 'updated_by' - 'created_at' - 'updated_at'
            - 'organization_id' - 'building_id')
         || pg_catalog.jsonb_build_object('terms', COALESCE((
              SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                       'valid_from', t.valid_from,
                       'manager_percent', t.manager_percent,
                       'landlord_account_ids', pg_catalog.to_jsonb(t.landlord_account_ids)) ORDER BY t.valid_from)
                FROM app_private.landlord_operation_terms t
               WHERE t.building_id = o.building_id), '[]'::jsonb))
    FROM app_private.landlord_operations o
   WHERE o.building_id = p_building_id;
$fn$;

REVOKE ALL ON FUNCTION app_private.landlord_operation_state_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- bản 11 tham số (chưa có chống ghi đè) chỉ từng được dựng trên TEST — bỏ để không thành hai hàm trùng tên
-- mà PostgREST không chọn được (production chưa từng có: IF EXISTS là không làm gì)
DROP FUNCTION IF EXISTS public.landlord_operation_upsert_v1(uuid, text, numeric, date, uuid[], text, boolean, numeric, boolean, date, numeric);
CREATE OR REPLACE FUNCTION public.landlord_operation_upsert_v1(
  p_building_id          uuid,
  p_landlord_name        text,
  p_manager_percent      numeric,
  p_effective_from       date,
  p_landlord_account_ids uuid[],
  p_note                 text DEFAULT NULL,
  p_is_active            boolean DEFAULT true,
  p_opening_balance      numeric DEFAULT 0,
  p_opening_confirmed    boolean DEFAULT false,
  p_terms_from           date DEFAULT NULL,
  p_opening_seen_pre_start numeric DEFAULT NULL,
  -- updated_at hộp cài đặt đọc lúc mở (landlord_operation_options_v1); NULL = không kiểm (gọi ngoài màn)
  p_expected_updated_at  timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor        uuid := auth.uid();
  v_org          uuid;
  v_opening      numeric := COALESCE(p_opening_balance, 0);
  v_name         text := NULLIF(btrim(COALESCE(p_landlord_name, '')), '');
  v_note         text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_from         date := date_trunc('month', p_effective_from)::date;
  v_ids          uuid[];
  v_bad          integer;
  v_old          app_private.landlord_operations%ROWTYPE;
  v_exists       boolean;
  v_latest       app_private.landlord_operation_terms%ROWTYPE;
  v_prev         app_private.landlord_operation_terms%ROWTYPE;
  v_base         date;
  v_terms_from   date;
  v_first_closed date;
  v_last_closed  date;
  v_blocked      date;
  v_pct_change   boolean;
  v_ids_change   boolean;
  v_pre          numeric;
  v_first_ids_before uuid[];
  v_first_ids_after  uuid[];
  v_reconfirm    boolean := false;
  v_before       jsonb;
  v_after        jsonb;
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
  IF v_opening <> round(v_opening) OR abs(v_opening) >= 1e13 THEN
    RAISE EXCEPTION 'Số dư đầu kỳ phải là số nguyên đồng' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}'::uuid[]) INTO v_ids
    FROM unnest(COALESCE(p_landlord_account_ids, '{}'::uuid[])) AS x
   WHERE x IS NOT NULL;
  IF cardinality(v_ids) = 0 OR cardinality(v_ids) > 20 THEN
    RAISE EXCEPTION 'Chọn từ 1 đến 20 sổ quỹ của chủ nhà' USING ERRCODE = '22023';
  END IF;

  -- khoá cùng chìa với chốt tháng: không đổi cấu hình giữa lúc đang chốt
  PERFORM pg_advisory_xact_lock(hashtextextended('landlord_settlement:' || p_building_id::text, 0));

  SELECT * INTO v_old FROM app_private.landlord_operations o WHERE o.building_id = p_building_id FOR UPDATE;
  v_exists := FOUND;
  -- chống ghi đè: người khác đã lưu sau lúc hộp này mở ⇒ từ chối, không ghi đè số của họ (và không tạo
  -- xác nhận số dư đầu kỳ mới cho con số cũ đang hiện trên hộp)
  IF v_exists AND p_expected_updated_at IS NOT NULL
     AND v_old.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Cài đặt toà vừa được người khác sửa — đóng hộp, mở lại để xem bản mới rồi lưu lại'
      USING ERRCODE = '40001';
  END IF;
  v_before := app_private.landlord_operation_state_v1(p_building_id);
  SELECT * INTO v_latest
    FROM app_private.landlord_operation_terms t
   WHERE t.building_id = p_building_id
   ORDER BY t.valid_from DESC
   LIMIT 1;
  SELECT t.landlord_account_ids INTO v_first_ids_before
    FROM app_private.landlord_operation_terms t
   WHERE t.building_id = p_building_id
   ORDER BY t.valid_from
   LIMIT 1;

  -- sổ phải thuộc công ty của toà. Sổ THÊM MỚI (chưa có ở phiên bản điều khoản nào) còn phải là sổ thật
  -- (không ảo — sổ cấn trừ, làm tròn, tiền thối không giữ tiền của ai) và chưa xoá; sổ đã có ở một phiên bản
  -- mà sau đó bị xoá/đổi ảo thì vẫn giữ được (bỏ nó là quyết định riêng, có tháng áp dụng riêng).
  SELECT count(*) INTO v_bad
    FROM unnest(v_ids) AS x
   WHERE NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = x AND a.organization_id = v_org);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Có sổ quỹ không thuộc công ty của toà — bỏ chọn sổ đó' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_bad
    FROM unnest(v_ids) AS x
    JOIN public.accounts a ON a.id = x
   WHERE a.deleted_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM app_private.landlord_operation_terms tv
                      WHERE tv.building_id = p_building_id AND x = ANY (tv.landlord_account_ids));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Có sổ quỹ đã xoá — bỏ chọn sổ đó' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_bad
    FROM unnest(v_ids) AS x
    JOIN public.accounts a ON a.id = x
   WHERE COALESCE(a.is_virtual, false)
     AND NOT EXISTS (SELECT 1 FROM app_private.landlord_operation_terms tv
                      WHERE tv.building_id = p_building_id AND x = ANY (tv.landlord_account_ids));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Sổ chủ nhà phải là sổ quỹ thật — bỏ chọn sổ ảo' USING ERRCODE = '22023';
  END IF;
  SELECT max(m), min(m) INTO v_last_closed, v_first_closed
    FROM app_private.landlord_closed_months_v1(p_building_id) AS m;

  -- tháng đã chốt phải còn nằm trong thời gian áp dụng (không thì nó biến khỏi Tổng quyết toán)
  IF v_first_closed IS NOT NULL AND v_from > v_first_closed THEN
    RAISE EXCEPTION 'Tháng % đã chốt — không dời tháng bắt đầu áp dụng ra sau tháng đã chốt (mở chốt trước)',
      to_char(v_first_closed, 'MM/YYYY') USING ERRCODE = '55000';
  END IF;

  -- dấu xác nhận số dư đầu kỳ xử lý SAU khi điều khoản đã chuẩn hoá (cơ sở xác nhận phụ thuộc
  -- tháng áp dụng và sổ chủ nhà của điều khoản đầu)
  INSERT INTO app_private.landlord_operations AS o
    (building_id, organization_id, landlord_name, effective_from, note, is_active,
     opening_balance, created_by, updated_by)
  VALUES
    (p_building_id, v_org, v_name, v_from, v_note, COALESCE(p_is_active, true),
     v_opening, v_actor, v_actor)
  ON CONFLICT (building_id) DO UPDATE
     SET landlord_name = EXCLUDED.landlord_name,
         effective_from = EXCLUDED.effective_from,
         note = EXCLUDED.note,
         is_active = EXCLUDED.is_active,
         opening_balance = EXCLUDED.opening_balance,
         updated_by = v_actor,
         updated_at = clock_timestamp();

  IF NOT v_exists THEN
    INSERT INTO app_private.landlord_operation_terms
      (building_id, valid_from, manager_percent, landlord_account_ids, created_by)
    VALUES (p_building_id, v_from, p_manager_percent, v_ids, v_actor);
    v_terms_from := v_from;
  ELSE
    -- 1. dời tháng bắt đầu: điều khoản đầu tiên luôn bắt đầu đúng tháng áp dụng
    IF v_from < v_old.effective_from THEN
      UPDATE app_private.landlord_operation_terms t
         SET valid_from = v_from
       WHERE t.building_id = p_building_id
         AND t.valid_from = (SELECT min(t2.valid_from) FROM app_private.landlord_operation_terms t2
                              WHERE t2.building_id = p_building_id);
    ELSIF v_from > v_old.effective_from THEN
      SELECT max(t.valid_from) INTO v_base
        FROM app_private.landlord_operation_terms t
       WHERE t.building_id = p_building_id AND t.valid_from <= v_from;
      DELETE FROM app_private.landlord_operation_terms t
       WHERE t.building_id = p_building_id AND t.valid_from < v_base;
      IF v_base < v_from THEN
        UPDATE app_private.landlord_operation_terms t
           SET valid_from = v_from
         WHERE t.building_id = p_building_id AND t.valid_from = v_base;
      END IF;
    END IF;

    -- 2. đổi % / sổ chủ nhà TỪNG TRƯỜNG, từ tháng T (p_terms_from, mặc định ngay sau tháng chốt gần
    --    nhất) trở đi: so với điều khoản ĐANG ÁP ở T (đúng thứ màn đã hiện cho tháng đó). Trường nào
    --    đổi thì ghi trường đó cho T và mọi mốc sau T; trường không đổi giữ nguyên ở từng mốc (đổi %
    --    không kéo theo sổ của mốc khác, và ngược lại). Tháng trước T giữ điều khoản cũ.
    -- tháng trước tháng áp dụng không có trong quyết toán ⇒ T sớm hơn thì kẹp về tháng áp dụng
    v_terms_from := GREATEST(COALESCE(date_trunc('month', p_terms_from)::date,
                                      CASE WHEN v_last_closed IS NULL THEN v_from
                                           ELSE (v_last_closed + interval '1 month')::date END), v_from);
    SELECT * INTO v_prev
      FROM app_private.landlord_operation_terms t
     WHERE t.building_id = p_building_id AND t.valid_from <= v_terms_from
     ORDER BY t.valid_from DESC
     LIMIT 1;
    v_pct_change := v_prev.manager_percent IS DISTINCT FROM p_manager_percent;
    v_ids_change := v_prev.landlord_account_ids IS DISTINCT FROM v_ids;
    IF NOT (v_pct_change OR v_ids_change) THEN
      v_terms_from := NULL;
    ELSE
      IF v_terms_from < v_from THEN
        RAISE EXCEPTION 'Tháng áp dụng tỷ lệ / sổ mới (%) phải từ tháng bắt đầu áp dụng (%) trở đi',
          to_char(v_terms_from, 'MM/YYYY'), to_char(v_from, 'MM/YYYY') USING ERRCODE = '22023';
      END IF;
      SELECT min(m) INTO v_blocked
        FROM app_private.landlord_closed_months_v1(p_building_id) AS m
       WHERE m >= v_terms_from;
      IF v_blocked IS NOT NULL THEN
        RAISE EXCEPTION 'Tháng % đã chốt — mở chốt tháng đó trước khi đổi tỷ lệ / sổ chủ nhà từ tháng %',
          to_char(v_blocked, 'MM/YYYY'), to_char(v_terms_from, 'MM/YYYY') USING ERRCODE = '55000';
      END IF;
      INSERT INTO app_private.landlord_operation_terms AS t
        (building_id, valid_from, manager_percent, landlord_account_ids, created_by)
      VALUES (p_building_id, v_terms_from,
              CASE WHEN v_pct_change THEN p_manager_percent ELSE v_prev.manager_percent END,
              CASE WHEN v_ids_change THEN v_ids ELSE v_prev.landlord_account_ids END, v_actor)
      ON CONFLICT (building_id, valid_from) DO UPDATE
         SET manager_percent = EXCLUDED.manager_percent,
             landlord_account_ids = EXCLUDED.landlord_account_ids;
      UPDATE app_private.landlord_operation_terms t
         SET manager_percent = CASE WHEN v_pct_change THEN p_manager_percent ELSE t.manager_percent END,
             landlord_account_ids = CASE WHEN v_ids_change THEN v_ids ELSE t.landlord_account_ids END
       WHERE t.building_id = p_building_id AND t.valid_from > v_terms_from;
      -- gộp mốc trùng y điều khoản ngay trước nó
      DELETE FROM app_private.landlord_operation_terms t
       USING (SELECT x.valid_from,
                     x.manager_percent = lag(x.manager_percent) OVER w
                     AND x.landlord_account_ids = lag(x.landlord_account_ids) OVER w AS trung
                FROM app_private.landlord_operation_terms x
               WHERE x.building_id = p_building_id
              WINDOW w AS (ORDER BY x.valid_from)) d
       WHERE t.building_id = p_building_id AND t.valid_from = d.valid_from AND d.trung;
    END IF;
  END IF;

  IF (SELECT min(t.valid_from) FROM app_private.landlord_operation_terms t
       WHERE t.building_id = p_building_id) IS DISTINCT FROM v_from THEN
    RAISE EXCEPTION 'Điều khoản đầu tiên phải bắt đầu đúng tháng áp dụng' USING ERRCODE = 'XX000';
  END IF;

  -- số dư đầu kỳ. Dấu xác nhận:
  --   · giữ nguyên khi số dư, tháng áp dụng VÀ cọc trước kỳ ở sổ chủ nhà đều y như lúc xác nhận;
  --   · xác nhận MỚI chỉ nhận khi cơ sở KHÔNG đổi trong chính lần lưu này (không phải tạo mới, không
  --     dời tháng áp dụng, không đổi sổ của điều khoản đầu) VÀ số cọc trước kỳ người dùng đã thấy
  --     (p_opening_seen_pre_start) bằng đúng số hiện tại — không ai "xác nhận" một con số chưa từng thấy;
  --   · còn lại bỏ dấu, báo màn mở lại để đối chiếu (opening_needs_reconfirm).
  v_pre := app_private.landlord_pre_start_deposits_v1(p_building_id);
  SELECT t.landlord_account_ids INTO v_first_ids_after
    FROM app_private.landlord_operation_terms t
   WHERE t.building_id = p_building_id
   ORDER BY t.valid_from
   LIMIT 1;
  IF COALESCE(p_opening_confirmed, false) THEN
    IF v_exists AND v_old.opening_confirmed_at IS NOT NULL
       AND v_old.opening_balance = v_opening
       AND v_old.opening_confirmed_from = v_from
       AND v_old.opening_confirmed_pre_start = v_pre THEN
      NULL;  -- xác nhận cũ còn nguyên hiệu lực
    ELSIF v_exists AND v_old.effective_from = v_from
          AND v_first_ids_before IS NOT DISTINCT FROM v_first_ids_after
          AND p_opening_seen_pre_start IS NOT DISTINCT FROM v_pre THEN
      UPDATE app_private.landlord_operations
         SET opening_confirmed_at = clock_timestamp(), opening_confirmed_by = v_actor,
             opening_confirmed_from = v_from, opening_confirmed_pre_start = v_pre
       WHERE building_id = p_building_id;
    ELSE
      v_reconfirm := true;
      UPDATE app_private.landlord_operations
         SET opening_confirmed_at = NULL, opening_confirmed_by = NULL,
             opening_confirmed_from = NULL, opening_confirmed_pre_start = NULL
       WHERE building_id = p_building_id AND opening_confirmed_at IS NOT NULL;
    END IF;
  ELSE
    UPDATE app_private.landlord_operations
       SET opening_confirmed_at = NULL, opening_confirmed_by = NULL,
           opening_confirmed_from = NULL, opening_confirmed_pre_start = NULL
     WHERE building_id = p_building_id AND opening_confirmed_at IS NOT NULL;
  END IF;

  v_after := app_private.landlord_operation_state_v1(p_building_id);
  IF v_before IS DISTINCT FROM v_after THEN
    INSERT INTO app_private.landlord_operation_changes (organization_id, building_id, actor, before, after)
    VALUES (v_org, p_building_id, v_actor, v_before, v_after);
  END IF;

  RETURN jsonb_build_object('building_id', p_building_id, 'created', NOT v_exists, 'terms_from', v_terms_from,
                            'opening_needs_reconfirm', v_reconfirm,
                            -- sau lần lưu: còn phải đối chiếu số dư đầu kỳ thì mới chốt được
                            'opening_needs_confirm', COALESCE((SELECT c.needs_confirm
                                                                 FROM app_private.landlord_opening_check_v1(p_building_id) AS c), false));
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
  v_blockers jsonb;
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
  IF COALESCE((v_live->>'reversed_voucher_count')::integer, 0) > 0 THEN
    RAISE EXCEPTION 'Có % phiếu đã duyệt nhưng bút toán sổ quỹ đã bị đảo (tiền không còn ở sổ nào) trong tháng % — xử lý phiếu trước khi chốt',
      (v_live->>'reversed_voucher_count')::integer, to_char(v_month, 'MM/YYYY') USING ERRCODE = '55000';
  END IF;
  -- các lý do còn lại dùng chung với màn (landlord_close_blockers_v1)
  v_blockers := app_private.landlord_close_blockers_v1(p_building_id, v_month, v_live);
  IF v_blockers ? 'FOREIGN_LANDLORD_ACCOUNT' THEN
    RAISE EXCEPTION 'Có % phiếu trong tháng % dùng sổ chủ nhà của toà vận hành khác — chuyển phiếu về đúng sổ hoặc thêm sổ đó vào sổ chủ nhà của toà này',
      (v_live->>'foreign_account_voucher_count')::integer, to_char(v_month, 'MM/YYYY') USING ERRCODE = '55000';
  END IF;
  IF v_blockers ? 'UNPOSTED_POSTINGS' THEN
    RAISE EXCEPTION 'Có % phiếu đã duyệt nhưng chưa ghi sổ quỹ (tiền chưa thực vào/ra) trong tháng % — ghi sổ hoặc huỷ trước khi chốt',
      (v_live->>'unposted_voucher_count')::integer, to_char(v_month, 'MM/YYYY') USING ERRCODE = '55000';
  END IF;
  IF v_blockers ? 'LANDLORD_ACCOUNT_ELSEWHERE' THEN
    RAISE EXCEPTION 'Có phiếu của toà khác ghi vào sổ chủ nhà của toà này trong tháng % — chuyển phiếu về đúng sổ trước khi chốt',
      to_char(v_month, 'MM/YYYY') USING ERRCODE = '55000';
  END IF;
  IF v_blockers ? 'PRE_START_PENDING' THEN
    RAISE EXCEPTION 'Còn phiếu chờ duyệt ghi ngày trước tháng bắt đầu áp dụng — duyệt hoặc huỷ trước khi chốt tháng đầu tiên'
      USING ERRCODE = '55000';
  END IF;
  IF v_blockers ? 'OPENING_UNCONFIRMED' THEN
    RAISE EXCEPTION 'Chưa xác nhận số dư đầu kỳ với chủ nhà — vào Cài đặt toà, đối chiếu rồi đánh dấu đã xác nhận'
      USING ERRCODE = '55000';
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
  -- không có và không có quyền trả CÙNG một lỗi: người ngoài không dò được id nào tồn tại
  IF NOT FOUND OR auth.uid() IS NULL OR NOT app_private.landlord_actor_can_manage_v1(v_row.building_id) THEN
    RAISE EXCEPTION 'Không tìm thấy khoản thanh toán, hoặc bạn không có quyền với toà này'
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
  -- không có và không có quyền trả CÙNG một lỗi: người ngoài không dò được token nào tồn tại
  IF NOT FOUND OR auth.uid() IS NULL OR NOT app_private.landlord_actor_can_manage_v1(v_row.building_id) THEN
    RAISE EXCEPTION 'Không tìm thấy link, hoặc bạn không có quyền với toà này'
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
-- 11. RPC công khai cho chủ nhà — chỉ đọc, theo link. Token sai/thu hồi ⇒ NULL.
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
  -- toà còn áp dụng VÀ toà còn sống (xoá mềm / chuyển toà ảo ⇒ link chết, vì lúc đó không ai thu hồi
  -- hay tắt áp dụng được nữa — landlord_actor_can_manage_v1 từ chối toà đã xoá)
  SELECT o.* INTO v_cfg
    FROM app_private.landlord_operations o
    JOIN public.buildings b ON b.id = o.building_id
   WHERE o.building_id = v_link.building_id AND o.is_active
     AND b.deleted_at IS NULL AND NOT COALESCE(b.is_virtual, false);
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
-- 11b. Phần chủ nhà cho Báo cáo LN (chủ chốt 22/10): Báo cáo LN giữ TỔNG lợi nhuận và thêm MỘT dòng
--      "Lợi nhuận của iHome" = tổng − phần chủ nhà của các toà vận hành. Phần chủ nhà vẫn tính nhưng
--      không hiện thành dòng riêng. Trả theo toà × tháng (từ tháng áp dụng, tới tháng hiện tại): tháng
--      đã chốt lấy số đã chốt, tháng mở lấy số tạm tính (theo kỳ, phiếu đã duyệt). Chỉ toà người gọi xem
--      được — cùng luật can_access_building mà fa_accrual_allocations (nguồn Báo cáo LN) dùng. Toà đang
--      tạm ngừng (is_active = false, không lưu ngày ngừng): chỉ các tháng ĐÃ CHỐT còn được trả (số đã chốt
--      vẫn là của chủ nhà); tháng mở không tính tạm — cùng luật với bộ dò trước khi chốt LN (chỉ toà đang
--      áp dụng mới bỏ tiền nhà), để hai màn không mâu thuẫn và tháng sau khi ngừng không bị trừ mãi.
CREATE OR REPLACE FUNCTION public.landlord_ihome_profit_v1(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_from   date := date_trunc('month', p_from)::date;
  v_to     date := LEAST(date_trunc('month', p_to)::date, app_private.landlord_current_month_v1());
  v_rows   jsonb := '[]'::jsonb;
  v_r      record;
  v_m      date;
  v_stmt   jsonb;
  v_last   app_private.landlord_settlement_closes%ROWTYPE;
  v_closed boolean;
BEGIN
  IF auth.uid() IS NULL OR v_from IS NULL OR v_to IS NULL OR v_from > v_to THEN
    RETURN v_rows;
  END IF;
  -- tối đa 24 tháng mỗi lần gọi (Báo cáo LN xem 1 tháng + biểu đồ 6 tháng)
  v_from := GREATEST(v_from, (v_to - interval '23 months')::date);
  FOR v_r IN
    SELECT o.building_id, o.effective_from, o.is_active
      FROM app_private.landlord_operations o
      JOIN public.buildings b ON b.id = o.building_id AND b.deleted_at IS NULL
     WHERE public.can_access_building(o.building_id)
     ORDER BY o.building_id
  LOOP
    v_m := GREATEST(v_from, v_r.effective_from);
    WHILE v_m <= v_to LOOP
      SELECT * INTO v_last
        FROM app_private.landlord_settlement_closes c
       WHERE c.building_id = v_r.building_id AND c.period_month = v_m
       ORDER BY c.revision DESC
       LIMIT 1;
      v_closed := FOUND AND v_last.action = 'CLOSE';
      -- toà tạm ngừng: tháng chưa chốt không tính tạm (xem ghi chú đầu mục)
      IF NOT v_closed AND NOT v_r.is_active THEN
        v_m := (v_m + interval '1 month')::date;
        CONTINUE;
      END IF;
      v_stmt := CASE WHEN v_closed THEN v_last.snapshot
                     ELSE app_private.landlord_settlement_compute_v1(v_r.building_id, v_m) END;
      v_rows := v_rows || jsonb_build_object(
        'building_id', v_r.building_id,
        'period_month', v_m,
        'status', CASE WHEN v_closed THEN 'CLOSED' ELSE 'OPEN' END,
        'profit', COALESCE((v_stmt->'totals'->>'profit')::numeric, 0),
        'manager_share', COALESCE((v_stmt->'totals'->>'manager_share')::numeric, 0),
        'landlord_share', COALESCE((v_stmt->'totals'->>'landlord_share')::numeric, 0));
      v_m := (v_m + interval '1 month')::date;
    END LOOP;
  END LOOP;
  RETURN v_rows;
END
$fn$;

-- ---------------------------------------------------------------------------
-- 12. Quyền gọi.
REVOKE ALL ON FUNCTION public.landlord_operations_list_v1() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_operation_options_v1(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_settlement_month_v1(uuid, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_settlement_overview_v1(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_share_links_v1(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_operation_upsert_v1(uuid, text, numeric, date, uuid[], text, boolean, numeric, boolean, date, numeric, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_settlement_close_v1(uuid, date, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_settlement_reopen_v1(uuid, date, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_settlement_add_payment_v1(uuid, date, text, numeric, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_settlement_void_payment_v1(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_share_link_create_v1(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_share_link_revoke_v1(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_settlement_public_v1(text, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.landlord_ihome_profit_v1(date, date) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.landlord_operations_list_v1() TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_operation_options_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_settlement_month_v1(uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_settlement_overview_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_share_links_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_operation_upsert_v1(uuid, text, numeric, date, uuid[], text, boolean, numeric, boolean, date, numeric, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_settlement_close_v1(uuid, date, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_settlement_reopen_v1(uuid, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_settlement_add_payment_v1(uuid, date, text, numeric, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_settlement_void_payment_v1(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_share_link_create_v1(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_share_link_revoke_v1(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_settlement_public_v1(text, date) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_ihome_profit_v1(date, date) TO authenticated;

COMMIT;
NOTIFY pgrst, 'reload schema';

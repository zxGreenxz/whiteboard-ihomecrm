-- =============================================================================
-- quyet_toan_v3_ban_giao_giu_coc — Quyết toán vận hành v3 (thiết kế "Quyet toan van hanh v3", chủ chốt
-- 23/10/2026): người giữ cọc theo toà, hạng mục thu/chi, ghi chú bàn giao sửa được sau khi chốt, chủ nhà
-- xác nhận đã xem số liệu trên link.
-- =============================================================================
-- VÌ SAO
--   Trang mới chia 4 tab (Thu chi · Quyết toán · Bàn giao · Thống kê). Server còn thiếu:
--   · NGƯỜI GIỮ CỌC: luật cũ luôn là quản lý giữ cọc (cọc khách nộp vào sổ chủ nhà thì chủ nhà bàn giao
--     cho quản lý). Có thoả thuận để chủ nhà giữ cọc ⇒ cọc nằm ở sổ quản lý phải bàn giao cho chủ nhà.
--   · HẠNG MỤC: tab Thu chi chia thu/chi theo hạng mục (Tiền phòng, Điện, Nước…) và ghi chi tiết từng phiếu.
--   · BÀN GIAO: ghi chú của quản lý (đang chỉ nhập được lúc chốt) và xác nhận của chủ nhà.
--
-- LÀM GÌ
--   1. landlord_operation_terms THÊM cột deposit_holder ('MANAGER' | 'LANDLORD', mặc định 'MANAGER' = luật
--      cũ ⇒ số cũ không đổi). Theo PHIÊN BẢN THÁNG như % và tiền cố định (đổi chỉ từ tháng chưa chốt).
--   2. Hai bảng append-only mới:
--      · landlord_settlement_handovers — ghi chú bàn giao của MỘT lần chốt (khoá ngoại tới lần chốt). Dòng
--        mới nhất là ghi chú hiện hành; chưa có dòng nào ⇒ ghi chú lúc chốt (closes.reason).
--      · landlord_settlement_confirmations — chủ nhà xác nhận đã xem số liệu của MỘT lần chốt (duy nhất
--        theo toà × tháng × lần chốt). Mở chốt / chốt lại sinh lần chốt mới ⇒ xác nhận cũ tự hết hiệu lực.
--   3. app_private.landlord_kqkd_lines_v2 = CHÉP NGUYÊN v1 (md5 production d7f64c98…) + cột type_id (hạng
--      mục của dòng; NULL khi phiếu không có dòng hạng mục). v1 giữ nguyên cho các hàm khác.
--   4. app_private.landlord_settlement_compute_v1 (DỰNG TỪ THÂN production md5 1af9d2b8…, file
--      20261023113626) — đổi:
--      · đọc dòng lãi lỗ từ v2 (cùng số tiền với v1 — test PGlite so từng dòng);
--      · người giữ cọc của tháng: MANAGER ⇒ cộng cọc ở sổ chủ nhà (như cũ); LANDLORD ⇒ TRỪ cọc ở sổ quản lý
--        (thu − hoàn/cấn, đã duyệt). Phần cọc vào số bàn giao trả thành totals.deposit_adjustment (có dấu):
--          landlord_owes_manager = phần quản lý + quản lý chi − quản lý thu + deposit_adjustment + tiền thối
--        Tiền thối ở sổ chủ nhà (landlord_extra_cash) giữ luật cũ ở cả hai chế độ.
--        Phiếu cọc chờ duyệt / chuỗi băm theo ĐÚNG bên sổ có tính vào số (MANAGER: sổ chủ nhà như cũ;
--        LANDLORD: sổ quản lý) — chế độ MANAGER cho đúng chuỗi băm cũ ⇒ tháng đã chốt không thành "đổi sau
--        khi chốt"; LANDLORD thêm '|giu_coc:LANDLORD' vào phần điều khoản.
--      · trả thêm: deposit_holder, totals.manager_held_deposits, totals.deposit_adjustment,
--        totals.landlord_net_held / manager_net_held (thu − chi lãi lỗ của từng sổ),
--        deposits.manager_received / manager_paid_out, pending.deposit, categories {income, expense}
--        (dòng lãi lỗ đã duyệt theo tên hạng mục, kèm phần sổ chủ nhà / sổ quản lý, cờ restricted), và mỗi
--        phiếu lãi lỗ một mảng lines [{category, amount}]. Hạng mục / lines không vào chuỗi băm.
--   5. app_private.landlord_strip_public_v1 (md5 2377f91b…): phiếu hạn chế bỏ cả lines; hạng mục HẠN CHẾ
--      gộp thành một dòng "Khoản hạn chế" (link chủ nhà không thấy tên hạng mục hạn chế).
--   6. app_private.landlord_settlement_month_payload_v1 (md5 2f18d20b…): closed.note = ghi chú bàn giao
--      hiện hành, thêm closed.note_updated_at; thêm confirmation {confirmed_at, note} của lần chốt hiện tại.
--   7. app_private.landlord_settlement_overview_payload_v1 (md5 0884667f…): months[] thêm các dòng "Cách
--      tính" (phần cố định/%, quản lý chi hộ/thu hộ, người giữ cọc, deposit_adjustment, tiền thối), lần chốt
--      và thời điểm chủ nhà xác nhận; gói thêm deposit_holder của điều khoản mới nhất. Ảnh chốt cũ thiếu
--      trường ⇒ chép trường tương đương (deposit_adjustment = landlord_held_deposits, giữ cọc = MANAGER).
--   8. public.landlord_operation_options_v1 (md5 fb58fc83…), app_private.landlord_operation_state_v1
--      (md5 fb8fecf2…): kèm deposit_holder.
--   9. public.landlord_operation_upsert_v1 (md5 23c71a9a…): THÊM tham số cuối p_deposit_holder text DEFAULT
--      NULL ⇒ DROP đúng chữ ký 13 tham số rồi CREATE 14 tham số, cấp quyền như cũ. NULL = giữ người giữ cọc
--      của điều khoản đang áp ở tháng T (toà mới: MANAGER). Đổi xét từng trường như %, tiền cố định, sổ.
--  10. RPC mới:
--      · public.landlord_settlement_note_update_v1 (authenticated, chủ công ty / super admin) — sửa ghi chú
--        bàn giao của lần chốt hiện tại. 55000 tháng chưa chốt, 40001 lần chốt đã đổi.
--      · public.landlord_settlement_confirm_v1 (ANON qua token link chủ nhà) — chủ nhà xác nhận đã xem số
--        liệu của lần chốt hiện tại, ghi chú ≤ 500 ký tự. Một lần mỗi lần chốt (bấm lại ⇒ ALREADY_CONFIRMED).
--        Ghi được qua anon là CÓ CHỦ ĐÍCH: chỉ ghi một dòng/lần chốt, cần token chưa thu hồi của đúng toà.
--   Không đổi: chốt / mở chốt / thanh toán (net_amount = totals.landlord_owes_manager), landlord_ihome_profit_v1
--   (đọc manager_share / landlord_share — người giữ cọc không đổi hai số này), landlord_close_blockers_v1
--   (đọc pending.voucher_count), landlord_settlement_public_v1, gợi ý cọc trước kỳ (landlord_pre_start_*:
--   vẫn là cọc ở sổ chủ nhà — số dư đầu kỳ do người dùng đối chiếu và nhập tay). Ghim md5 các hàm này.
--
-- ĐƯỜNG LÙI
--   CREATE OR REPLACE các hàm 4–8 bằng thân của 20261023113626 / 20261021083438; DROP FUNCTION
--   public.landlord_operation_upsert_v1 bản 14 tham số rồi tạo lại bản 13 tham số + REVOKE/GRANT như
--   20261023113626 mục 6; DROP hai RPC mới và landlord_kqkd_lines_v2. Cột deposit_holder, hai bảng mới để
--   nguyên (không ai đọc nữa) — xoá là phá huỷ.
--
-- Chạy được hai lượt liên tiếp và trên DB rỗng của Restore Drill (không đòi dữ liệu).
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 0. Nền phải có + thân đang chạy phải đúng bản đã rà (hoặc đã là bản của file này — lượt hai).
DO $truoc$
DECLARE
  v_sig    text;
  v_md5    text;
  v_ghim   text[];
  v_cu     text := 'public.landlord_operation_upsert_v1(uuid,text,numeric,date,uuid[],text,boolean,numeric,boolean,date,numeric,timestamptz,numeric)';
  v_moi    text := 'public.landlord_operation_upsert_v1(uuid,text,numeric,date,uuid[],text,boolean,numeric,boolean,date,numeric,timestamptz,numeric,text)';
BEGIN
  IF to_regclass('app_private.landlord_operation_terms') IS NULL
     OR to_regclass('app_private.landlord_settlement_closes') IS NULL
     OR to_regclass('app_private.landlord_share_links') IS NULL THEN
    RAISE EXCEPTION 'Thiếu bảng quyết toán vận hành (20261021083438) — DỪNG.' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = 'app_private.landlord_operation_terms'::regclass
                    AND a.attname = 'manager_fixed_amount' AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'Thiếu cột landlord_operation_terms.manager_fixed_amount (20261023113626) — DỪNG.' USING ERRCODE = '55000';
  END IF;

  -- [chữ ký, md5 thân production (đọc 23/10/2026 21:2x, TEST cùng bản), md5 thân của chính file này (lượt hai)]
  FOR v_sig, v_ghim IN
    SELECT x.sig, x.ghim FROM (VALUES
      ('app_private.landlord_settlement_compute_v1(uuid,date)',
       ARRAY['1af9d2b8c6d10ca32dc177cf0d6a6d2a', 'ad0218a979233a5b15c17b7a141dfaea']),
      ('app_private.landlord_strip_public_v1(jsonb)',
       ARRAY['2377f91bcdab86e42a8371c0b6cb6ef2', '5ba02b4cd662bfdbf24b1e688de4f519']),
      ('app_private.landlord_settlement_month_payload_v1(uuid,date,boolean)',
       ARRAY['2f18d20bea0b4e607b7cbf43e3bbe9be', 'c172acff6a3488ae6d26c1b71d9f8693']),
      ('app_private.landlord_settlement_overview_payload_v1(uuid,boolean)',
       ARRAY['0884667fb4d68f576e158af7056f801a', 'e9f3454e0a1ddecd56d4ef5d69ff7ac8']),
      ('app_private.landlord_operation_state_v1(uuid)',
       ARRAY['fb8fecf22a102dc96e9d2937d4247b49', '1d1fdb65604925a4b2e394d141336d8a']),
      ('public.landlord_operation_options_v1(uuid)',
       ARRAY['fb58fc832aed0dffb93997a5f81aa991', 'f90e67730dbb2a8a4d0845dee972629b']),
      -- hàm KHÔNG thay — đọc gói tháng / gọi các hàm trên; đổi thì rà lại trước khi áp
      ('app_private.landlord_kqkd_lines_v1(uuid,date,date)',
       ARRAY['d7f64c98db3dd4598051377bb15b28d0']),
      ('app_private.landlord_close_blockers_v1(uuid,date,jsonb)',
       ARRAY['852a5bda931276ac220153774abaa766']),
      ('public.landlord_settlement_close_v1(uuid,date,text,text)',
       ARRAY['838f1727dfca7a29b84066e87528c08c']),
      ('public.landlord_settlement_reopen_v1(uuid,date,text)',
       ARRAY['60439d3c966dc0be852cdd84ff621d77']),
      ('public.landlord_settlement_public_v1(text,date)',
       ARRAY['1c3a19568446c14b0ab694e75e235c76']),
      ('public.landlord_ihome_profit_v1(date,date)',
       ARRAY['c00e7d21798664b8439a4d2a46273aae'])
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

  -- hàm ghi: lượt một còn chữ ký 13 tham số (thân production); lượt hai chỉ còn chữ ký 14 tham số
  IF to_regprocedure(v_cu) IS NOT NULL THEN
    v_md5 := md5(pg_get_functiondef(v_cu::regprocedure));
    IF v_md5 <> '23c71a9ac1b280f436a092f0b4a36325' THEN
      RAISE EXCEPTION '% KHÁC bản đã rà (md5 %) — DỪNG.', v_cu, v_md5 USING ERRCODE = '55000';
    END IF;
  ELSIF to_regprocedure(v_moi) IS NOT NULL THEN
    v_md5 := md5(pg_get_functiondef(v_moi::regprocedure));
    IF v_md5 <> '32311fa35dd5a531532da958428e8342' THEN
      RAISE EXCEPTION '% KHÁC bản của file này (md5 %) — DỪNG.', v_moi, v_md5 USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'Thiếu public.landlord_operation_upsert_v1 — DỪNG.' USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- ---------------------------------------------------------------------------
-- 1. Người giữ cọc theo phiên bản tháng. Dòng có sẵn nhận 'MANAGER' = luật cũ (không UPDATE dữ liệu).
ALTER TABLE app_private.landlord_operation_terms
  ADD COLUMN IF NOT EXISTS deposit_holder text NOT NULL DEFAULT 'MANAGER'
    CONSTRAINT landlord_operation_terms_deposit_holder_check
    CHECK (deposit_holder IN ('MANAGER', 'LANDLORD'));

COMMENT ON COLUMN app_private.landlord_operation_terms.deposit_holder IS
  'Bên giữ cọc của khách (và hoàn cọc khi trả phòng): MANAGER — cọc nằm ở sổ chủ nhà thì chủ nhà bàn giao cho quản lý (luật từ 21/10/2026); LANDLORD — cọc nằm ở sổ quản lý thì quản lý bàn giao cho chủ nhà. Chủ chốt 23/10/2026.';

-- ---------------------------------------------------------------------------
-- 2. Ghi chú bàn giao và xác nhận của chủ nhà — append-only, gắn với MỘT lần chốt.
CREATE TABLE IF NOT EXISTS app_private.landlord_settlement_handovers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  building_id     uuid NOT NULL,
  period_month    date NOT NULL,
  close_revision  integer NOT NULL,
  -- NULL: quản lý xoá trắng ghi chú
  note            text CHECK (note IS NULL OR length(note) <= 1000),
  actor           uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (building_id, period_month, close_revision)
    REFERENCES app_private.landlord_settlement_closes (building_id, period_month, revision) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS landlord_settlement_handovers_lan_chot
  ON app_private.landlord_settlement_handovers (building_id, period_month, close_revision, created_at DESC);

CREATE TABLE IF NOT EXISTS app_private.landlord_settlement_confirmations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  building_id     uuid NOT NULL,
  period_month    date NOT NULL,
  close_revision  integer NOT NULL,
  note            text CHECK (note IS NULL OR length(note) <= 500),
  -- link chủ nhà đã dùng để xác nhận
  share_token     text NOT NULL REFERENCES app_private.landlord_share_links(token) ON DELETE RESTRICT,
  confirmed_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (building_id, period_month, close_revision),
  FOREIGN KEY (building_id, period_month, close_revision)
    REFERENCES app_private.landlord_settlement_closes (building_id, period_month, revision) ON DELETE RESTRICT
);

REVOKE ALL ON app_private.landlord_settlement_handovers, app_private.landlord_settlement_confirmations
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE app_private.landlord_settlement_handovers IS
  'Ghi chú bàn giao của quản lý cho MỘT lần chốt quyết toán tháng (append-only). Dòng mới nhất là ghi chú hiện hành; chưa có dòng ⇒ ghi chú lúc chốt (landlord_settlement_closes.reason). Chủ chốt 23/10/2026.';
COMMENT ON TABLE app_private.landlord_settlement_confirmations IS
  'Chủ nhà xác nhận đã xem số liệu của MỘT lần chốt quyết toán tháng, bấm trên link chủ nhà (anon + token). Mở chốt/chốt lại ⇒ lần chốt mới ⇒ phải xác nhận lại. Chủ chốt 23/10/2026.';

-- ---------------------------------------------------------------------------
-- 3. Dòng lãi lỗ theo kỳ KÈM HẠNG MỤC — chép nguyên landlord_kqkd_lines_v1 (20261021083438, md5 production
--    d7f64c98…), chỉ thêm cột type_id. Không kiểm quyền: chỉ hàm công thức gọi.
CREATE OR REPLACE FUNCTION app_private.landlord_kqkd_lines_v2(
  p_building_id uuid,
  p_from        date,
  p_to          date
)
RETURNS TABLE (month date, voucher_id uuid, approval_status text, side text, amount numeric, type_id uuid)
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
           COALESCE(i.amount, i.unit_price * i.quantity)::numeric AS amt,
           t.id AS type_id
      FROM vouchers vo
      JOIN public.income_expense_items i ON i.income_expense_id = vo.id
      JOIN public.income_expense_types t ON t.id = i.income_expense_type_id
     WHERE vo.inv_month IS NOT NULL
       AND (vo.override IS TRUE OR i.accounting_class = 'PNL')
  ),
  invoice_no_item AS (
    SELECT vo.inv_month AS m, vo.id, vo.st, vo.side, vo.total_amount AS amt,
           NULL::uuid AS type_id
      FROM vouchers vo
     WHERE vo.inv_month IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.income_expense_items i WHERE i.income_expense_id = vo.id)
  ),
  period_items AS (
    SELECT (pg_catalog.date_trunc('month', i.start_date) + (s.k || ' month')::interval)::date AS m,
           vo.id, vo.st, vo.side,
           (pg_catalog.round(COALESCE(i.amount, i.unit_price * i.quantity) * (s.k + 1) / c.n)
            - pg_catalog.round(COALESCE(i.amount, i.unit_price * i.quantity) * s.k / c.n))::numeric AS amt,
           t.id AS type_id
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
           COALESCE(i.amount, i.unit_price * i.quantity)::numeric AS amt,
           t.id AS type_id
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
           COALESCE(i.amount, i.unit_price * i.quantity)::numeric AS amt,
           t.id AS type_id
      FROM vouchers vo
      JOIN public.income_expense_items i ON i.income_expense_id = vo.id
      JOIN public.income_expense_types t ON t.id = i.income_expense_type_id
     WHERE vo.inv_month IS NULL
       AND (vo.override IS TRUE OR i.accounting_class = 'PNL')
       AND (i.start_date IS NULL OR i.end_date IS NULL)
  ),
  no_item AS (
    SELECT pg_catalog.date_trunc('month', vo.voucher_date)::date AS m, vo.id, vo.st, vo.side,
           vo.total_amount AS amt,
           NULL::uuid AS type_id
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
  SELECT u.m, u.id, u.st, u.side, u.amt, u.type_id
    FROM unioned u, win
   WHERE u.m BETWEEN win.w_start AND win.w_end;
$fn$;

REVOKE ALL ON FUNCTION app_private.landlord_kqkd_lines_v2(uuid, date, date) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. CÔNG THỨC — thân production (20261023113626) + người giữ cọc + hạng mục. Không kiểm quyền: chỉ các hàm
--    SECURITY DEFINER gọi.
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
    -- điều khoản (% + tiền cố định + sổ chủ nhà + người giữ cọc) đang áp ở tháng này
    SELECT o.building_id, o.organization_id, o.effective_from,
           t.valid_from AS terms_from, t.manager_percent, t.manager_fixed_amount, t.landlord_account_ids,
           t.deposit_holder
      FROM app_private.landlord_operations o
      JOIN LATERAL (
        SELECT t.valid_from, t.manager_percent, t.manager_fixed_amount, t.landlord_account_ids, t.deposit_holder
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
  -- dòng lãi lỗ theo kỳ kèm hạng mục (v2 = v1 + type_id; cùng số tiền từng dòng)
  lai_lo AS (
    SELECT l.voucher_id, l.approval_status, l.amount, l.type_id
      FROM app_private.landlord_kqkd_lines_v2(p_building_id, p_month, p_month) AS l
  ),
  dong AS (
    -- MỌI dòng của phiếu đều vào đúng MỘT nhóm — không dòng nào rơi mất im lặng:
    --   KQKD  dòng lãi lỗ, xếp tháng THEO KỲ đúng luật fa_accrual_allocations (khớp Báo cáo LN);
    --   COC   cọc / tiền khách trả thừa — tiền giữ hộ khách, bên giữ cọc chịu trách nhiệm hoàn (theo ngày phiếu);
    --   KHAC  không tính (nội bộ, phiếu tắt KQKD, dòng không có hạng mục…) — vẫn liệt kê (theo ngày phiếu).
    SELECT l.voucher_id AS id, 'KQKD'::text AS nhom, NULL::text AS ly_do, l.amount AS so_tien
      FROM lai_lo AS l
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
            AND EXISTS (SELECT 1 FROM so_toa_khac s WHERE s.account_id = v.account_id)) AS so_toa_khac,
           v.invoice_id, v.room_id
      FROM (SELECT DISTINCT g.id FROM gop g) x
      CROSS JOIN cfg
      JOIN public.income_expenses v ON v.id = x.id
      LEFT JOIN public.accounts a ON a.id = v.account_id
  ),
  ct AS (
    SELECT p.id, p.code, p.voucher_date, p.loai, p.name, p.account_id, p.so_quy,
           p.approval_status, p.ben_chu_nha, p.nguon, p.kqkd, p.but_toan, p.han_che, p.so_toa_khac,
           p.invoice_id, p.room_id,
           g.nhom, g.ly_do, g.so_tien,
           -- dòng cọc / trả thừa nằm ở bên sổ CÓ TÍNH vào số bàn giao: quản lý giữ cọc ⇒ sổ chủ nhà
           -- (chủ nhà bàn giao); chủ nhà giữ cọc ⇒ sổ quản lý (quản lý bàn giao)
           (g.nhom = 'COC' AND p.ben_chu_nha = (cfg.deposit_holder = 'MANAGER')) AS coc_tinh
      FROM phieu p
      JOIN gop g ON g.id = p.id
      CROSS JOIN cfg
     WHERE g.so_tien <> 0
  ),
  -- hạng mục của dòng lãi lỗ (chỉ để hiển thị — không vào chuỗi băm). Phiếu không có dòng hạng mục ⇒ "Khác".
  lai_lo_hang_muc AS (
    SELECT l.voucher_id AS id, l.approval_status, l.amount,
           COALESCE(t.name, 'Khác') AS ten,
           COALESCE(t.is_restricted, false) AS han_che
      FROM lai_lo l
      LEFT JOIN public.income_expense_types t ON t.id = l.type_id
  ),
  hang_muc AS (
    SELECT p.loai, h.ten, h.han_che,
           sum(h.amount) AS tong,
           COALESCE(sum(h.amount) FILTER (WHERE p.ben_chu_nha), 0) AS chu_nha,
           COALESCE(sum(h.amount) FILTER (WHERE NOT p.ben_chu_nha), 0) AS quan_ly
      FROM lai_lo_hang_muc h
      JOIN phieu p ON p.id = h.id
     WHERE h.approval_status = 'APPROVED'
     GROUP BY p.loai, h.ten, h.han_che
  ),
  -- TÊN HIỂN THỊ (chủ nhắn 23/10/2026: đừng ghi "Thu tiền theo HĐ INV-…", ghi rõ tiền phòng kỳ nào; thanh lý /
  -- bỏ cọc đừng ghi mã). Web dựng tên bằng src/lib/voucherDisplayName.ts — cùng một đường với Thu chi và Báo
  -- cáo LN; link chủ nhà chạy bằng anon nên không đọc được bảng invoices ⇒ trả các PHẦN dựng tên ở đây.
  -- KHÔNG trả notes. Ba cờ CHÉP LUẬT src/lib/invoiceUtils.ts (invoiceTitlePartsOf / isFirstMonthInvoice):
  --   is_liquidation  kind = 'SETTLEMENT' hoặc notes có "thanh lý";
  --   is_extra        notes MỞ ĐẦU "hoá đơn thu thêm";
  --   is_first_month  notes có "tháng đầu" / "đầu tiên", hoặc dòng RENT có kỳ sớm nhất bắt đầu đúng
  --                   contracts.start_billing_date.
  -- Regex viết cả chữ hoa có dấu ([áÁ]…) vì lower() chỉ chắc với chữ ASCII ở mọi locale. Test PGlite so từng
  -- cờ với hàm TS — sửa luật một bên mà quên bên kia thì test đỏ.
  hien_thi AS (
    SELECT x.id,
           COALESCE(vr.name, ir.name) AS ten_phong,
           CASE WHEN inv.id IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object(
             'kind', inv.kind,
             'billing_month', inv.billing_month,
             'issue_date', inv.issue_date,
             'has_rent', EXISTS (SELECT 1 FROM public.invoice_items ii
                                  WHERE ii.invoice_id = inv.id AND ii.type::text = 'RENT'),
             'has_service', EXISTS (SELECT 1 FROM public.invoice_items ii
                                     WHERE ii.invoice_id = inv.id AND ii.type::text IN ('SERVICE', 'PENALTY')),
             'is_first_month',
               pg_catalog.lower(COALESCE(inv.notes, '')) ~ 'th[aáÁ]ng[\s_]?[đĐ][ầẦ]u|[đĐ][ầẦ]u\s*ti[êÊ]n'
               OR COALESCE((SELECT min(ii.from_date) FROM public.invoice_items ii
                             WHERE ii.invoice_id = inv.id AND ii.type::text = 'RENT' AND ii.from_date IS NOT NULL)
                           = c.start_billing_date, false),
             'is_liquidation',
               COALESCE(inv.kind = 'SETTLEMENT', false)
               OR pg_catalog.lower(COALESCE(inv.notes, '')) ~ 'thanh\s*l[ýÝ]',
             'is_extra',
               pg_catalog.lower(COALESCE(inv.notes, '')) ~ '^\s*ho[áÁ]\s*[đĐ][ơƠ]n\s*thu\s*th[êÊ]m')
           END AS hoa_don
      FROM (SELECT DISTINCT ct.id, ct.invoice_id, ct.room_id FROM ct) x
      LEFT JOIN public.rooms vr ON vr.id = x.room_id
      LEFT JOIN public.invoices inv ON inv.id = x.invoice_id AND inv.deleted_at IS NULL
      LEFT JOIN public.rooms ir ON ir.id = inv.room_id
      LEFT JOIN public.contracts c ON c.id = inv.contract_id
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
      -- cọc/tiền trả thừa đi qua SỔ QUẢN LÝ: chủ nhà giữ cọc thì quản lý bàn giao phần này cho chủ nhà
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'COC' AND approval_status = 'APPROVED' AND loai = 'INCOME'  AND NOT ben_chu_nha), 0) AS coc_quan_ly_thu,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'COC' AND approval_status = 'APPROVED' AND loai = 'EXPENSE' AND NOT ben_chu_nha), 0) AS coc_quan_ly_chi,
      -- thanh lý hợp đồng, tách theo nguồn phiếu hệ thống sinh
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'APPROVED' AND nguon = 'termination.revenue'), 0)         AS tl_doanh_thu_tu_coc,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'APPROVED' AND nguon = 'termination.forfeit_revenue'), 0) AS tl_doanh_thu_bo_coc,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'APPROVED' AND nguon = 'termination.extra_receipt'), 0)   AS tl_khach_tra_them,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'APPROVED' AND nguon = 'termination.refund'), 0)          AS tl_tra_them_ngoai_coc,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'COC'  AND approval_status = 'APPROVED' AND nguon = 'termination.refund'), 0)          AS tl_hoan_coc,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'COC'  AND approval_status = 'APPROVED' AND nguon IN ('termination.offset', 'termination.forfeit_offset')), 0) AS tl_can_coc,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'UNAPPROVED' AND nguon = 'termination.refund'), 0)        AS tl_cho_duyet,
      -- phiếu chờ duyệt chặn chốt: lãi lỗ + cọc ở bên sổ có tính vào số bàn giao (quản lý giữ cọc: sổ chủ
      -- nhà — đúng luật cũ; chủ nhà giữ cọc: sổ quản lý)
      count(DISTINCT id) FILTER (WHERE approval_status = 'UNAPPROVED'
                                   AND (nhom = 'KQKD' OR coc_tinh)) AS cho_duyet_so_phieu,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'UNAPPROVED' AND loai = 'INCOME'), 0)  AS cho_duyet_thu,
      COALESCE(sum(so_tien) FILTER (WHERE nhom = 'KQKD' AND approval_status = 'UNAPPROVED' AND loai = 'EXPENSE'), 0) AS cho_duyet_chi,
      COALESCE(sum(CASE WHEN loai = 'EXPENSE' THEN -so_tien ELSE so_tien END)
                 FILTER (WHERE nhom = 'COC' AND approval_status = 'UNAPPROVED' AND ben_chu_nha), 0) AS cho_duyet_coc_chu_nha,
      COALESCE(sum(CASE WHEN loai = 'EXPENSE' THEN -so_tien ELSE so_tien END)
                 FILTER (WHERE coc_tinh AND approval_status = 'UNAPPROVED'), 0) AS cho_duyet_coc_tinh,
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
           cfg.manager_percent, cfg.manager_fixed_amount, cfg.terms_from, cfg.deposit_holder,
           -- phần cọc vào số bàn giao (có dấu): quản lý giữ cọc ⇒ + cọc ở sổ chủ nhà (chủ nhà bàn giao cho
           -- quản lý); chủ nhà giữ cọc ⇒ − cọc ở sổ quản lý (quản lý bàn giao cho chủ nhà)
           CASE WHEN cfg.deposit_holder = 'LANDLORD'
                THEN -(so.coc_quan_ly_thu - so.coc_quan_ly_chi)
                ELSE so.coc_chu_nha_thu - so.coc_chu_nha_chi END AS phan_coc
      FROM so CROSS JOIN cfg CROSS JOIN du CROSS JOIN dao
  ),
  -- phần quản lý = tiền cố định (luôn đủ, kể cả tháng lỗ) + % LN tháng (LN ≤ 0 ⇒ 0)
  hai_phan AS (
    SELECT kq.*,
           kq.manager_fixed_amount AS phan_co_dinh,
           CASE WHEN kq.loi_nhuan > 0
                THEN pg_catalog.round(kq.loi_nhuan * kq.manager_percent / 100)
                ELSE 0::numeric END AS phan_phan_tram
      FROM kq
  ),
  chia AS (
    SELECT hp.*, hp.phan_co_dinh + hp.phan_phan_tram AS phan_quan_ly
      FROM hai_phan hp
  ),
  vet AS (
    SELECT pg_catalog.md5(
             -- chỉ dòng làm đổi số: KQKD, và cọc/trả thừa ở bên sổ có tính (quản lý giữ cọc: sổ chủ nhà — y
             -- như trước 23/10/2026). Cọc ở bên sổ kia và dòng "không tính" đổi (vd duyệt cọc giữ chỗ) không
             -- làm tháng đã chốt hoá cũ.
             COALESCE((SELECT pg_catalog.string_agg(
                         pg_catalog.concat_ws('|', ct.id, ct.approval_status, ct.but_toan, ct.account_id,
                                              ct.loai, ct.nhom, ct.so_tien, ct.voucher_date),
                         ';' ORDER BY ct.id, ct.nhom)
                         FROM ct WHERE ct.nhom = 'KQKD' OR ct.coc_tinh), '')
             || '#' || (SELECT du.du_chu_nha::text FROM du)
             -- phiếu TOÀ KHÁC ghi vào sổ chủ nhà trong tháng: nhập muộn sau khi chốt cũng làm tháng "đã đổi"
             || '#' || pg_catalog.md5(COALESCE(
                  app_private.landlord_account_elsewhere_v1(p_building_id, p_month)::text, ''))
             || '#' ||
             -- điều khoản: tiền cố định / người giữ cọc chỉ vào chuỗi khi khác mặc định ⇒ điều khoản mặc định
             -- băm y như trước (tháng đã chốt từ trước không thành "đổi sau khi chốt")
             (SELECT pg_catalog.concat_ws('|', cfg.manager_percent,
                       pg_catalog.array_to_string(
                         ARRAY(SELECT x FROM pg_catalog.unnest(cfg.landlord_account_ids) AS x ORDER BY x), ','))
                     || CASE WHEN cfg.manager_fixed_amount <> 0
                             THEN '|co_dinh:' || cfg.manager_fixed_amount::text ELSE '' END
                     || CASE WHEN cfg.deposit_holder <> 'MANAGER'
                             THEN '|giu_coc:' || cfg.deposit_holder ELSE '' END
                FROM cfg)
           ) AS source_hash
  )
  SELECT pg_catalog.jsonb_build_object(
           'building_id', p_building_id,
           'period_month', (SELECT dau FROM ky),
           'manager_percent', chia.manager_percent,
           'manager_fixed_amount', chia.manager_fixed_amount,
           'terms_from', chia.terms_from,
           'deposit_holder', chia.deposit_holder,
           'totals', pg_catalog.jsonb_build_object(
              'landlord_collected', chia.chu_nha_thu,
              'manager_collected',  chia.quan_ly_thu,
              'revenue',            chia.doanh_thu,
              'landlord_paid',      chia.chu_nha_chi,
              'manager_paid',       chia.quan_ly_chi,
              'expense',            chia.chi_phi,
              'profit',             chia.loi_nhuan,
              'manager_fixed_share',   chia.phan_co_dinh,
              'manager_percent_share', chia.phan_phan_tram,
              'manager_share',      chia.phan_quan_ly,
              'landlord_share',     chia.loi_nhuan - chia.phan_quan_ly,
              -- mỗi sổ đang giữ bao nhiêu từ thu chi lãi lỗ trong tháng (thu − chi; âm = bên đó ứng tiền chi hộ)
              'landlord_net_held',  chia.chu_nha_thu - chia.chu_nha_chi,
              'manager_net_held',   chia.quan_ly_thu - chia.quan_ly_chi,
              'landlord_held_deposits', chia.coc_chu_nha_thu - chia.coc_chu_nha_chi,
              'manager_held_deposits', chia.coc_quan_ly_thu - chia.coc_quan_ly_chi,
              'deposit_adjustment', chia.phan_coc,
              'landlord_extra_cash', chia.du_chu_nha,
              'landlord_owes_manager', chia.phan_quan_ly + chia.quan_ly_chi - chia.quan_ly_thu
                                       + chia.phan_coc + chia.du_chu_nha),
           'reversed_voucher_count', chia.so_phieu_dao,
           'unposted_voucher_count', chia.so_phieu_chua_ghi,
           'foreign_account_voucher_count', chia.so_phieu_so_khac,
           'deposits', pg_catalog.jsonb_build_object(
              'received', chia.coc_thu,
              'paid_out', chia.coc_chi,
              'landlord_received', chia.coc_chu_nha_thu,
              'landlord_paid_out', chia.coc_chu_nha_chi,
              'manager_received', chia.coc_quan_ly_thu,
              'manager_paid_out', chia.coc_quan_ly_chi),
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
              'landlord_deposit', chia.cho_duyet_coc_chu_nha,
              -- cọc/trả thừa chờ duyệt ở bên sổ có tính vào số bàn giao (theo người giữ cọc), có dấu
              'deposit', chia.cho_duyet_coc_tinh),
           'excluded', pg_catalog.jsonb_build_object(
              'voucher_count', chia.khac_so_phieu,
              'income', chia.khac_thu,
              'expense', chia.khac_chi),
           -- thu / chi lãi lỗ ĐÃ DUYỆT theo hạng mục (cộng đúng bằng revenue / expense)
           'categories', pg_catalog.jsonb_build_object(
              'income', COALESCE((
                 SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                          'name', h.ten, 'amount', h.tong, 'landlord_amount', h.chu_nha,
                          'manager_amount', h.quan_ly, 'restricted', h.han_che)
                        ORDER BY h.tong DESC, h.ten)
                   FROM hang_muc h WHERE h.loai = 'INCOME' AND h.tong <> 0), '[]'::jsonb),
              'expense', COALESCE((
                 SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                          'name', h.ten, 'amount', h.tong, 'landlord_amount', h.chu_nha,
                          'manager_amount', h.quan_ly, 'restricted', h.han_che)
                        ORDER BY h.tong DESC, h.ten)
                   FROM hang_muc h WHERE h.loai = 'EXPENSE' AND h.tong <> 0), '[]'::jsonb)),
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
                       'amount', ct.so_tien,
                       'room_name', ht.ten_phong,
                       'invoice', ht.hoa_don,
                       -- phần của KỲ tháng này theo hạng mục (chỉ dòng lãi lỗ)
                       'lines', CASE WHEN ct.nhom = 'KQKD' THEN (
                                  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                                           'category', d.ten, 'amount', d.so_tien) ORDER BY d.so_tien DESC, d.ten)
                                    FROM (SELECT h.ten, sum(h.amount) AS so_tien
                                            FROM lai_lo_hang_muc h
                                           WHERE h.id = ct.id
                                           GROUP BY h.ten) d
                                   WHERE d.so_tien <> 0) END)
                     ORDER BY ct.voucher_date, ct.code, ct.nhom)
                FROM ct LEFT JOIN hien_thi ht ON ht.id = ct.id), '[]'::jsonb),
           'source_hash', vet.source_hash)
    FROM chia CROSS JOIN vet;
$fn$;

REVOKE ALL ON FUNCTION app_private.landlord_settlement_compute_v1(uuid, date) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Gói cho link chủ nhà: thân production + phiếu HẠN CHẾ bỏ cả lines; hạng mục HẠN CHẾ gộp thành một dòng
--    "Khoản hạn chế" (link chủ nhà không thấy tên hạng mục hạn chế; số tiền cả phiếu vốn đã hiện).
CREATE OR REPLACE FUNCTION app_private.landlord_public_categories_v1(p_rows jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path TO ''
AS $fn$
  SELECT COALESCE(pg_catalog.jsonb_agg(x.e ORDER BY (x.e->>'amount')::numeric DESC, x.e->>'name'), '[]'::jsonb)
    FROM (
      SELECT r.value - 'restricted' AS e
        FROM pg_catalog.jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) AS r
       WHERE (r.value->>'restricted')::boolean IS NOT TRUE
      UNION ALL
      SELECT pg_catalog.jsonb_build_object(
               'name', 'Khoản hạn chế',
               'amount', sum((r.value->>'amount')::numeric),
               'landlord_amount', sum((r.value->>'landlord_amount')::numeric),
               'manager_amount', sum((r.value->>'manager_amount')::numeric))
        FROM pg_catalog.jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) AS r
       WHERE (r.value->>'restricted')::boolean IS TRUE
      HAVING count(*) > 0
    ) x;
$fn$;

REVOKE ALL ON FUNCTION app_private.landlord_public_categories_v1(jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.landlord_strip_public_v1(p_statement jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path TO ''
AS $fn$
  SELECT CASE
    WHEN p_statement IS NULL THEN NULL
    ELSE pg_catalog.jsonb_set(
           -- ảnh chốt trước 23/10/2026 tối không có categories ⇒ giữ nguyên (không thêm khoá)
           CASE WHEN pg_catalog.jsonb_typeof(p_statement->'categories') = 'object'
                THEN pg_catalog.jsonb_set(
                       p_statement - 'building_id',
                       '{categories}',
                       pg_catalog.jsonb_build_object(
                         'income', app_private.landlord_public_categories_v1(p_statement->'categories'->'income'),
                         'expense', app_private.landlord_public_categories_v1(p_statement->'categories'->'expense')))
                ELSE p_statement - 'building_id' END,
           '{vouchers}',
           COALESCE((SELECT pg_catalog.jsonb_agg(
                              (e.value - 'id' - 'foreign_landlord_account'
                                 - CASE WHEN (e.value->>'restricted')::boolean IS TRUE
                                        THEN ARRAY['room_name', 'invoice', 'lines']::text[]
                                        ELSE ARRAY[]::text[] END)
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

REVOKE ALL ON FUNCTION app_private.landlord_strip_public_v1(jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Gói một tháng: thân production + ghi chú bàn giao hiện hành + xác nhận của chủ nhà cho lần chốt hiện tại.
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
-- 7. Tổng quyết toán: thân production + các dòng "Cách tính" từng tháng, lần chốt, xác nhận của chủ nhà.
--    Ảnh chốt cũ thiếu trường ⇒ chép trường tương đương (không tính lại).
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
  v_fixed        numeric;
  v_holder       text;
  v_paid_l       numeric;
  v_paid_m       numeric;
  v_payments     jsonb;
  v_confirmed_at timestamptz;
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
    v_confirmed_at := NULL;
    IF v_closed THEN
      v_closed_net := v_closed_net + v_net;
      v_closed_count := v_closed_count + 1;
      SELECT k.confirmed_at INTO v_confirmed_at
        FROM app_private.landlord_settlement_confirmations k
       WHERE k.building_id = p_building_id AND k.period_month = v_m AND k.close_revision = v_last.revision;
    ELSIF v_cfg.is_active THEN
      -- toà đã ngừng áp dụng: tháng mở vẫn liệt kê (chốt được) nhưng không cộng tạm tính — phí cố
      -- định không tự dồn mãi theo tháng; cùng luật với landlord_ihome_profit_v1 (23/10/2026)
      v_open_net := v_open_net + v_net;
    END IF;
    v_months := v_months || pg_catalog.jsonb_build_object(
      'period_month', v_m,
      'status', CASE WHEN v_closed THEN 'CLOSED' ELSE 'OPEN' END,
      'is_stale', v_closed AND v_last.source_hash IS DISTINCT FROM (v_live->>'source_hash'),
      'is_current_month', v_m = v_now,
      'manager_percent', v_stmt->'manager_percent',
      -- ảnh chốt trước 23/10/2026 không có tiền cố định ⇒ 0 (thoả thuận lúc đó chỉ có %)
      'manager_fixed_amount', COALESCE(v_stmt->'manager_fixed_amount', '0'::jsonb),
      'revenue', v_stmt->'totals'->'revenue',
      'expense', v_stmt->'totals'->'expense',
      'profit', v_stmt->'totals'->'profit',
      'manager_share', v_stmt->'totals'->'manager_share',
      'landlord_owes_manager', v_net,
      'pending_count', COALESCE((v_live->'pending'->>'voucher_count')::integer, 0),
      -- các dòng "Cách tính" của tháng (ảnh chốt cũ: phần cố định 0, phần % = cả phần quản lý, cọc theo
      -- luật quản lý giữ cọc — đúng luật lúc chốt)
      'manager_fixed_share', COALESCE(v_stmt->'totals'->'manager_fixed_share', '0'::jsonb),
      'manager_percent_share', COALESCE(v_stmt->'totals'->'manager_percent_share', v_stmt->'totals'->'manager_share'),
      'manager_paid', v_stmt->'totals'->'manager_paid',
      'manager_collected', v_stmt->'totals'->'manager_collected',
      'deposit_holder', COALESCE(v_stmt->'deposit_holder', '"MANAGER"'::jsonb),
      'deposit_adjustment', COALESCE(v_stmt->'totals'->'deposit_adjustment', v_stmt->'totals'->'landlord_held_deposits'),
      'extra_cash', v_stmt->'totals'->'landlord_extra_cash',
      'close_revision', CASE WHEN v_closed THEN v_last.revision END,
      'confirmed_at', v_confirmed_at);
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

  -- tỷ lệ + tiền cố định + người giữ cọc của điều khoản mới nhất (từng tháng có điều khoản riêng trong months[])
  SELECT t.manager_percent, t.manager_fixed_amount, t.deposit_holder INTO v_percent, v_fixed, v_holder
    FROM app_private.landlord_operation_terms t
   WHERE t.building_id = p_building_id
   ORDER BY t.valid_from DESC
   LIMIT 1;

  RETURN pg_catalog.jsonb_build_object(
    'building_name', v_name,
    'landlord_name', v_cfg.landlord_name,
    'manager_percent', v_percent,
    'manager_fixed_amount', v_fixed,
    'deposit_holder', v_holder,
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

REVOKE ALL ON FUNCTION app_private.landlord_settlement_overview_payload_v1(uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. Hộp cài đặt / ảnh sổ thay đổi: thân production + người giữ cọc.
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
               'manager_fixed_amount', lt.manager_fixed_amount,
               'deposit_holder', lt.deposit_holder,
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
               -- tháng mặc định cho điều khoản mới: ngay sau tháng chốt gần nhất
               'next_terms_month', CASE WHEN v_last_closed IS NULL THEN o.effective_from
                                        ELSE (v_last_closed + interval '1 month')::date END,
               'terms', COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                           'valid_from', t.valid_from,
                           'manager_percent', t.manager_percent,
                           'manager_fixed_amount', t.manager_fixed_amount,
                           'deposit_holder', t.deposit_holder,
                           'landlord_account_ids', to_jsonb(t.landlord_account_ids)) ORDER BY t.valid_from)
                    FROM app_private.landlord_operation_terms t
                   WHERE t.building_id = o.building_id), '[]'::jsonb),
               'updated_at', o.updated_at)
        FROM app_private.landlord_operations o
        CROSS JOIN LATERAL (
          SELECT t.valid_from, t.manager_percent, t.manager_fixed_amount, t.deposit_holder, t.landlord_account_ids
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
                       'manager_fixed_amount', t.manager_fixed_amount,
                       'deposit_holder', t.deposit_holder,
                       'landlord_account_ids', pg_catalog.to_jsonb(t.landlord_account_ids)) ORDER BY t.valid_from)
                FROM app_private.landlord_operation_terms t
               WHERE t.building_id = o.building_id), '[]'::jsonb))
    FROM app_private.landlord_operations o
   WHERE o.building_id = p_building_id;
$fn$;

REVOKE ALL ON FUNCTION app_private.landlord_operation_state_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. Ghi cài đặt: thân production + tham số cuối p_deposit_holder. Thêm tham số không làm được bằng CREATE OR
--    REPLACE (sẽ thành hai hàm trùng tên mà PostgREST chọn nhầm) ⇒ bỏ đúng chữ ký cũ.
DROP FUNCTION IF EXISTS public.landlord_operation_upsert_v1(uuid, text, numeric, date, uuid[], text, boolean, numeric, boolean, date, numeric, timestamptz, numeric);
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
  p_expected_updated_at  timestamptz DEFAULT NULL,
  -- tiền quản lý nhận cố định mỗi tháng (đồng); NULL = giữ tiền cố định của điều khoản đang áp ở tháng T
  -- (toà mới: 0) — lời gọi cũ không biết tham số này không xoá mất tiền cố định
  p_manager_fixed_amount numeric DEFAULT NULL,
  -- người giữ cọc 'MANAGER' | 'LANDLORD'; NULL = giữ của điều khoản đang áp ở tháng T (toà mới: MANAGER)
  p_deposit_holder       text DEFAULT NULL
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
  v_fixed_change boolean;
  v_ids_change   boolean;
  v_holder_change boolean;
  v_fixed        numeric;
  v_holder       text;
  v_zero_month   date;
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
  IF p_manager_fixed_amount IS NOT NULL
     AND (p_manager_fixed_amount < 0 OR p_manager_fixed_amount <> round(p_manager_fixed_amount)
          OR p_manager_fixed_amount >= 1e13) THEN
    RAISE EXCEPTION 'Tiền quản lý nhận cố định phải là số nguyên đồng, từ 0 trở lên' USING ERRCODE = '22023';
  END IF;
  IF p_deposit_holder IS NOT NULL AND p_deposit_holder NOT IN ('MANAGER', 'LANDLORD') THEN
    RAISE EXCEPTION 'Người giữ cọc chỉ là quản lý hoặc chủ nhà' USING ERRCODE = '22023';
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
  -- toà mới: quản lý phải nhận % hoặc tiền cố định (hoặc cả hai)
  IF NOT v_exists AND p_manager_percent = 0 AND COALESCE(p_manager_fixed_amount, 0) = 0 THEN
    RAISE EXCEPTION 'Quản lý phải nhận %% lợi nhuận hoặc tiền cố định (hoặc cả hai) — không để cả hai bằng 0'
      USING ERRCODE = '22023';
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
      (building_id, valid_from, manager_percent, manager_fixed_amount, deposit_holder, landlord_account_ids, created_by)
    VALUES (p_building_id, v_from, p_manager_percent, COALESCE(p_manager_fixed_amount, 0),
            COALESCE(p_deposit_holder, 'MANAGER'), v_ids, v_actor);
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

    -- 2. đổi % / tiền cố định / sổ chủ nhà / người giữ cọc TỪNG TRƯỜNG, từ tháng T (p_terms_from, mặc định
    --    ngay sau tháng chốt gần nhất) trở đi: so với điều khoản ĐANG ÁP ở T (đúng thứ màn đã hiện cho tháng
    --    đó). Trường nào đổi thì ghi trường đó cho T và mọi mốc sau T; trường không đổi giữ nguyên ở từng mốc
    --    (đổi % không kéo theo tiền cố định, sổ hay người giữ cọc của mốc khác, và ngược lại). Tháng trước T
    --    giữ điều khoản cũ.
    -- tháng trước tháng áp dụng không có trong quyết toán ⇒ T sớm hơn thì kẹp về tháng áp dụng
    v_terms_from := GREATEST(COALESCE(date_trunc('month', p_terms_from)::date,
                                      CASE WHEN v_last_closed IS NULL THEN v_from
                                           ELSE (v_last_closed + interval '1 month')::date END), v_from);
    SELECT * INTO v_prev
      FROM app_private.landlord_operation_terms t
     WHERE t.building_id = p_building_id AND t.valid_from <= v_terms_from
     ORDER BY t.valid_from DESC
     LIMIT 1;
    v_fixed := COALESCE(p_manager_fixed_amount, v_prev.manager_fixed_amount, 0);
    v_holder := COALESCE(p_deposit_holder, v_prev.deposit_holder, 'MANAGER');
    -- điều khoản màn đang lưu cho tháng T: quản lý phải nhận % hoặc tiền cố định (hoặc cả hai)
    IF p_manager_percent = 0 AND v_fixed = 0 THEN
      RAISE EXCEPTION 'Quản lý phải nhận %% lợi nhuận hoặc tiền cố định (hoặc cả hai) — không để cả hai bằng 0'
        USING ERRCODE = '22023';
    END IF;
    v_pct_change := v_prev.manager_percent IS DISTINCT FROM p_manager_percent;
    v_fixed_change := v_prev.manager_fixed_amount IS DISTINCT FROM v_fixed;
    v_ids_change := v_prev.landlord_account_ids IS DISTINCT FROM v_ids;
    v_holder_change := v_prev.deposit_holder IS DISTINCT FROM v_holder;
    IF NOT (v_pct_change OR v_fixed_change OR v_ids_change OR v_holder_change) THEN
      v_terms_from := NULL;
    ELSE
      IF v_terms_from < v_from THEN
        RAISE EXCEPTION 'Tháng áp dụng điều khoản mới (%) phải từ tháng bắt đầu áp dụng (%) trở đi',
          to_char(v_terms_from, 'MM/YYYY'), to_char(v_from, 'MM/YYYY') USING ERRCODE = '22023';
      END IF;
      SELECT min(m) INTO v_blocked
        FROM app_private.landlord_closed_months_v1(p_building_id) AS m
       WHERE m >= v_terms_from;
      IF v_blocked IS NOT NULL THEN
        RAISE EXCEPTION 'Tháng % đã chốt — mở chốt tháng đó trước khi đổi tỷ lệ / tiền cố định / sổ chủ nhà / người giữ cọc từ tháng %',
          to_char(v_blocked, 'MM/YYYY'), to_char(v_terms_from, 'MM/YYYY') USING ERRCODE = '55000';
      END IF;
      INSERT INTO app_private.landlord_operation_terms AS t
        (building_id, valid_from, manager_percent, manager_fixed_amount, deposit_holder, landlord_account_ids, created_by)
      VALUES (p_building_id, v_terms_from,
              CASE WHEN v_pct_change THEN p_manager_percent ELSE v_prev.manager_percent END,
              CASE WHEN v_fixed_change THEN v_fixed ELSE v_prev.manager_fixed_amount END,
              CASE WHEN v_holder_change THEN v_holder ELSE v_prev.deposit_holder END,
              CASE WHEN v_ids_change THEN v_ids ELSE v_prev.landlord_account_ids END, v_actor)
      ON CONFLICT (building_id, valid_from) DO UPDATE
         SET manager_percent = EXCLUDED.manager_percent,
             manager_fixed_amount = EXCLUDED.manager_fixed_amount,
             deposit_holder = EXCLUDED.deposit_holder,
             landlord_account_ids = EXCLUDED.landlord_account_ids;
      UPDATE app_private.landlord_operation_terms t
         SET manager_percent = CASE WHEN v_pct_change THEN p_manager_percent ELSE t.manager_percent END,
             manager_fixed_amount = CASE WHEN v_fixed_change THEN v_fixed ELSE t.manager_fixed_amount END,
             deposit_holder = CASE WHEN v_holder_change THEN v_holder ELSE t.deposit_holder END,
             landlord_account_ids = CASE WHEN v_ids_change THEN v_ids ELSE t.landlord_account_ids END
       WHERE t.building_id = p_building_id AND t.valid_from > v_terms_from;
      -- đổi một trường mà mốc sau T giữ trường kia ⇒ mốc đó có thể thành 0% + 0đ: không cho lưu
      SELECT min(t.valid_from) INTO v_zero_month
        FROM app_private.landlord_operation_terms t
       WHERE t.building_id = p_building_id AND t.valid_from > v_terms_from
         AND t.manager_percent = 0 AND t.manager_fixed_amount = 0;
      IF v_zero_month IS NOT NULL THEN
        RAISE EXCEPTION 'Từ tháng % quản lý sẽ không nhận gì (0%% và 0đ cố định) — sửa cả điều khoản từ tháng đó',
          to_char(v_zero_month, 'MM/YYYY') USING ERRCODE = '22023';
      END IF;
      -- gộp mốc trùng y điều khoản ngay trước nó
      DELETE FROM app_private.landlord_operation_terms t
       USING (SELECT x.valid_from,
                     x.manager_percent = lag(x.manager_percent) OVER w
                     AND x.manager_fixed_amount = lag(x.manager_fixed_amount) OVER w
                     AND x.deposit_holder = lag(x.deposit_holder) OVER w
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

-- ---------------------------------------------------------------------------
-- 10a. Sửa ghi chú bàn giao của lần chốt hiện tại (chủ công ty / super admin). Append-only: mỗi lần sửa một dòng.
CREATE OR REPLACE FUNCTION public.landlord_settlement_note_update_v1(
  p_building_id uuid,
  p_month       date,
  p_revision    integer,
  p_note        text
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
  v_note  text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_last  app_private.landlord_settlement_closes%ROWTYPE;
  v_cur   text;
  v_cur_at timestamptz;
  v_at    timestamptz;
BEGIN
  IF auth.uid() IS NULL OR NOT app_private.landlord_actor_can_manage_v1(p_building_id) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xem và quyết toán toà vận hành'
      USING ERRCODE = '42501';
  END IF;
  IF v_month IS NULL OR p_revision IS NULL THEN
    RAISE EXCEPTION 'Thiếu tháng hoặc lần chốt cần sửa ghi chú' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN
    RAISE EXCEPTION 'Ghi chú bàn giao tối đa 1000 ký tự' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('landlord_settlement:' || p_building_id::text, 0));

  SELECT * INTO v_last
    FROM app_private.landlord_settlement_closes c
   WHERE c.building_id = p_building_id AND c.period_month = v_month
   ORDER BY c.revision DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tháng % chưa chốt — ghi chú bàn giao nhập khi chốt tháng', to_char(v_month, 'MM/YYYY')
      USING ERRCODE = '55000';
  END IF;
  -- màn đang cầm lần chốt cũ (đã mở chốt / chốt lại sau đó)
  IF v_last.revision <> p_revision THEN
    RAISE EXCEPTION 'Tháng % vừa được mở chốt hoặc chốt lại — tải lại trang rồi sửa ghi chú', to_char(v_month, 'MM/YYYY')
      USING ERRCODE = '40001';
  END IF;
  IF v_last.action <> 'CLOSE' THEN
    RAISE EXCEPTION 'Tháng % chưa chốt — ghi chú bàn giao nhập khi chốt tháng', to_char(v_month, 'MM/YYYY')
      USING ERRCODE = '55000';
  END IF;

  SELECT h.note, h.created_at INTO v_cur, v_cur_at
    FROM app_private.landlord_settlement_handovers h
   WHERE h.building_id = p_building_id AND h.period_month = v_month AND h.close_revision = v_last.revision
   ORDER BY h.created_at DESC, h.id DESC
   LIMIT 1;
  IF NOT FOUND THEN
    v_cur := v_last.reason;
    v_cur_at := v_last.created_at;
  END IF;
  IF v_cur IS NOT DISTINCT FROM v_note THEN
    RETURN jsonb_build_object('status', 'UNCHANGED', 'revision', v_last.revision, 'updated_at', v_cur_at);
  END IF;

  INSERT INTO app_private.landlord_settlement_handovers
    (organization_id, building_id, period_month, close_revision, note, actor)
  VALUES (v_last.organization_id, p_building_id, v_month, v_last.revision, v_note, v_actor)
  RETURNING created_at INTO v_at;

  RETURN jsonb_build_object('status', 'UPDATED', 'revision', v_last.revision, 'updated_at', v_at);
END
$fn$;

-- 10b. Chủ nhà xác nhận đã xem số liệu của lần chốt hiện tại — gọi bằng ANON qua token link chủ nhà. Kiểm token
--      y như landlord_settlement_public_v1 (link chưa thu hồi, toà còn áp dụng, toà còn sống). Một dòng mỗi lần
--      chốt: bấm lại / hai máy cùng bấm ⇒ ALREADY_CONFIRMED với thời điểm của lần đầu.
CREATE OR REPLACE FUNCTION public.landlord_settlement_confirm_v1(
  p_token    text,
  p_month    date,
  p_revision integer,
  p_note     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_link  app_private.landlord_share_links%ROWTYPE;
  v_cfg   app_private.landlord_operations%ROWTYPE;
  v_month date := date_trunc('month', p_month)::date;
  v_note  text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_last  app_private.landlord_settlement_closes%ROWTYPE;
  v_at    timestamptz;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{32,64}$' THEN
    RAISE EXCEPTION 'Link không còn hiệu lực — liên hệ bên quản lý để nhận link mới' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_link
    FROM app_private.landlord_share_links l
   WHERE l.token = p_token AND l.revoked_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Link không còn hiệu lực — liên hệ bên quản lý để nhận link mới' USING ERRCODE = 'P0002';
  END IF;
  SELECT o.* INTO v_cfg
    FROM app_private.landlord_operations o
    JOIN public.buildings b ON b.id = o.building_id
   WHERE o.building_id = v_link.building_id AND o.is_active
     AND b.deleted_at IS NULL AND NOT COALESCE(b.is_virtual, false);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Link không còn hiệu lực — liên hệ bên quản lý để nhận link mới' USING ERRCODE = 'P0002';
  END IF;
  IF v_month IS NULL OR p_revision IS NULL THEN
    RAISE EXCEPTION 'Thiếu tháng hoặc lần chốt cần xác nhận' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN
    RAISE EXCEPTION 'Ghi chú tối đa 500 ký tự' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('landlord_settlement:' || v_link.building_id::text, 0));

  SELECT * INTO v_last
    FROM app_private.landlord_settlement_closes c
   WHERE c.building_id = v_link.building_id AND c.period_month = v_month
   ORDER BY c.revision DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tháng % chưa chốt — xác nhận sau khi bên quản lý chốt tháng', to_char(v_month, 'MM/YYYY')
      USING ERRCODE = '55000';
  END IF;
  -- trang đang cầm lần chốt cũ (bên quản lý đã mở chốt / chốt lại sau đó)
  IF v_last.revision <> p_revision THEN
    RAISE EXCEPTION 'Bên quản lý vừa mở chốt hoặc chốt lại tháng % — tải lại trang để xem số mới rồi xác nhận',
      to_char(v_month, 'MM/YYYY') USING ERRCODE = '40001';
  END IF;
  IF v_last.action <> 'CLOSE' THEN
    RAISE EXCEPTION 'Tháng % chưa chốt — xác nhận sau khi bên quản lý chốt tháng', to_char(v_month, 'MM/YYYY')
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO app_private.landlord_settlement_confirmations
    (organization_id, building_id, period_month, close_revision, note, share_token)
  VALUES (v_last.organization_id, v_link.building_id, v_month, v_last.revision, v_note, v_link.token)
  ON CONFLICT (building_id, period_month, close_revision) DO NOTHING
  RETURNING confirmed_at INTO v_at;
  IF v_at IS NULL THEN
    SELECT k.confirmed_at INTO v_at
      FROM app_private.landlord_settlement_confirmations k
     WHERE k.building_id = v_link.building_id AND k.period_month = v_month AND k.close_revision = v_last.revision;
    RETURN jsonb_build_object('status', 'ALREADY_CONFIRMED', 'confirmed_at', v_at);
  END IF;
  RETURN jsonb_build_object('status', 'CONFIRMED', 'confirmed_at', v_at);
END
$fn$;

-- ---------------------------------------------------------------------------
-- 11. Quyền gọi (hàm CREATE OR REPLACE giữ ACL; hàm tạo mới / tạo lại thì cấp lại).
REVOKE ALL ON FUNCTION public.landlord_operation_options_v1(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_operation_upsert_v1(uuid, text, numeric, date, uuid[], text, boolean, numeric, boolean, date, numeric, timestamptz, numeric, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_settlement_note_update_v1(uuid, date, integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.landlord_settlement_confirm_v1(text, date, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.landlord_operation_options_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_operation_upsert_v1(uuid, text, numeric, date, uuid[], text, boolean, numeric, boolean, date, numeric, timestamptz, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_settlement_note_update_v1(uuid, date, integer, text) TO authenticated;
-- link chủ nhà: anon (chủ nhà không đăng nhập) — có chủ đích, như landlord_settlement_public_v1
GRANT EXECUTE ON FUNCTION public.landlord_settlement_confirm_v1(text, date, integer, text) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 12. Hậu kiểm: đúng một hàm ghi cài đặt, có cột + bảng mới.
DO $sau$
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'landlord_operation_upsert_v1') <> 1 THEN
    RAISE EXCEPTION 'public.landlord_operation_upsert_v1 phải còn đúng MỘT chữ ký' USING ERRCODE = 'XX000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = 'app_private.landlord_operation_terms'::regclass
                    AND a.attname = 'deposit_holder' AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'Thiếu cột landlord_operation_terms.deposit_holder' USING ERRCODE = 'XX000';
  END IF;
  IF to_regclass('app_private.landlord_settlement_handovers') IS NULL
     OR to_regclass('app_private.landlord_settlement_confirmations') IS NULL THEN
    RAISE EXCEPTION 'Thiếu bảng ghi chú bàn giao / xác nhận của chủ nhà' USING ERRCODE = 'XX000';
  END IF;
END
$sau$;

COMMIT;
NOTIFY pgrst, 'reload schema';

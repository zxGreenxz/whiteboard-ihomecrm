-- =============================================================================
-- quyet_toan_ky_hieu_so — Quyết toán vận hành: KÝ HIỆU SỔ của từng toà (chủ nhắn 24/10/2026: "các ký hiệu sổ
-- cho phép cài đặt trong trang quản trị, như nhà 950nk … sổ chủ nhà ký hiệu "CG", sổ quản lý ký hiệu "ET"";
-- "trong dòng khoản thu khoản chi thêm 2 nút nhỏ hiển thị tên cài đặt sổ để lọc khoản thu chi theo sổ").
-- =============================================================================
-- LÀM GÌ
--   1. app_private.landlord_operations: thêm landlord_book_code / manager_book_code (1–4 ký tự, chữ hoa, không
--      khoảng trắng; NULL = mặc định CN / QL ở web).
--   2. public.landlord_operation_book_codes_v1(p_building_id, p_landlord_code, p_manager_code) — RPC MỚI
--      (authenticated; chủ công ty / super admin như mọi RPC cài đặt toà): chuẩn hoá (bỏ khoảng trắng hai đầu,
--      chữ hoa, rỗng ⇒ NULL), hai ký hiệu đang hiện phải khác nhau, ghi sổ thay đổi (before/after = ảnh
--      landlord_operation_state_v1 + hai ký hiệu). KHÔNG đổi updated_at của cài đặt toà (ký hiệu chỉ để hiển thị —
--      không làm hộp cài đặt đang mở bị báo "người khác đã lưu").
--   3. app_private.landlord_settlement_overview_payload_v1 (DỰNG TỪ THÂN production md5 6e24b6cf…, file
--      20261023142407): thêm hai ký hiệu (link chủ nhà cũng hiện).
--   4. public.landlord_operation_options_v1 (DỰNG TỪ THÂN production md5 d21beaf9…, file 20261023142407): thêm
--      hai ký hiệu vào 'current' để hộp cài đặt điền sẵn.
--   Không đổi: công thức, ảnh chốt, chuỗi băm, quyền các RPC cũ.
--
-- ĐƯỜNG LÙI
--   CREATE OR REPLACE hai hàm bằng thân của 20261023142407; DROP FUNCTION
--   public.landlord_operation_book_codes_v1(uuid, text, text); ALTER TABLE … DROP COLUMN hai cột.
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
      ('app_private.landlord_settlement_overview_payload_v1(uuid,boolean)',
       ARRAY['6e24b6cf619f18b062f4779531544998', 'ba626299fe37535cd64776d0a9722944']),
      ('public.landlord_operation_options_v1(uuid)',
       ARRAY['d21beaf97052e2efa08e2d53b65b68b7', '7d26f5ea1a09b76b0b896de6ed570ac6']),
      -- hàm KHÔNG thay — gọi gói tổng quan / được RPC mới gọi; đổi thì rà lại trước khi áp
      ('public.landlord_settlement_overview_v1(uuid)',
       ARRAY['975e91aecde63bc5dc6a67c5f235bf2b']),
      ('public.landlord_settlement_public_v1(text,date)',
       ARRAY['1c3a19568446c14b0ab694e75e235c76']),
      ('app_private.landlord_operation_state_v1(uuid)',
       ARRAY['fb8fecf22a102dc96e9d2937d4247b49']),
      ('app_private.landlord_actor_can_manage_v1(uuid)',
       ARRAY['ee1362cb1858a7f9d4f39b31e842a5ca'])
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
  IF to_regprocedure('public.landlord_operation_book_codes_v1(uuid,text,text)') IS NOT NULL THEN
    v_md5 := md5(pg_get_functiondef('public.landlord_operation_book_codes_v1(uuid,text,text)'::regprocedure));
    IF v_md5 <> '36040204e6cd44effd0b2770d02e47f9' THEN
      RAISE EXCEPTION 'public.landlord_operation_book_codes_v1 KHÁC bản của file này (md5 %) — DỪNG.', v_md5 USING ERRCODE = '55000';
    END IF;
  END IF;
END
$truoc$;

-- ---------------------------------------------------------------------------
-- 1. Hai cột ký hiệu sổ (IF NOT EXISTS: lượt hai bỏ qua cả ràng buộc đi kèm).
ALTER TABLE app_private.landlord_operations
  ADD COLUMN IF NOT EXISTS landlord_book_code text
    CONSTRAINT landlord_operations_landlord_book_code_check
    CHECK (landlord_book_code IS NULL OR (char_length(landlord_book_code) BETWEEN 1 AND 4
           AND landlord_book_code = upper(landlord_book_code) AND landlord_book_code !~ '\s')),
  ADD COLUMN IF NOT EXISTS manager_book_code text
    CONSTRAINT landlord_operations_manager_book_code_check
    CHECK (manager_book_code IS NULL OR (char_length(manager_book_code) BETWEEN 1 AND 4
           AND manager_book_code = upper(manager_book_code) AND manager_book_code !~ '\s'));

COMMENT ON COLUMN app_private.landlord_operations.landlord_book_code IS
  'Ký hiệu sổ chủ nhà hiện ở danh sách thu chi của quyết toán (vd "CG"); NULL = "CN".';
COMMENT ON COLUMN app_private.landlord_operations.manager_book_code IS
  'Ký hiệu sổ quản lý hiện ở danh sách thu chi của quyết toán (vd "ET"); NULL = "QL".';

-- ---------------------------------------------------------------------------
-- 2. Đặt ký hiệu sổ.
CREATE OR REPLACE FUNCTION public.landlord_operation_book_codes_v1(
  p_building_id   uuid,
  p_landlord_code text,
  p_manager_code  text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor    uuid := auth.uid();
  v_landlord text := NULLIF(upper(btrim(COALESCE(p_landlord_code, ''))), '');
  v_manager  text := NULLIF(upper(btrim(COALESCE(p_manager_code, ''))), '');
  v_old      app_private.landlord_operations%ROWTYPE;
  v_state    jsonb;
BEGIN
  IF v_actor IS NULL OR NOT app_private.landlord_actor_can_manage_v1(p_building_id) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xem và quyết toán toà vận hành'
      USING ERRCODE = '42501';
  END IF;
  IF (v_landlord IS NOT NULL AND (char_length(v_landlord) > 4 OR v_landlord ~ '\s'))
     OR (v_manager IS NOT NULL AND (char_length(v_manager) > 4 OR v_manager ~ '\s')) THEN
    RAISE EXCEPTION 'Ký hiệu sổ tối đa 4 ký tự, không có khoảng trắng' USING ERRCODE = '22023';
  END IF;
  -- so ký hiệu ĐANG HIỆN (trống = CN / QL): hai sổ trùng ký hiệu thì không phân biệt được
  IF COALESCE(v_landlord, 'CN') = COALESCE(v_manager, 'QL') THEN
    RAISE EXCEPTION 'Ký hiệu sổ chủ nhà và sổ quản lý phải khác nhau' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('landlord_settlement:' || p_building_id::text, 0));

  SELECT * INTO v_old
    FROM app_private.landlord_operations o
   WHERE o.building_id = p_building_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Toà này chưa cài đặt vận hành cho chủ nhà' USING ERRCODE = 'P0002';
  END IF;
  IF v_old.landlord_book_code IS NOT DISTINCT FROM v_landlord
     AND v_old.manager_book_code IS NOT DISTINCT FROM v_manager THEN
    RETURN jsonb_build_object('status', 'UNCHANGED', 'landlord_book_code', v_landlord, 'manager_book_code', v_manager);
  END IF;

  v_state := app_private.landlord_operation_state_v1(p_building_id);
  UPDATE app_private.landlord_operations o
     SET landlord_book_code = v_landlord,
         manager_book_code = v_manager
   WHERE o.building_id = p_building_id;
  INSERT INTO app_private.landlord_operation_changes (organization_id, building_id, actor, before, after)
  VALUES (v_old.organization_id, p_building_id, v_actor,
          v_state || jsonb_build_object('landlord_book_code', v_old.landlord_book_code,
                                        'manager_book_code', v_old.manager_book_code),
          v_state || jsonb_build_object('landlord_book_code', v_landlord, 'manager_book_code', v_manager));

  RETURN jsonb_build_object('status', 'UPDATED', 'landlord_book_code', v_landlord, 'manager_book_code', v_manager);
END
$fn$;

REVOKE ALL ON FUNCTION public.landlord_operation_book_codes_v1(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.landlord_operation_book_codes_v1(uuid, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Gói tổng quan: thân production (20261023142407) + hai ký hiệu sổ.
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

  -- tỷ lệ + tiền cố định của điều khoản mới nhất (từng tháng có điều khoản riêng trong months[])
  SELECT t.manager_percent, t.manager_fixed_amount INTO v_percent, v_fixed
    FROM app_private.landlord_operation_terms t
   WHERE t.building_id = p_building_id
   ORDER BY t.valid_from DESC
   LIMIT 1;

  RETURN pg_catalog.jsonb_build_object(
    'building_name', v_name,
    'landlord_name', v_cfg.landlord_name,
    'manager_percent', v_percent,
    'manager_fixed_amount', v_fixed,
    -- người giữ cọc của toà (áp mọi tháng)
    'deposit_holder', v_cfg.deposit_holder,
    -- ký hiệu sổ của toà (NULL = CN / QL ở web)
    'landlord_book_code', v_cfg.landlord_book_code,
    'manager_book_code', v_cfg.manager_book_code,
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
-- 4. Hộp cài đặt: thân production (20261023142407) + hai ký hiệu sổ.
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
               -- người giữ cọc của toà (áp mọi tháng; chỉ đổi khi chưa chốt tháng nào)
               'deposit_holder', o.deposit_holder,
               -- ký hiệu sổ của toà (NULL = CN / QL ở web)
               'landlord_book_code', o.landlord_book_code,
               'manager_book_code', o.manager_book_code,
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
                           'landlord_account_ids', to_jsonb(t.landlord_account_ids)) ORDER BY t.valid_from)
                    FROM app_private.landlord_operation_terms t
                   WHERE t.building_id = o.building_id), '[]'::jsonb),
               'updated_at', o.updated_at)
        FROM app_private.landlord_operations o
        CROSS JOIN LATERAL (
          SELECT t.valid_from, t.manager_percent, t.manager_fixed_amount, t.landlord_account_ids
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

-- ---------------------------------------------------------------------------
-- 5. Hậu kiểm.
DO $sau$
BEGIN
  IF to_regprocedure('public.landlord_operation_book_codes_v1(uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu public.landlord_operation_book_codes_v1' USING ERRCODE = 'XX000';
  END IF;
  IF has_function_privilege('anon', 'public.landlord_operation_book_codes_v1(uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon gọi được landlord_operation_book_codes_v1' USING ERRCODE = 'XX000';
  END IF;
END
$sau$;

COMMIT;
NOTIFY pgrst, 'reload schema';

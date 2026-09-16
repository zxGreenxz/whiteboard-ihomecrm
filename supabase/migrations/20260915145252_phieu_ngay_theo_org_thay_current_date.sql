-- =============================================================================
-- H3.5 — "HÔM NAY" PHẢI LÀ NGÀY CỦA TỔ CHỨC, KHÔNG PHẢI CURRENT_DATE
--
-- VÌ SAO — cùng một gốc với án lệ 20260913172730 (reverse_collection)
--   Phiên Postgres chạy TimeZone = UTC. Từ 00:00 đến 07:00 giờ VN, CURRENT_DATE
--   còn là NGÀY HÔM QUA trong khi app và người dùng đã sang ngày mới.
--   `public.org_today_v1(<org>)` (baseline:58780, STABLE SECURITY DEFINER) là
--   nguồn "hôm nay" mà toàn hệ thống đã thống nhất dùng.
--
-- BA CHỖ TRONG LÁT NÀY
--   1. `payments.payment_date` DEFAULT (baseline:36424)
--   2. `cancel_income_voucher_v1` — cận trên bị CURRENT_DATE KÉO LÙI
--   3. `get_room_cash_lifecycle_v1` — "phòng trống mấy ngày" đếm theo UTC
--
-- ĐÃ XÉT VÀ CỐ Ý KHÔNG SỬA: `transfer_room`, `transfer_contract`,
--   `transfer_contract_impl`. Cả ba chỉ dùng CURRENT_DATE làm DEFAULT của
--   `p_transfer_date`, mà MỌI người gọi đều truyền ngày tường minh —
--   useContractOperations.ts:72 và :160 (giao diện), và Copilot L5.3
--   (copilotActionsL5Dot3Migration.test.ts:105,117) truyền `v_xfer_date`.
--   Đổi ba DEFAULT chết đó đòi CREATE OR REPLACE nguyên 350 dòng thân hàm hợp
--   đồng, đổi lấy 0 thay đổi hành vi. Ghi vào báo cáo H3 thay vì làm.
--
-- CÁCH LÀM: thân hai hàm dưới đây được TRÍCH BẰNG MÁY từ nguồn sự thật rồi vá
-- đúng biểu thức cần đổi, không chép tay:
--   · cancel_income_voucher_v1   ← supabase/baseline/schema.sql:50819-51036
--       md5 thân gốc: cf0ba45fdbdc75ae42fa8ea65b5280c3
--   · get_room_cash_lifecycle_v1 ← supabase/migrations/20260828122000_room_cash_lifecycle_guard_inverted_segments.sql:25-247
--       md5 thân gốc: b3f5eb1bf2b28d59a2504f277b4d50f6
-- Sau khi vá, cả hai thân KHÔNG còn chuỗi `CURRENT_DATE` nào (đã assert lúc sinh).
--
-- IDEMPOTENT: CREATE OR REPLACE cùng chữ ký + ALTER ... SET DEFAULT.
-- ACL giữ nguyên khi REPLACE; vẫn khẳng định lại ở cuối cho khỏi phụ thuộc
-- trạng thái trước.
-- =============================================================================

-- 1) payments.payment_date --------------------------------------------------
--
-- COALESCE là BẮT BUỘC ở đây, không phải cho đẹp: `org_today_v1(NULL)` suy tổ
-- chức từ membership và trả NULL khi người dùng thuộc NHIỀU tổ chức. Cột này
-- NOT NULL, nên bỏ COALESCE là đổi một ngày lệch múi giờ lấy một lỗi 23502
-- chặn hẳn đường ghi. CURRENT_DATE chỉ còn là đường lùi cuối.
--
-- Mọi writer hiện tại đều truyền payment_date tường minh (baseline:43563,
-- 85724, 86011, 92872, 93656) nên đây là lớp phòng xa cho writer tương lai.
ALTER TABLE public.payments
  ALTER COLUMN payment_date
  SET DEFAULT COALESCE(public.org_today_v1(NULL::uuid), CURRENT_DATE);

COMMENT ON COLUMN public.payments.payment_date IS
  'Ngày thanh toán. DEFAULT theo NGÀY CỦA TỔ CHỨC (org_today_v1) từ 15/09/2026 — CURRENT_DATE chạy theo UTC nên lùi một ngày trong khoảng 00:00-07:00 giờ VN.';

-- 2) cancel_income_voucher_v1 -----------------------------------------------
--
-- Chỗ đổi DUY NHẤT (baseline:50947-50948):
--     GREATEST(LEAST(public.org_today_v1(v.organization_id), CURRENT_DATE),
--              v_coll.collection_date)
--   → GREATEST(public.org_today_v1(v.organization_id), v_coll.collection_date)
--
-- Vế LEAST(..., CURRENT_DATE) từng đúng khi `reverse_invoice_collection_v5` đo
-- cận trên bằng CURRENT_DATE. Migration 20260913172730 đã chuyển cận trên đó
-- sang `org_today_v1`. Từ lúc ấy, LEAST không còn là "kẹp cho khỏi vượt trần"
-- mà thành thứ KÉO NGÀY LÙI xuống dưới trần: trong khoảng 00:00-07:00 giờ VN,
-- phiếu thu ghi hôm nay bị hoàn tác với ngày HÔM QUA.
CREATE OR REPLACE FUNCTION public.cancel_income_voucher_v1(p_voucher uuid, p_reason text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'app_private', 'public'
    AS $$
DECLARE
  v public.income_expenses%ROWTYPE;
  v_actor uuid := auth.uid();
  v_is_super boolean;
  v_membership uuid;
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_flow text;
  v_coll public.invoice_payment_collections%ROWTYPE;
  v_inv public.invoices%ROWTYPE;
  v_lot public.customer_credit_lots%ROWTYPE;
  v_blocker record;
  v_core jsonb;
  v_counter_code text;
  v_paid numeric;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_reason) < 8 THEN
    RAISE EXCEPTION 'Phải ghi lý do huỷ (ít nhất 8 ký tự) để còn đối soát về sau.'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v FROM public.income_expenses
   WHERE id = p_voucher AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE = 'P0002';
  END IF;

  -- Kiểm THÀNH VIÊN ngay sau khi tìm thấy phiếu: mọi thông điệp phía dưới (tên
  -- sổ quỹ, mã phiên bàn giao, mã phiếu chặn) đều là thông tin của tổ chức sở
  -- hữu phiếu — người ngoài không được nghe. Đọc thẳng bảng membership, KHÔNG
  -- join qua bảng có RLS (nếu không phép đo rò chéo tổ chức sẽ báo sạch nhầm).
  v_is_super := public.is_super_admin();
  SELECT m.id INTO v_membership FROM public.organization_memberships m
   WHERE m.user_id = v_actor AND m.organization_id = v.organization_id
     AND m.status = 'ACTIVE' LIMIT 1;
  IF v_membership IS NULL AND NOT v_is_super THEN
    RAISE EXCEPTION 'Không thuộc tổ chức của phiếu' USING ERRCODE = '42501';
  END IF;

  IF v.type <> 'INCOME' THEN
    RAISE EXCEPTION 'Đây là phiếu CHI — huỷ ở luồng phiếu chi, cửa này chỉ dành cho phiếu thu.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Luật #8 (chủ chốt 01/08/2026, áp cho CẢ trang Thu chi lẫn trang Thu tiền):
  -- chỉ chính người đã thu/lập phiếu, chủ tổ chức, hoặc super admin.
  IF NOT v_is_super
     AND NOT app_private.is_org_owner_v1(v.organization_id, v_actor)
     AND v.user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Chỉ người đã thu khoản này (hoặc chủ tổ chức) mới huỷ được. Nhờ người thu hoặc chủ tổ chức thực hiện.'
      USING ERRCODE = '42501';
  END IF;

  -- Đã huỷ rồi thì không còn gì để làm. Nhánh này đứng SAU khối quyền: ma trận
  -- quyền 02/08/2026 cho thấy đặt trước sẽ trả HTTP 200 cho người KHÔNG có
  -- quyền, lệch với reader (reader nói ALREADY_CANCELLED cho mọi người, nhưng
  -- mã 200 của writer thì nói sai về quyền).
  IF v.approval_status = 'CANCELLED' THEN
    RETURN jsonb_build_object('id', p_voucher, 'changed', false, 'reason', 'đã huỷ trước đó');
  END IF;

  -- Ba khoá thời gian — GIỮ NGUYÊN theo quyết định #2 của chủ.
  PERFORM app_private.assert_period_open_for_edit_v1(p_voucher, 'huỷ');

  SELECT o.flow_kind INTO v_flow
  FROM app_private.income_expense_flow_ownership o
  WHERE o.income_expense_id = p_voucher;

  -- ══ NHÁNH 1: khoản thu hoá đơn V5 (đi theo cả ĐỢT THU) ═════════════
  -- Bộ đếm toàn vẹn count_invalid_payment_reversals_in_place_v1 định nghĩa
  -- bất biến ở mức COLLECTION (collection phải REVERSED, payment phải trỏ về
  -- đúng collection…). Huỷ lẻ MỘT phiếu của đợt thu nhiều phiếu sẽ làm bộ đếm
  -- khác 0 và kẹt vĩnh viễn assert_accounting_feature_activation_v1.
  -- ⇒ luôn đi qua reverse_invoice_collection_v5 nguyên đợt.
  IF v.payment_collection_id IS NOT NULL OR v_flow = 'INVOICE_COLLECTION_V5' THEN
    SELECT * INTO v_coll FROM public.invoice_payment_collections
     WHERE id = v.payment_collection_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Phiếu thu gắn đợt thu hoá đơn nhưng không tìm thấy đợt thu — báo quản trị.'
        USING ERRCODE = 'P0001';
    END IF;
    IF v_coll.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'Đợt thu của phiếu này đã được hoàn tác trước đó.' USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_inv FROM public.invoices WHERE id = v_coll.invoice_id;

    -- LIFO — GIỮ theo quyết định #9. reverse_v5 cũng chặn ở trong, nhưng câu
    -- của nó không nói phải huỷ phiếu NÀO trước; ở đây nêu đích danh.
    IF abs(COALESCE(v_inv.paid_amount, 0)
           - (v_coll.expected_paid_amount + v_coll.applied_amount)) >= 0.01 THEN
      SELECT ie.code, ie.voucher_date INTO v_blocker
      FROM public.invoice_payment_collections c2
      JOIN public.invoice_payment_tenders t2 ON t2.collection_id = c2.id
      JOIN public.income_expenses ie ON ie.id = t2.voucher_id
      WHERE c2.invoice_id = v_coll.invoice_id
        AND c2.status = 'ACTIVE'
        AND c2.id <> v_coll.id
      ORDER BY c2.collection_date DESC, c2.created_at DESC, ie.code DESC
      LIMIT 1;

      IF v_blocker.code IS NOT NULL THEN
        RAISE EXCEPTION 'Phải huỷ khoản thu mới hơn trước: phiếu % ngày %. Hệ thống gỡ khoản thu theo thứ tự ngược thời gian để công nợ của hoá đơn không bị lệch.',
          v_blocker.code, to_char(v_blocker.voucher_date, 'DD/MM/YYYY')
          USING ERRCODE = 'P0001';
      END IF;
      RAISE EXCEPTION 'Hoá đơn còn khoản thu mới hơn phải huỷ trước (thứ tự ngược thời gian).'
        USING ERRCODE = 'P0001';
    END IF;

    -- Tiền thừa đã đem cấn sang hoá đơn khác thì máy không tự gỡ được.
    SELECT * INTO v_lot FROM public.customer_credit_lots
     WHERE source_collection_id = v_coll.id;
    IF FOUND AND v_lot.remaining_amount <> v_lot.amount THEN
      RAISE EXCEPTION 'Tiền thừa của lần thu này đã được cấn vào hoá đơn khác — phải gỡ khoản đã cấn trước rồi mới huỷ được.'
        USING ERRCODE = 'P0001';
    END IF;

    -- Ngày hoàn tác: reverse_v5 chặn cả hai đầu (không sớm hơn ngày thu, không
    -- ở tương lai). Kẹp vào khoảng hợp lệ thay vì để nó ném 22023.
    PERFORM public.reverse_invoice_collection_v5(
      v_coll.id,
      GREATEST(public.org_today_v1(v.organization_id), v_coll.collection_date),
      v_reason,
      'inccancel-' || replace(p_voucher::text, '-', '') || '-' || substr(md5(v_reason), 1, 8));

    RETURN jsonb_build_object(
      'id', p_voucher, 'changed', true, 'mode', 'COLLECTION',
      'collection_id', v_coll.id);
  END IF;

  -- ══ NHÁNH 2: cặp phiếu bỏ cọc (thu + chi cấn nhau) ═════════════════
  -- Huỷ một chân mà để chân kia sống thì hai sổ lệch nhau vĩnh viễn; hàm
  -- chuyên trách khoá và lật CẢ CẶP theo đúng thứ tự.
  -- Điều kiện phải HẸP ĐÚNG bằng thứ handler chịu được: set_termination_forfeit_status_v1
  -- mở đầu bằng SELECT … FROM termination_forfeit_authorizations và ném 55000
  -- 'Voucher is not a termination forfeit pair' nếu không có dòng. Bắt theo
  -- system_source/notes như trước làm phiếu forfeit MỒ CÔI (có nhãn nhưng không
  -- có dòng cặp — 8 phiếu như vậy trên org TEST) kẹt vĩnh viễn ở HTTP 500.
  -- Phiếu mồ côi nay rơi xuống nhánh 3 và huỷ được bình thường.
  IF EXISTS (SELECT 1 FROM app_private.termination_forfeit_authorizations f
              WHERE f.revenue_voucher_id = p_voucher OR f.offset_voucher_id = p_voucher) THEN
    PERFORM public.set_termination_forfeit_status_v1(p_voucher, 'CANCELLED');
    RETURN jsonb_build_object('id', p_voucher, 'changed', true, 'mode', 'FORFEIT_PAIR');
  END IF;

  -- ══ NHÁNH 3: mọi phiếu thu còn lại ═════════════════════════════════
  -- Thủ công, thu cọc hợp đồng, thu hoá đơn LEGACY (system_source
  -- 'invoice.payment' — 1542 phiếu, nhóm lớn nhất), thu thanh lý…
  -- Không còn hỏi luồng nào sở hữu phiếu: "huỷ ở đâu cũng là huỷ".
  IF v.reversal_of_income_expense_id IS NOT NULL THEN
    RAISE EXCEPTION 'Đây là bút toán đối ứng của một phiếu khác — huỷ phiếu gốc chứ không huỷ riêng phiếu này.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Đã có phiếu ĐỐI ỨNG còn sống ⇒ tiền đã ra khỏi két bằng đường cũ rồi. Huỷ
  -- tiếp ở đây sẽ đảo bút toán LẦN HAI và rút khỏi sổ quỹ một khoản chưa từng
  -- vào. Hậu điều kiện sum=0 của lõi không thấy được vì nó chỉ cộng bút toán
  -- mang posting_subject_id của CHÍNH phiếu này, còn phiếu đối ứng mang id khác.
  SELECT c.code INTO v_counter_code
  FROM public.income_expenses c
  WHERE c.reversal_of_income_expense_id = p_voucher
    AND c.deleted_at IS NULL
    AND c.approval_status <> 'CANCELLED'
  LIMIT 1;
  IF v_counter_code IS NOT NULL THEN
    RAISE EXCEPTION 'Khoản thu này đã được hoàn tác bằng phiếu chi đối ứng % — huỷ phiếu đối ứng đó thay vì huỷ lại ở đây.',
      v_counter_code USING ERRCODE = 'P0001';
  END IF;

  -- Gắn hoá đơn nhưng KHÔNG có khoản thanh toán liên kết: đảo bút toán được
  -- (tiền rời két) nhưng recompute_invoice_for_id dẫn xuất paid_amount TỪ
  -- payments nên hoá đơn vẫn PAID — sổ quỹ nói "không thu", công nợ nói "đã
  -- thu đủ". Từ chối thay vì để lệch âm thầm.
  IF v.invoice_id IS NOT NULL AND v.payment_id IS NULL THEN
    RAISE EXCEPTION 'Khoản thu này gắn hoá đơn nhưng không có khoản thanh toán liên kết — huỷ ở màn hình hoá đơn/thanh lý để công nợ được tính lại đúng.'
      USING ERRCODE = 'P0001';
  END IF;

  -- begin/end_accounting_chain_write_v1: guard_payment_canonical_link chỉ cho
  -- core-writer đổi payments.reversed_at.
  PERFORM app_private.begin_accounting_chain_write_v1();

  v_core := app_private.cancel_income_voucher_core_v1(p_voucher, v_reason, v_actor, v_membership);

  -- Hoá đơn mở lại nợ (quyết định #4). recompute_invoice_for_id dẫn xuất
  -- paid_amount TỪ payments chứ không đọc trạng thái phiếu, nên phải đánh dấu
  -- khoản thanh toán. Đánh dấu `reversed_at` thay vì xoá — giữ dấu vết, đúng
  -- cách đường thu tiền V5 đang làm (client cũ xoá thẳng payments).
  IF v.payment_id IS NOT NULL THEN
    UPDATE public.payments
       SET reversed_at = COALESCE(reversed_at, clock_timestamp()),
           updated_at = now()
     WHERE id = v.payment_id;
  END IF;

  PERFORM app_private.end_accounting_chain_write_v1();

  -- Trigger trg_payments_recompute_invoice / trg_voucher_recompute_invoice /
  -- trg_ie_recompute_contract_deposit đã tự chạy, nhưng gọi lại tường minh cho
  -- ca phiếu gắn hoá đơn mà KHÔNG có payment (thu cọc ghi thẳng vào hợp đồng).
  IF v.invoice_id IS NOT NULL THEN
    PERFORM public.recompute_invoice_for_id(v.invoice_id);
  END IF;
  IF v.contract_id IS NOT NULL THEN
    PERFORM public.recompute_contract_deposit_paid(v.contract_id);
  END IF;

  RETURN v_core || jsonb_build_object('mode', 'MANUAL');
END
$$;
-- 3) get_room_cash_lifecycle_v1 ---------------------------------------------
--
-- CTE `vac` tính "đuôi mở": phòng trống từ mốc đóng muộn nhất TỚI HÔM NAY.
-- Hai chỗ dùng CURRENT_DATE nên số ngày trống lệch 1 và mốc so sánh cũng lệch
-- trong khoảng 00:00-07:00 giờ VN. Hàm không có sẵn organization_id nên lát
-- này lấy thêm `b.organization_id` vào `v_room` rồi tính `v_today` đúng một
-- lần, ngay sau khi tra phòng.
CREATE OR REPLACE FUNCTION public.get_room_cash_lifecycle_v1(
  p_room_id uuid,
  p_from    date DEFAULT NULL,
  p_to      date DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private'
AS $function$
DECLARE
  v_room  record;
  v_ids   uuid[];
  v_out   jsonb;
  -- "Hôm nay" phải là ngày của TỔ CHỨC, không phải ngày của phiên Postgres
  -- (phiên chạy TimeZone=UTC nên từ 00:00 đến 07:00 giờ VN nó còn là hôm qua).
  v_today date;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;

  SELECT r.id, r.name, r.building_id, b.name AS building_name,
         b.organization_id
    INTO v_room
    FROM rooms r JOIN buildings b ON b.id = r.building_id
   WHERE r.id = p_room_id AND r.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy phòng' USING ERRCODE='P0002';
  END IF;

  v_today := public.org_today_v1(v_room.organization_id);

  IF NOT (public.can_access_building(v_room.building_id)
          OR public.ie_all_buildings_scope(v_room.building_id)
          OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền xem toà này' USING ERRCODE='42501';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT c.id), '{}') INTO v_ids
    FROM contracts c
   WHERE c.deleted_at IS NULL
     AND (c.room_id = p_room_id
          OR EXISTS (SELECT 1 FROM contract_transfers tr
                      WHERE tr.contract_id = c.id
                        AND tr.status IN ('COMPLETED','APPROVED')
                        AND (tr.old_room_id = p_room_id OR tr.new_room_id = p_room_id)));

  WITH seg_raw AS (
    -- Thanh cư trú trên phòng này. to_date NULL từ projection nghĩa là "không
    -- có mốc chuyển đi" — hợp đồng đã kết thúc thì đóng tại ngày kết thúc.
    SELECT s.contract_id, s.contract_number, s.seg_index, s.from_date,
           CASE
             WHEN s.to_date IS NOT NULL THEN s.to_date
             ELSE COALESCE(c.actual_end_date::date,
                    CASE WHEN c.status::text IN ('TERMINATED','EXPIRED')
                         THEN c.end_date::date END)
           END AS to_date,
           s.source_path, s.trusted, s.diagnostic
      FROM public.get_room_residence_segments_v1(v_ids) s
      JOIN contracts c ON c.id = s.contract_id
     WHERE s.room_id = p_room_id
  ),
  seg AS (
    -- Mốc đóng SỚM HƠN mốc mở = dữ liệu bẩn (hợp đồng rác kết thúc trước khi
    -- bắt đầu — có thật trên prod, phòng 401). Kẹp 0 ngày + hạ trusted + gắn
    -- diagnostic: UI vẽ thanh cảnh báo, vacancy bỏ qua.
    SELECT r.contract_id, r.contract_number, r.seg_index, r.from_date,
           CASE WHEN r.from_date IS NOT NULL AND r.to_date IS NOT NULL
                     AND r.to_date < r.from_date
                THEN r.from_date ELSE r.to_date END AS to_date,
           r.source_path,
           (r.trusted AND NOT (r.from_date IS NOT NULL AND r.to_date IS NOT NULL
                               AND r.to_date < r.from_date)) AS trusted,
           CASE WHEN r.from_date IS NOT NULL AND r.to_date IS NOT NULL
                     AND r.to_date < r.from_date
                THEN 'SEGMENT_END_BEFORE_START' ELSE r.diagnostic END AS diagnostic
      FROM seg_raw r
  ),
  hd AS (
    SELECT c.id, c.contract_number, c.status::text AS status,
           c.start_date, c.end_date, c.actual_end_date,
           c.rent_price, c.total_deposit,
           t.full_name AS tenant_name
      FROM contracts c
      LEFT JOIN tenants t ON t.id = c.tenant_id
     WHERE c.id = ANY(v_ids)
  ),
  ev AS (
    SELECT 'CONTRACT_OPENED' AS type, s.from_date AS date, s.contract_id,
           NULL::numeric AS amount, s.trusted,
           jsonb_build_object('segIndex', s.seg_index, 'sourcePath', s.source_path) AS meta
      FROM seg s WHERE s.from_date IS NOT NULL AND s.seg_index = 0
    UNION ALL
    SELECT 'ROOM_CHANGED_IN', s.from_date, s.contract_id, NULL, s.trusted,
           jsonb_build_object('segIndex', s.seg_index, 'sourcePath', s.source_path)
      FROM seg s WHERE s.from_date IS NOT NULL AND s.seg_index > 0
    UNION ALL
    SELECT CASE WHEN tr.id IS NOT NULL THEN 'ROOM_CHANGED_OUT' ELSE 'CONTRACT_CLOSED' END,
           s.to_date, s.contract_id, NULL, s.trusted,
           jsonb_build_object('segIndex', s.seg_index)
      FROM seg s
      LEFT JOIN contract_transfers tr
        ON tr.contract_id = s.contract_id AND tr.old_room_id = p_room_id
       AND tr.status IN ('COMPLETED','APPROVED')
       AND COALESCE(tr.move_out_date, tr.transfer_date) = s.to_date
     WHERE s.to_date IS NOT NULL
    UNION ALL
    SELECT 'DEPOSIT_RECEIVED', ie.voucher_date, ie.contract_id, ie.total_amount,
           (ie.posting_status = 'POSTED' AND ie.active_posting_id_v2 IS NOT NULL),
           jsonb_build_object('code', ie.code)
      FROM income_expenses ie
     WHERE ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source IN ('contract.deposit','deposit.reservation')
       AND ie.approval_status = 'APPROVED'
    UNION ALL
    SELECT 'INVOICE_ISSUED', COALESCE(i.issue_date::date, (i.billing_month || '-01')::date),
           i.contract_id, i.total_amount, true,
           jsonb_build_object('billingMonth', i.billing_month, 'status', i.status)
      FROM invoices i
     WHERE i.contract_id = ANY(v_ids) AND i.room_id = p_room_id
       AND i.deleted_at IS NULL AND i.status NOT IN ('CANCELLED','DRAFT')
    UNION ALL
    SELECT 'INVOICE_COLLECTION_POSTED', COALESCE(i.paid_date::date, i.updated_at::date),
           i.contract_id, i.paid_amount, true,
           jsonb_build_object('billingMonth', i.billing_month)
      FROM invoices i
     WHERE i.contract_id = ANY(v_ids) AND i.room_id = p_room_id
       AND i.deleted_at IS NULL AND i.status IN ('PAID','PARTIAL_PAID')
       AND COALESCE(i.paid_amount,0) > 0
    UNION ALL
    SELECT 'TERMINATION_REQUESTED', COALESCE(t.termination_date::date, t.created_at::date),
           t.contract_id, t.refund_amount,
           (t.status IN ('APPROVED','COMPLETED')),
           jsonb_build_object('status', t.status, 'type', t.termination_type)
      FROM contract_terminations t
     WHERE t.contract_id = ANY(v_ids)
    UNION ALL
    SELECT 'SETTLEMENT_OFFSET_POSTED', ie.voucher_date, ie.contract_id, ie.total_amount,
           true, jsonb_build_object('code', ie.code)
      FROM income_expenses ie
     WHERE ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source = 'termination.offset' AND ie.approval_status = 'APPROVED'
    UNION ALL
    SELECT 'DEPOSIT_FORFEIT_POSTED', ie.voucher_date, ie.contract_id, ie.total_amount,
           true, jsonb_build_object('code', ie.code)
      FROM income_expenses ie
     WHERE ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source = 'termination.forfeit_offset' AND ie.approval_status = 'APPROVED'
    UNION ALL
    SELECT 'DEPOSIT_REFUND_POSTED', ie.voucher_date, ie.contract_id, ie.total_amount,
           true, jsonb_build_object('code', ie.code)
      FROM income_expenses ie
     WHERE ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source = 'termination.refund' AND ie.approval_status = 'APPROVED'
       AND ie.posting_status = 'POSTED' AND ie.active_posting_id_v2 IS NOT NULL
    UNION ALL
    SELECT 'COMMISSION_PAID', ie.voucher_date, ie.contract_id, ie.total_amount,
           (ie.posting_status = 'POSTED' AND ie.active_posting_id_v2 IS NOT NULL),
           jsonb_build_object('code', ie.code, 'name', ie.name)
      FROM income_expenses ie
     WHERE ie.contract_id = ANY(v_ids) AND ie.deleted_at IS NULL
       AND ie.system_source = 'contract.commission' AND ie.approval_status = 'APPROVED'
  ),
  ev_loc AS (
    SELECT * FROM ev
     WHERE date IS NOT NULL
       AND (p_from IS NULL OR date >= p_from)
       AND (p_to   IS NULL OR date <= p_to)
  ),
  -- Vacancy theo chuẩn island (fix #2): running max của to_date đã thấy, NULL
  -- (đang ở) coi là infinity — sau một segment mở thì không bao giờ còn gap.
  seg_sorted AS (
    SELECT s.from_date, s.to_date,
           max(COALESCE(s.to_date, 'infinity'::date)) OVER (
             ORDER BY s.from_date NULLS FIRST
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS run_max_to,
           lead(s.from_date) OVER (ORDER BY s.from_date NULLS FIRST) AS next_from
      FROM seg s WHERE s.trusted
  ),
  vac AS (
    SELECT DISTINCT ss.run_max_to AS from_date, ss.next_from AS to_date,
           (ss.next_from - ss.run_max_to) AS days
      FROM seg_sorted ss
     WHERE ss.next_from IS NOT NULL
       AND ss.run_max_to <> 'infinity'::date
       AND ss.next_from > ss.run_max_to
    UNION ALL
    -- Đuôi mở: mọi segment tin cậy đều đã đóng ⇒ phòng trống từ mốc đóng muộn
    -- nhất tới hôm nay (chỉ khi thật sự đã qua ngày đó)
    SELECT max(s.to_date), NULL, (v_today - max(s.to_date))
      FROM seg s
     WHERE s.trusted
    HAVING count(*) > 0
       AND bool_and(s.to_date IS NOT NULL)
       AND max(s.to_date) < v_today
  )
  SELECT jsonb_build_object(
    'room', jsonb_build_object(
      'id', v_room.id, 'name', v_room.name,
      'buildingId', v_room.building_id, 'buildingName', v_room.building_name),
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'contracts', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', h.id, 'number', h.contract_number, 'status', h.status,
        'startDate', h.start_date, 'endDate', h.end_date,
        'actualEndDate', h.actual_end_date,
        'rentPrice', h.rent_price, 'totalDeposit', h.total_deposit,
        'tenantName', h.tenant_name) ORDER BY h.start_date)
      FROM hd h), '[]'::jsonb),
    'segments', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'contractId', s.contract_id, 'contractNumber', s.contract_number,
        'segIndex', s.seg_index, 'fromDate', s.from_date, 'toDate', s.to_date,
        'sourcePath', s.source_path, 'trusted', s.trusted, 'diagnostic', s.diagnostic)
        ORDER BY s.from_date NULLS FIRST, s.seg_index)
      FROM seg s), '[]'::jsonb),
    'events', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'type', e.type, 'date', e.date, 'contractId', e.contract_id,
        'amount', e.amount, 'trusted', e.trusted, 'meta', e.meta)
        ORDER BY e.date, e.type)
      FROM ev_loc e), '[]'::jsonb),
    'vacancies', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'fromDate', v.from_date, 'toDate', v.to_date, 'days', v.days)
        ORDER BY v.from_date)
      FROM vac v), '[]'::jsonb),
    'generatedAt', now()
  ) INTO v_out;

  RETURN v_out;
END;
$function$;
-- ACL: khẳng định lại (CREATE OR REPLACE giữ nguyên, nhưng không phụ thuộc). --
REVOKE ALL ON FUNCTION public.cancel_income_voucher_v1(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_income_voucher_v1(uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.get_room_cash_lifecycle_v1(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_room_cash_lifecycle_v1(uuid, date, date) TO authenticated, service_role;

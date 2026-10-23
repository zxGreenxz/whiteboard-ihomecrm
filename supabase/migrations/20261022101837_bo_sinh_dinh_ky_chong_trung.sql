-- =============================================================================
-- bo_sinh_dinh_ky_chong_trung — phiếu định kỳ tự lập KHÔNG còn tự duyệt khi nghi trùng
-- (22/10/2026; đợt rà Báo cáo Lợi nhuận 21/10: F01, F40, F58)
-- =============================================================================
-- LỖI
--   public.generate_recurring_vouchers (job recurring_vouchers_daily, 01:00 giờ VN, và nút
--   "Sinh phiếu định kỳ" qua generate_recurring_vouchers_v2) chỉ kiểm NOT EXISTS theo
--   (phiếu cha, ngày kỳ). Hệ quả đo trên production (chỉ đọc, 21–22/10/2026; chỉ ghi số đếm):
--     F01  phiếu cha tiền nhà/rác tự lập trong khi nhân viên vẫn lập tay cùng toà, cùng hạng
--          mục, cùng tháng ⇒ chi trùng; áp phép dò bên dưới lên phiếu con đã có từ tháng 7 bắt
--          29 phiếu con, gồm đủ 4 cặp trùng tháng 10 mà đợt rà đã nêu. Phiếu con tự lập lại
--          TỰ DUYỆT và tự ghi sổ quỹ (63/66 phiếu cha đang chạy có repeat_auto_approve).
--     F40  số tiền phiếu cha lệch mức mặc định của khoản phí ở building_fee_accounts mà vẫn tự
--          duyệt hằng tháng.
--     F58  phiếu con đã xoá mềm (nút Hủy ở màn Đóng tiền theo kỳ — cancel_period_fee — là xoá
--          mềm) sẽ bị SINH LẠI đêm đó vì NOT EXISTS lọc deleted_at IS NULL; và phiếu con mang kỳ
--          một ngày (ngày kỳ..ngày kỳ) trong khi phiếu lập tay mang kỳ cả tháng.
--
-- VÁ (chỉ thay THÂN hàm; mặc định chủ đã chốt 22/10, có thể đổi sau)
--   1. Nghi trùng: trước khi sinh phiếu con cho (toà, hạng mục, tháng), nếu đã có phiếu KHÁC
--      chưa huỷ (approval_status <> 'CANCELLED') và chưa xoá, cùng toà, cùng loại thu/chi, có
--      dòng cùng hạng mục HOẶC cùng fee_category với dòng của phiếu cha, kỳ dòng phủ tháng đó —
--      phiếu lập tay hay phiếu con của phiếu cha khác — thì VẪN sinh phiếu con (hai hợp đồng thuê
--      cùng toà là có thật, không bỏ qua im lặng) nhưng để CHỜ DUYỆT, sổ quỹ trống (luồng nháp
--      như phiếu cha không tự duyệt) và ghi chú "Có thể trùng <mã phiếu kia>". Không tính chính
--      phiếu cha và các phiếu con khác của cùng phiếu cha (các kỳ khác của chính nó).
--   2. Lệch mức mặc định: tổng các dòng cùng fee_category của phiếu cha khác default_amount của
--      khoản phí đó ở building_fee_accounts (dòng chưa xoá, không đánh dấu "không áp dụng", có
--      mức) ⇒ cũng CHỜ DUYỆT kèm ghi chú số tiền và mức mặc định.
--   3. F58: phiếu con của đúng phiếu cha + ngày kỳ đã có — KỂ CẢ đã xoá mềm — thì kỳ đó coi như
--      đã xử lý, không sinh lại. Đếm kỳ đã xử lý (repeat_remaining/repeat_next_date) cũng tính
--      phiếu con đã xoá mềm, đếm theo ngày kỳ khác nhau, để "kỳ kế tiếp" không chỉ lùi về một kỳ
--      đã xử lý. Production 22/10: 0 phiếu con xoá mềm ⇒ số đếm hiện tại không đổi.
--   4. Phí theo tháng (repeat_cycle = 'MONTH'): dòng phiếu con MỚI mang kỳ cả tháng (ngày 1 tới
--      ngày cuối tháng chứa ngày kỳ). Chu kỳ khác giữ kỳ một ngày như cũ. Phiếu con đã có không
--      đổi. Cổng bộ máy chi nhận cùng kỳ đó; tháng của bucket không đổi (vẫn tháng chứa ngày kỳ).
--   5. Duyệt phiếu cha theo thứ tự cố định (created_at, id) để khi hai phiếu cha cùng toà × hạng
--      mục sinh trong cùng một lượt, phiếu cha LẬP SAU luôn là phiếu bị giữ chờ duyệt.
--
-- BỘ MÁY CHI THEO CAM KẾT (G5) — KHÔNG ĐỔI CÁCH GỌI
--   Phiếu con không cần rà: gọi app_private.ie_spend_gate_v1 y như cũ (sổ = sổ phiếu cha khi
--   phiếu cha tự duyệt, ngữ cảnh recurring_auto_approve = repeat_auto_approve), cổng áp thì lấy
--   trạng thái cổng. Phiếu con cần rà: cổng nhận sổ NULL + recurring_auto_approve = false — đúng
--   như phiếu cha không tự duyệt — nên bộ máy quyết CHỜ (NO_CASHBOOK) và sổ bóng ghi khớp trạng
--   thái sinh; sau cổng vẫn ép CHỜ DUYỆT. Sổ tiêu (HOLD/DRAW) đồng bộ theo trạng thái như mọi
--   phiếu chờ duyệt (câu 09). Cổng gọi TRƯỚC khi chèn ⇒ trigger z59 gắn kết quả vào phiếu chèn
--   ngay sau, như cũ.
--
-- KHÔNG ĐỤNG
--   Chữ ký, kiểu trả về, LANGUAGE, SECURITY DEFINER, search_path = public, ACL (CREATE OR
--   REPLACE giữ ACL; REVOKE bên dưới chỉ là khẳng định trạng thái đang có), lọc phiếu cha, vòng
--   kỳ k (≤ 240, ≤ hôm nay của tổ chức), khối EXCEPTION từng phiếu con, phiếu THU vẫn không qua
--   cổng. KHÔNG sửa/xoá/huỷ phiếu nào đang có, không dừng phiếu cha nào (chủ chốt "không đụng
--   dữ liệu cũ"). Phiếu lập tay SAU khi phiếu con đã sinh không được hàm này bắt (ngoài phạm vi
--   writer định kỳ).
--
-- THÂN GỐC
--   Dựng từ pg_get_functiondef của production đọc 22/10/2026 (md5 821a8518…, không CR) — trùng
--   từng chữ thân G5 trong 20260926160000_noi_writer_vao_bo_may_chi.sql; TEST cùng md5. Tiền kiểm
--   nhận thêm md5 e8b6f1e9… (thân trước G5, chính G5 đã ghim): bản dựng lại của Restore Drill
--   dừng G5 theo cascade (supabase/baseline/forward-lane-expectations.json) nên còn thân đó;
--   thân mới = G5 + vá nên áp lên đó vẫn ra đúng đích. Thân khác ⇒ DỪNG.
--
-- ĐƯỜNG LÙI
--   Forward migration khác CREATE OR REPLACE lại thân mục 8 của 20260926160000 (không phá dữ
--   liệu). Phiếu con đã sinh theo luật mới vẫn là phiếu thường: duyệt/huỷ như mọi phiếu chờ.
--
-- Chạy được hai lượt liên tiếp (lượt hai thấy dấu v_nghi_trung ⇒ thay lại bản y hệt).
-- =============================================================================

BEGIN;

-- 0. Tiền kiểm — không vá mù lên một định nghĩa lạ.
DO $truoc$
DECLARE
  v_def text;
  v_md5 text;
BEGIN
  IF to_regprocedure('public.generate_recurring_vouchers(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu public.generate_recurring_vouchers(uuid) — DỪNG.' USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('app_private.ie_spend_gate_v1(uuid,uuid,text,text,text,uuid,date,jsonb,uuid,jsonb)') IS NULL
     OR to_regprocedure('public.add_cycle(date,text,integer)') IS NULL
     OR to_regprocedure('public.org_today_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu cổng bộ máy chi / add_cycle / org_today_v1 — DỪNG.' USING ERRCODE = '55000';
  END IF;
  IF to_regclass('public.building_fee_accounts') IS NULL
     OR (SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'building_fee_accounts'
            AND column_name IN ('building_id', 'fee_category', 'default_amount', 'not_applicable', 'deleted_at')) <> 5
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'income_expense_types'
                       AND column_name = 'fee_category')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'income_expenses'
                       AND column_name = 'code') THEN
    RAISE EXCEPTION 'Thiếu building_fee_accounts / income_expense_types.fee_category / income_expenses.code — DỪNG.'
      USING ERRCODE = '55000';
  END IF;

  v_def := pg_get_functiondef('public.generate_recurring_vouchers(uuid)'::regprocedure);
  v_md5 := md5(replace(v_def, chr(13), ''));
  IF position('v_nghi_trung' IN v_def) > 0 THEN
    RAISE NOTICE 'generate_recurring_vouchers đã có chống trùng 22/10 — thay lại bản y hệt.';
  ELSIF v_md5 NOT IN ('821a8518c4692f3fdbce827804234d28',   -- production + TEST 22/10/2026 (thân G5)
                      'e8b6f1e9632ed2c6e94666cf09935a88') THEN -- thân trước G5 (Restore Drill dừng G5 theo cascade)
    RAISE EXCEPTION 'generate_recurring_vouchers KHÁC bản đã đối chiếu (md5 %) — DỪNG, đọc pg_get_functiondef trước khi replace.',
      v_md5 USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- 1. Thân mới = thân production (G5) + chống trùng / lệch mức / F58. Dòng đổi mang dấu 22/10/2026.
CREATE OR REPLACE FUNCTION public.generate_recurring_vouchers(p_user_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(parent_id uuid, child_id uuid, voucher_date date)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  parent   RECORD;
  v_child  uuid;
  v_target date;
  k        int;
  v_total  int;
  v_status text;   -- G5 26/09/2026
  v_gate   jsonb;  -- G5 26/09/2026: cổng bộ máy chi
  v_thang_dau  date;     -- 22/10/2026: tháng chứa ngày kỳ
  v_thang_cuoi date;
  v_ky_dau     date;     -- 22/10/2026: kỳ ghi trên dòng phiếu con
  v_ky_cuoi    date;
  v_nghi_trung text;     -- 22/10/2026: mã phiếu khác cùng toà × hạng mục × tháng
  v_lech_muc   text;     -- 22/10/2026: hạng mục lệch mức mặc định building_fee_accounts
  v_can_ra     text;     -- 22/10/2026: ghi chú giữ CHỜ DUYỆT; NULL ⇒ đi như cũ
  v_tu_duyet   boolean;  -- 22/10/2026: phiếu cha cho tự duyệt VÀ không cần rà
BEGIN
  FOR parent IN
    SELECT *
    FROM income_expenses ie
    WHERE ie.repeat_cycle <> 'NONE'
      AND ie.deleted_at IS NULL
      AND ie.repeat_parent_id IS NULL
      AND ie.approval_status = 'APPROVED'
      AND (p_user_id IS NULL OR ie.user_id = p_user_id)
      AND (ie.repeat_infinity OR ie.repeat_count > 0)
    ORDER BY ie.created_at, ie.id  -- 22/10/2026: thứ tự cố định ⇒ phiếu cha lập sau mới bị giữ khi trùng
  LOOP
    k := 1;
    LOOP
      v_target := public.add_cycle(parent.voucher_date, parent.repeat_cycle, k);

      EXIT WHEN v_target > public.org_today_v1(NULL);
      EXIT WHEN (NOT parent.repeat_infinity) AND k > parent.repeat_count;
      EXIT WHEN k > 240;

      -- 22/10/2026 (F58): phiếu con của đúng phiếu cha + ngày kỳ đã có, KỂ CẢ đã xoá mềm ⇒ kỳ đó
      -- đã xử lý, không sinh lại.
      IF NOT EXISTS (
        SELECT 1 FROM income_expenses c
        WHERE c.repeat_parent_id = parent.id
          AND c.voucher_date = v_target
      ) THEN
        BEGIN
          -- 22/10/2026 (F58): phí theo tháng ⇒ kỳ cả tháng chứa ngày kỳ; chu kỳ khác giữ một ngày.
          v_thang_dau  := date_trunc('month', v_target)::date;
          v_thang_cuoi := (date_trunc('month', v_target) + interval '1 month' - interval '1 day')::date;
          IF parent.repeat_cycle = 'MONTH' THEN
            v_ky_dau := v_thang_dau;  v_ky_cuoi := v_thang_cuoi;
          ELSE
            v_ky_dau := v_target;     v_ky_cuoi := v_target;
          END IF;

          -- 22/10/2026 (F01): phiếu KHÁC chưa huỷ/chưa xoá, cùng toà, cùng loại, có dòng cùng hạng
          -- mục hoặc cùng fee_category, kỳ dòng phủ tháng này. Không tính chính phiếu cha và các
          -- kỳ khác của nó.
          SELECT string_agg(x.ma, ', ' ORDER BY x.ma)
            INTO v_nghi_trung
          FROM (
            SELECT DISTINCT COALESCE(o.code, 'phiếu chưa có mã') AS ma
            FROM income_expense_items pi
            LEFT JOIN income_expense_types pt ON pt.id = pi.income_expense_type_id
            JOIN income_expenses o
              ON o.building_id = parent.building_id
             AND o.type = parent.type
             AND o.id <> parent.id
             AND o.repeat_parent_id IS DISTINCT FROM parent.id
             AND o.deleted_at IS NULL
             AND o.approval_status <> 'CANCELLED'
            JOIN income_expense_items oi ON oi.income_expense_id = o.id
            LEFT JOIN income_expense_types ot ON ot.id = oi.income_expense_type_id
            WHERE pi.income_expense_id = parent.id
              AND (oi.income_expense_type_id = pi.income_expense_type_id
                   OR (pt.fee_category IS NOT NULL AND ot.fee_category = pt.fee_category))
              AND COALESCE(oi.start_date, o.voucher_date) <= v_thang_cuoi
              AND COALESCE(oi.end_date, oi.start_date, o.voucher_date) >= v_thang_dau
          ) x;

          -- 22/10/2026 (F40): tổng dòng cùng fee_category khác mức mặc định của khoản phí ở toà.
          SELECT string_agg(
                   format('%s %sđ khác mức mặc định %sđ',
                          l.ten,
                          replace(to_char(round(l.so_tien), 'FM999,999,999,999,990'), ',', '.'),
                          replace(to_char(round(f.default_amount), 'FM999,999,999,999,990'), ',', '.')),
                   '; ' ORDER BY l.ten)
            INTO v_lech_muc
          FROM (
            SELECT pt.fee_category, min(pt.name) AS ten, sum(pi.quantity * pi.unit_price) AS so_tien
            FROM income_expense_items pi
            JOIN income_expense_types pt ON pt.id = pi.income_expense_type_id
            WHERE pi.income_expense_id = parent.id
              AND pt.fee_category IS NOT NULL
            GROUP BY pt.fee_category
          ) l
          JOIN building_fee_accounts f
            ON f.building_id = parent.building_id
           AND f.fee_category = l.fee_category
           AND f.deleted_at IS NULL
           AND NOT f.not_applicable
           AND f.default_amount IS NOT NULL
          WHERE l.so_tien IS DISTINCT FROM f.default_amount;

          v_can_ra := NULLIF(concat_ws(' ',
                        CASE WHEN v_nghi_trung IS NOT NULL THEN
                          format('Có thể trùng %s (cùng toà, cùng hạng mục, kỳ %s).',
                                 v_nghi_trung, to_char(v_thang_dau, 'MM/YYYY')) END,
                        CASE WHEN v_lech_muc IS NOT NULL THEN
                          format('Số tiền lệch: %s.', v_lech_muc) END), '');
          IF v_can_ra IS NOT NULL THEN
            v_can_ra := '[Cần rà trước khi duyệt] ' || v_can_ra
                        || ' Máy không tự duyệt, chưa ghi sổ quỹ.';
          END IF;
          v_tu_duyet := parent.repeat_auto_approve AND v_can_ra IS NULL;

          -- G5 (26/09/2026): phiếu con định kỳ cũng hỏi bộ máy chi. Cổng chưa áp ⇒ y như cũ
          -- (theo repeat_auto_approve của phiếu cha).
          -- 22/10/2026: cần rà ⇒ hỏi cổng như phiếu cha không tự duyệt (sổ NULL).
          v_status := CASE WHEN v_tu_duyet THEN 'APPROVED' ELSE 'UNAPPROVED' END;
          IF parent.type = 'EXPENSE' AND parent.organization_id IS NOT NULL THEN
            v_gate := app_private.ie_spend_gate_v1(
              parent.organization_id, parent.building_id, 'EXPENSE', 'generate_recurring_vouchers', NULL,
              CASE WHEN v_tu_duyet THEN parent.account_id ELSE NULL END,
              v_target,
              (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                        'type_id', ii.income_expense_type_id,
                        'amount', ii.quantity * ii.unit_price,
                        'start_date', v_ky_dau, 'end_date', v_ky_cuoi)), '[]'::jsonb)
                 FROM income_expense_items ii WHERE ii.income_expense_id = parent.id),
              NULL,
              jsonb_build_object('recurring_auto_approve', v_tu_duyet));
            IF COALESCE((v_gate->>'enforce')::boolean, false) THEN
              v_status := v_gate->>'status';
            END IF;
          END IF;
          -- 22/10/2026: cần rà ⇒ luôn CHỜ DUYỆT, kể cả khi cổng áp.
          IF v_can_ra IS NOT NULL THEN
            v_status := 'UNAPPROVED';
          END IF;
          INSERT INTO income_expenses (
            user_id, type, name, building_id, room_id, tenant_id,
            contract_id, account_id, payer_name,
            approval_status, approved_at, approved_by,
            business_result_accounting, counts_in_business_result,
            attachments, notes,
            receive_bank_name, receive_bank_account,
            creator_name,
            voucher_date, invoice_id, repeat_parent_id,
            repeat_cycle, repeat_infinity, repeat_count, repeat_remaining
          ) VALUES (
            parent.user_id, parent.type,
            parent.name || ' (tự động lập)',
            parent.building_id, parent.room_id, parent.tenant_id,
            NULL,
            -- DRAFT MODE: sổ trống + NHÁP, điền sổ/ảnh khi thanh toán thật
            -- 22/10/2026: phiếu cần rà cũng đi luồng nháp.
            CASE WHEN v_tu_duyet THEN parent.account_id ELSE NULL END,
            parent.payer_name,
            v_status,
            CASE WHEN v_status = 'APPROVED' THEN now() ELSE NULL END,
            CASE WHEN v_status = 'APPROVED' THEN parent.user_id ELSE NULL END,
            parent.business_result_accounting, parent.counts_in_business_result,
            parent.attachments,
            CASE WHEN v_can_ra IS NULL THEN parent.notes
                 ELSE concat_ws(E'\n', v_can_ra, parent.notes) END,  -- 22/10/2026
            parent.receive_bank_name, parent.receive_bank_account,
            parent.creator_name,
            v_target, NULL, parent.id,
            'NONE', false, 0, 0
          ) RETURNING id INTO v_child;

          INSERT INTO income_expense_items (
            income_expense_id, income_expense_type_id,
            description, quantity, unit_price, start_date, end_date
          )
          SELECT v_child, ii.income_expense_type_id,
                 ii.description, ii.quantity, ii.unit_price, v_ky_dau, v_ky_cuoi
          FROM income_expense_items ii
          WHERE ii.income_expense_id = parent.id;

          RETURN QUERY SELECT parent.id, v_child, v_target;
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE 'recurring child skipped parent=% date=%: %', parent.id, v_target, SQLERRM;
        END;
      END IF;

      k := k + 1;
    END LOOP;

    -- 22/10/2026 (F58): kỳ đã xử lý gồm cả phiếu con đã xoá mềm; đếm theo ngày kỳ.
    SELECT count(DISTINCT c.voucher_date) INTO v_total
    FROM income_expenses c
    WHERE c.repeat_parent_id = parent.id;

    BEGIN
      UPDATE income_expenses
      SET repeat_remaining = CASE
            WHEN parent.repeat_infinity THEN 0
            ELSE GREATEST(0, parent.repeat_count - v_total)
          END,
          repeat_next_date = CASE
            WHEN parent.repeat_infinity OR v_total < parent.repeat_count
              THEN public.add_cycle(parent.voucher_date, parent.repeat_cycle, v_total + 1)
            ELSE NULL
          END
      WHERE id = parent.id;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'recurring bookkeeping skipped parent=%: %', parent.id, SQLERRM;
    END;
  END LOOP;
END;
$function$;

-- 2. ACL: CREATE OR REPLACE giữ nguyên ACL (production: chủ hàm + service_role). Khẳng định lại
--    vế đóng — không mở cho trình duyệt (bản dựng lại có default privileges rộng).
REVOKE ALL ON FUNCTION public.generate_recurring_vouchers(uuid) FROM PUBLIC, anon, authenticated;

-- 3. Tự kiểm (chỉ catalog — chạy được trên database rỗng).
DO $sau$
DECLARE
  v_oid regprocedure := 'public.generate_recurring_vouchers(uuid)'::regprocedure;
  v_def text;
  v_p   record;
BEGIN
  v_def := pg_get_functiondef(v_oid);
  IF position('app_private.ie_spend_gate_v1(' IN v_def) = 0 THEN
    RAISE EXCEPTION 'generate_recurring_vouchers mất lời gọi cổng bộ máy chi' USING ERRCODE = '55000';
  END IF;
  IF position('v_nghi_trung' IN v_def) = 0 OR position('building_fee_accounts' IN v_def) = 0 THEN
    RAISE EXCEPTION 'generate_recurring_vouchers chưa mang chống trùng / lệch mức 22/10' USING ERRCODE = '55000';
  END IF;
  SELECT p.prosecdef, p.provolatile, p.proconfig, pg_get_function_result(p.oid) AS kq
    INTO v_p FROM pg_proc p WHERE p.oid = v_oid;
  IF NOT v_p.prosecdef OR v_p.provolatile <> 'v'
     OR v_p.proconfig IS DISTINCT FROM ARRAY['search_path=public']
     OR v_p.kq <> 'TABLE(parent_id uuid, child_id uuid, voucher_date date)' THEN
    RAISE EXCEPTION 'generate_recurring_vouchers đổi DEFINER/volatility/search_path/kiểu trả về' USING ERRCODE = '55000';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'ACL generate_recurring_vouchers bị nới cho anon/authenticated' USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'generate_recurring_vouchers') <> 1 THEN
    RAISE EXCEPTION 'Sai số overload của generate_recurring_vouchers' USING ERRCODE = '55000';
  END IF;
END
$sau$;

NOTIFY pgrst, 'reload schema';

COMMIT;

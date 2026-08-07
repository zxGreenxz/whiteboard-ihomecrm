-- Guard phiếu canonical — mở cửa hẹp HANDOVER (bàn giao tiền mặt).
--
-- TRIỆU CHỨNG (prod, 07/08/2026): Hiển quét 8 phiếu 05–06/08 trên màn Bàn giao
-- tiền mặt, bấm "Xác nhận giao 87.620.000đ" → toast tiếng Anh
--   "canonical income expense 0539bccb-… is frozen (update rejected)"
-- và phiên không tạo được. Tắt app bật lại vẫn thế.
--
-- NGUYÊN NHÂN GỐC: create_cash_handover kết phiên bằng
--   UPDATE income_expenses SET handover_id = v_id WHERE id = ANY(v_ids);
-- không mở flex-scope, không cấp token ⇒ với phiếu flow-owned, guard
-- a00_ie_owned_payload_freeze rơi xuống nhánh canonical ⇒ 55000 ⇒ rollback cả
-- phiên. Token lifecycle có cũng vô ích: handover_id KHÔNG nằm trong allowlist
-- (và không nên nằm — allowlist áp cho MỌI writer có token).
--
-- VÌ SAO 07/08 MỚI VỠ: guard chưa từng có cửa HANDOVER, nhưng phiếu sinh trước
-- 18/07/2026 đều legacy (không flow-owned) nên rơi early-return. Đo trên prod:
-- phiếu flow-owned đầu tiên sinh 18/07; MỌI phiên bàn giao CONFIRMED trong lịch
-- sử có 0 phiếu canonical; 329 phiếu canonical đã duyệt đang chờ bàn giao.
-- Phiên đầu tiên quét trúng phiếu canonical chính là phiên hôm nay.
--
-- ĐƯỜNG HỦY DÍNH Y HỆT: confirm_cancel_handover nhả phiếu gốc bằng
--   UPDATE income_expenses SET handover_id = NULL WHERE handover_id = …;
-- nên vá cùng đợt, kẻo tạo được phiên mà không hủy được phiên.
--
-- CỬA HẸP HANDOVER: chỉ handover_id + updated_at, mọi cột khác bất biến. Cho cả
-- hai chiều (gắn phiếu vào phiên / nhả phiếu khi 2 bên xác nhận hủy) — chiều và
-- điều kiện nghiệp vụ do chính writer kiểm (phiếu đã duyệt, chưa nằm phiên khác,
-- cùng sổ, sổ của chính mình…) cộng trigger trg_ie_handover_guard (khoá phiếu
-- đang trong phiên sống; hủy phải 2 bên xác nhận và set CANCELLED trước khi
-- nhả). Chỉ writer SECURITY DEFINER mở được scope (begin_ie_flex_write_v1 đã
-- REVOKE khỏi mọi role client). Khoá kỳ vẫn chặn như cũ — check_lock /
-- profit_lock chỉ miễn trừ ANNOTATE, không miễn HANDOVER.
--
-- Guard dưới đây là NGUYÊN VĂN bản đang chạy trên prod (pg_get_functiondef,
-- 07/08/2026 — trùng từng chữ với 20260805120000) + chèn nhánh HANDOVER sau
-- LINK_CONTRACT. Hai hàm handover cũng chép NGUYÊN VĂN bản prod (đối chiếu
-- md5 trong preflight) + bọc UPDATE bằng begin/end_ie_flex_write_v1 — theo án
-- lệ "thân hàm prod lệch file migration" thì KHÔNG vá mù: md5 lệch là dừng.

BEGIN;

-- ── 0. Cho phép scope mới — GIỮ ĐỦ 5 scope cũ, chỉ thêm HANDOVER ────────────
ALTER TABLE app_private.ie_flex_writer_xids
  DROP CONSTRAINT IF EXISTS ie_flex_writer_xids_scope_chk;
ALTER TABLE app_private.ie_flex_writer_xids
  ADD CONSTRAINT ie_flex_writer_xids_scope_chk
  CHECK (scope IN ('ANNOTATE', 'FLEX_EDIT', 'LINK_CONTRACT', 'SALE_BONUS_DEPOSIT',
                   'CASHBOOK_MOVE', 'HANDOVER'));

-- ── 1. Chặn lost-update: bản đang chạy phải còn ĐỦ cửa mà file này chép lại ──
DO $preflight$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
   WHERE p.proname = 'guard_income_expense_owned_payload'
     AND p.pronamespace = 'app_private'::regnamespace;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'guard_income_expense_owned_payload chưa tồn tại — migration này giả định bản 20260805120000 đã chạy.';
  END IF;

  IF v_def NOT LIKE '%CASHBOOK_MOVE%'
     OR v_def NOT LIKE '%ANNOTATE%'
     OR v_def NOT LIKE '%LINK_CONTRACT%'
     OR v_def NOT LIKE '%''notes''%' THEN
    RAISE EXCEPTION 'guard_income_expense_owned_payload trên DB này thiếu cửa/allowlist mà migration giả định (CASHBOOK_MOVE / ANNOTATE / LINK_CONTRACT / notes) — dừng lại, đối chiếu pg_get_functiondef trước khi replace.';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION app_private.guard_income_expense_owned_payload()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private'
AS $function$
declare
  v_authorized boolean;
  v_annotate_free text[];
begin
  if tg_op = 'DELETE' then
    if app_private.is_income_expense_flow_owned(old.id) then
      raise exception 'canonical income expense % is frozen (delete rejected)', old.id
        using errcode = '55000';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    -- WP1: cửa ANNOTATE đứng TRƯỚC early-return.
    -- Trước WP1 khối này nằm SAU early-return "phiếu không flow-owned",
    -- nên phần tự kiểm delta chỉ có hiệu lực trên 175/2528 phiếu: mở scope
    -- ANNOTATE trên một phiếu KHÔNG flow-owned rồi UPDATE total_amount là đi
    -- lọt (đã đo trên prod: total_amount thành 999999.00, không ai lên tiếng).
    -- Năng lực vẫn nằm ở app_private.ie_flex_writer_xids (chỉ writer definer
    -- mở được), KHÔNG mượn cột purpose của ie_transition_authorization vì cột
    -- đó bị writer canon ghi đè và purpose FINANCE_V2_LIFECYCLE làm tắt cầu a85.
    -- ĐỢT C: cửa ĐỔI SỔ QUỸ của phiếu THU (move_income_voucher_cashbook_v1).
    -- Guard chặn account_id vì cột đó không nằm trong allowlist lifecycle —
    -- đúng với mọi writer khác, nhưng hàm kia tồn tại CHÍNH ĐỂ đổi cột đó, và
    -- nó phải để cầu a85 chạy (đảo bút toán sổ cũ + ghi generation mới ở sổ
    -- mới) nên không dùng được token FINANCE_V2_LIFECYCLE. Cho ĐÚNG
    -- account_id + updated_at, không cột nào khác; mọi khoá kỳ vẫn chặn vì
    -- check_lock / profit_lock chỉ miễn trừ scope ANNOTATE.
    if exists (
      select 1 from app_private.ie_flex_writer_xids w
       where w.income_expense_id = old.id
         and w.transaction_id = pg_current_xact_id()
         and w.backend_pid = pg_backend_pid()
         and w.scope = 'CASHBOOK_MOVE'
    ) then
      if (to_jsonb(old) - array['account_id','updated_at'])
         is distinct from
         (to_jsonb(new) - array['account_id','updated_at']) then
        raise exception 'cashbook move scope may only change account_id of %', old.id
          using errcode = '55000';
      end if;
      return new;
    end if;

    if exists (
      select 1 from app_private.ie_flex_writer_xids w
       where w.income_expense_id = old.id
         and w.transaction_id = pg_current_xact_id()
         and w.backend_pid = pg_backend_pid()
         and w.scope = 'ANNOTATE'
    ) then
      -- a001_ie_lifecycle_normalize chạy TRƯỚC trigger này và ĐIỀN
      -- posting_mode / posting_status / review_state khi chúng đang NULL, ở
      -- MỌI update. Prod còn 173 phiếu NULL (75 trong đó flow-owned — tức
      -- annotate trên chúng đang hỏng sẵn từ Đợt 2, bản vá này chữa luôn).
      -- Chỉ miễn ĐÚNG chiều NULL -> giá trị, không miễn cả cột.
      v_annotate_free := array['attachments','notes','updated_at'];
      if old.posting_mode   is null then v_annotate_free := v_annotate_free || 'posting_mode'; end if;
      if old.posting_status is null then v_annotate_free := v_annotate_free || 'posting_status'; end if;
      if old.review_state   is null then v_annotate_free := v_annotate_free || 'review_state'; end if;

      if (to_jsonb(old) - v_annotate_free)
         is distinct from
         (to_jsonb(new) - v_annotate_free) then
        raise exception 'annotate scope may only change attachments/notes of %', old.id
          using errcode = '55000';
      end if;
      return new;
    end if;

    -- ĐỢT D: cửa GẮN PHIẾU CỌC VÀO HỢP ĐỒNG (create_contract_v2 và
    -- trg_contract_link_orphan_deposits). Hai hàm đó vốn đã mở scope
    -- 'LINK_CONTRACT' và mô tả đúng cửa này trong comment, nhưng nhánh guard
    -- tương ứng bị mất khi hàm được vá lại ngoài migration ⇒ mọi hợp đồng ký
    -- trên phòng "Đã cọc" fail 55000. Không dùng token lifecycle được vì
    -- contract_id không nằm trong allowlist (và không nên nằm: allowlist áp
    -- cho MỌI writer có token). Cửa này một chiều NULL -> NOT NULL nên không
    -- re-parent / không gỡ link được qua đây; thanh lý muốn đổi phải đi
    -- đường riêng. Phiếu legacy (không flow-owned) không cần cửa nhưng vẫn đi
    -- qua đây khi writer mở scope — giữ một đường ghi duy nhất, đồng thời
    -- siết luôn đường legacy.
    if exists (
      select 1 from app_private.ie_flex_writer_xids w
       where w.income_expense_id = old.id
         and w.transaction_id = pg_current_xact_id()
         and w.backend_pid = pg_backend_pid()
         and w.scope = 'LINK_CONTRACT'
    ) then
      if old.contract_id is not null or new.contract_id is null then
        raise exception 'link contract scope may only set contract_id from NULL of %', old.id
          using errcode = '55000';
      end if;
      if (to_jsonb(old) - array['contract_id','updated_at'])
         is distinct from
         (to_jsonb(new) - array['contract_id','updated_at']) then
        raise exception 'link contract scope may only change contract_id of %', old.id
          using errcode = '55000';
      end if;
      return new;
    end if;

    -- ĐỢT E: cửa BÀN GIAO TIỀN MẶT (create_cash_handover gắn phiếu vào phiên:
    -- handover_id NULL -> id; confirm_cancel_handover nhả phiếu khi cả hai bên
    -- xác nhận hủy: id -> NULL). Guard chưa từng có cửa này — phiếu sinh trước
    -- 18/07/2026 đều legacy nên rơi early-return, mọi phiên bàn giao CONFIRMED
    -- trong lịch sử có 0 phiếu canonical; từ khi màn Thu/Chi đi
    -- create_income_expense_v1 thì phiếu mới flow-owned, và phiên đầu tiên quét
    -- chúng (07/08/2026) chết 55000 nguyên khối. Token lifecycle không dùng
    -- được: handover_id không nằm trong allowlist (và không nên nằm). Cửa cho
    -- đổi ĐÚNG handover_id, cả hai chiều — chiều và điều kiện nghiệp vụ do
    -- writer + trigger trg_ie_handover_guard giữ (phiếu trong phiên sống bị
    -- khoá; nhả chỉ sau khi phiên CANCELLED bởi 2 bên xác nhận).
    if exists (
      select 1 from app_private.ie_flex_writer_xids w
       where w.income_expense_id = old.id
         and w.transaction_id = pg_current_xact_id()
         and w.backend_pid = pg_backend_pid()
         and w.scope = 'HANDOVER'
    ) then
      if (to_jsonb(old) - array['handover_id','updated_at'])
         is distinct from
         (to_jsonb(new) - array['handover_id','updated_at']) then
        raise exception 'handover scope may only change handover_id of %', old.id
          using errcode = '55000';
      end if;
      return new;
    end if;

    if not app_private.is_income_expense_flow_owned(old.id)
       and not (new.id is distinct from old.id
                and app_private.is_income_expense_flow_owned(new.id)) then
      return new; -- unmarked legacy row: unchanged behavior
    end if;

    -- canonical row: check for a live transition token in THIS transaction
    select exists (
      select 1 from app_private.ie_transition_authorization t
       where t.income_expense_id = old.id and t.xid = pg_current_xact_id()
    ) into v_authorized;

    if not v_authorized then
      raise exception 'canonical income expense % is frozen (update rejected)', old.id
        using errcode = '55000';
    end if;

    -- ALLOWLIST, not denylist. t5_08 widened: lifecycle metadata
    -- (approved_by/approved_at, verified_*) joins the original lifecycle
    -- columns. EVERY other column must be NOT DISTINCT FROM its old value.
    if (to_jsonb(old) - array['approval_status','posting_id','posted_at_v2',
                              'reversed_by_posting_id','updated_at',
                              'birth_operation_id','birth_txid','source_payload_hash',
                              'approved_by','approved_at',
                              'verified_at','verified_by','verified_by_name',
                              'verified_note',
                              'review_state','review_version','review_reason',
                              'approval_version','posting_version',
                              'posting_status','posting_mode','active_posting_id_v2',
                              'cancellation_kind','deleted_at','approval_request_id','notes'])
       is distinct from
       (to_jsonb(new) - array['approval_status','posting_id','posted_at_v2',
                              'reversed_by_posting_id','updated_at',
                              'birth_operation_id','birth_txid','source_payload_hash',
                              'approved_by','approved_at',
                              'verified_at','verified_by','verified_by_name',
                              'verified_note',
                              'review_state','review_version','review_reason',
                              'approval_version','posting_version',
                              'posting_status','posting_mode','active_posting_id_v2',
                              'cancellation_kind','deleted_at','approval_request_id','notes']) then
      raise exception 'authorized transition may only change lifecycle columns of %', old.id
        using errcode = '55000';
    end if;
    return new;
  end if;

  return new;
end;
$function$;

-- ── 2. create_cash_handover: mở cửa quanh câu UPDATE kết phiên ──────────────
-- Preflight md5: thân đang chạy phải ĐÚNG bản đã đối chiếu (20260731070000,
-- md5 đo 07/08/2026). Đã vá rồi (có HANDOVER) thì cho qua — replace idempotent.
DO $preflight_create$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
   WHERE p.proname = 'create_cash_handover'
     AND p.pronamespace = 'public'::regnamespace;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'create_cash_handover không tồn tại — dừng.';
  END IF;
  IF position('HANDOVER' IN v_def) > 0 THEN
    RAISE NOTICE 'create_cash_handover đã mở cửa HANDOVER — replace lại bản y hệt.';
    RETURN;
  END IF;
  IF md5(v_def) <> 'f97ee86cf84759fbf0427ef3aa4f5934' THEN
    RAISE EXCEPTION 'create_cash_handover trên DB này KHÁC bản migration giả định (md5 %) — dừng lại, đối chiếu pg_get_functiondef trước khi replace.', md5(v_def);
  END IF;
END
$preflight_create$;

CREATE OR REPLACE FUNCTION public.create_cash_handover(p_receiver_id uuid, p_voucher_ids uuid[], p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ids         uuid[];
  v_cnt         int;
  v_from_acc    uuid;
  v_acc_owner   uuid;
  v_gross       numeric;
  v_expense     numeric;
  v_net         numeric;
  v_recv_name   text;
  v_recv_active boolean;
  v_giver_name  text;
  v_month       text;
  v_seq         int;
  v_code        text;
  v_id          uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_receiver_id IS NULL OR p_receiver_id = auth.uid() THEN
    RAISE EXCEPTION 'Người nhận không hợp lệ (không thể tự bàn giao cho chính mình)';
  END IF;

  SELECT full_name, is_active INTO v_recv_name, v_recv_active
    FROM profiles WHERE id = p_receiver_id;
  IF NOT FOUND OR v_recv_active IS FALSE THEN
    RAISE EXCEPTION 'Người nhận không tồn tại hoặc đã bị khoá';
  END IF;

  -- Cho bàn giao trong đội HOẶC nộp cho CHỦ (super admin) — quản lý nộp cho chủ
  -- dù không cùng đội.
  IF NOT (public.is_super_admin()
          OR public.same_team(p_receiver_id)
          OR EXISTS (SELECT 1 FROM public.super_admins sa WHERE sa.user_id = p_receiver_id)) THEN
    RAISE EXCEPTION 'Người nhận không cùng đội với bạn';
  END IF;

  v_ids := ARRAY(SELECT DISTINCT unnest(p_voucher_ids));
  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'Chưa chọn phiếu nào để bàn giao';
  END IF;

  -- Khoá các phiếu chống race 2 phiên cùng lúc
  PERFORM 1 FROM income_expenses WHERE id = ANY(v_ids) FOR UPDATE;

  -- Hợp lệ: phiếu THU hoặc CHI đã duyệt, chưa bàn giao, có sổ.
  -- Loại phiếu CHI chuyển (handover_transfer_id IS NOT NULL, type=EXPENSE) — đó
  -- là phiếu "Bàn giao tiền mặt →" do confirm sinh ra, KHÔNG được quét lại (sẽ
  -- trừ trùng). Phiếu THU chuyển ("Nhận bàn giao") VẪN cho quét để bàn giao tiếp.
  SELECT count(*) INTO v_cnt
    FROM income_expenses
   WHERE id = ANY(v_ids)
     AND type IN ('INCOME', 'EXPENSE') AND approval_status = 'APPROVED'
     AND deleted_at IS NULL AND handover_id IS NULL AND account_id IS NOT NULL
     AND (handover_transfer_id IS NULL OR type = 'INCOME');
  IF v_cnt <> array_length(v_ids, 1) THEN
    RAISE EXCEPTION 'Có phiếu không hợp lệ (đã xoá / đã nằm trong phiên bàn giao khác / chưa duyệt)';
  END IF;

  SELECT count(DISTINCT account_id) INTO v_cnt FROM income_expenses WHERE id = ANY(v_ids);
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'Các phiếu bàn giao phải cùng MỘT sổ quỹ';
  END IF;

  SELECT account_id,
         COALESCE(sum(total_amount) FILTER (WHERE type = 'INCOME'), 0),
         COALESCE(sum(total_amount) FILTER (WHERE type = 'EXPENSE'), 0)
    INTO v_from_acc, v_gross, v_expense
    FROM income_expenses WHERE id = ANY(v_ids) GROUP BY account_id;
  v_net := v_gross - v_expense;
  IF v_net < 0 THEN
    RAISE EXCEPTION 'Phần đã chi lớn hơn phần đã thu — không thể bàn giao số âm. Thêm phiếu thu hoặc bớt phiếu chi.';
  END IF;

  SELECT user_id INTO v_acc_owner FROM accounts
   WHERE id = v_from_acc AND deleted_at IS NULL;
  IF v_acc_owner IS NULL OR v_acc_owner <> auth.uid() THEN
    RAISE EXCEPTION 'Chỉ bàn giao được phiếu nằm trong sổ quỹ do chính bạn sở hữu';
  END IF;

  SELECT COALESCE(full_name, '') INTO v_giver_name FROM profiles WHERE id = auth.uid();

  -- Mã BG{YYMM}{seq3} — advisory lock chống trùng khi 2 phiên tạo song song
  PERFORM pg_advisory_xact_lock(hashtext('cash_handover_code'));
  v_month := to_char(public.org_today_v1(NULL), 'YYMM');
  SELECT COALESCE(MAX(
           CASE WHEN code ~ ('^BG' || v_month || '\d+$')
                THEN substring(code FROM 7)::int ELSE 0 END
         ), 0) + 1
    INTO v_seq
    FROM cash_handovers WHERE code LIKE 'BG' || v_month || '%';
  v_code := 'BG' || v_month || lpad(v_seq::text, 3, '0');

  INSERT INTO cash_handovers
    (code, giver_id, receiver_id, giver_name, receiver_name, from_account_id,
     total_amount, gross_amount, expense_amount, voucher_count, note)
  VALUES
    (v_code, auth.uid(), p_receiver_id, v_giver_name, v_recv_name, v_from_acc,
     v_net, v_gross, v_expense, array_length(v_ids, 1), NULLIF(btrim(p_note), ''))
  RETURNING id INTO v_id;

  INSERT INTO cash_handover_items
    (handover_id, voucher_id, amount, voucher_code, voucher_date, room_name, building_name, voucher_type)
  SELECT v_id, ie.id, ie.total_amount, ie.code, ie.voucher_date, r.name, b.name, ie.type
    FROM income_expenses ie
    LEFT JOIN rooms r     ON r.id = ie.room_id
    LEFT JOIN buildings b ON b.id = ie.building_id
   WHERE ie.id = ANY(v_ids);

  -- Cửa hẹp HANDOVER cho TỪNG phiếu: phiếu flow-owned bị guard đóng băng, và
  -- allowlist token không (không nên) chứa handover_id. Đóng ngay sau UPDATE.
  PERFORM app_private.begin_ie_flex_write_v1(u.id, 'HANDOVER')
     FROM unnest(v_ids) AS u(id);
  UPDATE income_expenses SET handover_id = v_id WHERE id = ANY(v_ids);
  PERFORM app_private.end_ie_flex_write_v1(u.id)
     FROM unnest(v_ids) AS u(id);

  RETURN jsonb_build_object(
    'id', v_id, 'code', v_code, 'total_amount', v_net,
    'gross_amount', v_gross, 'expense_amount', v_expense,
    'voucher_count', array_length(v_ids, 1));
END;
$function$;

-- ── 3. confirm_cancel_handover: mở cửa quanh câu nhả phiếu gốc ──────────────
DO $preflight_cancel$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
   WHERE p.proname = 'confirm_cancel_handover'
     AND p.pronamespace = 'public'::regnamespace;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'confirm_cancel_handover không tồn tại — dừng.';
  END IF;
  IF position('HANDOVER' IN v_def) > 0 THEN
    RAISE NOTICE 'confirm_cancel_handover đã mở cửa HANDOVER — replace lại bản y hệt.';
    RETURN;
  END IF;
  IF md5(v_def) <> '0c35d4883a6c234dfbbdeb58232c7e98' THEN
    RAISE EXCEPTION 'confirm_cancel_handover trên DB này KHÁC bản migration giả định (md5 %) — dừng lại, đối chiếu pg_get_functiondef trước khi replace.', md5(v_def);
  END IF;
END
$preflight_cancel$;

CREATE OR REPLACE FUNCTION public.confirm_cancel_handover(p_handover_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_h       cash_handovers%ROWTYPE;
  v_chain   text;
  v_release uuid[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_h FROM cash_handovers WHERE id = p_handover_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy phiên bàn giao'; END IF;
  IF v_h.cancel_requested_by IS NULL THEN
    RAISE EXCEPTION 'Phiên % chưa có yêu cầu hủy', v_h.code;
  END IF;
  IF auth.uid() NOT IN (v_h.giver_id, v_h.receiver_id) THEN
    RAISE EXCEPTION 'Chỉ người giao hoặc người nhận mới được xác nhận hủy';
  END IF;
  IF auth.uid() = v_h.cancel_requested_by THEN
    RAISE EXCEPTION 'Hủy phiên cần BÊN KIA xác nhận (bạn là người đã yêu cầu hủy)';
  END IF;
  IF v_h.status NOT IN ('PENDING', 'CONFIRMED') THEN
    RAISE EXCEPTION 'Phiên % đã hủy rồi', v_h.code;
  END IF;

  -- Chain LEGACY: phiếu THU đơn đã được bàn giao tiếp?
  IF v_h.transfer_income_id IS NOT NULL THEN
    SELECT ch.code INTO v_chain
      FROM income_expenses ie
      JOIN cash_handovers ch ON ch.id = ie.handover_id
     WHERE ie.id = v_h.transfer_income_id AND ch.status <> 'CANCELLED';
    IF v_chain IS NOT NULL THEN
      RAISE EXCEPTION 'Tiền của phiên % đã được bàn giao tiếp trong phiên % — hủy phiên đó trước', v_h.code, v_chain;
    END IF;
  END IF;

  -- Chain MỚI (batch): bất kỳ phiếu THU lẻ nào đã được bàn giao tiếp?
  SELECT ch.code INTO v_chain
    FROM income_expenses ie
    JOIN cash_handovers ch ON ch.id = ie.handover_id
   WHERE ie.handover_transfer_id = p_handover_id AND ie.type = 'INCOME'
     AND ch.status <> 'CANCELLED'
   LIMIT 1;
  IF v_chain IS NOT NULL THEN
    RAISE EXCEPTION 'Tiền của phiên % đã được bàn giao tiếp trong phiên % — hủy phiên đó trước', v_h.code, v_chain;
  END IF;

  -- Set CANCELLED TRƯỚC để trigger guard nhả các phiếu liên quan
  UPDATE cash_handovers
     SET status = 'CANCELLED', cancelled_by = auth.uid(), cancelled_at = now()
   WHERE id = p_handover_id;

  IF v_h.status = 'CONFIRMED' THEN
    -- Phiếu chuyển LẺ (mới) → CANCELLED + ẩn 2 phiếu tổng (số dư 2 sổ tự hồi)
    UPDATE income_expenses SET approval_status = 'CANCELLED'
     WHERE handover_transfer_id = p_handover_id;
    UPDATE income_expense_batches SET deleted_at = now()
     WHERE id IN (v_h.transfer_expense_batch_id, v_h.transfer_income_batch_id)
       AND deleted_at IS NULL;
    -- Cặp phiếu LEGACY (phiên cũ) → CANCELLED
    UPDATE income_expenses SET approval_status = 'CANCELLED'
     WHERE id IN (v_h.transfer_expense_id, v_h.transfer_income_id);
  END IF;

  -- Nhả phiếu gốc để có thể bàn giao lại / hoàn tác. Phiếu gốc có thể
  -- flow-owned ⇒ mở cửa hẹp HANDOVER cho TỪNG phiếu rồi đóng ngay sau UPDATE
  -- (phiếu chuyển ở khối trên sinh bằng INSERT trong RPC, không flow-owned,
  -- không cần cửa).
  SELECT COALESCE(array_agg(ie.id), '{}'::uuid[]) INTO v_release
    FROM income_expenses ie WHERE ie.handover_id = p_handover_id;
  PERFORM app_private.begin_ie_flex_write_v1(u.id, 'HANDOVER')
     FROM unnest(v_release) AS u(id);
  UPDATE income_expenses SET handover_id = NULL WHERE handover_id = p_handover_id;
  PERFORM app_private.end_ie_flex_write_v1(u.id)
     FROM unnest(v_release) AS u(id);

  RETURN jsonb_build_object('id', p_handover_id, 'code', v_h.code);
END;
$function$;

-- ── 4. Không có cửa nào rơi mất sau khi replace ─────────────────────────────
DO $verify$
DECLARE v_def text; v_fn text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
   WHERE p.proname = 'guard_income_expense_owned_payload'
     AND p.pronamespace = 'app_private'::regnamespace;

  IF v_def NOT LIKE '%LINK_CONTRACT%'
     OR v_def NOT LIKE '%CASHBOOK_MOVE%'
     OR v_def NOT LIKE '%ANNOTATE%'
     OR v_def NOT LIKE '%''HANDOVER''%'
     OR v_def NOT LIKE '%''notes''%' THEN
    RAISE EXCEPTION 'guard sau replace thiếu cửa — kiểm tra lại migration';
  END IF;

  FOR v_fn IN SELECT unnest(ARRAY['create_cash_handover','confirm_cancel_handover']) LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p
     WHERE p.proname = v_fn AND p.pronamespace = 'public'::regnamespace;
    IF v_def NOT LIKE '%begin_ie_flex_write_v1%'
       OR v_def NOT LIKE '%end_ie_flex_write_v1%'
       OR v_def NOT LIKE '%''HANDOVER''%' THEN
      RAISE EXCEPTION '% sau replace không mở/đóng cửa HANDOVER — kiểm tra lại migration', v_fn;
    END IF;
  END LOOP;
END
$verify$;

COMMIT;

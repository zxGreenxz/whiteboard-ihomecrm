-- Guard phiếu canonical — mở cửa hẹp LINK_CONTRACT (gắn phiếu cọc vào hợp đồng).
--
-- TRIỆU CHỨNG (prod, 05/08/2026): tạo hợp đồng cho phòng "Đã cọc" luôn fail —
-- create_contract_v2 trả 55000 "canonical income expense <id> is frozen
-- (update rejected)". Đo trên prod: phiếu thu cọc PT2607208 (401f14e3-…) có row
-- trong app_private.income_expense_flow_ownership ⇒ flow-owned từ lúc sinh, vì
-- mọi phiếu nhập qua màn Thu/Chi đều đi create_income_expense_v1 →
-- claim_canonical_income_expense_draft_v1.
--
-- NGUYÊN NHÂN GỐC: create_contract_v2 (và trg_contract_link_orphan_deposits)
-- mở cửa flex-writer scope 'LINK_CONTRACT' rồi UPDATE income_expenses SET
-- contract_id = <hđ mới>. Comment trong chính hai hàm đó viết "Cửa hẹp
-- LINK_CONTRACT: guard chỉ cho contract_id đi NULL → NOT NULL" — nhưng bản
-- guard ĐANG CHẠY chỉ có 2 cửa: CASHBOOK_MOVE (Đợt C) và ANNOTATE (WP1).
-- Nhánh LINK_CONTRACT bị MẤT: guard được vá ngoài migration (scripts/
-- authz-prepared) nên hai đợt vá sau ghi đè nguyên hàm và xoá nhánh của đợt
-- trước. Không có cửa ⇒ rơi xuống nhánh canonical ⇒ đòi token
-- ie_transition_authorization (create_contract_v2 không cấp, mà cấp cũng vô
-- ích vì allowlist lifecycle KHÔNG chứa contract_id) ⇒ 55000 ⇒ rollback cả
-- giao dịch tạo hợp đồng.
--
-- CHỌN CỬA HẸP, KHÔNG NỚI ALLOWLIST: nới allowlist thêm contract_id sẽ mở cho
-- MỌI writer có token; còn bỏ UPDATE thì recompute_room_reservation (key off
-- contract_id IS NULL) sẽ bật phòng lại RESERVED sau khi ký.
--
-- Cửa LINK_CONTRACT: một chiều NULL → NOT NULL, chỉ contract_id + updated_at,
-- mọi cột khác bất biến. Không đụng nhánh DELETE, không đụng allowlist token.
-- Khoá kỳ vẫn chặn như cũ (check_lock / profit_lock chỉ miễn trừ ANNOTATE).
--
-- Hàm dưới đây là NGUYÊN VĂN bản đang chạy trên prod (pg_get_functiondef,
-- 05/08/2026) + chèn thêm nhánh LINK_CONTRACT — KHÔNG lấy từ
-- scripts/authz-prepared/t5_08_ie_lifecycle_writers.sql vì bản đó cũ hơn prod
-- (thiếu WP1 + Đợt C). Dùng CREATE OR REPLACE nguyên hàm thay vì vá bằng
-- replace() chuỗi để lần sau đọc được toàn bộ hàm trong repo.

BEGIN;

-- Chặn lost-update lần nữa: nếu bản đang deploy đã có cửa nào đó mà file này
-- không biết, dừng lại để người sửa đối chiếu thay vì âm thầm xoá cửa đó.
DO $preflight$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
   WHERE p.proname = 'guard_income_expense_owned_payload'
     AND p.pronamespace = 'app_private'::regnamespace;

  IF v_def IS NULL THEN
    RAISE NOTICE 'guard_income_expense_owned_payload chưa tồn tại — tạo mới.';
    RETURN;
  END IF;

  IF v_def NOT LIKE '%CASHBOOK_MOVE%'
     OR v_def NOT LIKE '%ANNOTATE%'
     OR v_def NOT LIKE '%''notes''%' THEN
    RAISE EXCEPTION 'guard_income_expense_owned_payload trên DB này thiếu cửa/allowlist mà migration giả định (CASHBOOK_MOVE / ANNOTATE / notes) — dừng lại, đối chiếu pg_get_functiondef trước khi replace.';
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

-- Không có cửa nào rơi mất sau khi replace.
DO $verify$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
   WHERE p.proname = 'guard_income_expense_owned_payload'
     AND p.pronamespace = 'app_private'::regnamespace;

  IF v_def NOT LIKE '%LINK_CONTRACT%'
     OR v_def NOT LIKE '%CASHBOOK_MOVE%'
     OR v_def NOT LIKE '%ANNOTATE%'
     OR v_def NOT LIKE '%''notes''%' THEN
    RAISE EXCEPTION 'guard sau replace thiếu cửa — kiểm tra lại migration';
  END IF;
END
$verify$;

COMMIT;

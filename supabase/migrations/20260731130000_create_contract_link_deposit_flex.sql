-- =============================================================================
-- Tạo hợp đồng gắn phiếu cọc canonical bị 55000 "is frozen" — mở cửa hẹp LINK_CONTRACT
-- =============================================================================
-- BỆNH (NATHAN báo 31/07/2026, phòng 10-481NVK):
--   Tạo hợp đồng mới có chọn phiếu cọc giữ chỗ sẵn (PT2607209) → toast "Không
--   lưu được hợp đồng", console: POST create_contract_v2 500, code 55000
--   'canonical income expense 2461d5a0-… is frozen (update rejected)'.
--
-- CHUỖI NHÂN QUẢ:
--   1. create_contract_v2 (20260721090000) khi gắn phiếu cọc có sẵn vào HĐ mới
--      có bước "legacy sync": UPDATE income_expenses SET contract_id = <HĐ mới>
--      để phiếu rời khỏi các query cọc-mồ-côi/giữ-chỗ.
--   2. 20260727120000 bỏ cờ system_only của hạng mục "Tiền cọc" ⇒ phiếu cọc bắt
--      đầu sinh qua create_income_expense_v1 ⇒ flow-owned (canonical).
--   3. Guard app_private.guard_income_expense_owned_payload đóng băng mọi UPDATE
--      lên dòng flow-owned trừ khi transaction có token chuyển trạng thái, mà
--      allowlist token cũng KHÔNG chứa contract_id ⇒ mọi HĐ mới muốn nhận phiếu
--      cọc sinh sau 27/07 đều chết 55000. Phiếu cọc cũ (legacy, không flow-owned)
--      vẫn gắn bình thường — nên bug chỉ lộ khi gặp cọc "đời mới".
--
-- CÁCH VÁ — đúng khuôn cửa hẹp ie_flex_writer_xids đã dựng ở 20260730120000:
--   • Thêm scope 'LINK_CONTRACT' vào CHECK của app_private.ie_flex_writer_xids.
--   • Guard: nhánh LINK_CONTRACT chỉ cho phép contract_id đi từ NULL → NOT NULL,
--     MỌI cột khác (trừ updated_at) phải bất biến. Không mượn
--     ie_transition_authorization vì allowlist lifecycle của nó không (và không
--     nên) chứa contract_id.
--   • create_contract_v2: bọc câu UPDATE legacy-sync bằng
--     begin_ie_flex_write_v1(voucher, 'LINK_CONTRACT') … end_ie_flex_write_v1.
--     end_… gọi SAU khối IF NOT FOUND vì PERFORM ghi đè FOUND.
--
-- BASE: cả guard lẫn create_contract_v2 vá bằng pg_get_functiondef bản ĐANG CHẠY
--   (án "thân hàm prod lệch file migration") — anchor-replace, idempotent, KHÔNG
--   chép nguyên văn thân hàm vào file này.
-- =============================================================================

BEGIN;

-- ── 1. Cho phép scope mới ────────────────────────────────────────────────
ALTER TABLE app_private.ie_flex_writer_xids
  DROP CONSTRAINT ie_flex_writer_xids_scope_chk;
ALTER TABLE app_private.ie_flex_writer_xids
  ADD CONSTRAINT ie_flex_writer_xids_scope_chk
  CHECK (scope IN ('ANNOTATE', 'FLEX_EDIT', 'LINK_CONTRACT'));

-- ── 2. Guard: nhánh LINK_CONTRACT (anchor-replace trên bản đang chạy) ────
DO $patch_guard$
DECLARE
  v_def text;
  v_anchor text;
  v_branch text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app_private'
    AND p.proname = 'guard_income_expense_owned_payload';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy app_private.guard_income_expense_owned_payload';
  END IF;

  -- Idempotent: đã vá rồi thì thôi.
  IF position('LINK_CONTRACT' IN v_def) > 0 THEN
    RAISE NOTICE 'guard đã có cửa LINK_CONTRACT — bỏ qua';
    RETURN;
  END IF;

  v_anchor := '    -- canonical row: check for a live transition token in THIS transaction';
  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không khớp mẫu neo trong guard — DỪNG, không vá mù';
  END IF;

  v_branch := $branch$    -- Cửa LINK_CONTRACT — create_contract_v2 gắn phiếu cọc giữ chỗ vào HĐ
    -- mới sinh. CHỈ được set contract_id từ NULL, mọi cột khác bất biến.
    if exists (
      select 1 from app_private.ie_flex_writer_xids w
       where w.income_expense_id = old.id
         and w.transaction_id = pg_current_xact_id()
         and w.backend_pid = pg_backend_pid()
         and w.scope = 'LINK_CONTRACT'
    ) then
      if old.contract_id is not null
         or new.contract_id is null
         or (to_jsonb(old) - array['contract_id','updated_at'])
            is distinct from
            (to_jsonb(new) - array['contract_id','updated_at']) then
        raise exception 'link-contract scope may only set contract_id (from NULL) of %', old.id
          using errcode = '55000';
      end if;
      return new;
    end if;

$branch$ || v_anchor;

  v_def := replace(v_def, v_anchor, v_branch);

  IF position('LINK_CONTRACT' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Vá guard thất bại — không thấy dấu sau khi replace';
  END IF;

  EXECUTE v_def;
END
$patch_guard$;

-- ── 3. create_contract_v2: bọc UPDATE legacy-sync bằng cửa LINK_CONTRACT ─
DO $patch_writer$
DECLARE
  v_def text;
  v_anchor text;
  v_replacement text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'create_contract_v2';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy public.create_contract_v2';
  END IF;

  IF position('LINK_CONTRACT' IN v_def) > 0 THEN
    RAISE NOTICE 'create_contract_v2 đã mở cửa LINK_CONTRACT — bỏ qua';
    RETURN;
  END IF;

  v_anchor := $anchor$    UPDATE public.income_expenses
       SET contract_id = v_contract_id,
           updated_at = now()
     WHERE id = v_voucher_id
       AND contract_id IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Phiếu cọc đã đổi trạng thái trong lúc tạo hợp đồng'
        USING ERRCODE = '40001';
    END IF;$anchor$;

  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không khớp mẫu neo trong create_contract_v2 — DỪNG, không vá mù';
  END IF;

  -- end_… phải nằm SAU khối IF NOT FOUND: PERFORM ghi đè biến FOUND của UPDATE.
  v_replacement := $rep$    PERFORM app_private.begin_ie_flex_write_v1(v_voucher_id, 'LINK_CONTRACT');
    UPDATE public.income_expenses
       SET contract_id = v_contract_id,
           updated_at = now()
     WHERE id = v_voucher_id
       AND contract_id IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Phiếu cọc đã đổi trạng thái trong lúc tạo hợp đồng'
        USING ERRCODE = '40001';
    END IF;
    PERFORM app_private.end_ie_flex_write_v1(v_voucher_id);$rep$;

  v_def := replace(v_def, v_anchor, v_replacement);

  IF position('LINK_CONTRACT' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Vá create_contract_v2 thất bại — không thấy dấu sau khi replace';
  END IF;

  EXECUTE v_def;
END
$patch_writer$;

COMMIT;

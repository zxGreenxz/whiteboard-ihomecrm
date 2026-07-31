-- =====================================================================
-- WP1 — BẢO VỆ BẰNG CHỨNG: ảnh chứng từ + ghi chú
--
-- ĐÁNH SỐ LẠI 31/07/2026: file này soạn 30/07 với tên
-- 20260730230000_annotate_evidence_protection.sql nhưng CHƯA TỪNG APPLY, mà
-- dải 20260730* đã có 24 migration lên prod sau đó — trong đó
-- 20260730270000 vá chính annotate_income_expense_v1. Giữ số cũ nghĩa là khi
-- dựng lại clone, file này chạy TRƯỚC bản vá kia rồi bị nó ghi đè, và trên
-- prod thì chạy SAU nên lại xoá mất bản vá kia. Đổi sang 20260801000000 để
-- thứ tự replay khớp thứ tự thi hành thật. Nội dung giữ nguyên trừ chốt
-- digest ở mục 5 (xem ghi chú tại đó).
--
-- Chủ đã chốt (29/07): GIỮ quyết định #2 — đợt này vẫn CHỈ ảnh + ghi chú,
-- không mở sửa tiền — và "ghi nhận lại toàn bộ thao tác huỷ/chỉnh sửa để đối
-- soát sau này". Migration này siết bảy lỗ đã đo được trên prod:
--
--  1. GỠ ẢNH quá rộng. Header của 20260730100000 tuyên bố "dán thêm được, gỡ
--     bằng chứng thì không", nhưng annotate_income_expense_v1 lại cho gỡ ảnh
--     trên phiếu APPROVED + ĐÃ GHI SỔ, kể cả phiếu trong kỳ ĐÃ CHỐT SỔ, cho
--     mọi người có income_expenses.edit trên toà. Prod có 857 phiếu APPROVED
--     đang mang ảnh (851 POSTED + 3 NOT_APPLICABLE + 3 UNPOSTED).
--
--  2. Nhật ký gỡ ảnh không lưu URL nào bị gỡ.
--     ĐÃ ĐƯỢC GIẢI QUYẾT ở 20260730220000: trigger z99_ie_change_log ghi
--     before/after đầy đủ vào app_private.income_expense_change_log, và
--     `attachments` KHÔNG nằm trong danh sách nhiễu của
--     app_private.log_income_expense_change ⇒ mọi URL bị gỡ đều còn nguyên
--     trong `before`. Đã kiểm bằng dry-run. Ở đây chỉ làm thêm phần nhỏ: ghi
--     SỐ LƯỢNG ảnh vào income_expense_audit_log để đọc lướt không phải mở
--     bảng change_log (giữ nguyên tiền tố cũ để mọi thứ khớp LIKE cũ vẫn khớp).
--
--  3. Ghi chú không được bảo vệ như ảnh: người CHỈ giữ sổ (không có
--     income_expenses.edit, không phải người lập phiếu) ghi đè / xoá trắng
--     notes của phiếu ĐÃ DUYỆT + ĐÃ GHI SỔ.
--
--  4. (QUAN TRỌNG NHẤT VỀ KỸ THUẬT) Nhánh ANNOTATE trong
--     app_private.guard_income_expense_owned_payload nằm SAU early-return
--     "phiếu không flow-owned", nên phần tự kiểm delta
--     ("annotate scope may only change attachments/notes") chỉ có hiệu lực
--     trên 175/2528 phiếu. Đã đo: mở scope ANNOTATE trên phiếu KHÔNG
--     flow-owned rồi UPDATE total_amount -> 999999.00, không guard nào lên
--     tiếng. Migration này chuyển nhánh đó lên TRƯỚC early-return.
--
--  5. p_idempotency_key khai trong chữ ký nhưng không được đọc ở dòng nào.
--  6. p_note_mode='APPEND' không idempotent: gọi hai lần cùng nội dung, cùng
--     key vẫn nối hai lần.
--  7. Trần 5000 ký tự kiểm trên p_notes (ĐẦU VÀO) chứ không trên chuỗi KẾT
--     QUẢ, nên APPEND lặp làm notes phình vô hạn (đo được 9801 ký tự sau 2
--     lần; prod đang có 4 phiếu notes > 5000, dài nhất 15138 ký tự).
--
-- KHÔNG đụng: cầu a85 (annotate không chạm approval_status / account_id /
-- total_amount / deleted_at), trục tiền, và tập người được DÁN THÊM ảnh
-- (quyết định #8: dán thêm vẫn tự do, kể cả trong kỳ đã chốt).
-- =====================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1. "Phiếu đã rời bản nháp" — vị ngữ khoá bằng chứng
--
-- Yêu cầu của chủ nói "chưa ghi sổ". Ở đây CHẶT HƠN một bậc, cố ý:
-- mốc mở khoá là BẢN NHÁP (UNAPPROVED và chưa POSTED), không phải
-- "chưa POSTED". Lý do đo được trên prod:
--   * 310 phiếu APPROVED mang posting_status='NOT_APPLICABLE' (sổ ảo:
--     cấn cọc, cấn trừ thanh lý). Chúng KHÔNG BAO GIỜ thành 'POSTED', nên
--     nếu lấy mốc "chưa POSTED" thì cửa gỡ ảnh của chúng mở vĩnh viễn —
--     mà đây đúng là nhóm phiếu cọc vừa backfill 998,44tr, cần bằng chứng
--     nhất.
--   * 7 phiếu APPROVED + UNPOSTED: đã có người duyệt dựa trên tấm ảnh đó.
--   * 388 phiếu CANCELLED: ảnh trên phiếu đã huỷ chính là dấu vết cần giữ
--     ("phiếu này bị huỷ nhưng có ảnh thu tiền — ai đã cầm tiền?").
-- Bản nháp thì gỡ thoải mái: chưa ai duyệt, chưa vào sổ nào.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_private.ie_evidence_locked_v1(
  p_approval_status text,
  p_posting_status text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT NOT (
    COALESCE(p_approval_status, '') = 'UNAPPROVED'
    AND COALESCE(p_posting_status, 'UNPOSTED') <> 'POSTED'
  );
$fn$;

COMMENT ON FUNCTION app_private.ie_evidence_locked_v1(text, text) IS
  'Phiếu đã rời bản nháp chưa? Đúng thì ảnh chứng từ + ghi chú đã có là BẰNG CHỨNG: chỉ nối thêm, muốn gỡ phải là chủ tổ chức và kỳ còn mở.';

-- ─────────────────────────────────────────────────────────────────────
-- 2. Ghi chú trên phiếu đã lên sổ: CHỈ NỐI THÊM
--
-- "Nối thêm" định nghĩa là: nội dung cũ vẫn nằm nguyên ở ĐẦU chuỗi mới.
-- Không dùng so sánh thô `left(new, len(old)) = old` vì giao diện
-- (IncomeExpenseQuickEditDialog) nạp notes vào textarea rồi gửi lại bản
-- `.trim()`; phiếu nào có sẵn '\n' ở đầu/cuối (prod có, ví dụ các phiếu
-- '[Hủy] e2e cleanup') sẽ bị báo lỗi oan. Nên so trên bản btrim hai vế.
-- Ghi chú cũ rỗng thì viết gì cũng được — không có bằng chứng nào bị mất.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_private.ie_notes_append_only_v1(
  p_old text,
  p_new text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN btrim(COALESCE(p_old, '')) = '' THEN true
    WHEN p_new IS NULL THEN false
    -- left() thay vì LIKE: notes thật có chứa '%' và '_' (số tiền, đường
    -- dẫn), LIKE sẽ hiểu chúng là ký tự đại diện và cho lọt.
    ELSE left(btrim(p_new), length(btrim(p_old))) = btrim(COALESCE(p_old, ''))
  END;
$fn$;

COMMENT ON FUNCTION app_private.ie_notes_append_only_v1(text, text) IS
  'Ghi chú mới có GIỮ NGUYÊN ghi chú cũ ở đầu không (tức chỉ nối thêm)? So trên bản btrim vì giao diện gửi lại chuỗi đã trim.';

-- ─────────────────────────────────────────────────────────────────────
-- 3. Sổ idempotency cho annotate (điểm 5 + 6)
--
-- Dán ảnh vốn tự idempotent (hợp nhất mảng phía server), nhưng NỐI GHI CHÚ
-- thì không: bấm Lưu hai lần là notes có hai đoạn giống hệt nhau.
-- Bảng nhỏ, chỉ writer SECURITY DEFINER chạm tới.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_private.ie_annotate_idempotency (
  income_expense_id uuid        NOT NULL,
  idempotency_key   text        NOT NULL,
  actor_id          uuid,
  result            jsonb       NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (income_expense_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_ie_annotate_idem_created
  ON app_private.ie_annotate_idempotency (created_at);

REVOKE ALL ON app_private.ie_annotate_idempotency
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE app_private.ie_annotate_idempotency IS
  'Sổ chống lặp cho public.annotate_income_expense_v1. Khoá (phiếu, idempotency_key); gọi lại cùng khoá trả nguyên kết quả lần đầu, không nối ghi chú lần hai.';

-- ─────────────────────────────────────────────────────────────────────
-- 4. ĐIỂM 4 — đưa nhánh ANNOTATE lên TRƯỚC early-return
--
-- VÁ TẠI CHỖ theo neo, KHÔNG viết đè từ file: thân hàm đang chạy đã qua ba
-- lần vá (7t / 7u / Đợt 2) và bản trong scripts/authz-prepared đã lạc hậu —
-- viết đè sẽ nuốt mất review_state / posting_status / notes... khỏi allowlist
-- và làm hỏng mọi writer V2.
-- md5 thân hàm lúc soạn bản vá: 9e8b7bfef4ffb31b95955d57223b3248
-- ─────────────────────────────────────────────────────────────────────
DO $patch$
DECLARE
  v_def      text;
  v_mark     text := 'WP1: cửa ANNOTATE đứng TRƯỚC early-return';
  v_a_decl   text := 'declare' || chr(10) || '  v_authorized boolean;' || chr(10);
  v_a_early  text := '    if not app_private.is_income_expense_flow_owned(old.id)';
  v_a_annot  text := '    -- Đợt 2: cửa ANNOTATE';
  v_a_canon  text := '    -- canonical row: check for a live transition token in THIS transaction';
  v_start    int;
  v_end      int;
  v_block    text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app_private' AND p.proname = 'guard_income_expense_owned_payload';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy app_private.guard_income_expense_owned_payload';
  END IF;

  -- Idempotent: chạy lần hai là no-op.
  IF position(v_mark IN v_def) > 0 THEN
    RAISE NOTICE 'guard_income_expense_owned_payload đã có bản vá WP1 — bỏ qua';
    RETURN;
  END IF;

  -- Assert MẪU trước khi đụng dao. Lệch mẫu thì DỪNG, không vá mù.
  IF position(v_a_decl IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không khớp neo DECLARE trong guard — DỪNG';
  END IF;
  IF position(v_a_early IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không khớp neo early-return flow-owned trong guard — DỪNG';
  END IF;
  IF position(v_a_annot IN v_def) = 0 OR position(v_a_canon IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không thấy khối ANNOTATE của Đợt 2 trong guard — DỪNG';
  END IF;
  IF position(v_a_annot IN v_def) > position(v_a_canon IN v_def) THEN
    RAISE EXCEPTION 'Khối ANNOTATE nằm sai chỗ so với neo canonical — DỪNG';
  END IF;

  -- 4a. Cắt khối ANNOTATE cũ (đang nằm SAU early-return) ra khỏi thân hàm.
  v_start := position(v_a_annot IN v_def);
  v_end   := position(v_a_canon IN v_def);
  v_def   := substr(v_def, 1, v_start - 1) || substr(v_def, v_end);

  IF position('ie_flex_writer_xids' IN v_def) > 0 THEN
    RAISE EXCEPTION 'Cắt khối ANNOTATE cũ thất bại — vẫn còn dấu vết';
  END IF;

  -- 4b. Khai thêm biến cho danh sách cột được miễn.
  v_def := replace(v_def, v_a_decl,
    v_a_decl || '  v_annotate_free text[];' || chr(10));

  -- 4c. Dựng khối ANNOTATE mới, đặt TRƯỚC early-return.
  v_block :=
    '    -- ' || v_mark || '.' || chr(10) ||
    '    -- Trước WP1 khối này nằm SAU early-return "phiếu không flow-owned",' || chr(10) ||
    '    -- nên phần tự kiểm delta chỉ có hiệu lực trên 175/2528 phiếu: mở scope' || chr(10) ||
    '    -- ANNOTATE trên một phiếu KHÔNG flow-owned rồi UPDATE total_amount là đi' || chr(10) ||
    '    -- lọt (đã đo trên prod: total_amount thành 999999.00, không ai lên tiếng).' || chr(10) ||
    '    -- Năng lực vẫn nằm ở app_private.ie_flex_writer_xids (chỉ writer definer' || chr(10) ||
    '    -- mở được), KHÔNG mượn cột purpose của ie_transition_authorization vì cột' || chr(10) ||
    '    -- đó bị writer canon ghi đè và purpose FINANCE_V2_LIFECYCLE làm tắt cầu a85.' || chr(10) ||
    '    if exists (' || chr(10) ||
    '      select 1 from app_private.ie_flex_writer_xids w' || chr(10) ||
    '       where w.income_expense_id = old.id' || chr(10) ||
    '         and w.transaction_id = pg_current_xact_id()' || chr(10) ||
    '         and w.backend_pid = pg_backend_pid()' || chr(10) ||
    '         and w.scope = ''ANNOTATE''' || chr(10) ||
    '    ) then' || chr(10) ||
    '      -- a001_ie_lifecycle_normalize chạy TRƯỚC trigger này và ĐIỀN' || chr(10) ||
    '      -- posting_mode / posting_status / review_state khi chúng đang NULL, ở' || chr(10) ||
    '      -- MỌI update. Prod còn 173 phiếu NULL (75 trong đó flow-owned — tức' || chr(10) ||
    '      -- annotate trên chúng đang hỏng sẵn từ Đợt 2, bản vá này chữa luôn).' || chr(10) ||
    '      -- Chỉ miễn ĐÚNG chiều NULL -> giá trị, không miễn cả cột.' || chr(10) ||
    '      v_annotate_free := array[''attachments'',''notes'',''updated_at''];' || chr(10) ||
    '      if old.posting_mode   is null then v_annotate_free := v_annotate_free || ''posting_mode''; end if;' || chr(10) ||
    '      if old.posting_status is null then v_annotate_free := v_annotate_free || ''posting_status''; end if;' || chr(10) ||
    '      if old.review_state   is null then v_annotate_free := v_annotate_free || ''review_state''; end if;' || chr(10) ||
    chr(10) ||
    '      if (to_jsonb(old) - v_annotate_free)' || chr(10) ||
    '         is distinct from' || chr(10) ||
    '         (to_jsonb(new) - v_annotate_free) then' || chr(10) ||
    '        raise exception ''annotate scope may only change attachments/notes of %'', old.id' || chr(10) ||
    '          using errcode = ''55000'';' || chr(10) ||
    '      end if;' || chr(10) ||
    '      return new;' || chr(10) ||
    '    end if;' || chr(10) ||
    chr(10);

  v_def := replace(v_def, v_a_early, v_block || v_a_early);

  -- Assert KẾT QUẢ: đúng một cửa ANNOTATE, và nó phải đứng TRƯỚC early-return.
  IF position(v_mark IN v_def) = 0
     OR position('ie_flex_writer_xids' IN v_def) = 0
     OR position('v_annotate_free text[];' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Vá guard thất bại — thiếu dấu sau khi ghép';
  END IF;
  IF position('ie_flex_writer_xids' IN v_def) > position(v_a_early IN v_def) THEN
    RAISE EXCEPTION 'Vá guard thất bại — cửa ANNOTATE vẫn nằm sau early-return';
  END IF;
  IF (length(v_def) - length(replace(v_def, 'w.scope = ''ANNOTATE''', '')))
     <> length('w.scope = ''ANNOTATE''') THEN
    RAISE EXCEPTION 'Vá guard thất bại — cửa ANNOTATE bị nhân đôi';
  END IF;

  EXECUTE v_def;
  RAISE NOTICE 'guard_income_expense_owned_payload: cửa ANNOTATE đã lên trước early-return';
END
$patch$;

-- ─────────────────────────────────────────────────────────────────────
-- 5. RPC annotate — bản đã siết
--
-- KHÔNG đổi chữ ký (PostgREST đã cache, FE đang gửi đủ 6 tham số).
-- Trước khi ghi đè: ASSERT md5 thân hàm đang chạy nằm trong danh sách thân
-- hàm ĐÃ ĐƯỢC ĐỌC BẰNG MẮT. Lệch = có người vá mà mình chưa đọc => DỪNG.
--
-- ── 31/07/2026: đã ghép tay đúng như chốt chặn này yêu cầu ────────────
-- Chốt chặn bản 30/07 chỉ nhận cebb54db… và nó ĐÃ NỔ đúng như thiết kế:
-- prod trả a68c8662f07270f6cd6d4e47c01b5b19. Đã chạy `diff` đầy đủ giữa thân
-- hàm sống và bản dưới đây trước khi nới chốt. Kết quả đối chiếu:
--
--   Bản sống có gì mà bản này thiếu?  → KHÔNG CÓ GÌ. Không mất năng lực nào.
--   Bản sống đã tự có (một phần):
--     • gỡ ảnh: đòi quyền sửa VÀ (chưa POSTED HOẶC chủ/super)
--     • ghi chú: POSTED + REPLACE + đã có chữ ⇒ tự ép sang APPEND
--     • chốt hạng mục hạn chế
--   Bản dưới đây CHẶT HƠN ở đúng những chỗ đó:
--     • mốc khoá là RỜI BẢN NHÁP, không phải POSTED — bịt 310 phiếu
--       NOT_APPLICABLE (sổ ảo) vốn không bao giờ thành POSTED nên cửa gỡ ảnh
--       của chúng đang mở vĩnh viễn, đúng nhóm phiếu cọc vừa backfill 998tr
--     • thêm chốt KỲ: phiếu trong kỳ đã chốt thì KHÔNG AI gỡ, kể cả chủ
--     • ghi chú: chặn xoá chữ người khác thay vì chỉ ép APPEND
--     • trần 5000 kiểm trên chuỗi KẾT QUẢ (trước chỉ kiểm đầu vào ⇒ phình vô hạn)
--     • p_idempotency_key từ tham số trang trí thành chống lặp thật
--   Tiền tố nhật ký giữ nguyên ('Bổ sung ảnh chứng từ…') nên mọi bộ lọc LIKE
--   sẵn có vẫn khớp.
--
-- Nhận CẢ HAI digest để file còn chạy được trên clone dựng lại từ đầu (nơi
-- thân hàm còn ở bản cebb54db…) lẫn trên prod hôm nay (a68c8662…).
-- ─────────────────────────────────────────────────────────────────────
DO $guard$
DECLARE
  v_md5 text;
  v_def text;
  v_known text[] := ARRAY[
    'cebb54db0804fcb077b97ec08b45d1a7',  -- bản đọc lúc soạn WP1 (30/07)
    'a68c8662f07270f6cd6d4e47c01b5b19'   -- bản sống trên prod, đã diff tay 31/07
  ];
BEGIN
  SELECT pg_get_functiondef(p.oid), md5(pg_get_functiondef(p.oid))
    INTO v_def, v_md5
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'annotate_income_expense_v1';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy public.annotate_income_expense_v1';
  END IF;
  IF position('WP1' IN v_def) > 0 THEN
    RAISE NOTICE 'annotate_income_expense_v1 đã là bản WP1 — ghi đè lại vẫn an toàn (cùng nội dung)';
    RETURN;
  END IF;
  IF NOT (v_md5 = ANY(v_known)) THEN
    RAISE EXCEPTION
      'annotate_income_expense_v1 trên prod đã LỆCH mọi bản đã đọc (md5 %) — DỪNG, không ghi đè mù. Chạy diff với bản trong file này rồi thêm digest mới vào v_known.', v_md5;
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.annotate_income_expense_v1(
  p_voucher uuid,
  p_add_attachments jsonb DEFAULT NULL,
  p_remove_attachments jsonb DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_note_mode text DEFAULT 'REPLACE',
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_row public.income_expenses%ROWTYPE;
  v_actor uuid := auth.uid();
  v_membership uuid;
  v_is_super boolean;
  v_is_owner boolean;
  v_can_edit boolean;
  v_locked boolean;
  v_key text;
  v_prev jsonb;
  v_next_att jsonb;
  v_next_notes text;
  v_url text;
  v_added int := 0;
  v_removed int := 0;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_note_mode NOT IN ('REPLACE', 'APPEND') THEN
    RAISE EXCEPTION 'p_note_mode phải là REPLACE hoặc APPEND' USING ERRCODE = '22023';
  END IF;

  -- WP1 (điểm 5): tham số này trước đây khai rồi bỏ đó, không dòng nào đọc.
  v_key := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  IF v_key IS NOT NULL AND length(v_key) > 200 THEN
    RAISE EXCEPTION 'p_idempotency_key tối đa 200 ký tự' USING ERRCODE = '22023';
  END IF;

  -- FOR UPDATE giữ luôn vai trò hàng rào chống lặp song song: hai lần gọi cùng
  -- key chạy song song sẽ xếp hàng ở đây, lần sau đọc được sổ idempotency.
  SELECT * INTO v_row FROM public.income_expenses
   WHERE id = p_voucher AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE = 'P0002';
  END IF;

  v_is_super := public.is_super_admin();

  SELECT m.id INTO v_membership
  FROM public.organization_memberships m
  WHERE m.user_id = v_actor AND m.organization_id = v_row.organization_id
    AND m.status = 'ACTIVE'
  LIMIT 1;

  IF v_membership IS NULL AND NOT v_is_super THEN
    RAISE EXCEPTION 'Không thuộc tổ chức của phiếu' USING ERRCODE = '42501';
  END IF;

  -- Chủ tổ chức / super admin: cửa duy nhất còn gỡ được bằng chứng.
  v_is_owner := v_is_super OR app_private.is_org_owner_v1(v_row.organization_id, v_actor);

  -- Quyền sửa "thật" trên toà (quyết định #4: thêm Chủ tổ chức / Super Admin).
  v_can_edit := v_is_owner
             OR app_private.ie_can_edit_money_axis_v1(v_row.organization_id, v_row.building_id);

  -- Ai được đính ảnh/ghi chú: quyền sửa, HOẶC đang giữ/biết sổ, HOẶC là người
  -- lập phiếu (giữ nguyên tầm với của luồng dán ảnh hiện tại).
  IF NOT (
       v_can_edit
    OR v_row.user_id = v_actor
    OR app_private.ie_has_cashbook_possession_v1(
         v_row.organization_id, v_row.account_id, v_membership)
  ) THEN
    RAISE EXCEPTION 'Không có quyền bổ sung ảnh/ghi chú cho phiếu này'
      USING ERRCODE = '42501';
  END IF;

  -- RPC là SECURITY DEFINER nên không hưởng policy RESTRICTIVE hạng mục hạn chế.
  IF COALESCE(v_row.has_restricted_item, false)
     AND v_row.user_id IS DISTINCT FROM v_actor
     AND NOT public.can_view_restricted_ie()
     AND NOT v_is_super THEN
    RAISE EXCEPTION 'Phiếu chứa hạng mục hạn chế — không có quyền' USING ERRCODE = '42501';
  END IF;

  -- WP1 (điểm 5+6): chống lặp. CỐ Ý đặt SAU cổng quyền — người lạ đoán trúng
  -- một idempotency_key không được phát lại kết quả (trong đó có danh sách ảnh).
  IF v_key IS NOT NULL THEN
    SELECT k.result INTO v_prev
    FROM app_private.ie_annotate_idempotency k
    WHERE k.income_expense_id = p_voucher AND k.idempotency_key = v_key;
    IF v_prev IS NOT NULL THEN
      RETURN v_prev || jsonb_build_object('replayed', true);
    END IF;
  END IF;

  v_locked := app_private.ie_evidence_locked_v1(v_row.approval_status, v_row.posting_status);

  -- ── GỠ ẢNH (điểm 1) ───────────────────────────────────────────────
  -- Bậc 1 (đã có từ Đợt 2): gỡ là hành vi SỬA, đòi quyền sửa thật.
  -- Bậc 2 (WP1): phiếu đã rời bản nháp thì chỉ CHỦ TỔ CHỨC / SUPER ADMIN.
  -- Bậc 3 (WP1): và kỳ phải còn mở — phiếu đã lên sổ trong kỳ ĐÃ CHỐT thì
  --              KHÔNG AI gỡ được, kể cả chủ tổ chức. Đó là hàng rào giữ cho
  --              số đã chốt & đã chia cho cổ đông còn chứng từ đối soát.
  -- DÁN THÊM không đi qua đây: vẫn tự do ở mọi trạng thái, mọi kỳ (quyết định #8).
  IF p_remove_attachments IS NOT NULL
     AND jsonb_array_length(p_remove_attachments) > 0 THEN
    IF NOT v_can_edit THEN
      RAISE EXCEPTION 'Chỉ người có quyền sửa thu chi mới gỡ được ảnh chứng từ'
        USING ERRCODE = '42501';
    END IF;
    IF v_locked THEN
      IF NOT v_is_owner THEN
        RAISE EXCEPTION
          'Phiếu đã duyệt/ghi sổ — ảnh chứng từ là bằng chứng, chỉ chủ tổ chức mới gỡ được. Bạn vẫn dán thêm ảnh và ghi chú giải thích được.'
          USING ERRCODE = '42501';
      END IF;
      PERFORM app_private.assert_period_open_for_edit_v1(p_voucher, 'gỡ ảnh chứng từ của');
    END IF;
  END IF;

  -- Kiểm URL (cùng luật với create_income_expense_v1).
  IF p_add_attachments IS NOT NULL THEN
    FOR v_url IN SELECT jsonb_array_elements_text(p_add_attachments) LOOP
      IF v_url !~ '^https://' OR length(v_url) > 2048 OR v_url ~ '[[:cntrl:]]' THEN
        RAISE EXCEPTION 'Đường dẫn ảnh không hợp lệ' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  v_next_att := COALESCE(v_row.attachments, '[]'::jsonb);
  IF p_remove_attachments IS NOT NULL THEN
    v_next_att := app_private.ie_attachments_remove_v1(v_next_att, p_remove_attachments);
  END IF;
  IF p_add_attachments IS NOT NULL THEN
    -- Hợp nhất phía server: hai người cùng dán ảnh không đè mất của nhau, và
    -- dán lại đúng tấm cũ là no-op (nên không cần sổ idempotency riêng).
    v_next_att := app_private.ie_attachments_union_v1(v_next_att, p_add_attachments);
  END IF;

  IF jsonb_array_length(v_next_att) > 20 THEN
    RAISE EXCEPTION 'Tối đa 20 ảnh chứng từ trên một phiếu' USING ERRCODE = '22023';
  END IF;

  -- ── GHI CHÚ (điểm 3, 6, 7) ────────────────────────────────────────
  v_next_notes := v_row.notes;
  IF p_notes IS NOT NULL THEN
    IF length(p_notes) > 5000 THEN
      RAISE EXCEPTION 'Ghi chú tối đa 5000 ký tự' USING ERRCODE = '22023';
    END IF;

    v_next_notes := CASE
      WHEN p_note_mode = 'APPEND' AND COALESCE(v_row.notes, '') <> ''
        THEN CASE
          -- Nối chuỗi rỗng = không nối gì.
          WHEN btrim(p_notes) = '' THEN v_row.notes
          -- WP1 (điểm 6): đoạn định nối ĐÃ là đoạn cuối hiện tại ⇒ đây là cú
          -- bấm Lưu lần hai, không phải ý định viết trùng. Không nối nữa.
          WHEN right(v_row.notes, length(p_notes) + 1) = chr(10) || p_notes THEN v_row.notes
          ELSE v_row.notes || chr(10) || p_notes
        END
      ELSE p_notes
    END;

    -- WP1 (điểm 7): trần kiểm trên chuỗi KẾT QUẢ. Trước đây chỉ kiểm đầu vào
    -- nên APPEND lặp làm notes phình vô hạn (đo được 9801 ký tự sau 2 lần).
    IF length(COALESCE(v_next_notes, '')) > 5000 THEN
      RAISE EXCEPTION
        'Ghi chú sau khi nối dài % ký tự, vượt trần 5000. Hãy rút gọn nội dung định thêm.',
        length(v_next_notes)
        USING ERRCODE = '22023';
    END IF;

    -- WP1 (điểm 3): phiếu đã rời bản nháp thì ghi chú CHỈ ĐƯỢC NỐI THÊM.
    -- Chọn "nối thêm" thay vì dựng thêm một trục quyền mới, vì người GIỮ SỔ
    -- có nhu cầu chính đáng ghi chú lên phiếu của người khác (đối soát, ghi
    -- rõ đã nhận tiền mặt lúc nào) — cấm họ ghi là hỏng việc thật; cái phải
    -- cấm là XOÁ chữ của người khác. Chủ tổ chức vẫn viết đè được khi kỳ còn
    -- mở (ảnh chụp nhầm CMND, số điện thoại lỡ dán vào ghi chú...), và
    -- app_private.income_expense_change_log giữ nguyên văn bản cũ để đối soát.
    IF v_locked
       AND NOT app_private.ie_notes_append_only_v1(v_row.notes, v_next_notes) THEN
      IF NOT v_is_owner THEN
        RAISE EXCEPTION
          'Phiếu đã duyệt/ghi sổ — ghi chú chỉ được NỐI THÊM, không xoá/sửa phần đã có. Giữ nguyên nội dung cũ rồi viết tiếp ở cuối.'
          USING ERRCODE = '55000';
      END IF;
      PERFORM app_private.assert_period_open_for_edit_v1(p_voucher, 'viết đè ghi chú của');
    END IF;

    -- Dấu hiệu tiền trong ghi chú là LOGIC TIỀN (xem Đợt 0) — cấm thêm/gỡ.
    PERFORM app_private.assert_notes_markers_unchanged_v1(v_row.notes, v_next_notes);
  END IF;

  SELECT count(*) INTO v_added
    FROM jsonb_array_elements(v_next_att) e
   WHERE NOT COALESCE(v_row.attachments, '[]'::jsonb) @> jsonb_build_array(e.value);
  SELECT count(*) INTO v_removed
    FROM jsonb_array_elements(COALESCE(v_row.attachments, '[]'::jsonb)) e
   WHERE NOT v_next_att @> jsonb_build_array(e.value);

  IF v_next_att IS NOT DISTINCT FROM COALESCE(v_row.attachments, '[]'::jsonb)
     AND v_next_notes IS NOT DISTINCT FROM v_row.notes THEN
    v_result := jsonb_build_object('id', p_voucher, 'changed', false);
  ELSE
    PERFORM app_private.begin_ie_flex_write_v1(p_voucher, 'ANNOTATE');
    UPDATE public.income_expenses
       SET attachments = v_next_att,
           notes = v_next_notes
     WHERE id = p_voucher;
    PERFORM app_private.end_ie_flex_write_v1(p_voucher);

    -- Nguyên văn URL bị gỡ nằm ở app_private.income_expense_change_log
    -- (trigger z99_ie_change_log, migration 20260730220000) — ở đây chỉ ghi số
    -- lượng, và GIỮ NGUYÊN tiền tố cũ để mọi bộ lọc LIKE sẵn có vẫn khớp.
    PERFORM app_private.append_income_expense_event_v1(
      v_row.organization_id,
      p_voucher,
      'MANUAL_LOG',
      v_actor,
      NULL,
      v_row.approval_status,
      v_row.approval_status,
      CASE
        WHEN v_added > 0 AND v_removed > 0
          THEN format('Bổ sung/gỡ ảnh chứng từ (thêm %s, gỡ %s)', v_added, v_removed)
        WHEN v_added > 0   THEN format('Bổ sung ảnh chứng từ (%s)', v_added)
        WHEN v_removed > 0 THEN format('Gỡ ảnh chứng từ (%s)', v_removed)
        ELSE 'Sửa ghi chú'
      END
    );

    v_result := jsonb_build_object(
      'id', p_voucher,
      'changed', true,
      'attachments', v_next_att,
      'added', v_added,
      'removed', v_removed
    );
  END IF;

  IF v_key IS NOT NULL THEN
    INSERT INTO app_private.ie_annotate_idempotency
      (income_expense_id, idempotency_key, actor_id, result)
    VALUES (p_voucher, v_key, v_actor, v_result)
    ON CONFLICT (income_expense_id, idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END
$fn$;

REVOKE ALL ON FUNCTION public.annotate_income_expense_v1(uuid, jsonb, jsonb, text, text, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.annotate_income_expense_v1(uuid, jsonb, jsonb, text, text, text)
  TO authenticated;

COMMENT ON FUNCTION public.annotate_income_expense_v1(uuid, jsonb, jsonb, text, text, text) IS
  'Bổ sung ảnh chứng từ / ghi chú cho phiếu thu chi ở BẤT KỲ trạng thái nào. DÁN THÊM tự do; GỠ ẢNH chỉ khi phiếu còn là bản nháp, hoặc do chủ tổ chức và kỳ còn mở; GHI CHÚ trên phiếu đã rời bản nháp chỉ được nối thêm. Có sổ idempotency, trần 5000 ký tự tính trên chuỗi kết quả.';

COMMIT;

NOTIFY pgrst, 'reload schema';

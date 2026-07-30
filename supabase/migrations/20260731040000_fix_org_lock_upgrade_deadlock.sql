-- =====================================================================
-- SỬA DEADLOCK 40P01 CỦA GIAO THỨC GHI CANONICAL (bẫy "nâng khoá chia sẻ")
--
-- TRIỆU CHỨNG NGƯỜI DÙNG THẤY: bấm tạo sổ quỹ (hoặc bất kỳ writer canonical
-- nào) và nhận lỗi 500 kèm thông điệp
--   SQLSTATE 40P01 · "deadlock detected"
--   "Process A waits for ShareLock on transaction X; blocked by B.
--    Process B waits for ShareLock on transaction Y; blocked by A."
-- Đo thật 30/07/2026 qua .e2e-fleet/specs/utility-book-menu.spec.ts:
--   FLEET_WORKERS=3 → xanh 4/4 · FLEET_WORKERS=6 → ĐỎ ĐỀU ĐẶN 1/4.
--
-- NGUYÊN NHÂN GỐC (đã truy tới cùng, không phải phỏng đoán):
--
--   app_private.lock_org_for_decision_v1 lấy khoá dòng organizations bằng
--       SELECT o.authorization_version FROM organizations o
--        WHERE o.id = p_organization_id AND o.status='ACTIVE' FOR SHARE;
--
--   Còn trigger `a10_bump_authz_version` (hàm bump_org_authorization_version)
--   nổ trên INSERT/UPDATE/DELETE của BA bảng phân quyền — authorization_scopes,
--   member_permission_overrides, member_override_scopes — và làm
--       UPDATE organizations SET authorization_version = authorization_version + 1
--        WHERE id = v_org;
--   tức đòi khoá NO KEY UPDATE trên ĐÚNG DÒNG vừa bị khoá FOR SHARE.
--
--   Diễn biến deadlock:
--     1. A: FOR SHARE dòng org O          → được
--     2. B: FOR SHARE dòng org O          → được (share tương thích share)
--     3. A: ghi authorization_scopes → trigger UPDATE O → cần độc quyền
--          → PHẢI CHỜ B nhả share
--     4. B: y hệt → PHẢI CHỜ A nhả share
--     5. Chéo nhau → 40P01. Đúng thông điệp quan sát được.
--
--   Đây là bẫy LOCK UPGRADE kinh điển: giữ share rồi mới xin exclusive trên cùng
--   một dòng thì hai phiên không bao giờ nhường nhau được.
--
-- PHẠM VI: **41 hàm** gọi lock_org_for_decision_v1 (create_cashbook_v1,
-- salary_payout_v1, reverse_invoice_collection_v5, set_cashbook_shared_users_v1,
-- update_cashbook_metadata_v1, terminate_contract_move_out, …). Bất kỳ HAI hàm
-- trong số đó chạy song song cùng org mà đều chạm bảng phân quyền là ăn deadlock.
-- Vì vậy sửa ở ĐÚNG MỘT CHỖ — hàm khoá — thay vì vá từng writer.
--
-- CÁCH SỬA: đổi FOR SHARE → **FOR NO KEY UPDATE**.
--   • FOR NO KEY UPDATE chính là mode mà một câu UPDATE không đụng khoá sẽ lấy.
--     Lấy sẵn nó từ đầu ⇒ khi trigger UPDATE, transaction ĐÃ giữ mode đủ mạnh
--     ⇒ KHÔNG cần nâng khoá ⇒ KHÔNG thể deadlock ở điểm này.
--   • Hai phiên giờ XẾP HÀNG trên khoá org rồi lần lượt đi qua — đúng đúng ý
--     nghĩa hàng rào mà chính chú thích của hàm mong muốn ("take the org lock
--     FIRST so the witness statement runs on a snapshot taken AFTER any waiting").
--     FOR SHARE chưa bao giờ thực hiện được lời hứa đó cho writer có bump version.
--   • KHÔNG dùng FOR UPDATE: mạnh hơn mức cần và còn chặn cả kiểm khoá ngoại
--     (FK check lấy FOR KEY SHARE — tương thích với NO KEY UPDATE nhưng xung đột
--     với FOR UPDATE). Chọn mode nhỏ nhất mà đủ.
--
-- VỀ THÔNG LƯỢNG — vì sao đổi này KHÔNG làm chậm thêm: các writer này ĐÃ tuần tự
-- hoá sẵn ngay tại câu UPDATE của trigger (chúng đều tranh cùng một dòng org).
-- Thay đổi chỉ dời điểm xếp hàng lên SỚM HƠN và bỏ deadlock. Nói cách khác:
-- trước đây chúng vẫn phải chờ nhau, chỉ là đôi khi chờ thành chéo rồi CHẾT.
--
-- KHÔNG ĐỤNG TIỀN: chỉ đổi MODE KHOÁ của một hàm đọc. Không INSERT/UPDATE/DELETE
-- dữ liệu nào, không đổi chữ ký, không đổi trigger, không đổi writer nào.
-- =====================================================================
BEGIN;

DO $preflight$
DECLARE
  v_def  text;
  v_code text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='app_private' AND p.proname='lock_org_for_decision_v1';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'Không thấy app_private.lock_org_for_decision_v1. DỪNG, không vá mù.';
  END IF;

  -- Kiểm trên CODE, không kiểm trên comment (xem ghi chú ở khối tự kiểm cuối file).
  v_code := lower(regexp_replace(v_def, '--[^\n]*', '', 'g'));

  -- Chấp nhận hai trạng thái: chưa vá (còn clause FOR SHARE) hoặc đã vá
  -- (FOR NO KEY UPDATE) — file này phải chạy lại được. Còn nếu thân hàm khoá
  -- bằng cách thứ ba nào đó thì có người đã sửa theo hướng khác: DỪNG, đọc lại.
  IF NOT (v_code ~ 'for\s+share\s*(;|$)' OR position('for no key update' IN v_code) > 0) THEN
    RAISE EXCEPTION
      'lock_org_for_decision_v1 không khoá bằng FOR SHARE lẫn FOR NO KEY UPDATE — '
      'có người đã sửa theo hướng khác. DỪNG, đọc lại thân hàm trước khi ghi đè.';
  END IF;
  -- Trigger bump phải còn đó, vì đó là nửa còn lại của chẩn đoán.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_proc pf ON pf.oid=t.tgfoid
     WHERE NOT t.tgisinternal
       AND pf.proname='bump_org_authorization_version'
       AND c.relname IN ('authorization_scopes','member_permission_overrides','member_override_scopes')
  ) THEN
    RAISE EXCEPTION
      'Không thấy trigger bump_org_authorization_version trên bảng phân quyền — chẩn đoán đã lệch. DỪNG.';
  END IF;
END
$preflight$;

-- Giữ NGUYÊN chữ ký / VOLATILE / SECURITY DEFINER / search_path / ACL
-- (postgres=X/postgres). CREATE OR REPLACE thay tại chỗ nên ACL không bị reset.
CREATE OR REPLACE FUNCTION app_private.lock_org_for_decision_v1(p_organization_id uuid)
 RETURNS bigint
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  -- Statement 1 of the writer protocol: take the org lock FIRST so the witness
  -- statement that follows runs on a snapshot taken AFTER any waiting.
  --
  -- FOR NO KEY UPDATE, *không phải* FOR SHARE (sửa 30/07/2026, deadlock 40P01):
  -- trigger a10_bump_authz_version làm `UPDATE organizations SET
  -- authorization_version = …` khi writer chạm authorization_scopes /
  -- member_permission_overrides / member_override_scopes. Nếu ở đây chỉ giữ
  -- share thì hai phiên cùng org đều phải NÂNG khoá lên độc quyền và chờ chéo
  -- nhau ⇒ deadlock (đã tái hiện: 6 worker song song đỏ 1/4). NO KEY UPDATE là
  -- đúng mode mà câu UPDATE kia cần, nên lấy sẵn từ đầu là hết phải nâng.
  -- KHÔNG dùng FOR UPDATE: mạnh quá mức và chặn luôn cả FK check (FOR KEY SHARE).
  select o.authorization_version
    from public.organizations o
   where o.id = p_organization_id
     and o.status = 'ACTIVE'
     for no key update;
$function$;

COMMENT ON FUNCTION app_private.lock_org_for_decision_v1(uuid) IS
  'Bước 1 của giao thức ghi canonical: khoá dòng organizations bằng FOR NO KEY '
  'UPDATE để mọi quyết định sau đó chạy trên snapshot lấy SAU khi đã chờ. Phải là '
  'NO KEY UPDATE chứ không phải FOR SHARE: trigger a10_bump_authz_version làm '
  'UPDATE organizations khi writer chạm bảng phân quyền, nên giữ share rồi mới xin '
  'độc quyền là bẫy nâng khoá — hai phiên cùng org chờ chéo nhau và chết 40P01 '
  '(tái hiện được với 6 phiên song song, 30/07/2026). 41 hàm gọi hàm này.';

DO $selfcheck$
DECLARE
  v_def  text;
  v_code text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='app_private' AND p.proname='lock_org_for_decision_v1';

  -- BỎ COMMENT trước khi kiểm. Lần đầu viết file này tôi tự đá vào chân mình:
  -- chú thích có câu "FOR NO KEY UPDATE, không phải FOR SHARE", nên phép kiểm
  -- "còn sót FOR SHARE?" bắt trúng chính comment và migration RAISE oan.
  -- Chỉ được kết luận trên CODE THẬT.
  v_code := lower(regexp_replace(v_def, '--[^\n]*', '', 'g'));

  IF position('for no key update' IN v_code) = 0 THEN
    RAISE EXCEPTION 'Thân hàm không chứa FOR NO KEY UPDATE — bản vá không vào. DỪNG.';
  END IF;
  -- Không được sót clause FOR SHARE (kẻo vẫn còn đường nâng khoá). Bắt theo
  -- CLAUSE (kết thúc bằng ; hoặc hết dòng), không bắt theo chuỗi rời.
  IF v_code ~ 'for\s+share\s*(;|$)' THEN
    RAISE EXCEPTION 'Thân hàm VẪN còn clause FOR SHARE. DỪNG.';
  END IF;
  -- Không được vô tình leo lên FOR UPDATE (chặn cả FK check FOR KEY SHARE).
  IF v_code ~ 'for\s+update\s*(;|$)' THEN
    RAISE EXCEPTION 'Thân hàm dùng FOR UPDATE — mạnh quá mức, chặn cả FK check. DỪNG.';
  END IF;
  -- Chữ ký / thuộc tính phải y nguyên.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='app_private' AND p.proname='lock_org_for_decision_v1'
       AND p.provolatile='v' AND p.prosecdef
       AND pg_get_function_identity_arguments(p.oid)='p_organization_id uuid'
       AND p.prorettype = 'bigint'::regtype
  ) THEN
    RAISE EXCEPTION 'Chữ ký/thuộc tính lock_org_for_decision_v1 đã lệch. DỪNG.';
  END IF;
  -- Chỉ được có MỘT overload, kẻo 41 caller gọi vào bản cũ.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='app_private' AND p.proname='lock_org_for_decision_v1') <> 1 THEN
    RAISE EXCEPTION 'lock_org_for_decision_v1 có nhiều hơn 1 overload. DỪNG.';
  END IF;
END
$selfcheck$;

COMMIT;

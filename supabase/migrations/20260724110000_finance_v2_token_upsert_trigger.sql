-- Finance V2 — Hotfix 7v: chuẩn hoá cấp token transition ở TẦNG BẢNG.
--
-- PROD (huỷ phiếu "Tesst" đã chi): set_termination_forfeit_status_v1 (bước dò
-- thanh-lý đầu flow huỷ của client) cấp token bằng INSERT TRẦN ⇒ phiếu đã có
-- row token (từ lần duyệt V2 trước) ⇒ 23505 duplicate "ie_transition_
-- authorization_pkey" ⇒ toàn flow huỷ chết ngay bước 1. 7u mới UPSERT 3 writer;
-- còn sót writer khác (forfeit, …). Fix một-lần-cho-tất-cả: trigger BEFORE
-- INSERT trên ie_transition_authorization — nếu phiếu đã có token thì UPDATE
-- xid/purpose/granted_at và nuốt INSERT (RETURN NULL). Mọi writer INSERT trần,
-- ON CONFLICT DO NOTHING hay DO UPDATE đều cho cùng kết quả: token = xid MỚI NHẤT.

BEGIN;

CREATE OR REPLACE FUNCTION app_private.ie_transition_token_upsert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private
AS $fn$
BEGIN
  UPDATE app_private.ie_transition_authorization
     SET xid = NEW.xid,
         purpose = NEW.purpose,
         granted_at = COALESCE(NEW.granted_at, now())
   WHERE income_expense_id = NEW.income_expense_id;
  IF FOUND THEN
    RETURN NULL; -- đã cập nhật row hiện có — nuốt INSERT, không 23505
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS a00_ie_transition_token_upsert
  ON app_private.ie_transition_authorization;
CREATE TRIGGER a00_ie_transition_token_upsert
  BEFORE INSERT ON app_private.ie_transition_authorization
  FOR EACH ROW EXECUTE FUNCTION app_private.ie_transition_token_upsert();

-- Smoke: INSERT trần 2 lần cùng phiếu (xid giả lập khác nhau về purpose) phải
-- SỐNG và giữ giá trị lần sau.
DO $smoke$
DECLARE v_id uuid := gen_random_uuid();
DECLARE v_purpose text;
BEGIN
  INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
  VALUES (v_id, pg_current_xact_id(), 'SMOKE_A');
  INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
  VALUES (v_id, pg_current_xact_id(), 'SMOKE_B'); -- trần, không ON CONFLICT
  SELECT purpose INTO v_purpose FROM app_private.ie_transition_authorization
  WHERE income_expense_id = v_id;
  IF v_purpose IS DISTINCT FROM 'SMOKE_B' THEN
    RAISE EXCEPTION 'token upsert smoke: purpose=% (kỳ vọng SMOKE_B)', v_purpose;
  END IF;
  DELETE FROM app_private.ie_transition_authorization WHERE income_expense_id = v_id;
  RAISE NOTICE 'token upsert trigger smoke OK';
END
$smoke$;

COMMIT;

NOTIFY pgrst, 'reload schema';

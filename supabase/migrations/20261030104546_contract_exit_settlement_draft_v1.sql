-- Quyết toán thanh lý: LƯU NHÁP ở bước quyết toán (chủ yêu cầu 30/10/2026).
-- Hồ sơ trả phòng đang Chờ quyết toán (contract_exit_cases.state='PENDING') giữ MỘT bản nháp: những gì người dùng đã điền ở
-- bước quyết toán (loại thanh lý đang chọn + lý do đổi loại, cọc hoàn, credit áp, các dòng Thu thêm / Hoàn lại khách, số điện
-- cuối ghi tay, cách thu phần thiếu, sổ nhận tiền, ghi chú). Danh sách Chờ quyết toán hiện "Mở bản nháp" bên cạnh "Quyết toán".
-- Lưu nháp KHÔNG đổi hồ sơ (state / version / current_kind giữ nguyên), không ghi tiền, không chạm hoá đơn / phiếu / chỉ số.
-- Nháp chỉ để điền lại form: quyết toán thật vẫn đi finalize_contract_exit_case_v1 với payload gửi lên, server kiểm/tính như cũ.
-- Quyết toán xong (state → FINALIZED) ⇒ trigger xoá nháp trong CÙNG giao dịch với quyết toán.
-- Quyền như nút Quyết toán: phạm vi toà của hồ sơ + contracts.terminate; ghi thêm rào người ghi hồ sơ (contracts.edit) như finalize.
-- Hai người cùng sửa: lưu/bỏ phải nêu version nháp đã đọc (NULL = chưa có nháp); lệch ⇒ PT409, giao diện hỏi ghi đè.
-- version lấy từ MỘT sequence chung, không đếm lại từ 1 theo từng nháp: bỏ nháp rồi tạo lại không bao giờ ra version cũ, nên
-- người đang mở bản cũ không ghi đè / bỏ nhầm bản mới (ABA — review chéo 30/10/2026).
-- Bảng ở app_private (PostgREST không thấy), mọi đường đọc/ghi qua 4 RPC bên dưới. Không ghi dữ liệu có sẵn. Idempotent.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $requires$
BEGIN
  IF to_regclass('public.contract_exit_cases') IS NULL OR to_regclass('public.profiles') IS NULL
    OR to_regprocedure('app_private.assert_contract_exit_scope_v1(uuid,uuid,text)') IS NULL
    OR to_regprocedure('app_private.assert_contract_exit_writer_v1(uuid,uuid)') IS NULL
    OR to_regprocedure('app_private.require_building_perm_v1(uuid,text,text[])') IS NULL
    OR to_regprocedure('public.can_do_on_building(text,text,uuid)') IS NULL OR to_regprocedure('public.can_access_building(uuid)') IS NULL
    OR to_regprocedure('public.my_org_ids()') IS NULL OR to_regprocedure('public.is_super_admin()') IS NULL
    OR to_regprocedure('public.sandbox_org_ids()') IS NULL THEN
    RAISE EXCEPTION 'contract_exit_settlement_draft_dependency_invalid'; END IF;
END $requires$;

CREATE SEQUENCE IF NOT EXISTS app_private.contract_exit_settlement_draft_version_seq;
REVOKE ALL ON SEQUENCE app_private.contract_exit_settlement_draft_version_seq FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE IF NOT EXISTS app_private.contract_exit_settlement_drafts (
  case_id uuid PRIMARY KEY REFERENCES public.contract_exit_cases(id) ON DELETE CASCADE,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=32768),
  version bigint NOT NULL CHECK (version>0),
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Bản đầu của file này đã áp TEST 30/10/2026 với DEFAULT 1 và version đếm theo từng nháp. Hai câu dưới đưa TEST về cùng
-- định nghĩa: bỏ DEFAULT, và đẩy sequence lên trên mọi version đang có (chỉ tiến, không lùi) để không bao giờ cấp lại một
-- số mà ai đó còn đang giữ. DB mới: không có default để bỏ, sequence mới tạo chỉ nhảy qua số 1.
ALTER TABLE app_private.contract_exit_settlement_drafts ALTER COLUMN version DROP DEFAULT;
SELECT setval('app_private.contract_exit_settlement_draft_version_seq',
  GREATEST(s.last_value, COALESCE((SELECT max(d.version) FROM app_private.contract_exit_settlement_drafts d), 0), 1), true)
FROM app_private.contract_exit_settlement_draft_version_seq s;
COMMENT ON TABLE app_private.contract_exit_settlement_drafts IS
  'Nháp bước quyết toán của hồ sơ trả phòng PENDING (một nháp/hồ sơ). Chỉ để điền lại form, không có hiệu lực tiền; xoá khi hồ sơ FINALIZED. version lấy từ contract_exit_settlement_draft_version_seq (không lặp lại).';
REVOKE ALL ON app_private.contract_exit_settlement_drafts FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE app_private.contract_exit_settlement_drafts ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION app_private.contract_exit_settlement_draft_response_v1(p_case uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT jsonb_build_object('case_id',d.case_id,'case_version',c.version,'version',d.version,'payload',d.payload,
    'created_at',d.created_at,'created_by',d.created_by,'updated_at',d.updated_at,'updated_by',d.updated_by,
    'updated_by_name',(SELECT p.full_name FROM public.profiles p WHERE p.id=d.updated_by))
  FROM app_private.contract_exit_settlement_drafts d JOIN public.contract_exit_cases c ON c.id=d.case_id WHERE d.case_id=p_case
$fn$;

-- Đọc nháp của MỘT hồ sơ. Hồ sơ đã quyết toán hoặc chưa có nháp ⇒ NULL.
CREATE OR REPLACE FUNCTION public.get_contract_exit_settlement_draft_v1(p_organization_id uuid,p_case_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE e public.contract_exit_cases%ROWTYPE;
BEGIN
  SELECT * INTO e FROM public.contract_exit_cases WHERE id=p_case_id AND organization_id=p_organization_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Exit case not found' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_contract_exit_scope_v1(e.organization_id,e.building_id,'view');
  PERFORM app_private.require_building_perm_v1(e.building_id,'xem nháp quyết toán thanh lý','contracts.terminate');
  IF e.state<>'PENDING' THEN RETURN NULL; END IF;
  RETURN app_private.contract_exit_settlement_draft_response_v1(e.id);
END $fn$;

-- Dấu "Có nháp" cho danh sách Chờ quyết toán: chỉ trả hồ sơ PENDING người gọi xem được VÀ quyết toán được; hồ sơ khác bỏ qua
-- (danh sách, không ném). Không trả payload.
CREATE OR REPLACE FUNCTION public.list_contract_exit_settlement_drafts_v1(p_organization_id uuid,p_case_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Organization is outside the readable scope' USING ERRCODE='42501'; END IF;
  IF p_case_ids IS NULL OR COALESCE(cardinality(p_case_ids),0)>100 THEN RAISE EXCEPTION 'Invalid draft lookup' USING ERRCODE='22023'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('case_id',d.case_id,'version',d.version,'updated_at',d.updated_at,
      'updated_by',d.updated_by,'updated_by_name',(SELECT p.full_name FROM public.profiles p WHERE p.id=d.updated_by)) ORDER BY d.case_id)
    FROM app_private.contract_exit_settlement_drafts d JOIN public.contract_exit_cases c ON c.id=d.case_id
    WHERE d.case_id=ANY(p_case_ids) AND c.organization_id=p_organization_id AND c.state='PENDING'
      AND COALESCE(public.can_access_building(c.building_id),false)
      AND COALESCE(public.can_do_on_building('contracts','view',c.building_id),false)
      AND COALESCE(public.can_do_on_building('contracts','terminate',c.building_id),false)
      AND NOT (COALESCE(public.is_super_admin(),false) AND COALESCE(c.organization_id=ANY(public.sandbox_org_ids()),false))),'[]'::jsonb);
END $fn$;

-- Lưu nháp. p_expected_version NULL = tạo mới (đã có nháp ⇒ PT409); có số = ghi đè đúng version đó (lệch ⇒ PT409).
-- FOR SHARE hồ sơ: chờ quyết toán đang chạy (FOR UPDATE) xong rồi mới đọc state ⇒ không lưu nháp vào hồ sơ vừa quyết toán.
CREATE OR REPLACE FUNCTION public.save_contract_exit_settlement_draft_v1(p_organization_id uuid,p_case_id uuid,p_expected_version bigint,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE e public.contract_exit_cases%ROWTYPE;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR octet_length(p_payload::text)>32768
    OR (p_expected_version IS NOT NULL AND p_expected_version<1) THEN
    RAISE EXCEPTION 'Invalid settlement draft' USING ERRCODE='22023'; END IF;
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Organization is outside the writable scope' USING ERRCODE='42501'; END IF;
  SELECT * INTO e FROM public.contract_exit_cases WHERE id=p_case_id AND organization_id=p_organization_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Exit case not found' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_contract_exit_writer_v1(e.organization_id,e.building_id);
  PERFORM app_private.require_building_perm_v1(e.building_id,'lưu nháp quyết toán thanh lý','contracts.terminate');
  IF e.state<>'PENDING' THEN RAISE EXCEPTION 'Exit case is already finalized' USING ERRCODE='PT409'; END IF;
  IF p_expected_version IS NULL THEN
    INSERT INTO app_private.contract_exit_settlement_drafts(case_id,payload,version,created_by,updated_by)
      VALUES(e.id,p_payload,nextval('app_private.contract_exit_settlement_draft_version_seq'),auth.uid(),auth.uid())
      ON CONFLICT (case_id) DO NOTHING;
  ELSE
    UPDATE app_private.contract_exit_settlement_drafts SET payload=p_payload,version=nextval('app_private.contract_exit_settlement_draft_version_seq'),
      updated_by=auth.uid(),updated_at=clock_timestamp()
      WHERE case_id=e.id AND version=p_expected_version;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Settlement draft changed; reload' USING ERRCODE='PT409'; END IF;
  RETURN app_private.contract_exit_settlement_draft_response_v1(e.id);
END $fn$;

-- Bỏ nháp đúng version đã đọc. Nháp đã không còn (người khác bỏ / đã quyết toán) ⇒ coi như xong; còn mà lệch version ⇒ PT409.
CREATE OR REPLACE FUNCTION public.discard_contract_exit_settlement_draft_v1(p_organization_id uuid,p_case_id uuid,p_expected_version bigint)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE e public.contract_exit_cases%ROWTYPE;
BEGIN
  IF p_expected_version IS NULL OR p_expected_version<1 THEN RAISE EXCEPTION 'Invalid settlement draft' USING ERRCODE='22023'; END IF;
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Organization is outside the writable scope' USING ERRCODE='42501'; END IF;
  SELECT * INTO e FROM public.contract_exit_cases WHERE id=p_case_id AND organization_id=p_organization_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Exit case not found' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_contract_exit_writer_v1(e.organization_id,e.building_id);
  PERFORM app_private.require_building_perm_v1(e.building_id,'bỏ nháp quyết toán thanh lý','contracts.terminate');
  DELETE FROM app_private.contract_exit_settlement_drafts WHERE case_id=e.id AND version=p_expected_version;
  IF NOT FOUND AND EXISTS(SELECT 1 FROM app_private.contract_exit_settlement_drafts WHERE case_id=e.id) THEN
    RAISE EXCEPTION 'Settlement draft changed; reload' USING ERRCODE='PT409'; END IF;
  RETURN jsonb_build_object('case_id',e.id,'discarded',true);
END $fn$;

-- Quyết toán xong thì nháp hết giá trị: xoá trong cùng giao dịch với UPDATE state='FINALIZED' của finalize.
CREATE OR REPLACE FUNCTION app_private.clear_contract_exit_settlement_draft_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  DELETE FROM app_private.contract_exit_settlement_drafts WHERE case_id=NEW.id;
  RETURN NULL;
END $fn$;
DROP TRIGGER IF EXISTS clear_contract_exit_settlement_draft ON public.contract_exit_cases;
CREATE TRIGGER clear_contract_exit_settlement_draft AFTER UPDATE OF state ON public.contract_exit_cases
  FOR EACH ROW WHEN (NEW.state='FINALIZED' AND OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION app_private.clear_contract_exit_settlement_draft_v1();

REVOKE ALL ON FUNCTION app_private.contract_exit_settlement_draft_response_v1(uuid),app_private.clear_contract_exit_settlement_draft_v1()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.get_contract_exit_settlement_draft_v1(uuid,uuid),public.list_contract_exit_settlement_drafts_v1(uuid,uuid[]),
  public.save_contract_exit_settlement_draft_v1(uuid,uuid,bigint,jsonb),public.discard_contract_exit_settlement_draft_v1(uuid,uuid,bigint)
  FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.get_contract_exit_settlement_draft_v1(uuid,uuid),public.list_contract_exit_settlement_drafts_v1(uuid,uuid[]),
  public.save_contract_exit_settlement_draft_v1(uuid,uuid,bigint,jsonb),public.discard_contract_exit_settlement_draft_v1(uuid,uuid,bigint)
  TO authenticated;

DO $assert$
DECLARE v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.get_contract_exit_settlement_draft_v1(uuid,uuid)','public.list_contract_exit_settlement_drafts_v1(uuid,uuid[])',
    'public.save_contract_exit_settlement_draft_v1(uuid,uuid,bigint,jsonb)','public.discard_contract_exit_settlement_draft_v1(uuid,uuid,bigint)'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=v_fn::regprocedure AND p.prosecdef
        AND replace(COALESCE(array_to_string(p.proconfig,','),''),' ','')='search_path=pg_catalog,public,app_private')
      OR NOT has_function_privilege('authenticated',v_fn,'EXECUTE')
      OR has_function_privilege('anon',v_fn,'EXECUTE') THEN
      RAISE EXCEPTION 'contract_exit_settlement_draft_contract_violated: %',v_fn; END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY['app_private.contract_exit_settlement_draft_response_v1(uuid)','app_private.clear_contract_exit_settlement_draft_v1()'] LOOP
    IF has_function_privilege('authenticated',v_fn,'EXECUTE') OR has_function_privilege('anon',v_fn,'EXECUTE') THEN
      RAISE EXCEPTION 'contract_exit_settlement_draft_contract_violated: %',v_fn; END IF;
  END LOOP;
  IF has_table_privilege('authenticated','app_private.contract_exit_settlement_drafts','SELECT')
    OR has_table_privilege('anon','app_private.contract_exit_settlement_drafts','SELECT')
    OR has_sequence_privilege('authenticated','app_private.contract_exit_settlement_draft_version_seq','USAGE, SELECT, UPDATE')
    OR has_sequence_privilege('anon','app_private.contract_exit_settlement_draft_version_seq','USAGE, SELECT, UPDATE')
    OR has_sequence_privilege('service_role','app_private.contract_exit_settlement_draft_version_seq','USAGE, SELECT, UPDATE')
    OR (SELECT s.last_value FROM app_private.contract_exit_settlement_draft_version_seq s)
      < COALESCE((SELECT max(d.version) FROM app_private.contract_exit_settlement_drafts d), 0)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_attrdef d JOIN pg_catalog.pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
      WHERE d.adrelid='app_private.contract_exit_settlement_drafts'::regclass AND a.attname='version')
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid='public.contract_exit_cases'::regclass
      AND t.tgname='clear_contract_exit_settlement_draft' AND t.tgenabled<>'D'
      AND t.tgfoid='app_private.clear_contract_exit_settlement_draft_v1()'::regprocedure) THEN
    RAISE EXCEPTION 'contract_exit_settlement_draft_contract_violated: table/trigger'; END IF;
END $assert$;
COMMIT;
NOTIFY pgrst,'reload schema';

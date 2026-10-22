-- Direct scoped sale metadata and timed room campaigns. No approval queue,
-- financial permission grant, role scope expansion, or legacy-note backfill.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

INSERT INTO public.permission_definitions(key,resource,action,sensitivity,permission_domain,scope_kinds,is_active)
VALUES('sale_phong.edit','sale_phong','edit','MANAGE','TENANT',ARRAY['ORGANIZATION','AREA','BUILDING'],true)
ON CONFLICT(key) DO UPDATE SET scope_kinds=excluded.scope_kinds;

-- A durable one-time marker prevents replay from restoring a subsequently
-- deleted grant. Explicit role DENY and all member overrides remain intact.
CREATE TABLE IF NOT EXISTS app_private.sale_info_default_grants_v1(
 source text NOT NULL CHECK(source IN ('canonical','legacy')),role_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(source,role_id)
);
ALTER TABLE app_private.sale_info_default_grants_v1 OWNER TO postgres;
ALTER TABLE app_private.sale_info_default_grants_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.sale_info_default_grants_v1 FROM PUBLIC,anon,authenticated,service_role;
WITH fresh AS (
 INSERT INTO app_private.sale_info_default_grants_v1(source,role_id)
 SELECT 'canonical',r.id FROM public.organization_roles r
 WHERE r.system_key='TENANT_OWNER' OR lower(btrim(r.name))=ANY(ARRAY[
  'chủ sở hữu tổ chức','chủ công ty','chủ trọ','quản lý tòa','sale admin','sale'])
 ON CONFLICT DO NOTHING RETURNING role_id
)
INSERT INTO public.role_permissions(organization_id,role_id,permission_key,effect)
SELECT r.organization_id,r.id,'sale_phong.edit','ALLOW' FROM public.organization_roles r JOIN fresh f ON f.role_id=r.id
ON CONFLICT(organization_id,role_id,permission_key) DO NOTHING;
WITH fresh AS (
 INSERT INTO app_private.sale_info_default_grants_v1(source,role_id)
 SELECT 'legacy',r.id FROM public.roles r WHERE lower(btrim(r.name))=ANY(ARRAY[
  'chủ sở hữu tổ chức','chủ công ty','chủ trọ','quản lý tòa','sale admin','sale'])
 ON CONFLICT DO NOTHING RETURNING role_id
)
UPDATE public.roles r SET permissions=(CASE WHEN jsonb_typeof(r.permissions)='object' THEN r.permissions ELSE '{}'::jsonb END)||jsonb_build_object(
 'sale_phong',(CASE WHEN jsonb_typeof(r.permissions->'sale_phong')='object' THEN r.permissions->'sale_phong' ELSE '{}'::jsonb END)||jsonb_build_object('edit',true))
FROM fresh f WHERE f.role_id=r.id;

CREATE TABLE IF NOT EXISTS app_private.room_sale_policies_v1(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES public.organizations(id),
 room_id uuid NOT NULL REFERENCES public.rooms(id),building_id uuid NOT NULL REFERENCES public.buildings(id),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),title text NOT NULL CHECK(char_length(btrim(title)) BETWEEN 1 AND 120),
 content text NOT NULL CHECK(char_length(btrim(content)) BETWEEN 1 AND 2000),
 starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,
 created_by uuid NOT NULL REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 cancelled_by uuid REFERENCES auth.users(id),cancelled_at timestamptz,cancel_reason text,
 CHECK(isfinite(starts_at) AND isfinite(ends_at) AND starts_at<ends_at),
 CHECK((cancelled_at IS NULL AND cancelled_by IS NULL AND cancel_reason IS NULL) OR
       (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND char_length(btrim(cancel_reason)) BETWEEN 1 AND 500))
);
CREATE INDEX IF NOT EXISTS room_sale_policies_room_window_v1 ON app_private.room_sale_policies_v1(organization_id,room_id,starts_at,ends_at) WHERE cancelled_at IS NULL;
ALTER TABLE app_private.room_sale_policies_v1 OWNER TO postgres;
ALTER TABLE app_private.room_sale_policies_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.room_sale_policies_v1 FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE IF NOT EXISTS app_private.room_sale_policy_receipts_v1(
 organization_id uuid NOT NULL REFERENCES public.organizations(id),actor_id uuid NOT NULL REFERENCES auth.users(id),
 request_id uuid NOT NULL,room_id uuid NOT NULL REFERENCES public.rooms(id),policy_id uuid NOT NULL REFERENCES app_private.room_sale_policies_v1(id),
 operation text NOT NULL CHECK(operation IN ('SAVE','CANCEL')),payload_hash text NOT NULL,response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(organization_id,actor_id,request_id)
);
ALTER TABLE app_private.room_sale_policy_receipts_v1 OWNER TO postgres;
ALTER TABLE app_private.room_sale_policy_receipts_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.room_sale_policy_receipts_v1 FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.sale_room_can_edit_v1(p_org uuid,p_building uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
 SELECT app_private.sale_room_can_v1(p_org,p_building,'rooms.edit') OR app_private.sale_room_can_v1(p_org,p_building,'sale_phong.edit')
$fn$;
CREATE OR REPLACE FUNCTION app_private.sale_room_authorize_edit_v1(p_org uuid,p_building uuid)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
 SELECT EXISTS(SELECT 1 FROM app_private.authorize_tenant_action_v3(auth.uid(),p_org,'rooms.edit',p_building,NULL) a WHERE a.allowed)
 OR EXISTS(SELECT 1 FROM app_private.authorize_tenant_action_v3(auth.uid(),p_org,'sale_phong.edit',p_building,NULL) a WHERE a.allowed)
$fn$;
CREATE OR REPLACE FUNCTION app_private.sale_room_fact_key_v1(p_room uuid,p_org uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
 SELECT md5(format('%s|%s|%s|%s|%s|%s',f.status_public,f.sale_state,to_char(f.avail_date,'YYYY-MM-DD'),
  to_char(f.expected_ready_on,'YYYY-MM-DD'),CASE WHEN f.status_public='pass' THEN pl.id END,
  CASE WHEN f.status_public='pass' THEN to_char(pl.avail_date,'YYYY-MM-DD') END))
 FROM public.rooms r JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=r.organization_id
 LEFT JOIN public.public_room_settings s ON s.owner_id=b.user_id
 LEFT JOIN public.room_pass_listings pl ON pl.room_id=r.id AND pl.organization_id=r.organization_id AND pl.active
 CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(r.id,r.organization_id,r.status::text,pl.id IS NOT NULL,COALESCE(s.soon_days,30)) f
 WHERE r.id=p_room AND r.organization_id=p_org AND r.deleted_at IS NULL AND b.deleted_at IS NULL
$fn$;
CREATE OR REPLACE FUNCTION app_private.room_sale_policy_json_v1(p app_private.room_sale_policies_v1,p_at timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $fn$
 SELECT jsonb_build_object('id',p.id,'version',p.version,'title',p.title,'content',p.content,'starts_at',p.starts_at,'ends_at',p.ends_at,
 'status',CASE WHEN p.cancelled_at IS NOT NULL THEN 'CANCELLED' WHEN p_at<p.starts_at THEN 'SCHEDULED' WHEN p_at>=p.ends_at THEN 'EXPIRED' ELSE 'ACTIVE' END)
$fn$;
CREATE OR REPLACE FUNCTION app_private.room_sale_policy_current_v1(p_org uuid,p_room uuid,p_at timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
 SELECT app_private.room_sale_policy_json_v1(p,p_at) FROM app_private.room_sale_policies_v1 p
 WHERE p.organization_id=p_org AND p.room_id=p_room
 ORDER BY CASE WHEN p.cancelled_at IS NULL AND p.starts_at<=p_at AND p.ends_at>p_at THEN 0
  WHEN p.cancelled_at IS NULL AND p.starts_at>p_at THEN 1 ELSE 2 END,
  CASE WHEN p.cancelled_at IS NULL AND p.starts_at>p_at THEN p.starts_at END ASC,
  p.created_at DESC,p.id DESC LIMIT 1
$fn$;
CREATE OR REPLACE FUNCTION app_private.room_sale_policy_active_text_v1(p_org uuid,p_room uuid,p_at timestamptz)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
 SELECT p.content FROM app_private.room_sale_policies_v1 p
 WHERE p.organization_id=p_org AND p.room_id=p_room AND p.cancelled_at IS NULL AND p.starts_at<=p_at AND p.ends_at>p_at
 ORDER BY p.starts_at,p.id LIMIT 1
$fn$;

CREATE OR REPLACE FUNCTION public.save_room_sale_policy_v1(p_organization_id uuid,p_room_id uuid,p_expected_revision text,p_request_id uuid,p_policy jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE r public.rooms%ROWTYPE;p app_private.room_sale_policies_v1%ROWTYPE;old app_private.room_sale_policy_receipts_v1%ROWTYPE;
 starts timestamptz;ends timestamptz;at_time timestamptz;request_hash text;result jsonb;
BEGIN
 IF p_organization_id IS NULL OR p_room_id IS NULL OR p_request_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision !~ '^[0-9a-f]{32}$'
  OR jsonb_typeof(p_policy) IS DISTINCT FROM 'object' OR NOT(p_policy ?& ARRAY['title','content','starts_at','ends_at'])
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_policy) k WHERE k NOT IN ('title','content','starts_at','ends_at'))
  THEN RAISE EXCEPTION 'Thiếu phòng, phiên bản hoặc chính sách' USING ERRCODE='22023';END IF;
 IF jsonb_typeof(p_policy->'title') IS DISTINCT FROM 'string' OR char_length(btrim(p_policy->>'title')) NOT BETWEEN 1 AND 120
  OR jsonb_typeof(p_policy->'content') IS DISTINCT FROM 'string' OR char_length(btrim(p_policy->>'content')) NOT BETWEEN 1 AND 2000
  OR jsonb_typeof(p_policy->'starts_at') IS DISTINCT FROM 'string' OR jsonb_typeof(p_policy->'ends_at') IS DISTINCT FROM 'string'
  OR p_policy->>'starts_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
  OR p_policy->>'ends_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
  THEN RAISE EXCEPTION 'Nội dung hoặc thời hạn chính sách không hợp lệ' USING ERRCODE='22023';END IF;
 BEGIN starts:=(p_policy->>'starts_at')::timestamptz;ends:=(p_policy->>'ends_at')::timestamptz;
 EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RAISE EXCEPTION 'Thời hạn chính sách không hợp lệ' USING ERRCODE='22023';END;
 IF NOT isfinite(starts) OR NOT isfinite(ends) OR starts>=ends THEN RAISE EXCEPTION 'Thời điểm kết thúc phải sau bắt đầu' USING ERRCODE='22023';END IF;
 SELECT * INTO r FROM public.rooms WHERE id=p_room_id AND organization_id=p_organization_id AND deleted_at IS NULL;
 IF NOT FOUND OR NOT app_private.sale_room_can_edit_v1(p_organization_id,r.building_id) THEN RAISE EXCEPTION 'Không có quyền cập nhật sale tại tòa này' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM public.rooms WHERE id=p_room_id AND organization_id=p_organization_id AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Phòng đã thay đổi' USING ERRCODE='PT409';END IF;
 PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
 IF NOT app_private.sale_room_authorize_edit_v1(p_organization_id,r.building_id) OR NOT COALESCE(public.can_access_building(r.building_id),false)
  OR NOT EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=r.building_id AND b.organization_id=r.organization_id AND b.deleted_at IS NULL AND NOT b.is_virtual)
  THEN RAISE EXCEPTION 'Quyền hoặc phạm vi phòng đã thay đổi' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_organization_id::text||auth.uid()::text||p_request_id::text,0));
 request_hash:=md5(jsonb_build_object('operation','SAVE','room_id',p_room_id,'revision',p_expected_revision,'policy',p_policy)::text);
 SELECT * INTO old FROM app_private.room_sale_policy_receipts_v1 WHERE organization_id=p_organization_id AND actor_id=auth.uid() AND request_id=p_request_id;
 IF FOUND THEN IF old.payload_hash<>request_hash THEN RAISE EXCEPTION 'Mã yêu cầu đã dùng cho nội dung khác' USING ERRCODE='22023';END IF;RETURN old.response;END IF;
 IF md5(to_jsonb(r)::text)<>p_expected_revision THEN RAISE EXCEPTION 'Thông tin phòng đã thay đổi' USING ERRCODE='PT409';END IF;
 at_time:=clock_timestamp();
 IF ends<=at_time THEN RAISE EXCEPTION 'Chính sách đã hết thời hạn' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM app_private.room_sale_policies_v1 x WHERE x.organization_id=p_organization_id AND x.room_id=p_room_id AND x.cancelled_at IS NULL AND x.ends_at>at_time
  AND x.starts_at<ends AND starts<x.ends_at) THEN RAISE EXCEPTION 'Phòng đã có chính sách trùng thời gian; ngưng chính sách cũ trước' USING ERRCODE='PT409';END IF;
 INSERT INTO app_private.room_sale_policies_v1(organization_id,room_id,building_id,title,content,starts_at,ends_at,created_by)
 VALUES(p_organization_id,p_room_id,r.building_id,btrim(p_policy->>'title'),btrim(p_policy->>'content'),starts,ends,auth.uid()) RETURNING * INTO p;
 UPDATE public.rooms SET updated_at=clock_timestamp() WHERE id=r.id AND organization_id=r.organization_id RETURNING * INTO r;
 result:=jsonb_build_object('request_id',p_request_id,'room_id',r.id,'building_id',r.building_id,'revision',md5(to_jsonb(r)::text),
  'policy',app_private.room_sale_policy_json_v1(p,at_time));
 INSERT INTO app_private.room_sale_policy_receipts_v1(organization_id,actor_id,request_id,room_id,policy_id,operation,payload_hash,response)
 VALUES(p_organization_id,auth.uid(),p_request_id,r.id,p.id,'SAVE',request_hash,result);
 RETURN result;
END $fn$;

CREATE OR REPLACE FUNCTION public.cancel_room_sale_policy_v1(p_organization_id uuid,p_policy_id uuid,p_expected_version bigint,p_request_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE r public.rooms%ROWTYPE;p app_private.room_sale_policies_v1%ROWTYPE;old app_private.room_sale_policy_receipts_v1%ROWTYPE;request_hash text;result jsonb;
BEGIN
 IF p_organization_id IS NULL OR p_policy_id IS NULL OR p_request_id IS NULL OR p_expected_version IS NULL OR p_expected_version<1
  OR p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Thiếu phiên bản hoặc lý do ngưng chính sách' USING ERRCODE='22023';END IF;
 SELECT * INTO p FROM app_private.room_sale_policies_v1 WHERE id=p_policy_id AND organization_id=p_organization_id;
 IF NOT FOUND OR NOT app_private.sale_room_can_edit_v1(p_organization_id,p.building_id) THEN RAISE EXCEPTION 'Không có quyền ngưng chính sách này' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM public.rooms WHERE id=p.room_id AND organization_id=p_organization_id AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Phòng đã thay đổi' USING ERRCODE='PT409';END IF;
 PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
 IF r.building_id IS DISTINCT FROM p.building_id OR NOT app_private.sale_room_authorize_edit_v1(p_organization_id,r.building_id)
  OR NOT COALESCE(public.can_access_building(r.building_id),false)
  OR NOT EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=r.building_id AND b.organization_id=r.organization_id AND b.deleted_at IS NULL AND NOT b.is_virtual)
  THEN RAISE EXCEPTION 'Quyền hoặc phạm vi phòng đã thay đổi' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_organization_id::text||auth.uid()::text||p_request_id::text,0));
 request_hash:=md5(jsonb_build_object('operation','CANCEL','policy_id',p_policy_id,'version',p_expected_version,'reason',p_reason)::text);
 SELECT * INTO old FROM app_private.room_sale_policy_receipts_v1 WHERE organization_id=p_organization_id AND actor_id=auth.uid() AND request_id=p_request_id;
 IF FOUND THEN IF old.payload_hash<>request_hash THEN RAISE EXCEPTION 'Mã yêu cầu đã dùng cho nội dung khác' USING ERRCODE='22023';END IF;RETURN old.response;END IF;
 SELECT * INTO p FROM app_private.room_sale_policies_v1 WHERE id=p_policy_id AND organization_id=p_organization_id FOR UPDATE;
 IF p.version<>p_expected_version OR p.cancelled_at IS NOT NULL THEN RAISE EXCEPTION 'Chính sách đã thay đổi' USING ERRCODE='PT409';END IF;
 UPDATE app_private.room_sale_policies_v1 SET cancelled_at=clock_timestamp(),cancelled_by=auth.uid(),cancel_reason=btrim(p_reason),version=version+1 WHERE id=p.id RETURNING * INTO p;
 UPDATE public.rooms SET updated_at=clock_timestamp() WHERE id=r.id AND organization_id=r.organization_id RETURNING * INTO r;
 result:=jsonb_build_object('request_id',p_request_id,'room_id',r.id,'building_id',r.building_id,'revision',md5(to_jsonb(r)::text),
  'policy',app_private.room_sale_policy_json_v1(p,clock_timestamp()));
 INSERT INTO app_private.room_sale_policy_receipts_v1(organization_id,actor_id,request_id,room_id,policy_id,operation,payload_hash,response)
 VALUES(p_organization_id,auth.uid(),p_request_id,r.id,p.id,'CANCEL',request_hash,result);
 RETURN result;
END $fn$;

-- Called only after the existing public/in-app reader has applied its visibility
-- contract. Add campaign text solely to rooms already admitted by that reader.
CREATE OR REPLACE FUNCTION app_private.room_sale_policy_overlay_v1(p_payload jsonb)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
 SELECT CASE WHEN p_payload IS NULL THEN NULL ELSE p_payload||jsonb_build_object('server_now',statement_timestamp(),
  'rooms',COALESCE((SELECT jsonb_agg(item||jsonb_build_object(
    'sale_note_base',item->'sale_note','active_policy_text',active.txt,
    'active_policy_ends_at',CASE WHEN active.txt IS NOT NULL THEN active.ends_at END,
    'sale_note',CASE WHEN active.txt IS NULL THEN item->>'sale_note'
      ELSE concat_ws(E'\n',NULLIF(btrim(item->>'sale_note'),''),active.txt) END) ORDER BY ord)
   FROM jsonb_array_elements(p_payload->'rooms') WITH ORDINALITY e(item,ord)
   JOIN public.rooms r ON r.id=(item->>'id')::uuid AND r.building_id=(item->>'building_id')::uuid
   CROSS JOIN LATERAL (SELECT app_private.room_sale_policy_active_text_v1(r.organization_id,r.id,statement_timestamp()) txt,
    app_private.room_sale_policy_current_v1(r.organization_id,r.id,statement_timestamp())->>'ends_at' ends_at) active),'[]'::jsonb),
  'next_policy_boundary_at',(SELECT min(boundary) FROM jsonb_array_elements(p_payload->'rooms') e(item)
   JOIN public.rooms r ON r.id=(item->>'id')::uuid AND r.building_id=(item->>'building_id')::uuid
   JOIN app_private.room_sale_policies_v1 p ON p.room_id=r.id AND p.organization_id=r.organization_id AND p.cancelled_at IS NULL
   CROSS JOIN LATERAL (VALUES(p.starts_at),(p.ends_at)) v(boundary) WHERE boundary>statement_timestamp())) END
$fn$;

-- Forward replacement: preserve validation, auth/replay order and row CAS.
CREATE OR REPLACE FUNCTION public.update_room_sale_info_v1(
  p_organization_id uuid, p_room_id uuid, p_expected_revision text,
  p_request_id uuid, p_patch jsonb
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  original public.rooms%ROWTYPE;
  changed public.rooms%ROWTYPE;
  key text;
  element jsonb;
  field_value jsonb;
  images_only boolean;
  edit_allowed boolean;
  image_allowed boolean;
  request_hash text;
  old_receipt app_private.sale_room_change_receipts%ROWTYPE;
  result jsonb;
  before_patch jsonb;
BEGIN
  IF p_room_id IS NULL OR p_request_id IS NULL OR p_organization_id IS NULL
    OR p_expected_revision IS NULL OR p_expected_revision !~ '^[0-9a-f]{32}$'
    OR p_patch IS NULL OR jsonb_typeof(p_patch)<>'object' OR p_patch='{}'::jsonb THEN
    RAISE EXCEPTION 'Thiếu phòng, phiên bản hoặc nội dung cập nhật' USING ERRCODE='22023';
  END IF;
  FOR key,field_value IN SELECT * FROM jsonb_each(p_patch) LOOP
    IF key NOT IN ('rent_price','area','room_type','amenities','sale_note','sale_bonus_note','images','description','sale_status_note','sale_status_note_key') THEN
      RAISE EXCEPTION 'Trường không được cập nhật từ Sale Phòng: %',key USING ERRCODE='22023';
    END IF;
    IF key='rent_price' THEN
      IF jsonb_typeof(field_value)<>'number' OR (field_value::text)::numeric<0
        OR (field_value::text)::numeric>9999999999999
        OR trunc((field_value::text)::numeric)<>(field_value::text)::numeric THEN
        RAISE EXCEPTION 'Giá phải là số nguyên VND không âm' USING ERRCODE='22023';
      END IF;
    ELSIF key='area' AND field_value<>'null'::jsonb THEN
      IF jsonb_typeof(field_value)<>'number' OR (field_value::text)::numeric<0
        OR (field_value::text)::numeric>1000000
        OR round((field_value::text)::numeric,2)<>(field_value::text)::numeric THEN
        RAISE EXCEPTION 'Diện tích không hợp lệ' USING ERRCODE='22023';
      END IF;
    ELSIF key IN ('room_type','sale_note','sale_bonus_note','description','sale_status_note','sale_status_note_key') AND field_value<>'null'::jsonb THEN
      IF jsonb_typeof(field_value)<>'string'
        OR length(p_patch->>key)>(CASE WHEN key='room_type' THEN 200 WHEN key='sale_status_note' THEN 120 WHEN key='sale_status_note_key' THEN 32 ELSE 2000 END) THEN
        RAISE EXCEPTION 'Nội dung trường % không hợp lệ',key USING ERRCODE='22023';
      END IF;
    ELSIF key IN ('amenities','images') THEN
      IF jsonb_typeof(field_value)<>'array' OR jsonb_array_length(field_value)>50 THEN
        RAISE EXCEPTION 'Danh sách % không hợp lệ',key USING ERRCODE='22023';
      END IF;
      FOR element IN SELECT * FROM jsonb_array_elements(field_value) LOOP
        IF jsonb_typeof(element)<>'string' OR length(btrim(element#>>'{}'))=0
          OR length(element#>>'{}')>(CASE WHEN key='images' THEN 2048 ELSE 200 END) THEN
          RAISE EXCEPTION 'Phần tử % không hợp lệ',key USING ERRCODE='22023';
        END IF;
        IF key='images' AND (
          element#>>'{}' ~ '[[:cntrl:]]'
          OR element#>>'{}' ~ '^(blob:|data:|javascript:|file:|http:)'
          OR element#>>'{}' ~ '^//'
          OR (element#>>'{}' ~ ':' AND element#>>'{}' !~ '^https://[^/@[:space:]]+(/|$)')
          OR element#>>'{}' ~ '(^|/)\.\.(/|$)'
        ) THEN
          RAISE EXCEPTION 'Ảnh phải là đường dẫn kho hoặc HTTPS hợp lệ' USING ERRCODE='22023';
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  IF (p_patch?'sale_status_note') IS DISTINCT FROM (p_patch?'sale_status_note_key')
    OR (p_patch?'sale_status_note' AND (
      (p_patch->'sale_status_note'='null'::jsonb) IS DISTINCT FROM (p_patch->'sale_status_note_key'='null'::jsonb)
      OR (p_patch->'sale_status_note_key'<>'null'::jsonb AND p_patch->>'sale_status_note_key' !~ '^[0-9a-f]{32}$'))) THEN
    RAISE EXCEPTION 'Tình trạng gõ tay phải đi cùng phiên bản tình trạng hiện tại' USING ERRCODE='22023';
  END IF;
  SELECT r.* INTO original
    FROM public.rooms r JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=r.organization_id
    WHERE r.id=p_room_id AND r.organization_id=p_organization_id
      AND r.deleted_at IS NULL AND b.deleted_at IS NULL AND NOT b.is_virtual;
  IF NOT FOUND OR auth.uid() IS NULL
    OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false)
    OR NOT COALESCE(public.can_access_building(original.building_id),false) THEN
    RAISE EXCEPTION 'Không có quyền cập nhật phòng trong tổ chức/tòa này' USING ERRCODE='42501';
  END IF;
  images_only := p_patch - 'images' = '{}'::jsonb;
  IF NOT app_private.sale_room_can_edit_v1(p_organization_id,original.building_id)
    AND NOT (images_only AND app_private.sale_room_can_v1(p_organization_id,original.building_id,'sale_phong.manage_images')) THEN
    RAISE EXCEPTION 'Không có quyền cập nhật thông tin phòng' USING ERRCODE='42501';
  END IF;
  -- Preserve the room -> organization order of the reservation/lock writers.
  SELECT * INTO original FROM public.rooms
    WHERE id=p_room_id AND organization_id=p_organization_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Phòng đã thay đổi' USING ERRCODE='PT409'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  IF NOT EXISTS (SELECT 1 FROM public.buildings WHERE id=original.building_id
      AND organization_id=p_organization_id AND deleted_at IS NULL AND NOT is_virtual)
    OR NOT COALESCE(public.can_access_building(original.building_id),false) THEN
    RAISE EXCEPTION 'Phạm vi phòng đã thay đổi' USING ERRCODE='42501';
  END IF;
  edit_allowed:=app_private.sale_room_authorize_edit_v1(p_organization_id,original.building_id);
  IF NOT COALESCE(edit_allowed,false) AND images_only THEN
    SELECT COALESCE(a.allowed,false) INTO image_allowed
      FROM app_private.authorize_tenant_action_v3(auth.uid(),p_organization_id,'sale_phong.manage_images',original.building_id,NULL) a;
  END IF;
  IF NOT COALESCE(edit_allowed,false) AND NOT COALESCE(image_allowed,false) THEN
    RAISE EXCEPTION 'Quyền cập nhật phòng đã thay đổi' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_organization_id::text||auth.uid()::text||p_request_id::text,0));
  request_hash := md5(jsonb_build_object('room_id',p_room_id,'revision',p_expected_revision,'patch',p_patch)::text);
  SELECT * INTO old_receipt FROM app_private.sale_room_change_receipts
    WHERE organization_id=p_organization_id AND actor_id=auth.uid() AND request_id=p_request_id;
  IF FOUND THEN
    IF old_receipt.payload_hash<>request_hash THEN
      RAISE EXCEPTION 'Mã yêu cầu đã dùng cho nội dung khác' USING ERRCODE='22023';
    END IF;
    RETURN old_receipt.response;
  END IF;
  IF md5(to_jsonb(original)::text)<>p_expected_revision THEN
    RAISE EXCEPTION 'Thông tin phòng đã thay đổi. Tải lại để đối chiếu.' USING ERRCODE='PT409';
  END IF;
  IF p_patch?'sale_status_note' AND p_patch->'sale_status_note'<>'null'::jsonb
    AND (p_patch->>'sale_status_note_key') IS DISTINCT FROM app_private.sale_room_fact_key_v1(p_room_id,p_organization_id) THEN
    RAISE EXCEPTION 'Tình trạng phòng đã thay đổi; đối chiếu lại trước khi ghi chú' USING ERRCODE='PT409';
  END IF;
  SELECT jsonb_object_agg(k, to_jsonb(original)->k) INTO before_patch FROM jsonb_object_keys(p_patch) k;
  UPDATE public.rooms SET
    rent_price=CASE WHEN p_patch?'rent_price' THEN (p_patch->>'rent_price')::numeric ELSE rent_price END,
    area=CASE WHEN p_patch?'area' THEN (p_patch->>'area')::numeric ELSE area END,
    room_type=CASE WHEN p_patch?'room_type' THEN p_patch->>'room_type' ELSE room_type END,
    amenities=CASE WHEN p_patch?'amenities' THEN p_patch->'amenities' ELSE amenities END,
    sale_note=CASE WHEN p_patch?'sale_note' THEN p_patch->>'sale_note' ELSE sale_note END,
    sale_bonus_note=CASE WHEN p_patch?'sale_bonus_note' THEN p_patch->>'sale_bonus_note' ELSE sale_bonus_note END,
    images=CASE WHEN p_patch?'images' THEN p_patch->'images' ELSE images END,
    description=CASE WHEN p_patch?'description' THEN p_patch->>'description' ELSE description END,
    sale_status_note=CASE WHEN p_patch?'sale_status_note' THEN p_patch->>'sale_status_note' ELSE sale_status_note END,
    sale_status_note_key=CASE WHEN p_patch?'sale_status_note_key' THEN p_patch->>'sale_status_note_key' ELSE sale_status_note_key END,
    updated_at=clock_timestamp()
  WHERE id=p_room_id AND organization_id=p_organization_id RETURNING * INTO changed;
  result := jsonb_build_object('room_id',changed.id,'building_id',changed.building_id,
    'revision',md5(to_jsonb(changed)::text),'updated_at',changed.updated_at,
    'request_id',p_request_id,'fields',p_patch);
  INSERT INTO app_private.sale_room_change_receipts
    (organization_id,actor_id,request_id,room_id,payload_hash,before_values,response)
    VALUES(p_organization_id,auth.uid(),p_request_id,p_room_id,request_hash,before_patch,result);
  RETURN result;
END
$fn$;

-- Inventory keeps editable legacy notes separate from effective public text.
CREATE OR REPLACE FUNCTION public.get_sale_room_inventory_v1(
  p_organization_id uuid, p_building_id uuid DEFAULT NULL, p_room_id uuid DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id = ANY(public.my_org_ids()), false)
    OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id=p_organization_id AND status='ACTIVE')
    OR (public.is_super_admin() AND COALESCE(p_organization_id = ANY(public.sandbox_org_ids()), false)) THEN
    RAISE EXCEPTION 'Không có quyền xem phòng trong tổ chức này' USING ERRCODE='42501';
  END IF;
  WITH allowed_buildings AS MATERIALIZED (
    SELECT b.*,
      app_private.sale_room_can_edit_v1(b.organization_id,b.id) AS can_edit,
      app_private.sale_room_can_v1(b.organization_id,b.id,'sale_phong.manage_images') AS can_images,
      app_private.sale_room_can_v1(b.organization_id,b.id,'sale_phong.manage_pass_listings') AS can_pass,
      app_private.sale_room_can_v1(b.organization_id,b.id,'sale_phong.lock_room') AS can_lock,
      app_private.sale_room_can_v1(b.organization_id,b.id,'deposits.create') AS can_deposit
    FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND b.deleted_at IS NULL AND NOT b.is_virtual
      AND (p_building_id IS NULL OR b.id=p_building_id)
      AND (app_private.sale_room_can_v1(b.organization_id,b.id,'rooms.view')
        OR app_private.sale_room_can_v1(b.organization_id,b.id,'sale_phong.view'))
  ), inventory AS MATERIALIZED (
    SELECT r.id, r.building_id, r.floor, r.name, r.code, r.area, r.rent_price,
      r.deposit_amount, r.max_occupants, r.amenities, r.images, r.description,
      r.sale_note, CASE WHEN b.can_edit THEN r.sale_bonus_note END AS sale_bonus_note,
      r.room_type, r.updated_at, md5(to_jsonb(r)::text) AS revision,
      r.sale_status_note AS sale_status_note_raw,r.sale_status_note_key,
      app_private.sale_room_fact_key_v1(r.id,r.organization_id) AS sale_fact_key,
      CASE WHEN r.sale_status_note_key=app_private.sale_room_fact_key_v1(r.id,r.organization_id) THEN r.sale_status_note END AS sale_status_note,
      app_private.room_sale_policy_current_v1(r.organization_id,r.id,statement_timestamp()) AS policy,
      COALESCE((SELECT jsonb_agg(app_private.room_sale_policy_json_v1(p,statement_timestamp()) ORDER BY p.starts_at,p.id)
        FROM app_private.room_sale_policies_v1 p WHERE p.organization_id=r.organization_id AND p.room_id=r.id
          AND p.cancelled_at IS NULL AND p.ends_at>statement_timestamp()),'[]'::jsonb) AS policies,
      app_private.room_sale_policy_active_text_v1(r.organization_id,r.id,statement_timestamp()) AS active_policy_text,
      NULLIF(concat_ws(E'\n',NULLIF(btrim(r.sale_note),''),app_private.room_sale_policy_active_text_v1(r.organization_id,r.id,statement_timestamp())),'') AS effective_sale_note,
      fact.status_public, fact.sale_state, fact.avail_date, fact.sale_today, fact.expected_ready_on,
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_name END AS pass_contact_name,
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_phone END AS pass_contact_phone,
      CASE WHEN fact.status_public='pass' THEN pl.sale_policy END AS pass_sale_policy,
      CASE WHEN fact.status_public='pass' THEN pl.pass_price END AS pass_price,
      CASE WHEN fact.status_public='pass' AND pl.avail_date>=fact.sale_today THEN pl.avail_date END AS pass_avail_date,
      COALESCE(fact.status_public='pass' AND pl.contact_manager,false) AS pass_contact_manager,
      CASE WHEN lk.id IS NOT NULL THEN jsonb_build_object(
        'id',lk.id,'hours',lk.hours,'note',lk.note,'locked_at',lk.locked_at,'expires_at',lk.expires_at,
        'locked_by_name',COALESCE(NULLIF(btrim(lp.full_name),''),'Người dùng'),
        'locked_by_me',lk.locked_by=auth.uid()) END AS sale_lock,
      jsonb_build_object(
        'edit',b.can_edit,'images',b.can_edit OR b.can_images,'pass',b.can_pass,
        'lock',b.can_lock AND fact.status_public IN ('free','soon') AND lk.id IS NULL,
        'releaseLock',lk.id IS NOT NULL AND ((lk.locked_by=auth.uid() AND b.can_lock) OR b.can_deposit),
        'deposit',b.can_deposit
      ) AS capabilities,
      audit.updated_by_name
    FROM public.rooms r
    JOIN allowed_buildings b ON b.id=r.building_id AND b.organization_id=r.organization_id
    LEFT JOIN public.public_room_settings settings ON settings.owner_id=b.user_id
    LEFT JOIN public.room_pass_listings pl
      ON pl.room_id=r.id AND pl.organization_id=r.organization_id AND pl.active
    CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(
      r.id,r.organization_id,r.status::text,pl.id IS NOT NULL,COALESCE(settings.soon_days,30)
    ) fact
    LEFT JOIN LATERAL (
      SELECT l.* FROM public.room_sale_locks l
      WHERE l.room_id=r.id AND l.organization_id=r.organization_id
        AND l.released_at IS NULL AND l.expires_at>now()
        AND fact.status_public='rented'
        AND EXISTS (SELECT 1 FROM app_private.room_sale_workflow_base_fact_v1(
          r.id,r.organization_id,r.status::text,pl.id IS NOT NULL,COALESCE(settings.soon_days,30)
        ) base WHERE base.status_public IN ('free','soon'))
      ORDER BY l.locked_at DESC LIMIT 1
    ) lk ON true
    LEFT JOIN public.profiles lp ON lp.id=lk.locked_by
    LEFT JOIN LATERAL (
      SELECT COALESCE(NULLIF(btrim(p.full_name),''),'Người dùng') AS updated_by_name
      FROM app_private.sale_room_change_receipts cr
      LEFT JOIN public.profiles p ON p.id=cr.actor_id
      WHERE cr.room_id=r.id AND cr.organization_id=r.organization_id
        AND cr.response->>'revision'=md5(to_jsonb(r)::text)
      ORDER BY cr.created_at DESC LIMIT 1
    ) audit ON true
    WHERE r.organization_id=p_organization_id AND r.deleted_at IS NULL
      AND (p_room_id IS NULL OR r.id=p_room_id)
  )
  SELECT jsonb_build_object(
    'server_now',statement_timestamp(),'areas','[]'::jsonb,
    'next_policy_boundary_at',(SELECT min(boundary) FROM app_private.room_sale_policies_v1 p
      JOIN inventory i ON i.id=p.room_id CROSS JOIN LATERAL (VALUES(p.starts_at),(p.ends_at)) d(boundary)
      WHERE p.organization_id=p_organization_id AND p.cancelled_at IS NULL AND boundary>statement_timestamp()),
    'settings_owner_id',(SELECT CASE WHEN count(DISTINCT b.user_id)=1 THEN (array_agg(DISTINCT b.user_id))[1] END FROM allowed_buildings b),
    'can_manage_account_settings',COALESCE((SELECT count(*)>0 AND bool_and(b.user_id=auth.uid()
      AND app_private.sale_room_can_v1(p_organization_id,b.id,'sale_phong.manage_settings')) FROM allowed_buildings b),false),
    'sale_policy',(SELECT NULLIF(btrim(s.sale_policy),'') FROM public.public_room_settings s
      WHERE s.owner_id=(SELECT CASE WHEN count(DISTINCT b.user_id)=1 THEN (array_agg(DISTINCT b.user_id))[1] END FROM allowed_buildings b)),
    'contact',(SELECT jsonb_build_object('name',h.name,'phone',h.phone_number) FROM public.hotlines h
      LEFT JOIN public.public_room_settings s ON s.owner_id=h.user_id
      WHERE h.user_id=(SELECT CASE WHEN count(DISTINCT b.user_id)=1 THEN (array_agg(DISTINCT b.user_id))[1] END FROM allowed_buildings b)
      AND COALESCE(h.is_active,true) AND (s.hotline_id IS NULL OR h.id=s.hotline_id)
      ORDER BY (h.id=s.hotline_id) DESC NULLS LAST,h.created_at LIMIT 1),
    'rooms',COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.building_id,i.floor,i.name,i.id) FROM inventory i),'[]'::jsonb),
    'buildings',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',b.id,'name',b.name,'code',b.code,'district',b.district,'ward',b.ward,
      'address',concat_ws(', ',NULLIF(b.street_address,''),NULLIF(b.ward,''),NULLIF(b.district,''),NULLIF(b.province,'')),
      'total_floors',b.total_floors,'images',b.images,'public_contact_name',b.public_contact_name,
      'public_contact_phone',b.public_contact_phone,'public_map_url',b.public_map_url,
      'public_lift_type',b.public_lift_type,
      'floor_layouts',b.floor_layouts,
      'area_ids',COALESCE((SELECT jsonb_agg(ab.area_id ORDER BY ab.area_id) FROM public.area_buildings ab
        JOIN public.areas a ON a.id=ab.area_id AND a.organization_id=b.organization_id AND a.deleted_at IS NULL
        WHERE ab.building_id=b.id AND ab.organization_id=b.organization_id),'[]'::jsonb),
      'elec_rate',(SELECT COALESCE(bs.unit_price_override,s.unit_price) FROM public.building_services bs
        JOIN public.services s ON s.id=bs.service_id WHERE bs.building_id=b.id AND bs.is_active
        AND s.deleted_at IS NULL AND s.unit ILIKE 'kwh' ORDER BY (s.type='FIXED') DESC,s.unit_price LIMIT 1)
    ) ORDER BY b.name,b.id) FROM allowed_buildings b
      WHERE EXISTS (SELECT 1 FROM inventory i WHERE i.building_id=b.id)),'[]'::jsonb)
  ) INTO result;
  RETURN result;
END
$fn$;

-- Existing visibility predicates stay unchanged; overlay only admitted rooms.
CREATE OR REPLACE FUNCTION public.get_public_available_rooms(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_owner   uuid;
  v_soon    int;
  v_hotline uuid;
  v_sale_policy text;
  v_result  jsonb;
BEGIN
  IF p_token IS NULL OR p_token = '' THEN
    RETURN NULL;
  END IF;

  SELECT owner_id INTO v_owner
  FROM public.public_room_share_tokens
  WHERE token = p_token AND revoked = false;

  IF v_owner IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT soon_days, hotline_id, sale_policy INTO v_soon, v_hotline, v_sale_policy
  FROM public.public_room_settings
  WHERE owner_id = v_owner;
  IF v_soon IS NULL THEN v_soon := 30; END IF;

  WITH rms AS (
    SELECT
      rm.id,
      rm.building_id,
      rm.floor,
      rm.name,
      rm.code,
      rm.area,
      rm.rent_price,
      rm.deposit_amount,
      rm.max_occupants,
      COALESCE(rm.amenities, '[]'::jsonb) AS amenities,
      COALESCE(rm.images,    '[]'::jsonb) AS images,
      rm.description,
      rm.sale_note,
      rm.room_type,
      -- Phòng khách nhờ sale (overlay). Khi contact_manager → che SĐT/tên khách.
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_name ELSE NULL END AS pass_contact_name,
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_phone ELSE NULL END AS pass_contact_phone,
      CASE WHEN fact.status_public='pass' THEN pl.sale_policy ELSE NULL END AS pass_sale_policy,
      CASE WHEN fact.status_public='pass' THEN pl.pass_price ELSE NULL END AS pass_price,
      CASE WHEN fact.status_public='pass' AND pl.avail_date>=fact.sale_today THEN pl.avail_date ELSE NULL END AS pass_avail_date,
      COALESCE(fact.status_public='pass' AND pl.contact_manager,false) AS pass_contact_manager,
      fact.status_public, fact.sale_state, fact.avail_date, fact.sale_today, fact.expected_ready_on
    FROM public.rooms rm
    JOIN public.buildings b ON b.id = rm.building_id AND b.organization_id = rm.organization_id
    LEFT JOIN public.room_pass_listings pl
      ON pl.room_id = rm.id AND pl.user_id = v_owner AND pl.active = true
    CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(rm.id,rm.organization_id,rm.status::text,pl.id IS NOT NULL,v_soon) fact
    WHERE b.user_id = v_owner
      AND b.is_virtual = false
      AND b.deleted_at IS NULL
      AND rm.deleted_at IS NULL
  ),
  bld_ids AS (
    SELECT DISTINCT building_id FROM rms WHERE status_public IN ('free','soon','pass')
  ),
  rooms_j AS (
    SELECT jsonb_agg(to_jsonb(rms) ORDER BY rms.floor DESC, rms.name) AS j
    FROM rms
    WHERE rms.building_id IN (SELECT building_id FROM bld_ids)
  ),
  blds_j AS (
    SELECT jsonb_agg(jsonb_build_object(
      'id',           b.id,
      'name',         b.name,
      'code',         b.code,
      'area_ids',     COALESCE((
                        SELECT jsonb_agg(ab.area_id)
                        FROM public.area_buildings ab
                        JOIN public.areas a ON a.id = ab.area_id
                        WHERE ab.building_id = b.id AND a.deleted_at IS NULL
                      ), '[]'::jsonb),
      'district',     b.district,
      'ward',         b.ward,
      'address',      CASE
                        WHEN b.street_address IS NOT NULL AND b.street_address LIKE '%,%'
                          THEN b.street_address
                        ELSE concat_ws(', ',
                               NULLIF(b.street_address, ''),
                               NULLIF(b.ward, ''),
                               NULLIF(b.district, ''),
                               NULLIF(b.province, ''))
                      END,
      'total_floors', b.total_floors,
      'floor_layouts', b.floor_layouts,
      'images',        COALESCE(b.images, '[]'::jsonb),
      'public_contact_name',  b.public_contact_name,
      'public_contact_phone', b.public_contact_phone,
      'public_map_url',       b.public_map_url,
      'public_lift_type',     b.public_lift_type,
      'elec_rate', (
        SELECT COALESCE(bs.unit_price_override, s.unit_price)
        FROM public.building_services bs
        JOIN public.services s ON s.id = bs.service_id
        WHERE bs.building_id = b.id
          AND bs.is_active = true
          AND s.deleted_at IS NULL
          AND s.unit ILIKE 'kwh'
        ORDER BY (s.type = 'FIXED') DESC, s.unit_price
        LIMIT 1
      )
    ) ORDER BY b.name) AS j
    FROM public.buildings b
    WHERE b.id IN (SELECT building_id FROM bld_ids)
  ),
  areas_j AS (
    SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) ORDER BY a.name) AS j
    FROM public.areas a
    WHERE a.user_id = v_owner AND a.deleted_at IS NULL
  ),
  contact_j AS (
    SELECT jsonb_build_object('name', h.name, 'phone', h.phone_number) AS j
    FROM public.hotlines h
    WHERE h.user_id = v_owner
      AND COALESCE(h.is_active, true) = true
      AND (v_hotline IS NULL OR h.id = v_hotline)
    ORDER BY (h.id = v_hotline) DESC NULLS LAST, h.created_at
    LIMIT 1
  )
  SELECT jsonb_build_object(
    'areas',     COALESCE((SELECT j FROM areas_j), '[]'::jsonb),
    'buildings', COALESCE((SELECT j FROM blds_j), '[]'::jsonb),
    'rooms',     COALESCE((SELECT j FROM rooms_j), '[]'::jsonb),
    'contact',   (SELECT j FROM contact_j),
    'sale_policy', NULLIF(btrim(v_sale_policy), '')
  ) INTO v_result;

  RETURN app_private.room_sale_policy_overlay_v1(v_result);
END;
$function$;

-- Existing visibility predicates stay unchanged; overlay only admitted rooms.
CREATE OR REPLACE FUNCTION public.get_my_available_rooms()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_caller  uuid := auth.uid();
  v_owner   uuid;
  v_soon    int;
  v_hotline uuid;
  v_sale_policy text;
  v_result  jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT sa.user_id INTO v_owner
  FROM public.staff_assignments sa
  WHERE sa.staff_id = v_caller AND sa.user_id <> v_caller
  LIMIT 1;
  IF v_owner IS NULL THEN
    v_owner := v_caller;
  END IF;

  SELECT soon_days, hotline_id, sale_policy INTO v_soon, v_hotline, v_sale_policy
  FROM public.public_room_settings
  WHERE owner_id = v_owner;
  IF v_soon IS NULL THEN v_soon := 30; END IF;

  WITH rms AS (
    SELECT
      rm.id,
      rm.building_id,
      rm.floor,
      rm.name,
      rm.code,
      rm.area,
      rm.rent_price,
      rm.deposit_amount,
      rm.max_occupants,
      COALESCE(rm.amenities, '[]'::jsonb) AS amenities,
      COALESCE(rm.images,    '[]'::jsonb) AS images,
      rm.description,
      rm.sale_note,
      rm.sale_bonus_note,
      rm.room_type,
      -- 10/10 (Tình trạng gõ tay): chỉ trả chữ khi tình trạng tự tính vẫn như lúc gõ.
      CASE WHEN rm.sale_status_note_key = fk.sale_fact_key THEN rm.sale_status_note END AS sale_status_note,
      fk.sale_fact_key,
      -- Phòng khách nhờ sale (overlay). Khi contact_manager → che SĐT/tên khách.
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_name ELSE NULL END AS pass_contact_name,
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_phone ELSE NULL END AS pass_contact_phone,
      CASE WHEN fact.status_public='pass' THEN pl.sale_policy ELSE NULL END AS pass_sale_policy,
      CASE WHEN fact.status_public='pass' THEN pl.pass_price ELSE NULL END AS pass_price,
      CASE WHEN fact.status_public='pass' AND pl.avail_date>=fact.sale_today THEN pl.avail_date ELSE NULL END AS pass_avail_date,
      COALESCE(fact.status_public='pass' AND pl.contact_manager,false) AS pass_contact_manager,
      fact.status_public, fact.sale_state, fact.avail_date, fact.sale_today, fact.expected_ready_on,
      lk.sale_lock
    FROM public.rooms rm
    JOIN public.buildings b ON b.id = rm.building_id AND b.organization_id = rm.organization_id
    LEFT JOIN public.room_pass_listings pl
      ON pl.room_id = rm.id AND pl.user_id = v_owner AND pl.active = true
    CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(rm.id,rm.organization_id,rm.status::text,pl.id IS NOT NULL,v_soon) fact
    CROSS JOIN LATERAL (
      -- format giữ chỗ cho NULL (concat_ws bỏ qua NULL ⇒ hai tình trạng khác nhau có thể trùng khoá);
      -- ngày qua to_char để khoá không phụ thuộc DateStyle của phiên.
      SELECT md5(format('%s|%s|%s|%s|%s|%s', fact.status_public, fact.sale_state,
                        to_char(fact.avail_date, 'YYYY-MM-DD'), to_char(fact.expected_ready_on, 'YYYY-MM-DD'),
                        CASE WHEN fact.status_public = 'pass' THEN pl.id END,
                        CASE WHEN fact.status_public = 'pass' THEN to_char(pl.avail_date, 'YYYY-MM-DD') END)) AS sale_fact_key
    ) fk
    -- 10/10: phòng bị ẩn CHỈ vì lock tạm còn hạn ⇒ nhân viên trong app thấy ai lock, còn bao lâu.
    -- Reader công khai/Zalo/Copilot không có khoá này; trạng thái vẫn 'rented' như phòng đã cọc.
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object('id', l.id, 'hours', l.hours, 'note', l.note,
               'locked_at', l.locked_at, 'expires_at', l.expires_at,
               'locked_by_name', COALESCE(NULLIF(btrim(p.full_name), ''), 'Người dùng'),
               'locked_by_me', l.locked_by = v_caller) AS sale_lock
      FROM public.room_sale_locks l
      LEFT JOIN public.profiles p ON p.id = l.locked_by
      WHERE fact.status_public = 'rented'
        AND l.organization_id = rm.organization_id AND l.room_id = rm.id
        AND l.released_at IS NULL AND l.expires_at > now()
        AND EXISTS (
          SELECT 1 FROM app_private.room_sale_workflow_base_fact_v1(rm.id,rm.organization_id,rm.status::text,pl.id IS NOT NULL,v_soon) base
          WHERE base.status_public IN ('free','soon'))
    ) lk ON true
    WHERE b.user_id = v_owner
      AND b.is_virtual = false
      AND b.deleted_at IS NULL
      AND rm.deleted_at IS NULL
  ),
  bld_ids AS (
    SELECT DISTINCT building_id FROM rms WHERE status_public IN ('free','soon','pass') OR sale_lock IS NOT NULL
  ),
  rooms_j AS (
    SELECT jsonb_agg(to_jsonb(rms) ORDER BY rms.floor DESC, rms.name) AS j
    FROM rms
    WHERE rms.building_id IN (SELECT building_id FROM bld_ids)
  ),
  blds_j AS (
    SELECT jsonb_agg(jsonb_build_object(
      'id',           b.id,
      'name',         b.name,
      'code',         b.code,
      'area_ids',     COALESCE((
                        SELECT jsonb_agg(ab.area_id)
                        FROM public.area_buildings ab
                        JOIN public.areas a ON a.id = ab.area_id
                        WHERE ab.building_id = b.id AND a.deleted_at IS NULL
                      ), '[]'::jsonb),
      'district',     b.district,
      'ward',         b.ward,
      'address',      CASE
                        WHEN b.street_address IS NOT NULL AND b.street_address LIKE '%,%'
                          THEN b.street_address
                        ELSE concat_ws(', ',
                               NULLIF(b.street_address, ''),
                               NULLIF(b.ward, ''),
                               NULLIF(b.district, ''),
                               NULLIF(b.province, ''))
                      END,
      'total_floors', b.total_floors,
      'floor_layouts', b.floor_layouts,
      'images',        COALESCE(b.images, '[]'::jsonb),
      'public_contact_name',  b.public_contact_name,
      'public_contact_phone', b.public_contact_phone,
      'public_map_url',       b.public_map_url,
      'public_lift_type',     b.public_lift_type,
      'elec_rate', (
        SELECT COALESCE(bs.unit_price_override, s.unit_price)
        FROM public.building_services bs
        JOIN public.services s ON s.id = bs.service_id
        WHERE bs.building_id = b.id
          AND bs.is_active = true
          AND s.deleted_at IS NULL
          AND s.unit ILIKE 'kwh'
        ORDER BY (s.type = 'FIXED') DESC, s.unit_price
        LIMIT 1
      )
    ) ORDER BY b.name) AS j
    FROM public.buildings b
    WHERE b.id IN (SELECT building_id FROM bld_ids)
  ),
  areas_j AS (
    SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) ORDER BY a.name) AS j
    FROM public.areas a
    WHERE a.user_id = v_owner AND a.deleted_at IS NULL
  ),
  contact_j AS (
    SELECT jsonb_build_object('name', h.name, 'phone', h.phone_number) AS j
    FROM public.hotlines h
    WHERE h.user_id = v_owner
      AND COALESCE(h.is_active, true) = true
      AND (v_hotline IS NULL OR h.id = v_hotline)
    ORDER BY (h.id = v_hotline) DESC NULLS LAST, h.created_at
    LIMIT 1
  )
  SELECT jsonb_build_object(
    'areas',     COALESCE((SELECT j FROM areas_j), '[]'::jsonb),
    'buildings', COALESCE((SELECT j FROM blds_j), '[]'::jsonb),
    'rooms',     COALESCE((SELECT j FROM rooms_j), '[]'::jsonb),
    'contact',   (SELECT j FROM contact_j),
    'sale_policy', NULLIF(btrim(v_sale_policy), '')
  ) INTO v_result;

  RETURN app_private.room_sale_policy_overlay_v1(v_result);
END;
$function$;

ALTER FUNCTION app_private.sale_room_can_edit_v1(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.sale_room_can_edit_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION app_private.sale_room_authorize_edit_v1(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.sale_room_authorize_edit_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION app_private.sale_room_fact_key_v1(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.sale_room_fact_key_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION app_private.room_sale_policy_json_v1(app_private.room_sale_policies_v1,timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.room_sale_policy_json_v1(app_private.room_sale_policies_v1,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION app_private.room_sale_policy_current_v1(uuid,uuid,timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.room_sale_policy_current_v1(uuid,uuid,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION app_private.room_sale_policy_active_text_v1(uuid,uuid,timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.room_sale_policy_active_text_v1(uuid,uuid,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION app_private.room_sale_policy_overlay_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.room_sale_policy_overlay_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION public.save_room_sale_policy_v1(uuid,uuid,text,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.save_room_sale_policy_v1(uuid,uuid,text,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION public.cancel_room_sale_policy_v1(uuid,uuid,bigint,uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.cancel_room_sale_policy_v1(uuid,uuid,bigint,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.save_room_sale_policy_v1(uuid,uuid,text,uuid,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_room_sale_policy_v1(uuid,uuid,bigint,uuid,text) TO authenticated;

COMMIT;
NOTIFY pgrst,'reload schema';

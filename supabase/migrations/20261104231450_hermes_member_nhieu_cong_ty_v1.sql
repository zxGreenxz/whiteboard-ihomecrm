-- hermes_member_v1: người ở nhiều công ty dùng được Hermes ở công ty mình đang là thành viên ACTIVE (04/11/2026, hậu kiểm PR #371).
--
-- VẤN ĐỀ. Thân 20261012061447 (đang chạy trên prod và TEST, md5 prosrc 37853e82…) từ chối mọi người thường, tức không phải
-- super admin, có membership ACTIVE ở từ 2 công ty trở lên ('hermes_ordinary_org_ambiguous', 42501), kể cả khi họ là thành
-- viên ACTIVE của đúng công ty đang thao tác. Trang Cài đặt › Hermes › "Bài học chờ duyệt" (hermes_learning_admin_v1 của
-- 20261031041523) nhận 42501 đó và báo "Chỉ chủ hoặc quản trị viên công ty…" cho một quản trị viên thật, chỉ vì họ còn thuộc
-- công ty khác. Đo 04/11: prod và TEST có 0 người thường thuộc từ 2 công ty (1 super admin) — chưa ai bị chặn, nhưng luật sai.
--
-- VÌ SAO NỚI ĐƯỢC. 64 hàm gọi hermes_member_v1 (đều SECURITY DEFINER, chủ postgres) sau bước kiểm đều lọc tường minh theo
-- p_org hoặc organization_id của kết nối. Helper theo auth.uid() không gắn công ty (current_visible_owner_ids,
-- accessible_account_ids, can_access_org_entity) luôn đứng trong AND với điều kiện công ty; đường đọc INVOKER đợt 2 qua RLS
-- my_org_ids() có rào đầu ra hermes_w2_row_outside_scope (42501). Luật "một công ty" không phải chốt cách ly công ty.
--
-- PHẠM VI. Chỉ thân hermes_member_v1: bỏ khối đếm công ty. Giữ nguyên: tham số NULL ⇒ từ chối; phải có đúng 1 membership
-- ACTIVE của p_org (status, revoked_at, valid_from/valid_to, organizations.status); câu báo 'hermes_membership_required';
-- isSuperadmin, authorizationVersion, membershipId; chữ ký, DEFINER, VOLATILE, search_path, chủ và ACL (chỉ postgres). Người
-- một công ty và super admin nhận đúng kết quả cũ. Các bản chép luật ở hermes_metadata_member_v1 (trang capabilities, đọc
-- nhanh), hermes_room_scope_map_v1 và hermes_zalo_private_reply_v1 KHÔNG đổi ở đây — các đường đó vẫn chặn người nhiều công
-- ty (đóng an toàn), là việc sau.
-- Ghim md5 thân đang chạy; lượt hai (idempotent) chấp nhận md5 thân mới. Không DROP, không đổi dữ liệu.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $requires$
DECLARE v_md5 text;
BEGIN
  SELECT md5(replace(p.prosrc,chr(13),'')) INTO v_md5 FROM pg_catalog.pg_proc p
    WHERE p.oid=to_regprocedure('app_private.hermes_member_v1(uuid,uuid)');
  IF v_md5 IS NULL OR v_md5 NOT IN ('37853e826f0e7f2538bf5a60e5754e87','28270f0f09cf4d16a263f6a595bc7d85')
    OR to_regclass('public.organization_memberships') IS NULL OR to_regclass('public.organizations') IS NULL
    OR to_regclass('public.super_admins') IS NULL THEN
    RAISE EXCEPTION 'hermes_member_v1_body_drift: %',COALESCE(v_md5,'missing');
  END IF;
END $requires$;

-- Thành viên ACTIVE của ĐÚNG p_org là đủ; người thuộc thêm công ty khác không bị chặn ở đây vì bên gọi luôn lọc theo p_org.
CREATE OR REPLACE FUNCTION app_private.hermes_member_v1(p_user uuid,p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE v_count integer; v_super boolean; v_member uuid; v_version bigint;
  v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_user IS NULL OR p_org IS NULL THEN RAISE EXCEPTION 'hermes_membership_required' USING ERRCODE='42501'; END IF;
  SELECT count(*),min(m.id::text)::uuid INTO v_count,v_member
  FROM public.organization_memberships m JOIN public.organizations o ON o.id=m.organization_id
  WHERE m.user_id=p_user AND m.organization_id=p_org AND o.status='ACTIVE'
    AND m.status='ACTIVE' AND m.revoked_at IS NULL
    AND COALESCE(m.valid_from,'-infinity'::timestamptz)<=v_now
    AND (m.valid_to IS NULL OR m.valid_to>v_now);
  IF v_count<>1 THEN RAISE EXCEPTION 'hermes_membership_required' USING ERRCODE='42501'; END IF;
  SELECT EXISTS(SELECT 1 FROM public.super_admins WHERE user_id=p_user) INTO v_super;
  SELECT authorization_version INTO v_version FROM public.organizations WHERE id=p_org;
  RETURN jsonb_build_object('membershipId',v_member,'authorizationVersion',v_version,'isSuperadmin',v_super);
END
$fn$;
ALTER FUNCTION app_private.hermes_member_v1(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_member_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

DO $check$
DECLARE p record;
BEGIN
  SELECT x.prosecdef,x.provolatile,x.proconfig,pg_get_userbyid(x.proowner) AS owner,md5(replace(x.prosrc,chr(13),'')) AS md5,
      x.prosrc,pg_get_function_result(x.oid) AS result
    INTO p FROM pg_catalog.pg_proc x WHERE x.oid='app_private.hermes_member_v1(uuid,uuid)'::regprocedure;
  IF NOT p.prosecdef OR p.provolatile<>'v' OR p.owner<>'postgres' OR p.result<>'jsonb'
    OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, app_private']
    OR p.md5<>'28270f0f09cf4d16a263f6a595bc7d85' OR p.prosrc ~ 'hermes_ordinary_org_ambiguous' OR p.prosrc !~ 'm\.organization_id=p_org'
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role','hermes_store_executor')
      AND pg_catalog.has_function_privilege(r.oid,'app_private.hermes_member_v1(uuid,uuid)'::regprocedure,'EXECUTE')) THEN
    RAISE EXCEPTION 'hermes_member_v1_check_failed';
  END IF;
END $check$;

COMMIT;

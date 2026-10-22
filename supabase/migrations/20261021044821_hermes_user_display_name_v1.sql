-- R2c part 2 (c) (21/10/2026): "Tôi đang kết nối CRM bằng tài khoản nào?" — crm_auth_context had the user id but no
-- name. public.hermes_user_display_name_v1() returns {"id","name"} of the CALLER only (auth.uid()): the display name of
-- their own profile (public.profiles.full_name, what the web header shows), read under the caller's own RLS ("Users can
-- view own profile"), hence SECURITY INVOKER — no other user, no argument, no email/phone (PII: the connector answer may
-- reach a group chat; the name is enough to recognise the account). Text sanitised like hermes_memory_owner_name_v1
-- (control characters, 120 characters); name null when the profile is not visible to the caller. Returns a jsonb OBJECT
-- (the connector's bound-user transport accepts objects only). No write; no other function changes.
-- RELEASE: the connector reads it optionally (PGRST202 ⇒ userName null), so either order works; connector first is the
-- documented order. Prepared rollback (not a migration): docs/plans/hermes-crm/revert/hermes_user_display_name_revert_v1.sql.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regclass('public.profiles') IS NULL OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.profiles')
      AND attname='full_name' AND attnum>0 AND NOT attisdropped)
    THEN RAISE EXCEPTION 'hermes_user_display_name_dependency_invalid: public.profiles.full_name'; END IF;
  IF to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('auth.role()') IS NULL THEN
    RAISE EXCEPTION 'hermes_user_display_name_dependency_invalid: auth.uid()/auth.role()'; END IF;
END $requires$;

-- Tên hiển thị của chính người gọi (JWT người dùng); vai khác authenticated hoặc không có uid ⇒ 42501.
CREATE OR REPLACE FUNCTION public.hermes_user_display_name_v1()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE v_actor uuid:=auth.uid(); v_name text;
BEGIN
  IF v_actor IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE='42501'; END IF;
  SELECT NULLIF(left(btrim(regexp_replace(translate(COALESCE(p.full_name,''),chr(8232)||chr(8233),'  '),'[[:cntrl:]]',' ','g')),120),'')
    INTO v_name FROM public.profiles p WHERE p.id=v_actor;
  RETURN jsonb_build_object('id',v_actor,'name',v_name);
END $fn$;

ALTER FUNCTION public.hermes_user_display_name_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_user_display_name_v1() FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_user_display_name_v1() TO authenticated;
COMMENT ON FUNCTION public.hermes_user_display_name_v1() IS
  'Hermes: tên hiển thị (profiles.full_name) của CHÍNH người gọi, dưới RLS của họ; crm_auth_context trả userName.';

-- Tự kiểm trước khi commit: đúng quyền, đúng tính chất hàm, chỉ đọc hồ sơ của chính người gọi.
DO $assert$
DECLARE p record; sig text:='public.hermes_user_display_name_v1()'; src text;
BEGIN
  IF has_function_privilege('anon',sig,'EXECUTE') OR has_function_privilege('service_role',sig,'EXECUTE')
    OR has_function_privilege('hermes_store_executor',sig,'EXECUTE') OR NOT has_function_privilege('authenticated',sig,'EXECUTE')
    THEN RAISE EXCEPTION 'hermes user display name ACL'; END IF;
  SELECT pr.prosecdef,pr.provolatile,pg_get_userbyid(pr.proowner) AS owner,pr.proconfig INTO p FROM pg_proc pr WHERE pr.oid=to_regprocedure(sig);
  IF NOT FOUND OR p.prosecdef OR p.provolatile<>'s' OR p.owner<>'postgres'
    OR replace(COALESCE(array_to_string(p.proconfig,','),''),' ','')<>'search_path=pg_catalog,public'
    THEN RAISE EXCEPTION 'hermes user display name definition'; END IF;
  src:=pg_get_functiondef(to_regprocedure(sig));
  IF position('p.id=v_actor' IN src)=0 OR position('app_private' IN src)>0 OR position('email' IN src)>0 OR position('phone' IN src)>0
    THEN RAISE EXCEPTION 'hermes user display name source'; END IF;
END $assert$;
COMMIT;
NOTIFY pgrst,'reload schema';

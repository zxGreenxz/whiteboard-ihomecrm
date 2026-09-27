-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- app_private.lock_org_for_decision_v1(p_organization_id uuid) md5(prosrc)=cd59b90fbbd143dab9cf0b21bf5d685d
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
$function$


-- t5_29 — P1 gia cố sau tổng kiểm 2026-07-19:
--  (a) STORAGE write-isolation: SELECT đã có RESTRICTIVE org-isolation
--      (storage_pii_org_isolation) nhưng UPDATE/DELETE còn permissive bucket-wide
--      → ghi đè/xoá chéo org về lý thuyết được. Thêm RESTRICTIVE cho UPDATE+DELETE
--      dùng ĐÚNG predicate can_read_storage_object_v1 (bucket non-PII luôn pass;
--      object PII: 0/2448 thiếu link → không gãy xoá hợp lệ; chéo org bị chặn).
--  (b) EMERGENCY break-glass endpoint: emergency_approve_financial_v1 đã đủ chặt
--      (OWNER + không-maker + approvals.emergency_override + reason>=20 + reauth +
--      log emergency_override_events) nhưng CHỈ app_private, 0 caller sản phẩm.
--      Thêm wrapper public map membership + version.
--  (c) DATA FIX: 2 phiếu demo trỏ sổ quỹ org THẬT (c82db700 PT2607007,
--      3dd30392 PT2607008 — fixture preflight) → reassign sang sổ demo.

begin;

-- ========== (a) STORAGE write-isolation ==========
drop policy if exists storage_pii_org_isolation_update on storage.objects;
create policy storage_pii_org_isolation_update on storage.objects
  as restrictive for update to authenticated
  using (app_private.can_read_storage_object_v1(bucket_id, name))
  with check (app_private.can_read_storage_object_v1(bucket_id, name));

drop policy if exists storage_pii_org_isolation_delete on storage.objects;
create policy storage_pii_org_isolation_delete on storage.objects
  as restrictive for delete to authenticated
  using (app_private.can_read_storage_object_v1(bucket_id, name));

-- ========== (b) EMERGENCY break-glass wrapper ==========
create or replace function public.emergency_approve_request_v1(
  p_request_id uuid, p_reason text, p_reauth_fresh boolean default false)
returns json
language plpgsql security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $fn$
declare
  v_actor uuid := auth.uid();
  v_req public.approval_requests;
  v_memb uuid;
  v_posting uuid;
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;

  select * into v_req from public.approval_requests where id = p_request_id;
  if not found then raise exception 'Không tìm thấy yêu cầu duyệt' using errcode='P0002'; end if;

  -- membership OWNER đang hoạt động của actor trong org của yêu cầu
  select m.id into v_memb from public.organization_memberships m
   where m.user_id = v_actor and m.organization_id = v_req.organization_id
     and m.status = 'ACTIVE' and m.member_type = 'OWNER'
   limit 1;
  if v_memb is null then
    raise exception 'Duyệt khẩn cấp yêu cầu tư cách CHỦ SỞ HỮU đang hoạt động' using errcode='42501';
  end if;

  -- inner fn tự kiểm: not-maker + approvals.emergency_override + reason>=20 +
  -- reauth + version + log emergency_override_events + BYPASS steps + post.
  v_posting := app_private.emergency_approve_financial_v1(
    p_request_id, v_req.version, v_memb, v_actor, p_reason, coalesce(p_reauth_fresh, false));

  return json_build_object('request_id', p_request_id, 'posting_id', v_posting, 'emergency', true);
end;
$fn$;

revoke execute on function public.emergency_approve_request_v1(uuid, text, boolean) from public, anon;
grant execute on function public.emergency_approve_request_v1(uuid, text, boolean) to authenticated;

-- ========== (c) DATA FIX: 2 phiếu demo trỏ sổ org thật ==========
-- Reassign sang sổ demo "DEMO Ngân Hàng" (giữ nguyên trạng thái/khoản; chỉ sửa
-- account để không phiếu demo nào tham chiếu sổ org thật — mở đường thêm FK
-- same-org về sau). Chỉ đụng 2 id đã xác minh.
update public.income_expenses
   set account_id = 'af8edddc-33ff-4878-b984-90e990c87a64'  -- DEMO Ngân Hàng (org dddd)
 where id in ('c82db700-9a48-4e76-9e21-3d3d69915632',
              '3dd30392-5ef9-4fe0-b8bd-3f664343b0b4')
   and organization_id = 'dddd0000-0000-4000-8000-000000000001';

commit;

-- ============================================================================
-- T8 §14 PREPARED SQL — Storage object org-isolation (đóng lỗ cross-tenant PII).
-- STATUS: APPLIED production 2026-07-18 (audit §1.2 critical DEFECT — lỗ sống).
-- LÝ DO: 7 policy SELECT bucket PII chỉ check bucket_id → mọi authenticated user
--   đọc chéo tenant (CCCD/biên nhận/ảnh KH). Không có storage_object_links (§14.1).
-- MÔ HÌNH: object đặt tên `<uploader_uuid>/…`. Suy org từ uploader:
--   OWNER-org (nếu owner đúng 1 org) → else single-active-membership → else NULL
--   (quarantine: chỉ chính uploader đọc). Link-table làm nguồn ánh xạ; SELECT
--   check qua SECURITY DEFINER; INSERT trigger tự tạo link cho upload mới.
-- KHÔNG copy/move/xoá object (copy-not-delete). Chỉ đóng đọc chéo. Reversible.
-- ============================================================================

begin;

-- 1. Link table (nguồn ánh xạ object → org). organization_id NULL = quarantine.
create table if not exists app_private.storage_object_links (
  bucket_id       text not null,
  object_name     text not null,
  organization_id uuid,
  owner_user_id   uuid,
  derivation      text not null,
  created_at      timestamptz not null default now(),
  primary key (bucket_id, object_name)
);
revoke all on app_private.storage_object_links from public, anon, authenticated, service_role;

-- 2. Hàm suy org từ 1 uploader (OWNER-org → single-membership → NULL).
create or replace function app_private.derive_uploader_org_v1(p_uploader uuid)
returns table(org uuid, how text)
language sql stable security definer set search_path to 'pg_catalog','public' as $fn$
  with owner_org as (
    select m.organization_id
      from public.organization_memberships m
     where m.user_id = p_uploader and m.status = 'ACTIVE' and m.member_type = 'OWNER'
     group by m.organization_id
  ),
  single_owner as (
    select case when (select count(*) from owner_org) = 1
                then (select organization_id from owner_org) end as oid
  ),
  single_mem as (
    select case when (select count(distinct m.organization_id)
                        from public.organization_memberships m
                       where m.user_id = p_uploader and m.status='ACTIVE') = 1
                then (select distinct m.organization_id
                        from public.organization_memberships m
                       where m.user_id = p_uploader and m.status='ACTIVE') end as oid
  )
  select coalesce((select oid from single_owner), (select oid from single_mem)) as org,
         case when (select oid from single_owner) is not null then 'uploader_owner_org'
              when (select oid from single_mem)   is not null then 'uploader_single_org'
              else 'quarantine' end as how;
$fn$;
revoke all on function app_private.derive_uploader_org_v1(uuid) from public, anon, authenticated, service_role;

-- 3. Backfill mọi object hiện có trong 7 bucket tenant-data.
insert into app_private.storage_object_links (bucket_id, object_name, organization_id, owner_user_id, derivation)
select o.bucket_id, o.name, d.org, up.uploader, d.how
  from storage.objects o
  cross join lateral (select nullif(split_part(o.name,'/',1),'')::uuid as uploader) up
  cross join lateral app_private.derive_uploader_org_v1(up.uploader) d
 where o.bucket_id in ('customer-id-cards','customer-images','income-expense-attachments',
                       'job-attachments','payment-receipts','meter-images','document-templates')
on conflict (bucket_id, object_name) do nothing;

-- 4. Trigger tự tạo link cho upload MỚI (derive từ uploader = split prefix, hoặc owner).
create or replace function app_private.storage_object_link_maintain()
returns trigger language plpgsql security definer set search_path to 'pg_catalog','app_private','public' as $fn$
declare v_uploader uuid; v_org uuid; v_how text;
begin
  if new.bucket_id not in ('customer-id-cards','customer-images','income-expense-attachments',
                           'job-attachments','payment-receipts','meter-images','document-templates') then
    return new;
  end if;
  v_uploader := coalesce(new.owner_id::uuid, new.owner, nullif(split_part(new.name,'/',1),'')::uuid);
  select org, how into v_org, v_how from app_private.derive_uploader_org_v1(v_uploader);
  insert into app_private.storage_object_links (bucket_id, object_name, organization_id, owner_user_id, derivation)
  values (new.bucket_id, new.name, v_org, v_uploader, coalesce(v_how,'quarantine'))
  on conflict (bucket_id, object_name) do update set organization_id=excluded.organization_id,
    owner_user_id=excluded.owner_user_id, derivation=excluded.derivation;
  return new;
end;
$fn$;
revoke all on function app_private.storage_object_link_maintain() from public, anon, authenticated, service_role;
drop trigger if exists a00_storage_object_link on storage.objects;
create trigger a00_storage_object_link before insert on storage.objects
  for each row execute function app_private.storage_object_link_maintain();

-- 5. SECURITY DEFINER read-check: object thuộc org của caller (hoặc quarantine→uploader, super_admin).
create or replace function app_private.can_read_storage_object_v1(p_bucket text, p_name text)
returns boolean language sql stable security definer
set search_path to 'pg_catalog','app_private','public' as $fn$
  select
    p_bucket not in ('customer-id-cards','customer-images','income-expense-attachments',
                     'job-attachments','payment-receipts','meter-images','document-templates')
    or (select public.is_super_admin())
    or exists (
      select 1 from app_private.storage_object_links l
       where l.bucket_id = p_bucket and l.object_name = p_name
         and ( (l.organization_id is not null and l.organization_id in (select unnest(public.my_org_ids())))
            or (l.organization_id is null and l.owner_user_id = (select auth.uid())) )
    );
$fn$;
revoke all on function app_private.can_read_storage_object_v1(text,text) from public, anon;
grant execute on function app_private.can_read_storage_object_v1(text,text) to authenticated;

-- 6. RESTRICTIVE SELECT policy: chồng lên 7 permissive policy cũ → AND lại → chặn chéo tenant.
drop policy if exists storage_pii_org_isolation on storage.objects;
create policy storage_pii_org_isolation on storage.objects as restrictive for select to authenticated
  using (app_private.can_read_storage_object_v1(bucket_id, name));

commit;

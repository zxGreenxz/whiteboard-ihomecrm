declare
  v_uploader uuid;
  v_org uuid;
  v_how text;
  v_requested text;
  v_intent_org uuid;
  v_intent_user uuid;
begin
  if new.bucket_id not in ('customer-id-cards','customer-images','income-expense-attachments',
                           'job-attachments','payment-receipts','meter-images','document-templates') then
    return new;
  end if;
  v_uploader := coalesce(new.owner_id::uuid,new.owner);
  if v_uploader is null and split_part(new.name,'/',1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_uploader := split_part(new.name,'/',1)::uuid;
  end if;
  -- A server-issued finance intent owns the company, including v2/org paths.
  if exists (select 1 from public.finance_evidence_objects e where e.bucket_id=new.bucket_id and e.object_name=new.name and e.state='QUARANTINED')
     or (select count(*) from public.finance_evidence_objects e where e.bucket_id=new.bucket_id and e.object_name=new.name)>1 then
    raise exception 'Chứng từ của đường dẫn ảnh bị cách ly hoặc mâu thuẫn công ty' using errcode='42501';
  end if;
  select e.organization_id,e.uploader_user_id into v_intent_org,v_intent_user
    from public.finance_evidence_objects e
    where e.bucket_id=new.bucket_id and e.object_name=new.name
      and e.state in ('UPLOAD_INTENT','FINALIZED','ATTACHED');
  v_requested := nullif(new.user_metadata->>'ihomecrm_organization_id','');
  if v_intent_org is not null then
    if v_intent_user is distinct from v_uploader then
      raise exception 'Người tải không khớp chứng từ' using errcode='42501';
    end if;
    v_org := v_intent_org;
    if v_requested is not null and v_requested::uuid is distinct from v_org then
      raise exception 'Công ty ảnh không khớp chứng từ' using errcode='42501';
    end if;
    v_how := 'finance-intent';
  elsif v_requested is not null then
    v_org := v_requested::uuid;
    v_how := 'explicit-upload';
  else
    -- Old clients keep the existing unambiguous derivation/quarantine behavior.
    select org,how into v_org,v_how from app_private.derive_uploader_org_v1(v_uploader);
  end if;
  if v_org is not null and not app_private.active_working_membership_v1(v_uploader,v_org) then
    raise exception 'Người tải không còn quyền trong công ty của ảnh' using errcode='42501';
  end if;
  insert into app_private.storage_object_links(bucket_id,object_name,organization_id,owner_user_id,derivation)
    values(new.bucket_id,new.name,v_org,v_uploader,coalesce(v_how,'quarantine'))
    on conflict (bucket_id,object_name) do update set
      organization_id=coalesce(storage_object_links.organization_id,excluded.organization_id),
      derivation=case when storage_object_links.organization_id is null then excluded.derivation else storage_object_links.derivation end
    where storage_object_links.owner_user_id is not distinct from excluded.owner_user_id
      and (storage_object_links.organization_id is null or storage_object_links.organization_id is not distinct from excluded.organization_id);
  if not found then raise exception 'Đường dẫn ảnh đã thuộc chủ hoặc công ty khác' using errcode='42501'; end if;
  return new;
end;

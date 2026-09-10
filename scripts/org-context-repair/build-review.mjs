// Build a guarded review from a locally exported live catalog. No credentials,
// network calls or database writes. The output always ends in ROLLBACK.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {extendParentReview} from './extend-parent-review.mjs';
const md5=value=>createHash('md5').update(value).digest('hex');
const literal=value=>"'"+value.replaceAll("'","''")+"'";
const signature=f=>`${f.schema}.${f.name}(${f.arguments.split(',').filter(Boolean).map(x=>x.trim().replace(/^\w+\s+/, '')).join(',')})`;

export function buildReview(catalog){
 const edits=[];
 const update=(name,change,args)=>{
  const candidates=catalog.functions.filter(f=>f.name===name&&(args===undefined||f.arguments===args));
  if(candidates.length!==1)throw new Error('Ambiguous/missing live function: '+name);
  const f=candidates[0];
  if(md5(f.definition)!==f.digest)throw new Error('Catalog digest mismatch: '+name);
  let current=f.definition;
  const replacements=[];
  const replace=(pattern,replacement)=>{
   const matches=typeof pattern==='string'?current.split(pattern).length-1:[...current.matchAll(new RegExp(pattern.source,pattern.flags.includes('g')?pattern.flags:pattern.flags+'g'))].length;
   if(matches!==1)throw new Error(`${name}: expected exactly one replacement, found ${matches}: ${pattern}`);
   const before=typeof pattern==='string'?pattern:current.match(pattern)[0];
   const after=typeof replacement==='function'?replacement(before):replacement;
   current=current.replace(before,()=>after);replacements.push({before,after});
  };
  change(replace,current);
  if(current===f.definition)throw new Error('Empty patch: '+name);
  edits.push({signature:signature(f),before:f.digest,after:md5(current),replacements});
 };
 const actorSelection=/select m\.organization_id into v_org\s+from public\.organization_memberships m[\s\S]*?limit 1;/i;
 const parentHelpers=extendParentReview(catalog,update);
 for(const phase of ['preview','execute'])for(const action of ['chi_luong','khoa_thang']){
  const staff=action==='chi_luong'?'v_staff_id':'v_first_staff';
  const org=phase==='preview'?'p_organization_id':'v_org';
  const account=action==='chi_luong'?'v_account':'NULL';
  update(`copilot_${phase}_salary_${action}_v1`,replace=>replace(`app_private.copilot_salary_org_of_staff_v1(${staff})`,
   `app_private.salary_subject_organization_v1(${staff},v_period,${account},${org})`));
 }
 update('get_or_create_deposit_account',(replace,current)=>replace(current,current.replaceAll(
  'WHERE user_id = auth.uid() AND deleted_at IS NULL AND NOT is_virtual',
  'WHERE organization_id = app_private.working_organization_v1() AND user_id = auth.uid() AND deleted_at IS NULL AND NOT is_virtual')));
 update('set_salary_v5_config',replace=>{
  replace('  SELECT rules INTO v_rules FROM public.salary_bonus_rules WHERE user_id = v_owner FOR UPDATE;',`  SELECT rules INTO v_rules FROM public.salary_bonus_rules
    WHERE user_id = v_owner AND organization_id = app_private.working_organization_v1() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cấu hình lương V5 này không thuộc công ty đang chọn' USING ERRCODE='42501'; END IF;`);
 });
 update('storage_object_link_maintain',replace=>replace(/declare[\s\S]*?end;/,
  readFileSync(new URL('./storage-upload-body.sql',import.meta.url),'utf8').trim()));
 for(const name of ['current_admin_org_v1','invite_organization_member_v1','upsert_organization_role_v1']){
  update(name,replace=>replace(actorSelection,'v_org := app_private.working_organization_v1();'));
 }
 update('lucky_admin_org_v1',replace=>replace(actorSelection,`v_org := app_private.working_organization_v1(false);
  if not exists (select 1 from public.organization_memberships m
    where m.user_id=auth.uid() and m.organization_id=v_org and m.status='ACTIVE'
      and m.member_type in ('OWNER','STAFF')) then return null; end if;`));
 update('get_authorization_context_v1',replace=>replace(actorSelection,`v_org := coalesce(p_organization_id,app_private.working_organization_v1(false));
  if not app_private.active_working_membership_v1(v_actor,v_org) then v_org := null; end if;`));
 for(const name of ['get_ie_auto_approve_threshold_v1','set_ie_auto_approve_threshold_v1']){
  update(name,replace=>replace(/select count\(distinct m\.organization_id\)[\s\S]*?if v_owner_org is not null then v_org := v_owner_org; end if;\s*end if;/i,
   'v_org := app_private.working_organization_v1();'));
 }
 update('create_cashbook_v1',replace=>replace(/if p_organization_id is not null then[\s\S]*?v_org_count using errcode='42501'; end if;\s*end if;/i,
  'v_org := coalesce(p_organization_id,app_private.working_organization_v1());'));
 update('create_finance_evidence_upload_intent_v2',replace=>replace(/SELECT m\.organization_id INTO v_org FROM public\.organization_memberships m\s*WHERE m\.user_id = auth\.uid\(\) AND m\.status = 'ACTIVE' LIMIT 1;/,
  'v_org := app_private.working_organization_v1();'));
 update('ie_compat_insert_v2',replace=>replace(/SELECT m\.organization_id INTO v_org\s*FROM public\.organization_memberships m\s*WHERE m\.user_id = auth\.uid\(\)\s*AND m\.status = 'ACTIVE'\s*LIMIT 1;/,
  'v_org := app_private.working_organization_v1();'));
 update('resolve_finance_actor_v2',replace=>replace(/SELECT count\(DISTINCT m\.organization_id\)[\s\S]*?LIMIT 1;/,
  'v_org := app_private.working_organization_v1();'),'');
 for(const name of ['set_sale_bonus_cap_v1','set_commission_tier_v1']){
  update(name,replace=>replace(/SELECT m\.organization_id INTO v_org FROM public\.organization_memberships m\s*WHERE m\.user_id = v_actor AND m\.status = 'ACTIVE' LIMIT 1;/i,
   'v_org := app_private.working_organization_v1();'));
 }
 for(const name of ['set_utility_ceiling_v1','set_maintenance_rule_v1']){
  update(name,replace=>replace(/\(SELECT m\.organization_id FROM public\.organization_memberships m\s*WHERE m\.user_id = v_actor AND m\.status='ACTIVE' LIMIT 1\)/,
   'app_private.working_organization_v1()'));
 }
 update('_autofill_org',replace=>{
  replace("  PROD constant uuid := 'aaaa0000-0000-4000-8000-000000000001';",'');
  replace("  -- Membership: CHỈ khi user thuộc đúng MỘT org ACTIVE (uuid-safe, không dùng min()).",`  -- Parent record identity wins. An authenticated root insert uses the chosen company.
  IF v IS NULL AND auth.uid() IS NOT NULL THEN v := app_private.working_organization_v1(); END IF;
  -- Background writers without an authenticated actor may use one unambiguous owner membership.`);
  replace(/  IF v IS NULL THEN\s*BEGIN\s*INSERT INTO public\.authorization_migration_exceptions[\s\S]*?v := PROD;\s*END IF;/,
   "  IF v IS NULL THEN RAISE EXCEPTION 'Không xác định được công ty cho bản ghi mới' USING ERRCODE='22023'; END IF;");
 });
 update('set_membership_status_v1',replace=>{
  replace('   where m.user_id = p_user_id',`   where m.user_id = p_user_id
     and m.organization_id = app_private.working_organization_v1()`);
  replace('  -- org: nơi người thao tác giữ role Chủ sở hữu tổ chức và đối tượng là thành viên',`  -- Serialize decisions about the last owner inside the selected organization.
  perform 1 from public.organizations where id=app_private.working_organization_v1() for update;
  -- Retain the existing owner/superadmin and self-change checks.`);
 });
 update('delete_staff_member',replace=>{
  replace('  v_sa int := 0; v_memb int := 0;', '  v_sa int := 0; v_memb int := 0; v_org uuid;');
  replace('  if p_staff_id = auth.uid() then', `  v_org := app_private.working_organization_v1();
  perform 1 from public.organizations where id=v_org for update;
  if p_staff_id = auth.uid() then`);
  replace('     where staff_id = p_staff_id and user_id = auth.uid()',
    '     where staff_id = p_staff_id and user_id = auth.uid() and organization_id = v_org');
  replace('  -- 1) gỡ phân công legacy (trigger a80 đóng role_binding chuẩn hoá)', `  -- A selected-company removal must retain the last effective owner.
  if exists (
    select 1 from public.role_bindings rb
    join public.organization_memberships m on m.id=rb.membership_id and m.organization_id=rb.organization_id
    join public.organization_roles r on r.id=rb.role_id and r.organization_id=rb.organization_id
    where rb.organization_id=v_org and m.user_id=p_staff_id and r.name='Chủ sở hữu tổ chức'
      and coalesce(rb.valid_from,'-infinity'::timestamptz)<=now() and (rb.valid_to is null or rb.valid_to>now())
  ) and not exists (
    select 1 from public.role_bindings rb
    join public.organization_memberships m on m.id=rb.membership_id and m.organization_id=rb.organization_id
    join public.organization_roles r on r.id=rb.role_id and r.organization_id=rb.organization_id
    where rb.organization_id=v_org and m.user_id<>p_staff_id and r.name='Chủ sở hữu tổ chức'
      and app_private.active_working_membership_v1(m.user_id,v_org)
      and coalesce(rb.valid_from,'-infinity'::timestamptz)<=now() and (rb.valid_to is null or rb.valid_to>now())
  ) then raise exception 'Không thể thu hồi CHỦ SỞ HỮU CUỐI CÙNG của công ty' using errcode='42501'; end if;
  -- 1) gỡ phân công legacy (trigger a80 đóng role_binding chuẩn hoá)`);
  replace('  delete from public.staff_assignments where staff_id = p_staff_id;',
    '  delete from public.staff_assignments where staff_id = p_staff_id and organization_id = v_org;');
  replace("   where user_id = p_staff_id and status <> 'REVOKED';",
    "   where user_id = p_staff_id and organization_id = v_org and status <> 'REVOKED';");
  replace('  delete from public.roles where user_id = p_staff_id;', `  delete from public.roles where user_id = p_staff_id
    and not exists (select 1 from public.organization_memberships m
      where m.user_id=p_staff_id and m.organization_id<>v_org and m.status<>'REVOKED');`);
  replace('   where exists (select 1 from public.organization_memberships m',
    '   where o.id=v_org and exists (select 1 from public.organization_memberships m');
 });
 update('salary_payout_v1',replace=>{
  replace(/  select organization_id into v_org from public\.manager_salary_config[\s\S]*?if v_org is null then raise exception 'Không xác định được tổ chức của nhân viên' using errcode='42501'; end if;/,
   '  v_org := app_private.salary_subject_organization_v1(p_staff_id,p_period_month,p_account_id);');
  replace('    -- P5: clamp về phần còn nợ (mirror legacy; tránh excess ngoài ý muốn).',`    if v_inv.organization_id is distinct from v_org then
      raise exception 'Hoá đơn khấu trừ không thuộc công ty của bảng lương' using errcode='42501'; end if;
    -- P5: clamp về phần còn nợ (mirror legacy; tránh excess ngoài ý muốn).`);
  replace('    organization_id   = coalesce(public.salary_monthly.organization_id, excluded.organization_id);',`    organization_id   = coalesce(public.salary_monthly.organization_id, excluded.organization_id)
  where public.salary_monthly.organization_id = excluded.organization_id;
  if not found then raise exception 'Bảng lương đã thuộc công ty khác' using errcode='40001'; end if;`);
 });
 update('lock_salary_month_v1',replace=>{
  replace(/    select organization_id into v_org from public\.manager_salary_config[\s\S]*?if v_org is null then raise exception 'Không xác định được tổ chức của nhân viên'; end if;/,
   '    v_org := app_private.salary_subject_organization_v1(v_first_staff,p_period_month);');
  replace('    -- mọi staff còn lại phải cùng org',`    -- Every persisted salary period, not only its staff membership, must match.
    if exists (select 1 from jsonb_array_elements(p_managers) mg
      where app_private.salary_subject_organization_v1(nullif(mg->>'staff_id','')::uuid,p_period_month) is distinct from v_org) then
      raise exception 'Danh sách bảng lương chứa công ty khác' using errcode='42501'; end if;
    if exists (select 1 from jsonb_array_elements(p_managers) mg
      cross join lateral jsonb_array_elements_text(coalesce(mg->'commission_voucher_ids','[]'::jsonb)) ids(id)
      join public.income_expenses ie on ie.id=nullif(ids.id,'')::uuid
      where ie.organization_id is distinct from v_org) then
      raise exception 'Phiếu hoa hồng không thuộc công ty của bảng lương' using errcode='42501'; end if;
    -- mọi staff còn lại phải cùng org`);
  replace('     where staff_id = v_staff and is_active = true','     where staff_id = v_staff and organization_id = v_org and is_active = true');
  replace('      select user_id into v_owner from public.super_admins order by created_at limit 1;',`      select (array_agg(distinct user_id))[1] into v_owner from public.organization_memberships
       where organization_id=v_org and member_type='OWNER'
         and app_private.active_working_membership_v1(user_id,v_org)
       having count(distinct user_id)=1;`);
  replace('    returning id into v_monthly_id;',`    where public.salary_monthly.organization_id = excluded.organization_id
    returning id into v_monthly_id;
    if not found then raise exception 'Bảng lương đã thuộc công ty khác' using errcode='40001'; end if;`);
 });
 update('unlock_salary_month_v1',replace=>{
  replace(/  select organization_id into v_org from public\.organization_memberships[\s\S]*?if v_org is null then raise exception 'Không xác định được tổ chức của nhân viên'; end if;/,
   `  v_org := app_private.salary_subject_organization_v1(p_staff_ids[1],p_period_month);
  if exists (select 1 from unnest(p_staff_ids) ids(staff_id)
    where app_private.salary_subject_organization_v1(ids.staff_id,p_period_month) is distinct from v_org) then
    raise exception 'Danh sách bảng lương chứa công ty khác' using errcode='42501'; end if;`);
  replace("   where period_month = p_period_month and staff_id = any(p_staff_ids) and status = 'LOCKED'",
   "   where organization_id = v_org and period_month = p_period_month and staff_id = any(p_staff_ids) and status = 'LOCKED'");
  replace('   where period_month = p_period_month\n     and staff_id = any(p_staff_ids)',
   '   where organization_id = v_org and period_month = p_period_month\n     and staff_id = any(p_staff_ids)');
 });
 for(const name of ['pay_utility_bill','pay_period_fee'])update(name,replace=>{
  if(name==='pay_utility_bill')replace("public._termination_ensure_type(v_owner, 'expense', v_type_nm)","app_private.ensure_termination_type_in_org_v1(v_owner, 'expense', v_type_nm,v_org)");
  else replace('public.resolve_fixed_expense_type(v_owner, p_category_key)','app_private.resolve_fixed_expense_type_in_org_v1(v_owner, p_category_key,v_org)');
  replace('WHERE id = p_account_id AND deleted_at IS NULL','WHERE id = p_account_id AND organization_id = v_org AND deleted_at IS NULL');
  replace("WHERE user_id = auth.uid() AND deleted_at IS NULL AND btrim(name) LIKE '%Thu'",
   "WHERE user_id = auth.uid() AND organization_id = v_org AND deleted_at IS NULL AND btrim(name) LIKE '%Thu'");
  if(name==='pay_period_fee')replace('JOIN accounts a ON a.id = fa.default_account_id AND a.deleted_at IS NULL',
   'JOIN accounts a ON a.id = fa.default_account_id AND a.organization_id = v_org AND a.deleted_at IS NULL');
 });
 for(const name of ['adopt_voucher_attachments_as_evidence_v2','finalize_finance_evidence_v2'])update(name,replace=>{
  const adopt=name==='adopt_voucher_attachments_as_evidence_v2';
  const call=adopt?'PERFORM app_private.bind_finance_storage_org_v1(v_ie.organization_id,v_bucket,v_object);':'PERFORM app_private.bind_finance_storage_org_v1(v_row.organization_id,v_row.bucket_id,v_row.object_name);';
  const bucket=adopt?'v_bucket':'v_row.bucket_id';
  replace(/INSERT INTO app_private\.storage_object_links[\s\S]*?ON CONFLICT DO NOTHING;/,
   before=>`IF ${bucket} = 'income-expense-attachments' THEN ${call} ELSE ${before} END IF;`);
  if(adopt)replace("IF v_row.state <> 'FINALIZED' THEN",`IF v_bucket = 'income-expense-attachments' AND v_row.state = 'ATTACHED' THEN
      ${call}
    END IF;
    IF v_row.state <> 'FINALIZED' THEN`);
  else replace("IF v_row.state = 'FINALIZED' THEN",`IF v_row.state = 'FINALIZED' THEN
    IF v_row.bucket_id = 'income-expense-attachments' THEN ${call} END IF;`);
 });
 const imageDraft=readFileSync(new URL('../attachment-access/durable-fix.review.sql',import.meta.url),'utf8');
 const imageHelpers=imageDraft.slice(imageDraft.indexOf('CREATE OR REPLACE FUNCTION'),imageDraft.indexOf('-- Surgical replacements'));
 if(!imageHelpers||imageHelpers.includes('BEGIN;'))throw new Error('Unexpected image helper source');
 const helpers=readFileSync(new URL('./working-organization.sql',import.meta.url),'utf8')+'\n'+imageHelpers;
 const helperBodies=[...helpers.matchAll(/AS \$(fn|bind|parent)\$([\s\S]*?)\$\1\$;/g)].map(x=>x[2]);
 const helperSignatures=['app_private.active_working_membership_v1(uuid,uuid)','app_private.working_organization_v1(boolean)','app_private.salary_subject_organization_v1(uuid,date,uuid,uuid)',
  'app_private.bind_finance_storage_org_v1(uuid,text,text)','app_private.bind_voucher_attachment_links_v1()'];
 if(helperBodies.length!==helperSignatures.length)throw new Error('Unexpected helper inventory');
 for(const helper of parentHelpers){helperBodies.push(helper.body);helperSignatures.push(helper.signature);}
 const sql=['-- REVIEW ONLY. Production application requires the reviewed migration lane and a fresh full backup.','BEGIN;','SET LOCAL search_path=pg_catalog,public;','SET LOCAL lock_timeout=\'5s\';','SET LOCAL statement_timeout=\'60s\';'];
 helperSignatures.forEach((sig,i)=>sql.push(`DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(${literal(sig)}) AND md5(prosrc)<>${literal(md5(helperBodies[i]))}) THEN
    RAISE EXCEPTION 'Existing helper differs from reviewed body: %',${literal(sig)};
  END IF;
END $guard$;`));
 sql.push(helpers);
 sql.push(...parentHelpers.map(h=>h.sql));
 for(const edit of edits){
  sql.push(`-- ${edit.signature}\nDO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(${literal(edit.signature)}::regprocedure);
  IF md5(definition) = ${literal(edit.after)} THEN RETURN; END IF;
  IF md5(definition) <> ${literal(edit.before)} THEN RAISE EXCEPTION 'Live function changed: %',${literal(edit.signature)}; END IF;
${edit.replacements.map(r=>`  definition := replace(definition,${literal(r.before)},${literal(r.after)});`).join('\n')}
  IF md5(definition) <> ${literal(edit.after)} THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;`);
 }
 for(const table of ['buildings','areas','building_utility_accounts']){
  const existing=catalog.triggers.filter(t=>t.schema==='public'&&t.table===table).sort((a,b)=>a.name.localeCompare(b.name));
  if(existing.some(t=>t.name==='a10_working_organization_insert'))throw new Error('Trigger already exists in baseline: '+table);
  const expected=md5(existing.map(t=>t.definition).join('\n'));
  const create=`CREATE TRIGGER a10_working_organization_insert BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION public._autofill_org()`;
  sql.push(`DO $trigger_guard$ DECLARE actual text; BEGIN
  SELECT pg_get_triggerdef(oid) INTO actual FROM pg_trigger WHERE tgrelid='public.${table}'::regclass AND tgname='a10_working_organization_insert';
  IF actual IS NOT NULL THEN
    IF actual<>${literal(create.replace('FUNCTION public._autofill_org','FUNCTION _autofill_org'))} THEN RAISE EXCEPTION 'Existing organization trigger differs'; END IF;
    RETURN;
  END IF;
  SELECT md5(coalesce(string_agg(pg_get_triggerdef(oid),E'\\n' ORDER BY tgname),'')) INTO actual
    FROM pg_trigger WHERE tgrelid='public.${table}'::regclass AND NOT tgisinternal;
  IF actual<>${literal(expected)} THEN RAISE EXCEPTION 'Live triggers changed on public.${table}'; END IF;
  EXECUTE ${literal(create)};
END $trigger_guard$;`);
 }
 sql.push('ROLLBACK;');
 return {sql:sql.join('\n\n')+'\n',changes:edits.map(({replacements,...identity})=>({...identity,replacements:replacements.length}))};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const [, ,catalogFile,output]=process.argv;
 if(!catalogFile||!output)throw new Error('Usage: node build-review.mjs LOCAL_CATALOG_JSON OUTPUT_REVIEW_SQL');
 const result=buildReview(JSON.parse(readFileSync(catalogFile,'utf8')));
 writeFileSync(output,result.sql);
 writeFileSync(output+'.changes.json',JSON.stringify(result.changes,null,2));
 console.log(JSON.stringify({output,functions:result.changes.length,reviewOnly:true}));
}

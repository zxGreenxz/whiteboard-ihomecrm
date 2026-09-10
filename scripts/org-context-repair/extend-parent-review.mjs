// Existing-record workflows use their persisted company throughout nested helpers.
// All replacements are applied by the caller's live-definition hash guard.
export function extendParentReview(catalog,update){
 const helpers=[];
 const get=name=>{const rows=catalog.functions.filter(f=>f.name===name);if(rows.length!==1)throw new Error('Ambiguous helper '+name);return rows[0].definition;};
 const once=(s,a,b)=>{if(s.split(a).length!==2)throw new Error('Parent helper replacement is not unique: '+a);return s.replace(a,b);};
 const guard=`
  IF p_org IS NULL THEN RAISE EXCEPTION 'Dữ liệu gốc chưa có công ty' USING ERRCODE='22023'; END IF;
  IF auth.uid() IS NOT NULL AND NOT app_private.active_working_membership_v1(auth.uid(),p_org) THEN
    RAISE EXCEPTION 'Không có quyền trong công ty của dữ liệu gốc' USING ERRCODE='42501'; END IF;`;
 function clone(name,newName,argTypes,change){
  let s=get(name).replace(/\r\n/g,'\n');
  const header=s.slice(0,s.indexOf('\n'));
  s=once(s,header,header.replace('public.'+name,'app_private.'+newName).replace(/\)$/,', p_org uuid)'));
  s=change(s);
  s=s.replace(/\bBEGIN\s*\n/i,m=>m+guard+'\n');
  const signature=`app_private.${newName}(${argTypes},uuid)`;
  const body=s.slice(s.indexOf('AS $function$')+'AS $function$'.length,s.lastIndexOf('$function$'));
  helpers.push({signature,body,sql:s.trim().replace(/;$/,'')+`;\nREVOKE ALL ON FUNCTION ${signature} FROM PUBLIC,anon,authenticated,service_role;`});
 }
 clone('_termination_ensure_type','ensure_termination_type_in_org_v1','uuid,text,text',s=>{
  const start=s.indexOf('  -- org của người thao tác:');
  const end=s.indexOf('  -- (1) TRA THEO ĐÚNG PHẠM VI');
  if(start<0||end<start)throw new Error('Missing type derivation boundaries');
  s=once(s,s.slice(start,end),'  v_org := p_org;\n\n');
  const legacy=s.indexOf('  -- (2) Nhánh cũ');
  const insert=s.indexOf('  insert into income_expense_types',legacy);
  if(legacy<0||insert<legacy)throw new Error('Missing legacy type boundaries');
  return once(s,s.slice(legacy,insert),'  -- Unclassified historical types are not claimed without parent proof.\n');
 });
 clone('resolve_fixed_expense_type','resolve_fixed_expense_type_in_org_v1','uuid,text',s=>once(s,
  'v_organization_id := app_private.resolve_ie_type_org_for_user_v1(p_owner);','v_organization_id := p_org;'));
 clone('_chung_building','chung_building_in_org_v1','uuid',s=>{
  s=once(s,"WHERE b.is_virtual = true AND b.deleted_at IS NULL","WHERE b.organization_id = p_org AND b.is_virtual = true AND b.deleted_at IS NULL");
  s=once(s,"WHERE user_id = p_user_id AND is_virtual = true AND name = 'Chung'","WHERE organization_id = p_org AND user_id = p_user_id AND is_virtual = true AND name = 'Chung'");
  s=once(s,'INSERT INTO buildings (user_id, name,','INSERT INTO buildings (organization_id, user_id, name,');
  return once(s,"VALUES (p_user_id, 'Chung'","VALUES (p_org, p_user_id, 'Chung'");
 });
 for(const [name,newName] of [['_deposit_account','deposit_account_in_org_v1'],['_internal_settlement_account','internal_settlement_account_in_org_v1']])clone(name,newName,'uuid',s=>{
  s=once(s,'WHERE user_id = p_user_id AND deleted_at IS NULL','WHERE organization_id = p_org AND user_id = p_user_id AND deleted_at IS NULL');
  s=once(s,'INSERT INTO accounts (user_id, name,','INSERT INTO accounts (organization_id, user_id, name,');
  return once(s,'VALUES (p_user_id,','VALUES (p_org, p_user_id,');
 });
 const wrappers=[
  ['_termination_ensure_type','ensure_termination_type_in_org_v1','p_user_id,p_type,p_name'],
  ['resolve_fixed_expense_type','resolve_fixed_expense_type_in_org_v1','p_owner,p_category_key'],
  ['_chung_building','chung_building_in_org_v1','p_user_id'],
  ['_deposit_account','deposit_account_in_org_v1','p_user_id'],
  ['_internal_settlement_account','internal_settlement_account_in_org_v1','p_user_id'],
 ];
 for(const [name,target,args] of wrappers)update(name,(replace,current)=>{
  const body=current.slice(current.indexOf('AS $function$')+'AS $function$'.length,current.lastIndexOf('$function$'));
  replace(body,`\nBEGIN RETURN app_private.${target}(${args},app_private.working_organization_v1()); END;\n`);
 });
 const nested=(definition,org)=>definition
  .replace(/public\._termination_ensure_type\(([^;]+?)\);/g,`app_private.ensure_termination_type_in_org_v1($1,${org});`)
  .replace(/public\._internal_settlement_account\(([^)]+)\)/g,`app_private.internal_settlement_account_in_org_v1($1,${org})`)
  .replace(/public\._deposit_account\(([^)]+)\)/g,`app_private.deposit_account_in_org_v1($1,${org})`)
  .replace(/public\._chung_building\(([^)]+)\)/g,`app_private.chung_building_in_org_v1($1,${org})`);
 for(const [name,org] of [
  ['terminate_contract_forfeit_impl','v_contract.organization_id'],
  ['terminate_contract_move_out_impl','v_contract.organization_id'],
  ['_ensure_initial_deposit_voucher','v_c.organization_id'],
  ['create_opening_adjustment','v_acc.organization_id'],
 ])update(name,(replace,current)=>replace(current,nested(current,org)));
 update('confirm_cash_handover',(replace,current)=>{
  let s=nested(current,'v_h.organization_id');
  s=once(s,'WHERE id = p_to_account_id AND user_id = auth.uid() AND deleted_at IS NULL','WHERE id = p_to_account_id AND organization_id = v_h.organization_id AND user_id = auth.uid() AND deleted_at IS NULL');
  s=once(s,"WHERE user_id = auth.uid() AND deleted_at IS NULL AND btrim(name) LIKE '%Thu'","WHERE organization_id = v_h.organization_id AND user_id = auth.uid() AND deleted_at IS NULL AND btrim(name) LIKE '%Thu'");
  s=once(s,'AND ie.account_id = v_h.from_account_id;','AND ie.account_id = v_h.from_account_id AND ie.organization_id = v_h.organization_id;');
  replace(current,s);
 });
 update('_termination_pick_account',(replace,current)=>{
  let s=current.replaceAll('AND a.deleted_at IS NULL AND a.is_virtual = false','AND a.organization_id = b.organization_id AND a.deleted_at IS NULL AND a.is_virtual = false');
  s=once(s,'(SELECT name FROM buildings WHERE id = p_building_id) bld','(SELECT name,organization_id FROM buildings WHERE id = p_building_id) bld');
  s=once(s,'WHERE a.user_id = p_user_id','WHERE a.user_id = p_user_id AND a.organization_id = bld.organization_id');
  replace(current,s);
 });
 return helpers;
}

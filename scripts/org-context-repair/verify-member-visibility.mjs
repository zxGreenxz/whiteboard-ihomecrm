import assert from 'node:assert/strict';
export async function verifyMemberVisibility(db,{orgA,orgB,actor,withAdminResolver=true}){
 await db.exec('BEGIN');
 try{
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('fixture.super_admin','false',true),set_config('request.headers',$2,true)",[actor,JSON.stringify({'x-ihomecrm-organization-id':orgB})]);
  await db.exec("DELETE FROM permission_definitions WHERE key='users.view'; INSERT INTO permission_definitions(key,permission_domain,is_active,scope_kinds,requires_cashbook_possession) VALUES('users.view','TENANT',true,ARRAY['ORGANIZATION'],false)");
  const role='00000000-0000-4000-8020-000000000001',scope='00000000-0000-4000-8020-000000000002',binding='00000000-0000-4000-8020-000000000003';
  await db.query("INSERT INTO organization_roles(id,organization_id,name,status) VALUES($1,$2,'Viewer fixture','ACTIVE')",[role,orgA]);
  await db.query("INSERT INTO role_permissions(organization_id,role_id,permission_key,effect) VALUES($1,$2,'users.view','ALLOW')",[orgA,role]);
  await db.query("INSERT INTO role_bindings(id,organization_id,membership_id,role_id,valid_from) SELECT $1,$2,id,$3,now() FROM organization_memberships WHERE user_id=$4 AND organization_id=$2",[binding,orgA,role,actor]);
  await db.query("INSERT INTO authorization_scopes(id,organization_id,scope_type) VALUES($1,$2,'ORGANIZATION')",[scope,orgA]);
  await db.query('INSERT INTO role_binding_scopes(organization_id,role_binding_id,scope_id) VALUES($1,$2,$3)',[orgA,binding,scope]);
  const visible=async org=>(await db.query("SELECT app_private.has_any_scope_for_org_v1('users.view',$1) allowed",[org])).rows[0].allowed;
  assert.equal((await db.query("SELECT app_private.has_any_scope_v3('users.view') allowed")).rows[0].allowed,true,'Old global permission witness is true from company A');
  assert.equal(await visible(orgA),true);
  assert.equal(await visible(orgB),false,'Permission in A cannot admit membership visibility in B');
  if(withAdminResolver){
   assert.equal((await db.query('SELECT app_private.current_admin_org_v1() org')).rows[0].org,null,'Normal member cannot read the selected foreign company directory');
   await db.query("SELECT set_config('request.headers',$1,true)",[JSON.stringify({'x-ihomecrm-organization-id':orgA})]);
   assert.equal((await db.query('SELECT app_private.current_admin_org_v1() org')).rows[0].org,orgA);
  }
  await db.query("INSERT INTO app_private.tenant_emergency_denies(organization_id,permission_key,active_from) VALUES($1,'users.view',now())",[orgA]);
  assert.equal(await visible(orgA),false,'Existing emergency deny remains effective inside the company');
  if(withAdminResolver){
   await db.query("SELECT set_config('fixture.super_admin','true',true),set_config('request.headers',$1,true)",[JSON.stringify({'x-ihomecrm-organization-id':orgB})]);
   assert.equal((await db.query('SELECT app_private.current_admin_org_v1() org')).rows[0].org,orgB,'The existing platform-admin bypass is preserved for an active selected membership');
  }
  for(const roleName of ['anon','authenticated','service_role'])assert.equal((await db.query("SELECT has_function_privilege($1,'app_private.has_any_scope_for_org_v1(text,uuid)','EXECUTE') allowed",[roleName])).rows[0].allowed,false);
  return {memberVisibilityCompanyScoped:true,existingEmergencyDenyPreserved:true,platformAdminBypassVerified:withAdminResolver};
 }finally{await db.exec('ROLLBACK');}
}

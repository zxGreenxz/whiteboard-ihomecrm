// Current database helpers and authenticated/JWT role. All fixture writes target
// DEMO and roll back in finally, including scoped overrides on existing members.
// DATABASE_URL targets the configured project. No schema changes or PII output.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const demoOrg='dddd0000-0000-4000-8000-000000000001';
const connection=new URL(process.env.DATABASE_URL??'');
assert.equal(connection.hostname,'aws-1-ap-southeast-1.pooler.supabase.com');
assert.equal(decodeURIComponent(connection.username),'postgres.tryymsxyyckgbrmmvozx');
assert.equal(connection.pathname,'/postgres');
const client=new pg.Client({connectionString:connection.toString(),ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
await client.connect();
const building=randomUUID();
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='3s'");
  const actors=(await client.query(`SELECT m.user_id,m.id membership_id FROM public.organization_memberships m
    JOIN auth.users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.status='ACTIVE'
    AND (m.valid_to IS NULL OR m.valid_to>now()) ORDER BY m.id LIMIT 3`,[demoOrg])).rows;
  assert.equal(actors.length,3,'Need three active DEMO actors; no auth users are created');
  const [creator,printer,editor]=actors;
  const outsider=(await client.query(`SELECT m.user_id FROM public.organization_memberships m JOIN auth.users u ON u.id=m.user_id
    WHERE m.organization_id<>$1 AND m.status='ACTIVE' AND coalesce(m.valid_from,'-infinity')<=now()
    AND (m.valid_to IS NULL OR m.valid_to>now()) AND NOT EXISTS (
      SELECT 1 FROM public.organization_memberships d WHERE d.user_id=m.user_id AND d.organization_id=$1)
    ORDER BY m.id LIMIT 1`,[demoOrg])).rows[0];
  assert(outsider,'Need an actor outside DEMO; their data is read only');
  await client.query(`INSERT INTO public.buildings(id,organization_id,user_id,name,province,district,ward,street_address)
    VALUES($1,$2,$3,'CT01 OWNER ROLLBACK FIXTURE','Hồ Chí Minh','','Phường kiểm thử','123 Kiểm thử')`,[building,demoOrg,creator.user_id]);
  const scope=randomUUID();
  await client.query(`INSERT INTO public.authorization_scopes(id,organization_id,scope_type,building_id) VALUES($1,$2,'BUILDING',$3)`,[scope,demoOrg,building]);
  const grant=async(actor,key,effect)=>{
    const id=randomUUID();
    await client.query(`INSERT INTO public.member_permission_overrides(id,organization_id,membership_id,permission_key,effect,reason,scope_mode)
      VALUES($1,$2,$3,$4,$5,'CT01 transaction-only permission fixture','SCOPED')`,[id,demoOrg,actor.membership_id,key,effect]);
    await client.query(`INSERT INTO public.member_override_scopes(organization_id,override_id,scope_id) VALUES($1,$2,$3)`,[demoOrg,id,scope]);
  };
  for(const actor of actors) await grant(actor,'buildings.view','ALLOW');
  await grant(creator,'buildings.create','ALLOW'); await grant(creator,'buildings.edit','DENY');
  await grant(printer,'customers.print','ALLOW'); await grant(printer,'buildings.edit','DENY');
  await grant(editor,'buildings.edit','ALLOW');
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  const asActor=async actor=>{
    await client.query('RESET ROLE');
    await client.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[actor,JSON.stringify({sub:actor,role:'authenticated'})]);
    await client.query('SET LOCAL ROLE authenticated');
  };
  const save=owner=>client.query('SELECT public.save_building_legal_owner($1,$2)',[building,owner]);
  const read=()=>client.query('SELECT id_number FROM public.building_legal_owners WHERE building_id=$1',[building]);
  const denied=async action=>{
    await client.query('SAVEPOINT deny_check');let code;
    try{await action();}catch(error){code=error.code;}
    await client.query('ROLLBACK TO SAVEPOINT deny_check');
    assert.equal(code,'42501','Expected permission denied');
  };
  const owner={full_name:'FIXTURE OWNER ROLLBACK',id_number:'001122334455'};
  await asActor(creator.user_id);
  assert.deepEqual((await client.query("SELECT public.can_access_building($1) access,public.can_do_on_building('buildings','create',$1) can_create,public.can_do_on_building('buildings','edit',$1) can_edit",[building])).rows[0],{access:true,can_create:true,can_edit:false});
  await save(owner);await save(owner);await denied(()=>save({...owner,full_name:'CHANGED'}));
  await asActor(printer.user_id);
  assert.equal((await client.query("SELECT public.can_do_on_building('customers','print',$1) allowed",[building])).rows[0].allowed,true);
  assert.equal((await client.query("SELECT public.can_do_on_building('buildings','edit',$1) allowed",[building])).rows[0].allowed,false);
  assert.equal((await read()).rows[0].id_number,'001122334455');await denied(()=>save({...owner,full_name:'FORBIDDEN'}));
  await asActor(outsider.user_id);
  assert.equal((await client.query('SELECT public.can_access_building($1) allowed',[building])).rows[0].allowed,false);
  assert.equal((await read()).rowCount,0);await denied(()=>save(owner));
  await asActor(editor.user_id);
  assert.equal((await client.query("SELECT public.can_do_on_building('buildings','edit',$1) allowed",[building])).rows[0].allowed,true);
  await save({...owner,full_name:'EDITOR ROLLBACK'});assert.equal((await read()).rowCount,1);
  for(const sql of ['UPDATE public.building_legal_owners SET full_name=full_name WHERE building_id=$1','DELETE FROM public.building_legal_owners WHERE building_id=$1'])await denied(()=>client.query(sql,[building]));
  assert.equal((await client.query("SELECT has_table_privilege(current_user,'public.building_legal_owners','TRUNCATE') allowed")).rows[0].allowed,false);
  await denied(()=>client.query('INSERT INTO public.building_legal_owners(building_id,organization_id) VALUES($1,$2)',[building,demoOrg]));
  await client.query('RESET ROLE');await client.query('SET LOCAL ROLE anon');
  await denied(()=>read());await denied(()=>save(owner));
  console.log('PASS current live helpers/JWT: creator retry, printer, editor, cross-org, anon and direct DML ACL');
}finally{
  await client.query('ROLLBACK');
  assert.equal((await client.query('SELECT 1 FROM public.buildings WHERE id=$1',[building])).rowCount,0,'Fixture rolled back');
  await client.end();
  console.log('ROLLBACK verified: no fixture building or scoped grants persisted');
}

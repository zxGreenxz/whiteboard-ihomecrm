// Synthetic records on an explicitly named disposable loopback database.
// Action calls use the real restored authorization functions and authenticated
// DB role; this does not replace an HTTP JWT verification test.
import pg from 'pg';
import { randomUUID } from 'node:crypto';

export function saleQuickLocalUrl() {
  const value = process.env.SALE_QUICK_TEST_DATABASE_URL;
  if (!value) throw new Error('Set SALE_QUICK_TEST_DATABASE_URL to an isolated local sale_quick_* database.');
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || !/^\/sale_quick_[a-z0-9_]+$/.test(url.pathname)) {
    throw new Error('Only disposable loopback sale_quick_* databases are accepted.');
  }
  return value;
}
export async function saleQuickClient(actor = null) {
  const db = new pg.Client({ connectionString: saleQuickLocalUrl() });
  await db.connect();
  await db.query("SET statement_timeout = '20s'");
  if (actor) {
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [actor]);
    await db.query("SELECT set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: actor, role: 'authenticated' })]);
    await db.query('SET ROLE authenticated');
  }
  return db;
}
export async function seedSaleQuickFixture() {
  const db = await saleQuickClient();
  const id = () => randomUUID();
  const f = {
    org: id(), otherOrg: id(), buildings: [id(), id(), id()], rooms: [id(), id(), id(), id()],
    actors: Object.fromEntries(['landlord','company','manager','saleAdmin','sale','other'].map(role => [role,id()])),
    memberships: {}, roles: {},
  };
  try {
    // The baseline restore intentionally supplies NULL-returning auth stubs.
    // Replace only that platform stub with request claims for local role tests.
    // Never replace an application permission function.
    const authBody=(await db.query("SELECT prosrc FROM pg_proc WHERE oid='auth.uid()'::regprocedure")).rows[0].prosrc.trim();
    if (/^SELECT NULL::uuid$/i.test(authBody)) {
      await db.query(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
        CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
        $$SELECT nullif(current_setting('request.jwt.claims',true),'')::jsonb$$;
        GRANT USAGE ON SCHEMA auth TO authenticated,anon;`);
    }
    await db.query('BEGIN');
    // Fixture import only: no application code disables triggers.
    await db.query('SET LOCAL session_replication_role = replica');
    for (const [role,user] of Object.entries(f.actors)) {
      await db.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [user,`${role}-${user}@example.invalid`]);
      await db.query('INSERT INTO public.profiles(id,full_name) VALUES($1,$2)', [user,`Local ${role}`]);
    }
    for (const [org,user] of [[f.org,f.actors.landlord],[f.otherOrg,f.actors.other]]) {
      await db.query("INSERT INTO public.organizations(id,slug,name,status,created_by) VALUES($1,$2,'Sale quick local','ACTIVE',$3)", [org,`sale-local-${org}`,user]);
    }
    const keys = ['buildings.view','rooms.view','rooms.edit','sale_phong.view','sale_phong.manage_images',
      'sale_phong.manage_pass_listings','sale_phong.lock_room','deposits.view','deposits.create','deposits.edit',
      'income_expenses.view','income_expenses.create','income_expenses.approve'];
    for (const key of keys) {
      await db.query(`INSERT INTO public.permission_definitions(key,resource,action,sensitivity,permission_domain,scope_kinds,is_active)
        VALUES($1,$2,$3,$4,'TENANT',ARRAY['ORGANIZATION','AREA','BUILDING'],true) ON CONFLICT(key) DO NOTHING`,
      [key,...key.split('.'),key.endsWith('.view')?'VIEW':'MANAGE']);
    }
    for (let i=0;i<3;i++) {
      await db.query(`INSERT INTO public.buildings(id,organization_id,user_id,name,province,district,ward,street_address,is_virtual)
        VALUES($1,$2,$3,$4,'Local','Local','Local','Đường thử nghiệm',false)`,
      [f.buildings[i],i===2?f.otherOrg:f.org,i===2?f.actors.other:f.actors.landlord,`Tòa local ${i+1}`]);
    }
    for (let i=0;i<4;i++) {
      const b=i<2?0:i-1;
      await db.query(`INSERT INTO public.rooms(id,organization_id,building_id,name,status,rent_price,deposit_amount,floor,sale_bonus_note)
        VALUES($1,$2,$3,$4,$5,3000000,3000000,1,'Nội bộ thử nghiệm')`,
      [f.rooms[i],b===2?f.otherOrg:f.org,f.buildings[b],String(101+i),i===1?'OCCUPIED':'AVAILABLE']);
    }
    const scopes=new Map();
    for (const [role,user] of Object.entries(f.actors)) {
      const org=role==='other'?f.otherOrg:f.org, membership=id(), roleId=id(), binding=id();
      f.memberships[role]=membership; f.roles[role]=roleId;
      await db.query(`INSERT INTO public.organization_memberships(id,organization_id,user_id,member_type,status)
        VALUES($1,$2,$3,$4,'ACTIVE')`,[membership,org,user,['landlord','company','other'].includes(role)?'OWNER':'STAFF']);
      await db.query('INSERT INTO public.organization_roles(id,organization_id,name) VALUES($1,$2,$3)',[roleId,org,`Local ${role}`]);
      await db.query('INSERT INTO public.role_bindings(id,organization_id,membership_id,role_id) VALUES($1,$2,$3,$4)',[binding,org,membership,roleId]);
      const wide=['landlord','company','other'].includes(role);
      const scopeKey=`${org}:${wide?'org':f.buildings[0]}`;
      let scope=scopes.get(scopeKey);
      if (!scope) {
        scope=id(); scopes.set(scopeKey,scope);
        await db.query('INSERT INTO public.authorization_scopes(id,organization_id,scope_type,building_id) VALUES($1,$2,$3,$4)',
          [scope,org,wide?'ORGANIZATION':'BUILDING',wide?null:f.buildings[0]]);
      }
      await db.query('INSERT INTO public.role_binding_scopes(organization_id,role_binding_id,scope_id) VALUES($1,$2,$3)',[org,binding,scope]);
      const permissions=role==='sale'?['buildings.view','sale_phong.view','sale_phong.lock_room']
        :role==='saleAdmin'?['buildings.view','sale_phong.view','sale_phong.manage_images','sale_phong.manage_pass_listings','deposits.create','income_expenses.create']
          :keys;
      for (const key of permissions) await db.query('INSERT INTO public.role_permissions(organization_id,role_id,permission_key) VALUES($1,$2,$3)',[org,roleId,key]);
    }
    await db.query('COMMIT');
    return f;
  } catch (error) {
    await db.query('ROLLBACK'); throw error;
  } finally { await db.end(); }
}

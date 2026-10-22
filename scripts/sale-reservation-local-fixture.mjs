import {randomUUID} from 'node:crypto';
import {saleQuickClient,seedSaleQuickFixture} from './sale-quick-local-fixture.mjs';

/** Synthetic extension; each invocation owns a distinct org and every record. */
export async function seedSaleReservationFixture() {
  const f=await seedSaleQuickFixture(),db=await saleQuickClient();
  Object.assign(f,{customer:randomUUID(),account:randomUUID(),depositType:randomUUID(),extraRooms:Array.from({length:5},()=>randomUUID())});
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL session_replication_role=replica');
    await db.query(`INSERT INTO app_private.server_feature_flags(feature_key,domain,mode,commit_sha,migration_sha256,maintenance_window_id,approval_reference)
      VALUES('income_expense.create_draft.v1','income_expenses','ON','LOCAL_TEST','LOCAL_TEST','LOCAL_TEST','LOCAL_TEST')
      ON CONFLICT(feature_key) DO NOTHING`);
    await db.query(`INSERT INTO customers(id,user_id,organization_id,full_name,phone)
      VALUES($1,$2,$3,'Khách kiểm thử cọc local',$4)`,[f.customer,f.actors.landlord,f.org,'09'+String(parseInt(f.customer.slice(0,8),16)).slice(-8).padStart(8,'0')]);
    await db.query(`INSERT INTO accounts(id,user_id,organization_id,name,code,is_virtual)
      VALUES($1,$2,$3,'Quỹ kiểm thử cọc local',$4,false)`,[f.account,f.actors.landlord,f.org,'LOCAL-'+f.account.slice(0,8)]);
    await db.query(`INSERT INTO income_expense_types(id,user_id,organization_id,name,type,is_deposit)
      VALUES($1,$2,$3,'Cọc kiểm thử local','income',true)`,[f.depositType,f.actors.landlord,f.org]);
    for(const [index,room] of f.extraRooms.entries())await db.query(`INSERT INTO rooms(id,organization_id,building_id,name,status,rent_price,deposit_amount,floor)
      VALUES($1,$2,$3,$4,'AVAILABLE',3000000,3000000,1)`,[room,f.org,f.buildings[0],`LOCAL-${index+1}`]);
    for(const role of ['sale','saleAdmin']) {
      for(const permission of ['deposits.create','deposits.view','income_expenses.create','income_expenses.view'])
        await db.query(`INSERT INTO role_permissions(organization_id,role_id,permission_key) VALUES($1,$2,$3)
          ON CONFLICT DO NOTHING`,[f.org,f.roles[role],permission]);
      // The restored canonical money writer still consumes this legacy witness
      // graph as well as normalized permissions. Seed matching scope, not a
      // replacement authorizer or organization-wide shortcut.
      const legacyRole=randomUUID();
      await db.query(`INSERT INTO roles(id,user_id,organization_id,name,permissions)
        VALUES($1,$2,$3,$4,$5)`,[legacyRole,f.actors.landlord,f.org,`Local money ${role}`,
        {income_expenses:{create:true,view:true}}]);
      await db.query(`INSERT INTO staff_assignments(staff_id,role_id,building_id,user_id,organization_id)
        VALUES($1,$2,$3,$4,$5)`,[f.actors[role],legacyRole,f.buildings[0],f.actors.landlord,f.org]);
    }
    for(const [role,kind] of [['landlord','CUSTODIAN'],['sale','KNOWER'],['saleAdmin','KNOWER']])
      await db.query(`INSERT INTO cashbook_possession_bindings(organization_id,cashbook_id,membership_id,possession_kind,granted_by,reason)
        VALUES($1,$2,$3,$4,$5,'Local synthetic test')`,[f.org,f.account,f.memberships[role],kind,f.actors.landlord]);
    await db.query('COMMIT');
    const {rows:[dates]}=await db.query(`SELECT public.org_today_v1($1)::text today,
      (public.org_today_v1($1)+2)::text topup,(public.org_today_v1($1)+7)::text deadline,
      (public.org_today_v1($1)+10)::text extension`,[f.org]);
    return {...f,...dates};
  }catch(error){await db.query('ROLLBACK');throw error;}
  finally{await db.end();}
}

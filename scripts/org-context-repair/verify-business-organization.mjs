import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

export async function verifyBusinessOrganization(db,snapshot,{orgA,orgB,actor,verifySettings=true}) {
 const plans=JSON.parse(readFileSync(new URL('./business-organization-tables.json',import.meta.url),'utf8'));
 const parentTables=[...new Set(plans.flatMap(([,parents])=>parents.map(([,table])=>table)))];
 const ids=new Map(parentTables.map((table,i)=>[table,[0,1].map(side=>'00000000-0000-4000-8010-'+String(i*2+side+1).padStart(12,'0'))]));
 const header=org=>db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.headers',$2,false)",[actor,JSON.stringify(org?{'x-ihomecrm-organization-id':org}:{})]);
 await db.exec('BEGIN');
 try {
  await header(orgB);
  for(const [table,pair] of ids) {
   for(const [side,id] of pair.entries()) await db.query('INSERT INTO public.'+table+'(id,organization_id) VALUES($1,$2)',[id,side?orgB:orgA]);
  }
  let checked=0;
  for(const [table,parents] of plans) {
   const hasUser=snapshot.columns.some(c=>c.table_schema==='public'&&c.table_name===table&&c.column_name==='user_id');
   const row=Object.fromEntries(parents.map(([column,parent])=>[column,ids.get(parent)[0]]));
   if(hasUser)row.user_id=actor;
   const insert=async values=>{
    const entries=Object.entries(values);
    return db.query('INSERT INTO public.'+table+'('+entries.map(([key])=>key).join(',')+') VALUES('+entries.map((_,i)=>'$'+(i+1)).join(',')+') RETURNING *',entries.map(([,value])=>value));
   };
   const value=(await insert(row)).rows[0];
   assert.equal(value.organization_id,parents.length?orgA:orgB,table+': parent identity wins over browser selection');
   if(parents.length) {
    await db.exec('SAVEPOINT rejected_insert');
    await assert.rejects(insert({...row,organization_id:orgB}),/cùng công ty/);
    await db.exec('ROLLBACK TO SAVEPOINT rejected_insert');
    if(value.id) {
     await db.exec('SAVEPOINT rejected_parent_update');
     await assert.rejects(db.query('UPDATE public.'+table+' SET '+parents[0][0]+'=$1 WHERE id=$2',[ids.get(parents[0][1])[1],value.id]),/cùng công ty/);
     await db.exec('ROLLBACK TO SAVEPOINT rejected_parent_update');
    }
   } else {
    await header(null);
    await db.exec('SAVEPOINT missing_choice');
    await assert.rejects(insert(row),/chọn công ty/);
    await db.exec('ROLLBACK TO SAVEPOINT missing_choice');
    await header(orgB);
   }
   checked++;
  }
  if(verifySettings){
   const settings=(await db.query('INSERT INTO public.settings(user_id) VALUES($1) RETURNING organization_id',[actor])).rows[0];
   assert.equal(settings.organization_id,orgB,'Settings uses the explicit selected company for a multi-company actor');
  }
  return {businessTablesVerified:checked,conflictingParentOrExplicitCompanyRejected:true,settingsSelectionVerified:verifySettings};
 } finally {await db.exec('ROLLBACK');}
}

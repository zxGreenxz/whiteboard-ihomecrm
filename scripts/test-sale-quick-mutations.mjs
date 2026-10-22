import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { saleQuickClient, seedSaleQuickFixture } from './sale-quick-local-fixture.mjs';

const source=readFileSync(new URL('../supabase/migrations/20261020183120_sale_room_quick_operations.sql',import.meta.url),'utf8');
function replaceOnce(from,to) {
  assert.equal(source.split(from).length,2,'mutation anchor must be unique');
  return source.replace(from,to);
}
async function expectedCode(run,code) {
  try { await run(); return false; }
  catch(error) { if(error.code===code)return true; throw error; }
}
test('Quick writer mutations: guards must cause observable failures',async t=>{
  const f=await seedSaleQuickFixture();
  const db=await saleQuickClient();
  const originalHash=(await db.query("SELECT md5(pg_get_functiondef('public.update_room_sale_info_v1(uuid,uuid,text,uuid,jsonb)'::regprocedure)) hash")).rows[0].hash;
  const cases=[
    {
      name:'revision guard',source:replaceOnce("IF md5(to_jsonb(original)::text)<>p_expected_revision THEN","IF false THEN"),
      check:async ctx=>expectedCode(()=>ctx.patch({sale_note:'Stale'},{revision:'0'.repeat(32)}),'PT409'),
    },
    {
      name:'request content guard',source:replaceOnce('IF old_receipt.payload_hash<>request_hash THEN','IF false THEN'),
      check:async ctx=>{const id=randomUUID(),revision=ctx.revision;await ctx.patch({sale_note:'A'},{id,revision});return expectedCode(()=>ctx.patch({sale_note:'B'},{id,revision}),'22023');},
    },
    {
      name:'occupancy field whitelist',source:replaceOnce("IF key NOT IN ('rent_price','area','room_type','amenities','sale_note','sale_bonus_note','images','description') THEN",'IF false THEN'),
      check:async ctx=>expectedCode(()=>ctx.patch({status:'AVAILABLE'}),'22023'),
    },
    {
      name:'internal bonus confidentiality',source:replaceOnce('CASE WHEN b.can_edit THEN r.sale_bonus_note END AS sale_bonus_note','r.sale_bonus_note AS sale_bonus_note'),
      actor:'sale',
      check:async()=>{const result=(await db.query('SELECT public.get_sale_room_inventory_v1($1) data',[f.org])).rows[0].data;assert.ok(result.rooms.length>0);return result.rooms.every(room=>room.sale_bonus_note===null);},
    },
  ];
  try {
    for(const c of cases)await t.test(`Mutation killed: ${c.name}`,async()=>{
      for(const [label,sql] of [['control',source],['mutant',c.source]]) {
        await db.query('BEGIN');
        try {
          // DDL stays in this connection's transaction. No shared source or
          // committed application function is changed by a mutation test.
          await db.query(sql);
          const revision=(await db.query('SELECT md5(to_jsonb(r)::text) revision FROM public.rooms r WHERE id=$1',[f.rooms[0]])).rows[0].revision;
          await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[f.actors[c.actor??'landlord']]);
          await db.query('SET LOCAL ROLE authenticated');
          const ctx={revision,patch:async(fields,options={})=>(await db.query('SELECT public.update_room_sale_info_v1($1,$2,$3,$4,$5) result',
            [f.org,f.rooms[0],options.revision??revision,options.id??randomUUID(),fields])).rows[0].result};
          assert.equal(await c.check(ctx),label==='control',`${label} must ${label==='control'?'enforce':'violate'} the expected business invariant`);
        } finally {await db.query('ROLLBACK');}
      }
    });
    assert.equal((await db.query("SELECT md5(pg_get_functiondef('public.update_room_sale_info_v1(uuid,uuid,text,uuid,jsonb)'::regprocedure)) hash")).rows[0].hash,originalHash);
  }finally{await db.end();}
});

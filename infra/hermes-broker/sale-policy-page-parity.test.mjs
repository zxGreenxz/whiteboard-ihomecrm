import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSqlCatalog, stripSqlComments } from '../../scripts/check-hermes-web-parity.mjs';

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const original = read('supabase/migrations/20261020101453_hermes_available_rooms_page_v1.sql');
const forward = read('supabase/migrations/20261021072345_hermes_room_timed_policy_projection_v1.sql');
const extract = sql => sql.match(/CREATE OR REPLACE FUNCTION public\.hermes_available_rooms_page_v1\([\s\S]*?END \$fn\$;/)?.[0];
const oldProjection = 'left(rm.sale_note,241) AS sale_note';
const newProjection = "left((SELECT CASE WHEN active.txt IS NULL THEN rm.sale_note ELSE concat_ws(E'\\n',NULLIF(btrim(rm.sale_note),''),active.txt) END FROM (SELECT app_private.room_sale_policy_active_text_v1(rm.organization_id,rm.id,statement_timestamp()) AS txt) active),241) AS sale_note";
function verify(sql) {
 const baseline = extract(original), candidate = extract(sql);
 assert(baseline && candidate);
 assert.equal(baseline.split(oldProjection).length, 2);
 assert.equal(candidate.split(newProjection).length, 2);
 assert.equal(candidate.replace(newProjection, oldProjection), baseline, 'only the bounded sale_note expression may change');
}
test('timed-policy page forward changes only the bounded note projection; every admission/filter/page byte remains identical', () => {
 verify(forward);
 const current = buildSqlCatalog({functions:['public.hermes_available_rooms_page_v1']}).functions.get('public.hermes_available_rooms_page_v1');
 assert.equal(stripSqlComments(current.statement,{deep:true}).trim().replace(/;$/,''), stripSqlComments(extract(forward),{deep:true}).trim().replace(/;$/,''));
 const signature='public.hermes_available_rooms_page_v1(jsonb,uuid,uuid[],text,text[],integer,integer)';
 for(const statement of [`ALTER FUNCTION ${signature} OWNER TO postgres;`,
  `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;`,
  `GRANT EXECUTE ON FUNCTION ${signature} TO authenticated;`])assert(forward.includes(statement));
});
test('page projection proof rejects changed scope, room key, organization, clock, truncation and hidden future text', () => {
 for(const [from,to] of [['p_building_ids<@v_scope','true'],['rm.organization_id,rm.id,statement_timestamp()','v_org,rm.id,statement_timestamp()'],
  ['rm.organization_id,rm.id,statement_timestamp()','rm.organization_id,cb.id,statement_timestamp()'],['statement_timestamp()','clock_timestamp()'],
  ['),241) AS sale_note','),2000) AS sale_note'],['room_sale_policy_active_text_v1','room_sale_policy_current_v1']]) {
  assert(forward.includes(from));assert.throws(()=>verify(forward.replace(from,to)),from);
 }
});

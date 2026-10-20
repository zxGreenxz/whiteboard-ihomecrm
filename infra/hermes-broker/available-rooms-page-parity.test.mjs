import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { buildSqlCatalog, sqlCalls, stripSqlComments } from '../../scripts/check-hermes-web-parity.mjs';

// Static drift guards for B3 (hermes_available_rooms_page_v1), no database:
//  G1 the web-parity map pins get_public_available_rooms as the mirrored source;
//  G2 the admission block is the FAST block (hermes_domain_read_scope_fast_v1) verbatim;
//  the page predicates are the sale page's own predicates (final definition in migrations).
// The real oracle comparison runs on PG17 in available-rooms-page-sql.test.mjs.
const root = new URL('../../', import.meta.url);
const migrations = readdirSync(new URL('supabase/migrations/', root)).filter(name => name.endsWith('.sql')).sort();
const migration = slug => {
  const names = migrations.filter(name => new RegExp(`^\\d{14}_${slug}\\.sql$`).test(name));
  assert.equal(names.length, 1, `one ${slug} migration`);
  return readFileSync(new URL(`supabase/migrations/${names[0]}`, root), 'utf8').replaceAll('\r\n', '\n');
};
const PAGE_SQL = migration('hermes_available_rooms_page_v1'), FAST_SQL = migration('hermes_domain_read_fast_v1');
const catalog = buildSqlCatalog({ functions: ['public.get_public_available_rooms', 'public.hermes_available_rooms_page_v1',
  'app_private.hermes_room_page_admission_v1', 'app_private.hermes_sale_listing_payload_v1', 'app_private.hermes_domain_read_scope_fast_v1'] });
const final = name => { const state = catalog.functions.get(name); assert.equal(state?.action, 'create', name); return stripSqlComments(state.statement, { deep: true }); };
// Spacing-insensitive SQL text: the sale page writes `a = b`, the page function `a=b`.
const norm = text => text.replace(/\s+/g, ' ').replace(/\s*([(),=<>])\s*/g, '$1').trim();
const body = name => norm(final(name));

test('page SQL is a new migration after the tombstone fix and keeps the reviewed shape', () => {
  const name = migrations.find(file => file.includes('hermes_available_rooms_page_v1'));
  assert(name > '20261019144508_hermes_inherited_room_scope_tombstones_v1.sql');
  assert.match(PAGE_SQL, /CREATE OR REPLACE FUNCTION public\.hermes_available_rooms_page_v1\(p_binding jsonb,p_organization_id uuid,p_building_ids uuid\[\] DEFAULT NULL,\n  p_building_name text DEFAULT '',p_statuses text\[\] DEFAULT NULL,p_limit integer DEFAULT 50,p_offset integer DEFAULT 0\)\nRETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER\nSET search_path=pg_catalog,public,app_private/);
  assert.match(PAGE_SQL, /CREATE OR REPLACE FUNCTION app_private\.hermes_room_page_admission_v1\(p_binding jsonb\)\nRETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER\nSET search_path=pg_catalog,public,app_private/);
  for (const statement of ['ALTER FUNCTION app_private.hermes_room_page_admission_v1(jsonb) OWNER TO postgres',
    'REVOKE ALL ON FUNCTION app_private.hermes_room_page_admission_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',
    'ALTER FUNCTION public.hermes_available_rooms_page_v1(jsonb,uuid,uuid[],text,text[],integer,integer) OWNER TO postgres',
    'REVOKE ALL ON FUNCTION public.hermes_available_rooms_page_v1(jsonb,uuid,uuid[],text,text[],integer,integer) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',
    'GRANT EXECUTE ON FUNCTION public.hermes_available_rooms_page_v1(jsonb,uuid,uuid[],text,text[],integer,integer) TO authenticated',
    "NOTIFY pgrst,'reload schema'"]) assert(PAGE_SQL.includes(statement), statement);
  assert.doesNotMatch(PAGE_SQL, /GRANT EXECUTE ON FUNCTION app_private\.hermes_room_page_admission_v1/);
  assert.doesNotMatch(PAGE_SQL, /copilot/i);
  assert.match(PAGE_SQL, /DO \$assert\$[\s\S]*position\('room_sale_workflow_fact_v1\(' IN pg_get_functiondef[\s\S]*position\('get_public_available_rooms\(' IN pg_get_functiondef[\s\S]*\$assert\$;/);
});

test('G5: the final page function calls the shared sale fact exactly and never the public page reader or the base fact', () => {
  const page = final('public.hermes_available_rooms_page_v1');
  assert(sqlCalls(page, 'room_sale_workflow_fact_v1'));
  assert(sqlCalls(page, 'hermes_room_page_admission_v1'));
  assert(!sqlCalls(page, 'get_public_available_rooms'));
  assert(!sqlCalls(page, 'room_sale_workflow_base_fact_v1'));
  assert(!sqlCalls(page, 'hermes_sale_listing_payload_v1'));
  assert(!sqlCalls(page, 'hermes_room_scope_map_v1'));
  assert.equal((page.match(/room_sale_workflow_fact_v1\(/g) ?? []).length, 1, 'one LATERAL call per candidate room');
  assert.match(page, /CROSS JOIN LATERAL app_private\.room_sale_workflow_fact_v1\(rm\.id,rm\.organization_id,rm\.status::text,pl\.id IS NOT NULL,cb\.soon_days\) fact/);
  // The page window applies after the status filter; the total counts the whole filtered set.
  assert.match(page, /listed AS MATERIALIZED \(\s*SELECT f\.\*,row_number\(\) OVER \(ORDER BY cb\.name,cb\.id,f\.floor DESC NULLS LAST,f\.name,f\.id\) AS rn\s*FROM facts f JOIN cb ON cb\.id=f\.building_id\s*WHERE f\.status_public IN \('free','soon','pass'\) AND f\.status_public=ANY\(v_statuses\)/);
  assert.match(page, /total AS \(SELECT count\(\*\)::integer AS n FROM listed\)/);
  assert.match(page, /page AS \(SELECT \* FROM listed WHERE rn>p_offset AND rn<=p_offset\+p_limit\)/);
  assert.doesNotMatch(page, /\bLIMIT\s+p_limit\b|OFFSET\s+p_offset/i, 'no LIMIT/OFFSET before the status filter');
  // Narrowing only: requested buildings must be inside the derived set; an empty derived set denies.
  assert.match(page, /IF NOT\(p_building_ids<@v_scope\) THEN RAISE EXCEPTION 'hermes_rooms_page_denied' USING ERRCODE='42501'; END IF;/);
  assert.match(page, /IF cardinality\(v_scope\)<1 THEN RAISE EXCEPTION 'hermes_rooms_page_denied' USING ERRCODE='42501'; END IF;/);
  assert.match(page, /IF p_organization_id IS NULL OR p_organization_id<>v_org THEN RAISE EXCEPTION 'hermes_rooms_page_denied' USING ERRCODE='42501'; END IF;/);
  // No media, floor plans, internal notes or lock details in the page rows.
  for (const column of ['images', 'floor_layouts', 'sale_bonus_note', 'sale_lock', 'max_occupants', 'public_map_url', 'elec_rate', 'area_ids', 'token']) {
    assert.doesNotMatch(page, new RegExp(`'${column}'`), column);
  }
});

test('G2: the admission block is the FAST read admission verbatim (only the error names differ) and the scope predicate is identical', () => {
  const block = (sql, from, to) => {
    const start = sql.indexOf(from), end = sql.indexOf(to, start);
    assert(start >= 0 && end > start, `${from} … ${to}`);
    return sql.slice(start, end + to.length).split('\n').map(line => line.trim()).filter(Boolean);
  };
  const fast = block(FAST_SQL, 'SELECT * INTO t FROM app_private.hermes_connection_tokens', 'SELECT unnest(c.scope_ids) id INTERSECT SELECT unnest(policy.scope_ids) id) intersection;')
    .map(line => line.replace(/hermes_domain_context_changed/g, 'hermes_rooms_page_context_changed').replace(/hermes_domain_denied/g, 'hermes_rooms_page_denied'));
  const page = block(PAGE_SQL, 'SELECT * INTO t FROM app_private.hermes_connection_tokens', 'SELECT unnest(c.scope_ids) id INTERSECT SELECT unnest(policy.scope_ids) id) intersection;');
  assert.deepEqual(page, fast);
  assert(fast.length >= 20, 'the FAST block is the full connection/session/token/assistant/member/context/policy admission');
  // Single permission: the FAST loop body for one key k, with k replaced by the fixed 'rooms.view' variable.
  const loop = block(FAST_SQL, 'enabled:=COALESCE(policy.enabled,false)', "WHERE ab.organization_id=c.organization_id AND ab.area_id=scope.area_id AND ab.building_id=b.id)));")
    .map(line => line.replace(/\bk\b/g, 'permission'));
  const single = block(PAGE_SQL, 'enabled:=COALESCE(policy.enabled,false)', "WHERE ab.organization_id=c.organization_id AND ab.area_id=scope.area_id AND ab.building_id=b.id)));");
  assert.deepEqual(single, loop);
  assert(PAGE_SQL.includes("IF grant_state->'allowed' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'hermes_rooms_page_denied' USING ERRCODE='42501'; END IF;"));
  assert(FAST_SQL.includes("IF state->'allowed' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;"));
  // Both admit only the caller's own ACTIVE connection under the authenticated role.
  for (const sql of [PAGE_SQL, FAST_SQL]) {
    assert.match(sql, /auth\.role\(\) IS DISTINCT FROM 'authenticated' OR auth\.uid\(\) IS NULL/);
    assert.match(sql, /PERFORM app_private\.hermes_request_v1\(p_binding,ARRAY\['connectionId','tokenDigest','expectedEpoch','expectedSessionRevision'\]\);/);
  }
  assert.doesNotMatch(PAGE_SQL, /'customers\.view'|'contracts\.view'|FOREACH k IN ARRAY/, 'no embed permissions in the room admission');
});

// Sale-page predicates the page function copies (design table §1). Left: the final
// public.get_public_available_rooms / hermes_sale_listing_payload_v1 text; right: the page
// function text. A change on either side turns this red together with the parity hash.
const MIRRORED = [
  ['owner link', 'app_private.hermes_sale_listing_payload_v1', 'WHERE t.organization_id=p_org AND t.revoked=false', 'WHERE t.organization_id=v_org AND t.revoked=false GROUP BY t.owner_id'],
  ['owner buildings', 'public.get_public_available_rooms', 'WHERE b.user_id = v_owner AND b.is_virtual = false AND b.deleted_at IS NULL AND rm.deleted_at IS NULL',
    'JOIN owners o ON o.owner_id=b.user_id'],
  ['static building', 'public.get_public_available_rooms', 'AND b.is_virtual = false AND b.deleted_at IS NULL', 'AND b.is_virtual=false AND b.deleted_at IS NULL'],
  ['live room', 'public.get_public_available_rooms', 'AND rm.deleted_at IS NULL', 'WHERE rm.organization_id=v_org AND rm.deleted_at IS NULL'],
  ['company', 'public.get_public_available_rooms', 'JOIN public.buildings b ON b.id = rm.building_id AND b.organization_id = rm.organization_id', 'WHERE b.organization_id=v_org'],
  ['soon days default', 'public.get_public_available_rooms', 'IF v_soon IS NULL THEN v_soon := 30; END IF;', 'COALESCE(ps.soon_days,30) AS soon_days'],
  ['settings by owner', 'public.get_public_available_rooms', 'FROM public.public_room_settings WHERE owner_id = v_owner;', 'LEFT JOIN public.public_room_settings ps ON ps.owner_id=b.user_id'],
  ['pass overlay', 'public.get_public_available_rooms', 'LEFT JOIN public.room_pass_listings pl ON pl.room_id = rm.id AND pl.user_id = v_owner AND pl.active = true',
    'LEFT JOIN public.room_pass_listings pl ON pl.room_id=rm.id AND pl.user_id=cb.owner_id AND pl.active=true'],
  ['sale fact', 'public.get_public_available_rooms', 'CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(rm.id,rm.organization_id,rm.status::text,pl.id IS NOT NULL,v_soon) fact',
    'CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(rm.id,rm.organization_id,rm.status::text,pl.id IS NOT NULL,cb.soon_days) fact'],
  ['hidden contact name', 'public.get_public_available_rooms', "CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_name ELSE NULL END AS pass_contact_name",
    "CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN left(pl.contact_name,81) END AS pass_contact_name"],
  ['hidden contact phone', 'public.get_public_available_rooms', "CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN pl.contact_phone ELSE NULL END AS pass_contact_phone",
    "CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN left(pl.contact_phone,81) END AS pass_contact_phone"],
  ['pass policy', 'public.get_public_available_rooms', "CASE WHEN fact.status_public='pass' THEN pl.sale_policy ELSE NULL END AS pass_sale_policy",
    "CASE WHEN fact.status_public='pass' THEN left(pl.sale_policy,241) END AS pass_sale_policy"],
  ['pass price', 'public.get_public_available_rooms', "CASE WHEN fact.status_public='pass' THEN pl.pass_price ELSE NULL END AS pass_price",
    "CASE WHEN fact.status_public='pass' THEN pl.pass_price END AS pass_price"],
  ['pass date', 'public.get_public_available_rooms', "CASE WHEN fact.status_public='pass' AND pl.avail_date>=fact.sale_today THEN pl.avail_date ELSE NULL END AS pass_avail_date",
    "CASE WHEN fact.status_public='pass' AND pl.avail_date>=fact.sale_today THEN pl.avail_date END AS pass_avail_date"],
  ['pass manager', 'public.get_public_available_rooms', "COALESCE(fact.status_public='pass' AND pl.contact_manager,false) AS pass_contact_manager",
    "COALESCE(fact.status_public='pass' AND pl.contact_manager,false) AS pass_contact_manager"],
  ['fact columns', 'public.get_public_available_rooms', 'fact.status_public, fact.sale_state, fact.avail_date, fact.sale_today, fact.expected_ready_on',
    'fact.status_public,fact.sale_state,fact.avail_date,fact.sale_today,fact.expected_ready_on'],
  ['amenities', 'public.get_public_available_rooms', "COALESCE(rm.amenities, '[]'::jsonb) AS amenities", "COALESCE(rm.amenities,'[]'::jsonb) AS amenities"],
  ['address', 'public.get_public_available_rooms', "CASE WHEN b.street_address IS NOT NULL AND b.street_address LIKE '%,%' THEN b.street_address ELSE concat_ws(', ', NULLIF(b.street_address, ''), NULLIF(b.ward, ''), NULLIF(b.district, ''), NULLIF(b.province, '')) END",
    "CASE WHEN b.street_address IS NOT NULL AND b.street_address LIKE '%,%' THEN b.street_address ELSE concat_ws(', ',NULLIF(b.street_address,''),NULLIF(b.ward,''),NULLIF(b.district,''),NULLIF(b.province,'')) END AS address"],
  ['hotline', 'public.get_public_available_rooms', "FROM public.hotlines h WHERE h.user_id = v_owner AND COALESCE(h.is_active, true) = true AND (v_hotline IS NULL OR h.id = v_hotline) ORDER BY (h.id = v_hotline) DESC NULLS LAST, h.created_at LIMIT 1",
    "FROM public.hotlines h WHERE h.user_id=b.user_id AND COALESCE(h.is_active,true)=true AND (ps.hotline_id IS NULL OR h.id=ps.hotline_id) ORDER BY (h.id=ps.hotline_id) DESC NULLS LAST,h.created_at LIMIT 1"],
  ['page policy', 'public.get_public_available_rooms', "'sale_policy', NULLIF(btrim(v_sale_policy), '')", "NULLIF(btrim(ps.sale_policy),'') AS page_sale_policy"],
  ['listed statuses', 'app_private.hermes_sale_listing_payload_v1', "WHERE pr->>'status_public' IN ('free','soon','pass')", "WHERE f.status_public IN ('free','soon','pass') AND f.status_public=ANY(v_statuses)"],
  ['order', 'app_private.hermes_sale_listing_payload_v1', "ORDER BY bx->>'name',bx->>'id',(x->>'floor')::numeric DESC NULLS LAST,x->>'name',x->>'id'",
    'ORDER BY cb.name,cb.id,f.floor DESC NULLS LAST,f.name,f.id'],
  ['building order', 'app_private.hermes_sale_listing_payload_v1', "jsonb_agg(x ORDER BY x->>'name',x->>'id')", 'ORDER BY cb.name,cb.id'],
];
test('page predicates mirror the final sale-page reader and listing wrapper text', () => {
  const page = body('public.hermes_available_rooms_page_v1');
  for (const [label, source, left, right] of MIRRORED) {
    assert(body(source).includes(norm(left)), `${label}: sale page still contains "${left}"`);
    assert(page.includes(norm(right)), `${label}: page function contains "${right}"`);
  }
  // Allowlisted room/building columns of the listing wrapper (no media/internal notes), same 23 + 8 keys.
  const wrapper = body('app_private.hermes_sale_listing_payload_v1');
  for (const key of ['id', 'building_id', 'floor', 'name', 'code', 'area', 'rent_price', 'deposit_amount', 'amenities', 'description', 'sale_note', 'room_type',
    'status_public', 'sale_state', 'avail_date', 'sale_today', 'expected_ready_on', 'pass_contact_name', 'pass_contact_phone', 'pass_sale_policy',
    'pass_price', 'pass_avail_date', 'pass_contact_manager']) {
    assert(wrapper.includes(`'${key}',pr->'${key}'`), `wrapper room column ${key}`);
    assert(page.includes(`'${key}',p.${key}`), `page room column ${key}`);
  }
  for (const key of ['id', 'name', 'code', 'address', 'public_contact_name', 'public_contact_phone']) assert(page.includes(`'${key}',`) && wrapper.includes(`'${key}',pb->'${key}'`), key);
  assert(wrapper.includes("'page_contact_name',v_page#>'{contact,name}','page_contact_phone',v_page#>'{contact,phone}'"));
  assert(page.includes("'page_contact_name',left(cb.page_contact_name,121),'page_contact_phone',left(cb.page_contact_phone,65)"));
});

test('G1: web-parity pins the sale page as the mirrored source of the page function', () => {
  const map = JSON.parse(readFileSync(new URL('infra/hermes-broker/web-parity.json', root), 'utf8'));
  const entry = map.entries.find(item => item.id === 'sale-listing-page');
  assert.equal(entry?.kind, 'mirrored');
  assert.deepEqual(entry.sql.map(item => item.function), ['public.get_public_available_rooms']);
  assert.match(entry.sql[0].sha256 ?? '', /^[0-9a-f]{64}$/, 'hash written with --write');
  const page = entry.hermes.find(item => item.sql === 'public.hermes_available_rooms_page_v1');
  assert.deepEqual(page.calls, ['room_sale_workflow_fact_v1', 'hermes_room_page_admission_v1']);
  assert(entry.hermes.some(item => item.sql === 'app_private.hermes_room_page_admission_v1'));
  assert(entry.hermes.some(item => item.path === 'infra/hermes-broker/room-read-service.mjs' && item.contains === 'hermes_available_rooms_page_v1'));
  // The legacy entry stays: group preview/send and schedules keep hermes_sale_listing_rooms_v1.
  const legacy = map.entries.find(item => item.id === 'sale-listing');
  assert(legacy.hermes.some(item => item.sql === 'public.hermes_sale_listing_rooms_v1'));
});

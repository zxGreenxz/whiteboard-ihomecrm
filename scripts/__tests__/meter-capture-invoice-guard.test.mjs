import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migrationPath = 'supabase/migrations/20261023145747_meter_capture_invoice_facts_guard.sql';
const migration = readFileSync(migrationPath, 'utf8');
const captureSql = readFileSync('supabase/migrations/20261022144130_meter_capture_evidence_v1.sql', 'utf8');
const terminationSql = readFileSync('supabase/migrations/20260627000001_termination_extra_charges.sql', 'utf8');
const functionSql = (sql, name) => {
 const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
 assert.ok(start >= 0, name);
 const end = sql.indexOf('END $$;', start);
 assert.ok(end >= start, name);
 return sql.slice(start, end + 'END $$;'.length);
};
const id = value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const [org, contract, building, room, meter, service, invoiceId, readingId, linkId, otherService] = Array.from({ length: 10 }, (_, i) => id(i + 1));
const source = { month: '2026-10', sortOrder: 1, previousReading: 100, currentReading: 120 };
const writerBody = name => `CREATE FUNCTION public.${name}(p_invoice_id uuid,p_items jsonb,p_notes text DEFAULT NULL)
RETURNS ${name === 'update_invoice_v1' ? 'invoices' : 'jsonb'} LANGUAGE plpgsql AS $$
DECLARE v_row invoices;result jsonb;it jsonb;BEGIN
 UPDATE invoices SET notes=p_notes WHERE id=p_invoice_id RETURNING * INTO v_row;
 ${name === 'update_invoice_v1' ? 'delete from public.invoice_items where invoice_id = p_invoice_id;' : 'DELETE FROM public.invoice_items WHERE invoice_id=p_invoice_id;'}
 FOR it IN SELECT value FROM jsonb_array_elements(p_items) LOOP
 INSERT INTO invoice_items(invoice_id,organization_id,service_id,sort_order,type,description,previous_reading,current_reading,from_date,to_date,quantity,unit_price,coefficient,amount)
 VALUES(p_invoice_id,v_row.organization_id,(it->>'service_id')::uuid,(it->>'sort_order')::int,it->>'type',it->>'description',
 (it->>'previous_reading')::numeric,(it->>'current_reading')::numeric,(it->>'from_date')::date,(it->>'to_date')::date,
 (it->>'quantity')::numeric,(it->>'unit_price')::numeric,(it->>'coefficient')::numeric,(it->>'amount')::numeric);
 END LOOP;
 result:=jsonb_build_object('invoice_id',p_invoice_id);
 ${name === 'update_invoice_v1' ? 'return v_row;' : '  RETURN result;'}
END $$;`;

async function fixture({ sql = migration, changedBeforeMigration = false } = {}) {
 const db = new PGlite();
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA app_private;CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
 CREATE TYPE invoice_item_type AS ENUM ('RENT','SERVICE','OTHER');
 CREATE TABLE invoices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,contract_id uuid,building_id uuid,room_id uuid,
 billing_month text,notes text,status text DEFAULT 'DRAFT',deleted_at timestamptz,subtotal numeric DEFAULT 0,total_amount numeric DEFAULT 0,updated_at timestamptz);
 CREATE TABLE invoice_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),invoice_id uuid REFERENCES invoices(id) ON DELETE CASCADE,
 organization_id uuid,service_id uuid,sort_order int,type text,description text,previous_reading numeric,current_reading numeric,
 from_date date,to_date date,quantity numeric,unit_price numeric,coefficient numeric,amount numeric);
 CREATE TABLE meter_readings(id uuid PRIMARY KEY,organization_id uuid,contract_id uuid,meter_id uuid,building_id uuid,room_id uuid,service_id uuid);
 CREATE TABLE app_private.meter_captures(id uuid,reading_id uuid);
 CREATE TABLE app_private.meter_capture_evidence_links(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,
 document_kind text,document_id uuid,contract_id uuid,meter_id uuid,source jsonb,end_reading_id uuid,start_reading_id uuid,linked_by uuid,
 UNIQUE(document_kind,document_id,meter_id));
 CREATE FUNCTION app_private.meter_capture_immutable_v1() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'Meter evidence history is immutable' USING ERRCODE='55000';END $$;
 ${writerBody('update_invoice_v1')}${writerBody('adjust_invoice_v2')}
 ${functionSql(captureSql, 'app_private.meter_capture_attach_v1')}
 ${functionSql(terminationSql, 'public._termination_apply_extra_charges')}
 INSERT INTO invoices(id,organization_id,contract_id,building_id,room_id,billing_month) VALUES('${invoiceId}','${org}','${contract}','${building}','${room}','2026-10');
 INSERT INTO meter_readings VALUES('${readingId}','${org}','${contract}','${meter}','${building}','${room}','${service}');
 INSERT INTO invoice_items(invoice_id,organization_id,service_id,sort_order,type,description,previous_reading,current_reading,quantity,unit_price,coefficient,amount)
 VALUES('${invoiceId}','${org}','${service}',1,'SERVICE','Electricity',100,${changedBeforeMigration ? 130 : 120},20,500,1,10000),
 ('${invoiceId}','${org}','${otherService}',2,'SERVICE','Other service',NULL,NULL,1,100,1,100);
 INSERT INTO app_private.meter_capture_evidence_links(id,organization_id,document_kind,document_id,contract_id,meter_id,source,end_reading_id)
 VALUES('${linkId}','${org}','INVOICE','${invoiceId}','${contract}','${meter}','${JSON.stringify(source)}','${readingId}');`);
 try { await db.exec(sql); await db.exec(sql); } catch (error) { await db.close(); throw error; }
 return db;
}
const items = async db => (await db.query('SELECT to_jsonb(i) item FROM invoice_items i WHERE invoice_id=$1 ORDER BY sort_order', [invoiceId])).rows.map(row => row.item);
async function writer(db, name, changes = item => item) {
 return db.query(`SELECT public.${name}($1,$2,$3) result`, [invoiceId, (await items(db)).map(changes), 'Updated notes']);
}

test('draft and issued adjustment writers preserve the pinned source and roll back changed readings', async t => {
 for (const name of ['update_invoice_v1', 'adjust_invoice_v2']) {
  const db = await fixture(); t.after(() => db.close());
  await assert.rejects(writer(db, name, item => item.sort_order === 1 ? { ...item, current_reading: 130, quantity: 30, amount: 15000 } : item), { code: '55000' });
  assert.equal((await items(db))[0].current_reading, 120);
  assert.equal((await db.query('SELECT source FROM app_private.meter_capture_evidence_links')).rows[0].source.currentReading, 120);
  assert.equal((await db.query('SELECT notes FROM invoices')).rows[0].notes, null);
 }
});

test('replace-all writers permit notes, rate and unrelated line changes with ALL IMMEDIATE', async t => {
 const db = await fixture(); t.after(() => db.close());
 for (const name of ['update_invoice_v1', 'adjust_invoice_v2']) {
  const oldId = (await items(db))[0].id;
  await db.exec('BEGIN;SET CONSTRAINTS ALL IMMEDIATE;');
  await writer(db, name, item => item.sort_order === 1 ? { ...item, unit_price: 600, amount: 12000 } : { ...item, description: 'Changed other service' });
  await db.exec('COMMIT');
  const row = (await items(db))[0]; assert.notEqual(row.id, oldId); assert.equal(row.current_reading, 120); assert.equal(row.unit_price, 600);
 }
 assert.equal((await db.query('SELECT count(*)::int n FROM app_private.meter_capture_invoice_facts')).rows[0].n, 1);
});

test('direct writes cannot move invoice scope or rewrite meter line, consumption, date or service', async t => {
 const db = await fixture(); t.after(() => db.close());
 for (const expression of [`contract_id='${id(31)}'`, `organization_id='${id(32)}'`, `building_id='${id(33)}'`, `room_id='${id(34)}'`, "billing_month='2026-11'"]) {
  await assert.rejects(db.exec(`UPDATE invoices SET ${expression} WHERE id='${invoiceId}'`), { code: '55000' });
 }
 for (const expression of ['current_reading=130', 'previous_reading=90', 'quantity=30', 'amount=9999', "to_date='2026-11-01'", `service_id='${otherService}'`, `organization_id='${id(32)}'`, 'sort_order=3']) {
  await assert.rejects(db.exec(`UPDATE invoice_items SET ${expression} WHERE invoice_id='${invoiceId}' AND sort_order=1`), { code: '55000' });
 }
});

test('delete or duplicate metered line cannot leave evidence pointing at a different bill', async t => {
 const db = await fixture(); t.after(() => db.close());
 await assert.rejects(db.exec(`DELETE FROM invoice_items WHERE invoice_id='${invoiceId}' AND sort_order=1`), { code: '55000' });
 await assert.rejects(db.exec(`DELETE FROM invoices WHERE id='${invoiceId}'`), { code: '55000' });
 await assert.rejects(db.exec(`INSERT INTO invoice_items(invoice_id,organization_id,service_id,sort_order,previous_reading,current_reading,quantity,unit_price,coefficient,amount)
 VALUES('${invoiceId}','${org}','${service}',3,120,130,10,500,1,5000)`), { code: '55000' });
 assert.equal((await items(db))[0].current_reading, 120);
});

test('cancel/soft-delete preserves historical evidence and facts; immutable snapshot is private', async t => {
 const db = await fixture(); t.after(() => db.close());
 await db.exec(`UPDATE invoices SET status='CANCELLED',deleted_at=clock_timestamp() WHERE id='${invoiceId}'`);
 assert.equal((await db.query('SELECT count(*)::int n FROM app_private.meter_capture_invoice_facts')).rows[0].n, 1);
 await assert.rejects(db.exec(`UPDATE invoice_items SET current_reading=130 WHERE invoice_id='${invoiceId}' AND sort_order=1`), { code: '55000' });
 await assert.rejects(db.exec('DELETE FROM app_private.meter_capture_invoice_facts'), { code: '55000' });
 await assert.rejects(db.exec("UPDATE app_private.meter_capture_invoice_facts SET line_snapshot='{}'"), { code: '55000' });
 await db.exec('GRANT USAGE ON SCHEMA app_private TO authenticated;SET ROLE authenticated');
 await assert.rejects(db.query('SELECT * FROM app_private.meter_capture_invoice_facts'), { code: '42501' });
 await db.exec('RESET ROLE');
});

test('migration rejects pre-existing mismatches instead of freezing them as approved history', async () => {
 await assert.rejects(fixture({ changedBeforeMigration: true }), { code: '55000' });
});

test('new link snapshots are attached atomically and invalid source insertion is rejected', async t => {
 const db = await fixture(); t.after(() => db.close());
 const newInvoice = id(40);
 await db.exec(`BEGIN;
 INSERT INTO invoices(id,organization_id,contract_id,building_id,room_id,billing_month,notes,status,deleted_at) SELECT '${newInvoice}',organization_id,contract_id,building_id,room_id,billing_month,notes,status,deleted_at FROM invoices WHERE id='${invoiceId}';
 INSERT INTO invoice_items(invoice_id,organization_id,service_id,sort_order,type,description,previous_reading,current_reading,quantity,unit_price,coefficient,amount)
 SELECT '${newInvoice}',organization_id,service_id,sort_order,type,description,previous_reading,current_reading,quantity,unit_price,coefficient,amount FROM invoice_items WHERE invoice_id='${invoiceId}';
 INSERT INTO app_private.meter_capture_evidence_links(organization_id,document_kind,document_id,contract_id,meter_id,source,end_reading_id)
 VALUES('${org}','INVOICE','${newInvoice}','${contract}','${meter}','${JSON.stringify(source)}','${readingId}');COMMIT;`);
 assert.equal((await db.query('SELECT count(*)::int n FROM app_private.meter_capture_invoice_facts')).rows[0].n, 2);
 await assert.rejects(db.exec(`INSERT INTO app_private.meter_capture_evidence_links(organization_id,document_kind,document_id,contract_id,meter_id,source,end_reading_id)
 VALUES('${org}','INVOICE','${id(41)}','${contract}','${meter}','${JSON.stringify({ ...source, currentReading: 130 })}','${readingId}')`), { code: '55000' });
});

test('mutation proof: bypassing the invariant permits the originally reported corruption', async t => {
 const anchor = "IF NOT EXISTS(SELECT 1 FROM app_private.meter_capture_evidence_links WHERE document_kind='INVOICE' AND document_id=p_invoice) THEN RETURN; END IF;";
 assert.equal(migration.split(anchor).length, 2);
 const db = await fixture({ sql: migration.replace(anchor, 'RETURN;') }); t.after(() => db.close());
 await writer(db, 'adjust_invoice_v2', item => item.sort_order === 1 ? { ...item, current_reading: 130, quantity: 30, amount: 15000 } : item);
 assert.equal((await items(db))[0].current_reading, 130);
 assert.equal((await db.query('SELECT source FROM app_private.meter_capture_evidence_links')).rows[0].source.currentReading, 120);
});

async function settlement(db, usages, { month = '2026-10', mutateOutput } = {}) {
 const invoice = id(70);
 const sources = usages.map((usage, n) => ({ purpose: 'MOVE_OUT', contractId: contract, meterId: id(80 + n), endReadingId: id(90 + n),
  month: '2026-10', readingDate: '2026-10-23', sortOrder: n + 1, previousReading: 120, currentReading: 120 + usage }));
 const charges = [{ kind: 'CUSTOM', description: 'Cleaning', amount: 50 }, ...sources.map((meterSource, n) => ({
  kind: 'ELECTRIC', description: `Electric meter ${n + 1}`, previous_reading: meterSource.previousReading,
  current_reading: meterSource.currentReading, unit_price: n === 3 ? 0 : 500.25,
  amount: Math.round(usages[n] * (n === 3 ? 0 : 500.25)), meter_source: meterSource,
 }))];
 await db.exec('BEGIN;SET CONSTRAINTS ALL IMMEDIATE');
 await db.query(`INSERT INTO invoices(id,organization_id,contract_id,building_id,room_id,billing_month) VALUES($1,$2,$3,$4,$5,$6)`, [invoice, org, contract, building, room, month]);
 for (const s of sources) await db.query('INSERT INTO meter_readings VALUES($1,$2,$3,$4,$5,$6,$7)', [s.endReadingId, org, contract, s.meterId, building, room, service]);
 await db.query(`INSERT INTO invoice_items(invoice_id,type,description,sort_order,quantity,unit_price,coefficient,amount) VALUES($1,'OTHER','Penalty',1,1,100,1,100)`, [invoice]);
 // Execute the repository's actual termination writer, not a lookalike fixture.
 await db.query('SELECT public._termination_apply_extra_charges($1,$2,$3,NULL,$4)', [invoice, charges.map(({ meter_source, ...charge }) => charge), '2026-10-23', contract]);
 if (mutateOutput) await mutateOutput(invoice);
 const before = (await db.query('SELECT sort_order,service_id,quantity FROM invoice_items WHERE invoice_id=$1 ORDER BY sort_order', [invoice])).rows;
 const mapped = (await db.query('SELECT app_private.meter_capture_map_exit_invoice_v1($1,$2,$3,$4,$5) sources', [org, invoice, contract, charges, sources])).rows[0].sources;
 await db.query("SELECT app_private.meter_capture_attach_v1($1,'EXIT',$2,$3,$4)", [org, id(99), contract, sources]);
 await db.query("SELECT app_private.meter_capture_attach_v1($1,'INVOICE',$2,$3,$4)", [org, invoice, contract, mapped]);
 await db.exec('COMMIT');
 return { invoice, sources, mapped, before };
}

test('real termination writer maps multiple meters after penalty and other charges, with zero consumption evidence unpinned', async t => {
 const db = await fixture(); t.after(() => db.close());
 const { invoice, mapped, before } = await settlement(db, [2.5, 0, 2.5, 1]);
 assert.deepEqual(before.map(row => Number(row.quantity)), [1, 1, 1, 1]);
 assert.deepEqual(before.map(row => row.service_id), [null, null, null, null]);
 assert.deepEqual(mapped.map(s => s.sortOrder), [3, null, 4, 5]);
 assert.equal(mapped[1].invoiceEvidenceOnly, true);
 const rows = (await db.query('SELECT sort_order,service_id,quantity,amount FROM invoice_items WHERE invoice_id=$1 ORDER BY sort_order', [invoice])).rows;
 assert.deepEqual(rows.slice(2).map(row => Number(row.quantity)), [2.5, 2.5, 1]);
 assert.deepEqual(rows.slice(2).map(row => Number(row.amount)), [1251, 1251, 0]);
 assert.ok(rows.slice(2).every(row => row.service_id === service));
 assert.equal((await db.query("SELECT count(*)::int n FROM app_private.meter_capture_evidence_links WHERE document_kind='EXIT'")).rows[0].n, 4);
 assert.equal((await db.query('SELECT count(*)::int n FROM app_private.meter_capture_invoice_facts WHERE invoice_id=$1 AND sort_order IS NULL', [invoice])).rows[0].n, 1);
 await assert.rejects(db.query('UPDATE invoice_items SET current_reading=130 WHERE invoice_id=$1 AND sort_order=3', [invoice]), { code: '55000' });
});

test('zero kWh source never gets pinned to an unrelated penalty/cleaning line and survives notes edits', async t => {
 const db = await fixture(); t.after(() => db.close());
 const { invoice, mapped } = await settlement(db, [0]);
 assert.equal(mapped[0].sortOrder, null);
 assert.equal((await db.query('SELECT count(*)::int n FROM invoice_items WHERE invoice_id=$1', [invoice])).rows[0].n, 2);
 await db.query('UPDATE invoices SET notes=$2 WHERE id=$1', [invoice, 'Zero usage confirmed']);
 await db.query('UPDATE invoice_items SET description=$2 WHERE invoice_id=$1', [invoice, 'Unrelated charge']);
 await assert.rejects(db.query(`INSERT INTO invoice_items(invoice_id,type,service_id,sort_order,previous_reading,current_reading,quantity,unit_price,coefficient,amount)
  VALUES($1,'SERVICE',$2,3,120,130,10,500,1,5000)`, [invoice, service]), { code: '55000' });
});

test('MOVE_OUT evidence can describe a forfeit invoice whose technical billing month is next month', async t => {
 const db = await fixture(); t.after(() => db.close());
 const { invoice, mapped } = await settlement(db, [2], { month: '2026-11' });
 assert.equal(mapped[0].month, '2026-10');
 assert.equal((await db.query('SELECT billing_month FROM invoices WHERE id=$1', [invoice])).rows[0].billing_month, '2026-11');
 await assert.rejects(db.query("UPDATE invoices SET billing_month='2026-12' WHERE id=$1", [invoice]), { code: '55000' });
});

test('settlement mapping rejects a changed or missing positive writer charge instead of dropping its source', async t => {
 for (const mutation of ['UPDATE invoice_items SET current_reading=130 WHERE invoice_id=$1 AND sort_order=3', 'DELETE FROM invoice_items WHERE invoice_id=$1 AND sort_order=3']) {
  const db = await fixture(); t.after(() => db.close());
  await assert.rejects(settlement(db, [2], { mutateOutput: invoice => db.query(mutation, [invoice]) }), { code: '55000' });
  await db.exec('ROLLBACK');
  assert.equal((await db.query("SELECT count(*)::int n FROM app_private.meter_capture_evidence_links WHERE document_kind='EXIT'")).rows[0].n, 0);
 }
});

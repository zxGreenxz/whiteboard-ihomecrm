// Audit probe on the TEST project ONLY. Every statement runs inside a transaction that is ROLLED BACK.
// Goal: show that live legacy entrypoints can (1) create a refund voucher for an already TERMINATED
// contract that has no contract_terminations row (the exact state a v2 DEFERRED case would leave), and
// (2) end a lifecycle by a direct UPDATE of contracts.status under a manager JWT (RLS path, no RPC).
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = 'C:/Users/Nguyen Tam/whiteboard-ihomecrm-main';
const vault = fs.readFileSync(path.join(ROOT, 'CLAUDE.local.md'), 'utf8');
const pw = (vault.match(/^TEST_SUPABASE_DB_PASSWORD=(\S+)\s*$/m) || [])[1];
const ref = (vault.match(/^TEST_SUPABASE_REF=(\S+)\s*$/m) || [])[1];
const host = (vault.match(/^TEST_SUPABASE_POOLER_HOST=(\S+)\s*$/m) || [])[1];
if (!pw || ref !== 'hzulujxgonszuleqticb' || !host) { console.error('TEST only'); process.exit(3); }

const MANAGER_UID = process.argv[2];           // a STAFF manager on TEST
const out = { target: `TEST ${ref}`, at: new Date().toISOString(), manager_uid_prefix: MANAGER_UID.slice(0, 8), probes: {} };
const short = (v) => (typeof v === 'string' ? v.slice(0, 8) : v);

async function asManager(c) {
  await c.query('SET LOCAL ROLE authenticated');
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: MANAGER_UID, role: 'authenticated', aud: 'authenticated' })]);
}

(async () => {
  const c = new Client({ host, port: 5432, database: 'postgres', user: `postgres.${ref}`, password: pw, ssl: { rejectUnauthorized: false }, application_name: 'audit-contract-lifecycle-probe' });
  c.on('error', () => {});
  await c.connect();
  try {
    // ---------- Probe 1: legacy termination approval on a TERMINATED contract without a termination row
    await c.query('BEGIN');
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: MANAGER_UID, role: 'authenticated', aud: 'authenticated' })]);
    const b = await c.query("select app_private.buildings_for_v3('contracts.create') as create_b, app_private.buildings_for_v3('contracts.edit') as edit_b");
    const createB = b.rows[0].create_b || [], editB = b.rows[0].edit_b || [];
    out.probes.scope = { create_buildings: createB.length, edit_buildings: editB.length };
    const cand = await c.query(`
      select c.id, r.building_id, c.deposit_paid, c.total_deposit
        from public.contracts c join public.rooms r on r.id = c.room_id
       where c.deleted_at is null and c.status = 'TERMINATED' and c.deposit_paid > 0
         and not exists (select 1 from public.contract_terminations t where t.contract_id = c.id)
         and r.building_id = any($1::uuid[]) and r.building_id = any($2::uuid[])
       order by c.actual_end_date desc limit 1`, [createB, editB]);
    if (!cand.rowCount) { out.probes.p1 = { skipped: 'no candidate in manager scope' }; }
    else {
      const k = cand.rows[0];
      await asManager(c);
      const ins = await c.query(`insert into public.contract_terminations
          (contract_id, termination_date, actual_move_out_date, termination_type, total_deposit, refund_method, status)
          values ($1, current_date, current_date, 'NORMAL', $2, 'TK', 'DRAFT') returning id`, [k.id, k.total_deposit]);
      const termId = ins.rows[0].id;
      const appr = await c.query('select public.approve_contract_termination_v1($1, $2) as r', [termId, 'audit probe — rolled back']);
      await c.query('RESET ROLE');
      const r = appr.rows[0].r;
      let voucher = null;
      if (r && r.voucher_id) {
        const v = await c.query(`select ie.type, ie.approval_status, ie.contract_id = $2 as same_contract,
              (select sum(amount) from public.income_expense_items i where i.income_expense_id = ie.id) as amount
            from public.income_expenses ie where ie.id = $1`, [r.voucher_id, k.id]);
        voucher = v.rows[0];
      }
      const t = await c.query('select status from public.contract_terminations where id = $1', [termId]);
      out.probes.p1 = {
        contract_prefix: short(k.id), contract_status_before: 'TERMINATED', deposit_paid: k.deposit_paid,
        inserted_termination_status: 'DRAFT', approve_result: { status: r.status, refund_amount: r.refund_amount, refund_capped: r.refund_capped, voucher_id_prefix: short(r.voucher_id) },
        voucher_created: voucher, termination_status_after: t.rows[0].status,
      };
    }
    await c.query('ROLLBACK');

    // ---------- Probe 2: direct UPDATE contracts.status by manager (PostgREST PATCH equivalent)
    await c.query('BEGIN');
    const act = await c.query(`
      select c.id, c.room_id, r.status as room_status
        from public.contracts c join public.rooms r on r.id = c.room_id
       where c.deleted_at is null and c.status = 'ACTIVE' and r.building_id = any($1::uuid[])
       order by c.created_at desc limit 1`, [editB]);
    if (!act.rowCount) { out.probes.p2 = { skipped: 'no ACTIVE contract in scope' }; }
    else {
      const a = act.rows[0];
      await asManager(c);
      const u = await c.query(`update public.contracts set status = 'TERMINATED', actual_end_date = current_date where id = $1`, [a.id]);
      await c.query('RESET ROLE');
      const after = await c.query('select c.status, r.status as room_status from public.contracts c join public.rooms r on r.id = c.room_id where c.id = $1', [a.id]);
      out.probes.p2 = { contract_prefix: short(a.id), rows_updated: u.rowCount, room_status_before: a.room_status, after: after.rows[0] };
    }
    await c.query('ROLLBACK');
  } catch (e) {
    out.error = String(e.message);
    try { await c.query('ROLLBACK'); } catch (_) {}
  } finally { await c.end(); }
  const file = path.join(ROOT, 'docs/audits/2026-09-27-contract-lifecycle/independent-verification/test-probe-legacy-entrypoints.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
})();

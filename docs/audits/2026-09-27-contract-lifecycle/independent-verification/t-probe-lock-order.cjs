// Audit probe on the TEST project ONLY; both transactions are ROLLED BACK.
// Demonstrates the wait-for cycle between
//   L (legacy writer, e.g. terminate_* / approve_*): contract FOR UPDATE -> UPDATE contracts.status
//      -> trigger update_room_status_on_contract_change -> UPDATE rooms (room row lock)
//   N (plan §4.2 proposed order): room FOR UPDATE -> ... -> contract FOR UPDATE
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = 'C:/Users/Nguyen Tam/whiteboard-ihomecrm-main';
const vault = fs.readFileSync(path.join(ROOT, 'CLAUDE.local.md'), 'utf8');
const pw = (vault.match(/^TEST_SUPABASE_DB_PASSWORD=(\S+)\s*$/m) || [])[1];
const ref = (vault.match(/^TEST_SUPABASE_REF=(\S+)\s*$/m) || [])[1];
const host = (vault.match(/^TEST_SUPABASE_POOLER_HOST=(\S+)\s*$/m) || [])[1];
if (!pw || ref !== 'hzulujxgonszuleqticb' || !host) { console.error('TEST only'); process.exit(3); }
const mk = (name) => { const c = new Client({ host, port: 5432, database: 'postgres', user: `postgres.${ref}`, password: pw, ssl: { rejectUnauthorized: false }, application_name: name }); c.on('error', () => {}); return c; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const L = mk('audit-lock-L'), N = mk('audit-lock-N');
  await L.connect(); await N.connect();
  const out = { target: `TEST ${ref}`, at: new Date().toISOString(), steps: [] };
  const log = (s) => { out.steps.push({ t: Date.now(), s }); };
  try {
    const pick = await L.query(`select c.id, c.room_id from public.contracts c join public.rooms r on r.id=c.room_id
                                 where c.deleted_at is null and c.status='ACTIVE' and r.status='OCCUPIED' order by c.created_at desc limit 1`);
    const { id: contractId, room_id: roomId } = pick.rows[0];
    out.contract_prefix = contractId.slice(0, 8); out.room_prefix = roomId.slice(0, 8);
    await L.query("BEGIN"); await L.query("SET LOCAL statement_timeout='15s'");
    await N.query("BEGIN"); await N.query("SET LOCAL statement_timeout='15s'");
    await L.query('select id from public.contracts where id=$1 for update', [contractId]); log('L: locked contract');
    await N.query('select id from public.rooms where id=$1 for update', [roomId]); log('N: locked room (plan §4.2 step 1)');
    const pL = L.query(`update public.contracts set status='TERMINATED', actual_end_date=current_date where id=$1`, [contractId])
      .then(() => { log('L: UPDATE contracts committed-in-tx (trigger got room lock)'); return 'ok'; })
      .catch(e => { log('L: ERROR ' + e.code + ' ' + e.message.split('\n')[0]); return e.code; });
    await sleep(400);
    log('L: waiting on room lock (trigger)');
    const pN = N.query('select id from public.contracts where id=$1 for update', [contractId])
      .then(() => { log('N: locked contract'); return 'ok'; })
      .catch(e => { log('N: ERROR ' + e.code + ' ' + e.message.split('\n')[0]); return e.code; });
    const [rL, rN] = await Promise.all([pL, pN]);
    out.result = { L: rL, N: rN, deadlock_detected: [rL, rN].includes('40P01') };
  } catch (e) { out.error = e.message; }
  finally {
    try { await L.query('ROLLBACK'); } catch (_) {}
    try { await N.query('ROLLBACK'); } catch (_) {}
    await L.end(); await N.end();
  }
  const t0 = out.steps.length ? out.steps[0].t : 0; out.steps = out.steps.map(x => ({ ms: x.t - t0, s: x.s }));
  fs.writeFileSync(path.join(ROOT, 'docs/audits/2026-09-27-contract-lifecycle/independent-verification/test-probe-lock-order.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
})();

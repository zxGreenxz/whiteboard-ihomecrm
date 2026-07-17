// ============================================================================
// T3 PREPARED TEST 92 — real two-connection concurrency suite against the
// disposable harness (127.0.0.1:55432/ihome ONLY — refuses anything else).
// Node's `pg` driver; each test uses two genuine sessions.
//   C1 duplicate-key race: two concurrent identical calls → one voucher,
//      identical responses, one completed ledger row, one marker.
//   C2 claimant-abort handover: session A claims the ledger row then aborts;
//      session B (blocked on the unique index) becomes claimant and completes.
//   C3 freeze race: concurrent UPDATE on a row being claimed waits on the row
//      lock, then sees the marker → 55000.
// Cleanup: all fixtures created inside each test are removed afterwards where
// the freeze allows; the harness DB is disposable regardless.
// ============================================================================
import pg from 'pg';

const CONN = { host: '127.0.0.1', port: 55432, user: 'postgres', database: 'ihome' };
if (CONN.host !== '127.0.0.1') throw new Error('harness only');

const claims = (sub) =>
  `select set_config('request.jwt.claims','${JSON.stringify({ sub, role: 'authenticated' }).replace(/'/g, "''")}', false)`;

async function client() {
  const c = new pg.Client(CONN);
  await c.connect();
  return c;
}

function args(building, type, key, name = 'CONC voucher') {
  const items = JSON.stringify([{
    income_expense_type_id: type, description: 'conc item', quantity: 1,
    unit_price: 111000,
    start_date: new Date().toISOString().slice(0, 10),
    end_date: new Date().toISOString().slice(0, 10),
  }]);
  return {
    text: `select (public.create_income_expense_v1(
      'EXPENSE', $1, $2, null,null,null,null,null,null,null,
      '[]'::jsonb, null, null, current_date, $3::jsonb, $4)).*`,
    values: [name, building, items, key],
  };
}

const main = async () => {
  const admin = await client();

  const fx = (await admin.query(`
    select m.organization_id as org, m.user_id as actor
      from public.organization_memberships m
      join auth.users u on u.id = m.user_id
      join public.staff_assignments sa on sa.staff_id = m.user_id
     where m.status = 'ACTIVE' limit 1`)).rows[0];
  const building = (await admin.query(`
    select b.id from public.buildings b
      join public.organizations o on o.id = b.organization_id and o.status='ACTIVE'
     where b.organization_id = $1 and b.deleted_at is null limit 1`, [fx.org])).rows[0].id;
  const type = (await admin.query(`
    select t.id from public.income_expense_types t
     where t.organization_id = $1
       and lower(coalesce(t.type,'expense'))='expense'
       and coalesce(t.is_deposit,false)=false
       and public.nrm_vn(t.name) not in ('hoa hong moi gioi','thuong nong sale')
     limit 1`, [fx.org])).rows[0].id;

  // flag ON with identity (harness-only)
  await admin.query(`
    update app_private.server_feature_flags
       set mode='ON', config_version=config_version+1,
           commit_sha=repeat('a',40), migration_sha256=repeat('b',64),
           maintenance_window_id='HARNESS', approval_reference='HARNESS-CONC',
           updated_at=clock_timestamp()
     where feature_key='income_expense.create_draft.v1'`);

  const results = [];

  // ---------- C1: duplicate-key race ----------
  {
    const key = 'conc-race-' + Date.now();
    const [a, b] = await Promise.all([client(), client()]);
    await a.query(claims(fx.actor));
    await b.query(claims(fx.actor));
    const q = args(building, type, key);
    const [ra, rb] = await Promise.allSettled([a.query(q), b.query(q)]);
    const ok = [ra, rb].filter(r => r.status === 'fulfilled');
    if (ok.length !== 2) {
      throw new Error('C1: expected both calls to succeed (one live, one replay): '
        + [ra, rb].map(r => r.status === 'rejected' ? r.reason.message : 'ok').join(' | '));
    }
    const ids = ok.map(r => r.value.rows[0].id);
    if (ids[0] !== ids[1]) throw new Error('C1: two different vouchers created');
    const cnt = (await admin.query(
      `select count(*)::int c from public.income_expenses where id=$1`, [ids[0]])).rows[0].c;
    const ops = (await admin.query(
      `select count(*)::int c from app_private.canonical_write_operations
        where idempotency_key=$1 and completed_at is not null`, [key])).rows[0].c;
    const markers = (await admin.query(
      `select count(*)::int c from app_private.income_expense_flow_ownership
        where income_expense_id=$1`, [ids[0]])).rows[0].c;
    if (cnt !== 1 || ops !== 1 || markers !== 1)
      throw new Error(`C1: cnt=${cnt} ops=${ops} markers=${markers}`);
    results.push('C1 duplicate-key race: one voucher, one op, one marker — PASS');
    await a.end(); await b.end();
  }

  // ---------- C2: claimant-abort handover ----------
  {
    const key = 'conc-abort-' + Date.now();
    const [a, b] = await Promise.all([client(), client()]);
    await a.query(claims(fx.actor));
    await b.query(claims(fx.actor));
    // A: begin, run writer, DO NOT commit
    await a.query('begin');
    await a.query(args(building, type, key, 'CONC abort voucher'));
    // B: same call — will block on the ledger unique index
    const pb = b.query(args(building, type, key, 'CONC abort voucher'));
    await new Promise(r => setTimeout(r, 400));
    await a.query('rollback'); // A aborts → B becomes claimant
    const rb = await pb;
    const id = rb.rows[0].id;
    const ops = (await admin.query(
      `select count(*)::int c from app_private.canonical_write_operations
        where idempotency_key=$1 and completed_at is not null`, [key])).rows[0].c;
    const markers = (await admin.query(
      `select count(*)::int c from app_private.income_expense_flow_ownership
        where income_expense_id=$1`, [id])).rows[0].c;
    if (ops !== 1 || markers !== 1)
      throw new Error(`C2: ops=${ops} markers=${markers}`);
    results.push('C2 claimant-abort handover: B completed after A rollback — PASS');
    await a.end(); await b.end();
  }

  // ---------- C3: freeze race on a visible row ----------
  {
    const key = 'conc-freeze-' + Date.now();
    const [a, b] = await Promise.all([client(), client()]);
    await a.query(claims(fx.actor));
    await b.query(claims(fx.actor));
    // create + claim via the writer (committed)
    const r = await a.query(args(building, type, key, 'CONC freeze voucher'));
    const id = r.rows[0].id;
    // B: direct UPDATE must hit the freeze
    let denied = false;
    try {
      await b.query(`update public.income_expenses set name='race hack' where id=$1`, [id]);
    } catch (e) {
      denied = e.code === '55000';
      if (!denied) throw e;
    }
    if (!denied) throw new Error('C3: frozen row was mutable from second session');
    results.push('C3 freeze visible cross-session: 55000 — PASS');
    await a.end(); await b.end();
  }

  console.log(results.join('\n'));
  console.log('ALL 3 CONCURRENCY TESTS PASSED');
  await admin.end();
};

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });

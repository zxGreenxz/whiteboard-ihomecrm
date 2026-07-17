// ============================================================================
// T4a PREPARED — two-org direct security matrix against the disposable
// harness (127.0.0.1:55432/ihome ONLY). Uses the two real restored orgs.
// Covers the T2/T3 acceptance rows that are testable without PostgREST:
//   S1  cross-org resolver deny (owner of org A against org B target)
//   S2  RBAC tables: authenticated role cannot DML (RLS/grants)
//   S3  possession tables: authenticated cannot read app_private at all
//   S4  claim helper: authenticated/service_role cannot execute
//   S5  writer wrapper: anon/authenticated/service_role cannot execute
//   S6  ie_canonical_writer owns exactly 1 function, no tables, NOLOGIN/NOBYPASSRLS
//   S7  freeze triggers all ENABLE ALWAYS (tgenabled='A')
//   S8  resolver: suspended org denies (status flip inside a rolled-back tx)
// ============================================================================
import pg from 'pg';

const CONN = { host: '127.0.0.1', port: 55432, user: 'postgres', database: 'ihome' };

const main = async () => {
  const c = new pg.Client(CONN);
  await c.connect();
  const out = [];
  const fail = (m) => { throw new Error(m); };

  const orgs = (await c.query(`select id from public.organizations order by id`)).rows.map(r => r.id);
  if (orgs.length < 2) fail('need two orgs');
  const [orgA, orgB] = orgs;
  const ownerA = (await c.query(`
    select m.user_id from public.organization_memberships m
     where m.organization_id=$1 and m.status='ACTIVE' limit 1`, [orgA])).rows[0].user_id;
  const bldB = (await c.query(`
    select id from public.buildings where organization_id=$1 limit 1`, [orgB])).rows[0]?.id;

  // S1 cross-org deny
  {
    await c.query('begin');
    await c.query(`select app_private.lock_org_for_decision_v1($1)`, [orgA]);
    const r = (await c.query(`
      select * from app_private.authorize_tenant_action_v3($1,$2,'income_expenses.create',$3,null)`,
      [ownerA, orgA, bldB])).rows[0];
    if (r.allowed || r.decision_reason !== 'TARGET_CROSS_ORG_OR_MISSING')
      fail(`S1: ${r.allowed} ${r.decision_reason}`);
    await c.query('rollback');
    out.push('S1 cross-org target deny — PASS');
  }

  // S2 RBAC table DML as authenticated
  {
    await c.query('begin');
    await c.query(`select set_config('request.jwt.claims',
      json_build_object('sub',$1::text,'role','authenticated')::text, true)`, [ownerA]);
    await c.query(`set local role authenticated`);
    let denied = 0;
    for (const t of ['role_permissions', 'role_bindings', 'member_permission_overrides']) {
      try {
        await c.query(`insert into public.${t} default values`);
      } catch { denied++; }
    }
    await c.query('rollback');
    if (denied !== 3) fail(`S2: only ${denied}/3 RBAC DML denied`);
    out.push('S2 RBAC client DML denied — PASS');
  }

  // S3 app_private invisible to authenticated
  {
    await c.query('begin');
    await c.query(`set local role authenticated`);
    let denied = false;
    try {
      await c.query(`select count(*) from app_private.cashbook_possession_candidates`);
    } catch (e) { denied = e.code === '42501'; }
    await c.query('rollback');
    if (!denied) fail('S3: authenticated read app_private');
    out.push('S3 app_private schema denied — PASS');
  }

  // S4 claim helper ACL
  {
    for (const role of ['authenticated', 'service_role']) {
      await c.query('begin');
      await c.query(`set local role ${role}`);
      let denied = false;
      try {
        await c.query(`select app_private.claim_canonical_income_expense_draft_v1(gen_random_uuid(),'x-key-123')`);
      } catch (e) { denied = e.code === '42501'; }
      await c.query('rollback');
      if (!denied) fail(`S4: ${role} reached claim helper`);
    }
    out.push('S4 claim helper denied for authenticated/service_role — PASS');
  }

  // S5 writer wrapper ACL
  {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await c.query('begin');
      await c.query(`set local role ${role}`);
      let denied = false;
      try {
        await c.query(`select public.create_income_expense_v1(
          'EXPENSE','acl',gen_random_uuid(),null,null,null,null,null,null,null,
          '[]'::jsonb,null,null,current_date,'[]'::jsonb,'acl-key-1')`);
      } catch (e) { denied = e.code === '42501'; }
      await c.query('rollback');
      if (!denied) fail(`S5: ${role} could call the writer`);
    }
    out.push('S5 writer wrapper denied for anon/authenticated/service_role — PASS');
  }

  // S6 capability role invariants
  {
    const fn = (await c.query(`
      select count(*)::int c from pg_proc where proowner='ie_canonical_writer'::regrole`)).rows[0].c;
    const tbl = (await c.query(`
      select count(*)::int c from pg_class where relowner='ie_canonical_writer'::regrole`)).rows[0].c;
    const role = (await c.query(`
      select rolcanlogin, rolbypassrls from pg_roles where rolname='ie_canonical_writer'`)).rows[0];
    if (fn !== 1 || tbl !== 0 || role.rolcanlogin || role.rolbypassrls)
      fail(`S6: fn=${fn} tbl=${tbl} login=${role.rolcanlogin} bypass=${role.rolbypassrls}`);
    out.push('S6 capability-role invariants — PASS');
  }

  // S7 all a00_ triggers ENABLE ALWAYS
  {
    const bad = (await c.query(`
      select count(*)::int c from pg_trigger
       where tgname like 'a00\\_%' escape '\\' and tgenabled <> 'A'`)).rows[0].c;
    if (bad !== 0) fail(`S7: ${bad} guard triggers not ENABLE ALWAYS`);
    out.push('S7 guard triggers ENABLE ALWAYS — PASS');
  }

  // S8 suspended org denies (inside rolled-back tx)
  {
    await c.query('begin');
    await c.query(`update public.organizations set status='SUSPENDED' where id=$1`, [orgA]);
    const r = (await c.query(`
      select * from app_private.authorize_tenant_action_v3($1,$2,'income_expenses.create',null,null)`,
      [ownerA, orgA])).rows[0];
    if (r.allowed || r.decision_reason !== 'ORGANIZATION_INACTIVE_OR_MISSING')
      fail(`S8: ${r.allowed} ${r.decision_reason}`);
    await c.query('rollback');
    out.push('S8 suspended-org deny — PASS');
  }

  console.log(out.join('\n'));
  console.log('ALL 8 SECURITY MATRIX TESTS PASSED');
  await c.end();
};

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });

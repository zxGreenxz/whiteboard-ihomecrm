// Thử bản vá guard cột luật trên TEST, trong transaction rồi ROLLBACK.
// So TRƯỚC (G1+G3) và SAU (G1+G3+vá) cùng một bộ ca:
//   A. thành viên thường gọi hàm hệ thống SECURITY DEFINER tạo hạng mục force_approval=true  → phải ĐƯỢC
//   B. thành viên thường gọi hàm hệ thống đổi is_deposit                                      → phải ĐƯỢC
//   C. thành viên thường sửa THẲNG spend_mode qua bảng                                         → phải 42501
//   D. thành viên thường INSERT thẳng hạng mục mặc định (đường màn Danh mục)                   → phải ĐƯỢC
//   E. thành viên thường INSERT thẳng hạng mục is_deposit=true                                → phải 42501
//   F. chủ công ty sửa thẳng spend_mode                                                        → phải ĐƯỢC
//   G. chủ công ty INSERT thẳng hạng mục force_approval=true (không gửi org, autofill điền)   → phải ĐƯỢC
const fs = require('fs'); const path = require('path'); const pg = require('pg');
const REPO = 'C:/Users/Nguyen Tam/whiteboard-ihomecrm-main';
const MIG = (f) => path.join(REPO, 'supabase/migrations', f);
const G1 = MIG('20260926082454_bang_cam_ket_chi.sql');
const G3 = MIG('20260926113435_anh_xa_hang_muc_va_khoa_cot_luat.sql');
const VA = MIG('20260926140000_va_guard_cot_luat_chi_canh_ghi_truc_tiep.sql');
const ORG = 'aaaa0000-0000-4000-8000-000000000001';
const OWNER = '0520169e-0860-4b4e-a603-675c8aa245aa';
pg.types.setTypeParser(1082, (v) => v);
function cred() {
  const t = fs.readFileSync(path.join(REPO, 'CLAUDE.local.md'), 'utf8');
  return { ref: t.match(/TEST_SUPABASE_REF=(\S+)/)[1], pwd: t.match(/TEST_SUPABASE_DB_PASSWORD=(\S+)/)[1],
           host: t.match(/TEST_SUPABASE_POOLER_HOST=(\S+)/)[1] };
}
const strip = (f) => fs.readFileSync(f, 'utf8').replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, '');
const jwt = (uid) => JSON.stringify({ sub: uid, role: 'authenticated' });

async function bo(c, member) {
  const kq = {};
  const tienNha = (await c.query(`select id from public.income_expense_types where organization_id=$1 and fee_category='tien_nha'`, [ORG])).rows[0].id;
  const depRow = (await c.query(`select id, is_deposit from public.income_expense_types
      where organization_id=$1 and fee_category is null and not is_deposit and type='expense' order by created_at limit 1`, [ORG])).rows[0];
  // hàm hệ thống giả lập đúng mẫu _termination_ensure_type / pay_period_fee: DEFINER, chủ postgres
  await c.query(`create or replace function public.zz_thu_writer_he_thong(p_org uuid, p_uid uuid, p_dep uuid)
    returns int language plpgsql security definer set search_path to 'pg_catalog','public' as $f$
    begin
      insert into public.income_expense_types (user_id, organization_id, type, name, description, force_approval)
      values (p_uid, p_org, 'expense', 'Thử guard — hạng mục hệ thống ' || gen_random_uuid(), 'thử', true);
      update public.income_expense_types set is_deposit = true where id = p_dep and is_deposit is distinct from true;
      return 1;
    end $f$`);
  await c.query(`grant execute on function public.zz_thu_writer_he_thong(uuid,uuid,uuid) to authenticated`);
  const ca = async (ten, uid, sql, params) => {
    await c.query('SAVEPOINT ca');
    try {
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [jwt(uid)]);
      await c.query('SET LOCAL ROLE authenticated');
      const r = await c.query(sql, params);
      await c.query('RESET ROLE');
      kq[ten] = 'DUOC (' + r.rowCount + ' dong)';
    } catch (e) { kq[ten] = 'CHAN ' + e.code + ' ' + e.message.slice(0, 70); }
    await c.query('ROLLBACK TO SAVEPOINT ca');
  };
  await ca('A_member_goi_writer_tao_force', member, `select public.zz_thu_writer_he_thong($1,$2,$3)`, [ORG, member, depRow.id]);
  await ca('C_member_sua_thang_spend_mode', member, `update public.income_expense_types set spend_mode='TUNG_PHIEU' where id=$1`, [tienNha]);
  await ca('D_member_insert_thang_mac_dinh', member, `insert into public.income_expense_types (user_id, name, type) values ($1, 'Thử guard — thường ' || gen_random_uuid(), 'expense')`, [member]);
  await ca('E_member_insert_thang_is_deposit', member, `insert into public.income_expense_types (user_id, name, type, is_deposit) values ($1, 'Thử guard — cọc ' || gen_random_uuid(), 'expense', true)`, [member]);
  await ca('F_chu_sua_thang_spend_mode', OWNER, `update public.income_expense_types set spend_mode='TUNG_PHIEU' where id=$1`, [tienNha]);
  await ca('G_chu_insert_thang_force', OWNER, `insert into public.income_expense_types (user_id, name, type, force_approval) values ($1, 'Thử guard — chủ ' || gen_random_uuid(), 'expense', true)`, [OWNER]);
  // B: hàm hệ thống THẬT _termination_ensure_type với tên mới (INSERT force_approval=true)
  const coQuyen = (await c.query(`select has_function_privilege('authenticated','public._termination_ensure_type(uuid,text,text)','EXECUTE') x`)).rows[0].x;
  if (coQuyen) {
    await ca('B_member_goi_termination_ensure_type_THAT', member, `select public._termination_ensure_type($1,'expense','Thử guard — thanh lý ' || gen_random_uuid())`, [member]);
  } else {
    // authenticated không gọi thẳng được ⇒ đi qua một DEFINER bọc ngoài, đúng như pay_utility_bill gọi nó
    await c.query(`create or replace function public.zz_thu_boc_termination(p_uid uuid) returns uuid language sql security definer
      set search_path to 'pg_catalog','public' as $f$ select public._termination_ensure_type(p_uid,'expense','Thử guard — thanh lý ' || gen_random_uuid()) $f$`);
    await c.query(`grant execute on function public.zz_thu_boc_termination(uuid) to authenticated`);
    await ca('B_member_qua_definer_goi_termination_ensure_type_THAT', member, `select public.zz_thu_boc_termination($1)`, [member]);
  }
  return kq;
}

(async () => {
  const { ref, pwd, host } = cred();
  const c = new pg.Client({ host, port: 5432, database: 'postgres', user: 'postgres.' + ref, password: pwd,
    ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });
  await c.connect(); console.log('da noi TEST ' + ref);
  let ok = false; const out = {};
  await c.query('BEGIN');
  try {
    await c.query(strip(G1)); await c.query(strip(G3));
    const member = (await c.query(`
      select m.user_id from public.organization_memberships m
       where m.organization_id=$1 and m.status='ACTIVE' and m.user_id<>$2
         and not exists (select 1 from public.super_admins s where s.user_id=m.user_id)
         and not app_private.ie_actor_is_company_owner_v1($1, m.user_id)
       order by m.user_id limit 1`, [ORG, OWNER])).rows[0].user_id;
    // member phải có quyền sửa danh mục, nếu không RLS ẩn dòng và ca C/D/E không kết luận được
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [jwt(member)]);
    await c.query('SET LOCAL ROLE authenticated');
    const cap = (await c.query(`select public.can_access_org_entity('categories','edit') e, public.can_access_org_entity('categories','create') cr`)).rows[0];
    await c.query('RESET ROLE');
    console.log('thanh vien thu: ' + member + '  categories.edit=' + cap.e + ' create=' + cap.cr);

    await c.query('SAVEPOINT truoc');
    out.TRUOC = await bo(c, member);
    await c.query('ROLLBACK TO SAVEPOINT truoc');

    await c.query(strip(VA));
    out.SAU = await bo(c, member);
    // lượt hai của bản vá
    await c.query(strip(VA));
    const tg = (await c.query(`select tgname from pg_trigger where tgrelid='public.income_expense_types'::regclass and not tgisinternal order by 1`)).rows.map(r => r.tgname);
    out.trigger_sau = tg;
    ok = true;
  } catch (e) {
    console.error('LOI: ' + e.message + (e.position ? ' @' + e.position : ''));
  } finally { await c.query('ROLLBACK'); await c.end(); }
  for (const k of ['TRUOC', 'SAU']) {
    console.log('\n== ' + k + (k === 'TRUOC' ? ' (G1+G3, guard DEFINER)' : ' (G1+G3+va, guard INVOKER)') + ' ==');
    for (const [ten, v] of Object.entries(out[k] || {})) console.log('  ' + ten.padEnd(52) + v);
  }
  console.log('\ntrigger tren income_expense_types sau va: ' + (out.trigger_sau || []).join(', '));
  console.log('da ROLLBACK — TEST khong con dau vet.');
  fs.writeFileSync(path.join(__dirname, 'thu-va-guard-tren-TEST.json'), JSON.stringify({ chay_luc: new Date().toISOString(), ...out }, null, 1), 'utf8');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('THAT BAI:', e.message); process.exit(1); });

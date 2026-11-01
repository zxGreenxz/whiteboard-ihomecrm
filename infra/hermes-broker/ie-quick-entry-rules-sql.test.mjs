import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { localCluster, jwt, id, ORG, FOREIGN, USER } from './crm-shared-read-sql-fixture.mjs';

// Hàm dùng chung web + Hermes của "Báo chi nhanh" (Đợt 2 Thu chi, THU-CHI-THAO-TAC-GHI.md mục 4.2–4.3) trên PostgreSQL 17 dùng
// một lần, locale builtin C.UTF-8 (lower()/[[:alpha:]] theo Unicode như ICU en_US.UTF-8 của production — đã đọc TEST 22/10).
// (1) public.ie_category_suggest_v1 == bộ vector VÀNG do suggestCategory (TypeScript) sinh — cùng {rule_key, lý do} trên mọi
// câu (414 câu thật + ca dễ nhầm + cụm phí + mã khách hàng phí). Mốc 6: web gọi hàm này, bản TypeScript đã xoá ⇒ bộ vàng là đặc tả
// cố định (đổi luật = đổi hàm SQL bằng migration + sửa vàng).
// (2) lọc công ty / hạn chế / ẩn; (3) public.ie_default_cashbook_v1 đúng thứ tự pickDefaultAccount cũ; (4) đầu vào sai ⇒ 22023;
// (5) bảng đứng thay SQL của vitest (src/lib/quickEntry/__tests__/fixtures/goi-y-hang-muc-test.json) == hàm SQL.
// Lượt 11 (nghiệm thu 24/10): ie_quick_entry_shared_rules_v2 thêm lớp (3b) từ vựng vật tư / sửa chữa / văn phòng phẩm, áp lên thân v1. Bộ
// vàng đổi đúng 15 ca (đều từ không ra gì / gợi ý yếu ⇒ khoá cứng đúng hạng mục, đã soát tay) và thêm 37 câu chi thường gặp (vòi nước, ốc
// vít, ổ cắm, dây điện, văn phòng phẩm…, cả ca phải ra null).
const read = slug => {
  const files = readdirSync('supabase/migrations').filter(name => new RegExp(`^\\d{14}_${slug}\\.sql$`).test(name));
  assert.equal(files.length, 1, slug);
  return readFileSync(`supabase/migrations/${files[0]}`, 'utf8').replaceAll('\r\n', '\n');
};
// Lượt 14 (nghiệm thu vòng 1, 24/10): ie_quick_entry_shared_rules_v3 thêm từ vựng nội thất / điện máy / ăn uống / bỏ rác, mở rộng dụng cụ / vật
// tư điện nước, và "Chi khác" không bao giờ thắng trùng chữ tên; áp lên thân v2. Bộ vàng đổi đúng 32 ca (soát tay: không ra gì / trùng chữ sai ⇒
// khoá cứng đúng hạng mục; "chi phí …" ⇒ không còn ra "Chi khác") và thêm 60 câu (nệm, giường, tủ, kệ, quạt, ấm đun, cơm, pizza … cả ca phải ra
// null hoặc giữ nguyên: "mua nem", "sửa tủ", "vận chuyển giường", "giặt rèm", "mua bàn chải").
const sql = read('ie_quick_entry_shared_rules_v1'), sql2 = read('ie_quick_entry_shared_rules_v2'), sql3 = read('ie_quick_entry_shared_rules_v3');
const golden = JSON.parse(readFileSync('src/lib/quickEntry/__tests__/fixtures/goi-y-hang-muc-vang.json', 'utf8'));
const spec = JSON.parse(readFileSync('supabase/migrations/20261003151608_danh_muc_chi_du_lieu.sql', 'utf8').split('$spec$')[1]);
const lit = value => value === null || value === undefined ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
const typeId = new Map(spec.map((s, i) => [s.k, id(500 + i)]));
const [BUILDING, OTHER, CB_BUILDING, CB_LAST, CB_DEFAULT, CB_FIRST, CB_VIRTUAL, CB_FOREIGN, CB_NOT_HELD] = [40, 41, 60, 61, 62, 63, 64, 65, 66].map(id);
const code = expected => error => error.code === expected;

async function schema(pool) {
  await pool.query(`CREATE ROLE authenticated NOLOGIN; CREATE ROLE anon NOLOGIN;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated;
    CREATE TABLE public.income_expense_types(id uuid PRIMARY KEY,organization_id uuid,type text NOT NULL,name text NOT NULL,category text,rule_key text,
      keywords text[] NOT NULL DEFAULT '{}',fee_category text,sort_order integer,archived_at timestamptz,system_only boolean DEFAULT false,
      manual_hidden boolean DEFAULT false,quick_entry_hidden boolean DEFAULT false,is_restricted boolean DEFAULT false);
    -- Như production: RLS hạng mục cho thấy cả hạng mục của công ty khác (hàm phải tự lọc công ty).
    ALTER TABLE public.income_expense_types ENABLE ROW LEVEL SECURITY;
    CREATE POLICY fixture_all ON public.income_expense_types FOR SELECT TO authenticated USING(true);
    CREATE TABLE public.accounts(id uuid PRIMARY KEY,organization_id uuid,name text,quick_default_building_id uuid,is_default boolean DEFAULT false,
      is_virtual boolean DEFAULT false,deleted_at timestamptz);
    ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
    CREATE POLICY fixture_all ON public.accounts FOR SELECT TO authenticated USING(true);
    GRANT SELECT ON public.income_expense_types,public.accounts TO authenticated;
    -- Sổ người gọi đang giữ, như list_cashbooks_for_expense_v2 (không theo công ty, có thứ tự).
    CREATE TABLE public.fixture_custodian(user_id uuid,account_id uuid,ord int);
    CREATE FUNCTION public.list_cashbooks_for_expense_v2() RETURNS TABLE(id uuid,name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public
      AS $$ SELECT a.id,a.name FROM public.fixture_custodian c JOIN public.accounts a ON a.id=c.account_id WHERE c.user_id=auth.uid() ORDER BY c.ord $$;
    GRANT EXECUTE ON FUNCTION public.list_cashbooks_for_expense_v2() TO authenticated;
    INSERT INTO public.income_expense_types(id,organization_id,type,name,category,rule_key,keywords,manual_hidden,quick_entry_hidden,sort_order) VALUES
      ${spec.map((s, i) => `(${lit(typeId.get(s.k))},'${ORG}','expense',${lit(s.n)},${lit(s.g)},${lit(s.k)},ARRAY[${(s.kw ?? []).map(lit).join(',')}]::text[],${s.hid === true},${s.qeh === true},${(i + 1) * 10})`).join(',\n      ')},
      -- Công ty khác, cùng cụm "hay nói" và cùng tên: không bao giờ được chọn.
      ('${id(900)}','${FOREIGN}','expense','Tiền nhà','Cố định hằng tháng','tien_nha',ARRAY['tiền nhà','vòi nước'],false,false,1),
      -- Hạn chế: chỉ khi include_restricted.
      ('${id(901)}','${ORG}','expense','Lương quản lý','Nhân sự','luong_quan_ly',ARRAY['lương quản lý'],false,false,9999);
    UPDATE public.income_expense_types SET is_restricted=true WHERE id='${id(901)}';
    INSERT INTO public.accounts(id,organization_id,name,quick_default_building_id,is_default,is_virtual) VALUES
      ('${CB_BUILDING}','${ORG}','Sổ gắn toà','${BUILDING}',false,false),('${CB_LAST}','${ORG}','Sổ dùng lần trước',null,false,false),
      ('${CB_DEFAULT}','${ORG}','Sổ mặc định',null,true,false),('${CB_FIRST}','${ORG}','Sổ đầu',null,false,false),
      ('${CB_VIRTUAL}','${ORG}','Sổ ảo','${OTHER}',true,true),('${CB_FOREIGN}','${FOREIGN}','Sổ công ty khác','${OTHER}',true,false),
      ('${CB_NOT_HELD}','${ORG}','Sổ không giữ','${OTHER}',true,false);
    INSERT INTO public.fixture_custodian VALUES('${USER}','${CB_VIRTUAL}',1),('${USER}','${CB_FOREIGN}',2),('${USER}','${CB_FIRST}',3),
      ('${USER}','${CB_BUILDING}',4),('${USER}','${CB_LAST}',5),('${USER}','${CB_DEFAULT}',6);`);
}

test('ie_quick_entry_shared_rules_v1 + v2 + v3: gợi ý hạng mục == vàng; lọc công ty/hạn chế; sổ mặc định; đầu vào sai; idempotent', { timeout: 240000 }, async t => {
  const { pool, cleanup } = await localCluster(t, { initdbArgs: ['--locale-provider=builtin', '--builtin-locale=C.UTF-8'] });
  t.after(async () => { await pool.end(); cleanup(); });
  await schema(pool);
  await pool.query(sql); await pool.query(sql); // Idempotent.
  // v2 ghim md5 thân đang chạy (= thân v1) hoặc thân của chính nó: thân lạ ⇒ dừng, không thay.
  await pool.query('BEGIN');
  await pool.query(`CREATE OR REPLACE FUNCTION public.ie_category_suggest_v1(p_organization_id uuid,p_items jsonb,p_type text DEFAULT 'expense',
    p_include_restricted boolean DEFAULT false) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $f$ SELECT '[]'::jsonb $f$`);
  await assert.rejects(pool.query(sql2), error => error.message === 'ie_quick_entry_rules_v2_body_drift');
  await pool.query('ROLLBACK');
  await pool.query(sql2); await pool.query(sql2); // Áp lên thân v1, rồi áp lại.
  // v3 ghim md5 thân v2 hoặc thân của chính nó: thân lạ ⇒ dừng, không thay.
  await pool.query('BEGIN');
  await pool.query(`CREATE OR REPLACE FUNCTION public.ie_category_suggest_v1(p_organization_id uuid,p_items jsonb,p_type text DEFAULT 'expense',
    p_include_restricted boolean DEFAULT false) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $f$ SELECT '[]'::jsonb $f$`);
  await assert.rejects(pool.query(sql3), error => error.message === 'ie_quick_entry_rules_v3_body_drift');
  await pool.query('ROLLBACK');
  await pool.query(sql3); await pool.query(sql3); // Áp lên thân v2, rồi áp lại.
  const suggest = (items, { org = ORG, type = 'expense', restricted = false } = {}) => jwt(pool, async c =>
    (await c.query('SELECT public.ie_category_suggest_v1($1::uuid,$2::jsonb,$3,$4) value', [org, JSON.stringify(items), type, restricted])).rows[0].value);
  const keyOf = new Map([...typeId].map(([key, value]) => [value, key]));

  await t.test('mọi ca vàng: cùng hạng mục (rule_key) và cùng lý do với suggestCategory', async () => {
    const wrong = [];
    for (let start = 0; start < golden.length; start += 100) {
      const batch = golden.slice(start, start + 100);
      const got = await suggest(batch.map(c => ({ text: c.text, feeCategory: c.fee })));
      assert.equal(got.length, batch.length);
      batch.forEach((c, i) => {
        const value = got[i] === null ? null : { key: keyOf.get(got[i].typeId), reason: got[i].reason };
        if (got[i] !== null) assert.equal(got[i].ruleKey, value.key, 'ruleKey khớp typeId');
        if (JSON.stringify(value) !== JSON.stringify(c.expect)) wrong.push(`${c.text} [${c.fee}] ⇒ ${JSON.stringify(value)} (TS: ${JSON.stringify(c.expect)})`);
      });
    }
    assert.deepEqual(wrong, [], `${wrong.length}/${golden.length} lệch`);
    t.diagnostic(`${golden.length} ca vàng khớp`);
  });

  await t.test('chỉ hạng mục của công ty được hỏi; hạn chế chỉ khi include_restricted; chiều thu không thấy hạng mục chi', async () => {
    assert.deepEqual(await suggest([{ text: 'mua vòi nước' }], { org: FOREIGN }), [{ typeId: id(900), ruleKey: 'tien_nha', reason: 'rule' }],
      'công ty khác thấy đúng hạng mục của mình');
    const own = await suggest([{ text: 'tiền nhà tháng 10 512TT' }]);
    assert.equal(own[0].typeId, typeId.get('tien_nha'));
    assert.notEqual((await suggest([{ text: 'trả lương quản lý tháng 9' }]))[0]?.typeId, id(901), 'không có quyền hạng mục hạn chế ⇒ không bao giờ ra nó');
    assert.deepEqual((await suggest([{ text: 'trả lương quản lý tháng 9' }], { restricted: true }))[0]?.typeId, id(901));
    assert.deepEqual(await suggest([{ text: 'tiền nhà tháng 10 512TT' }], { type: 'income' }), [null]);
    assert.deepEqual(await suggest([]), []);
    assert.deepEqual(await suggest([{ text: '   ' }]), [null]);
  });

  await t.test('đầu vào sai ⇒ 22023', async () => {
    for (const items of [{ text: 'x' }, [{ text: 1 }], [{ text: 'x', feeCategory: 3 }], ['x'], Array.from({ length: 101 }, () => ({ text: 'x' })),
      [{ text: 'x'.repeat(1001) }]]) await assert.rejects(suggest(items), code('22023'), JSON.stringify(items).slice(0, 60));
    await assert.rejects(suggest([{ text: 'x' }], { type: 'EXPENSE' }), code('22023'));
    await assert.rejects(jwt(pool, c => c.query("SELECT public.ie_category_suggest_v1(NULL,'[]'::jsonb)")), code('22023'));
  });

  await t.test('sổ mặc định: gắn toà → dùng lần trước → mặc định → đầu tiên; chỉ sổ đang giữ, đúng công ty, không ảo', async () => {
    const pick = (building, last, org = ORG) => jwt(pool, async c =>
      (await c.query('SELECT public.ie_default_cashbook_v1($1::uuid,$2::uuid,$3::uuid) value', [org, building, last])).rows[0].value);
    assert.equal(await pick(BUILDING, CB_LAST), CB_BUILDING);
    assert.equal(await pick(OTHER, CB_LAST), CB_LAST, 'sổ gắn toà OTHER là ảo / công ty khác / không giữ');
    assert.equal(await pick(null, CB_NOT_HELD), CB_DEFAULT, 'sổ nhớ mà không còn giữ thì bỏ qua');
    assert.equal(await pick(null, null), CB_DEFAULT);
    await pool.query(`UPDATE public.accounts SET is_default=false WHERE id='${CB_DEFAULT}'`);
    assert.equal(await pick(null, null), CB_FIRST, 'sổ đầu theo thứ tự list_cashbooks_for_expense_v2, bỏ sổ ảo và sổ công ty khác');
    assert.equal(await pick(null, null, FOREIGN), CB_FOREIGN);
    assert.equal(await pick(null, null, id(999)), null);
  });

  await t.test('Mốc 6: bảng đứng thay SQL của vitest (goi-y-hang-muc-test.json) == hàm SQL trên đúng các danh sách hạng mục đó', async () => {
    const stub = JSON.parse(readFileSync('src/lib/quickEntry/__tests__/fixtures/goi-y-hang-muc-test.json', 'utf8'));
    const wrong = [];
    for (const [r, rows] of stub.rowsets.entries()) {
      const org = id(2000 + r), toDb = new Map(rows.map((row, j) => [row.id, id(3000 + r * 100 + j)])), fromDb = new Map([...toDb].map(([a, b]) => [b, a]));
      if (rows.length) await pool.query(`INSERT INTO public.income_expense_types(id,organization_id,type,name,category,rule_key,keywords,fee_category,sort_order,
          archived_at,system_only,manual_hidden,quick_entry_hidden,is_restricted) VALUES ${rows.map((row, j) => `(${lit(toDb.get(row.id))},${lit(org)},${lit(row.type)},
          ${lit(row.name)},${lit(row.category)},${lit(row.rule_key)},ARRAY[${(row.keywords ?? []).map(lit).join(',')}]::text[],${lit(row.fee_category)},${j},
          ${lit(row.archived_at)},${row.system_only === true},${row.manual_hidden === true},${row.quick_entry_hidden === true},${row.is_restricted === true})`).join(',')}`);
      for (const c of stub.cases.filter(x => x.rowset === r)) {
        const [got] = await suggest([{ text: c.text, feeCategory: c.fee }], { org, type: c.type, restricted: true });
        const value = got === null ? null : { id: fromDb.get(got.typeId), reason: got.reason };
        if (JSON.stringify(value) !== JSON.stringify(c.out)) wrong.push(`#${r} ${c.type} ${c.text} [${c.fee}] ⇒ ${JSON.stringify(value)} (bảng: ${JSON.stringify(c.out)})`);
      }
    }
    assert.deepEqual(wrong, [], `${wrong.length}/${stub.cases.length} lệch`);
    t.diagnostic(`${stub.cases.length} câu của bảng đứng thay khớp hàm SQL`);
  });

  await t.test('catalog: INVOKER, đúng độ biến động, anon không gọi được, search_path rỗng', async () => {
    const rows = (await pool.query(`SELECT p.proname,p.prosecdef,p.provolatile,p.proconfig,has_function_privilege('anon',p.oid,'EXECUTE') anon,
      has_function_privilege('authenticated',p.oid,'EXECUTE') auth FROM pg_proc p WHERE p.proname IN ('ie_quick_text_v1','ie_category_suggest_v1','ie_default_cashbook_v1') ORDER BY 1`)).rows;
    assert.deepEqual(rows.map(r => [r.proname, r.prosecdef, r.provolatile, r.proconfig, r.anon, r.auth]), [
      ['ie_category_suggest_v1', false, 's', ['search_path=""'], false, true], ['ie_default_cashbook_v1', false, 's', ['search_path=""'], false, true],
      ['ie_quick_text_v1', false, 'i', ['search_path=""'], false, true]]);
    assert.equal((await pool.query("SELECT public.ie_quick_text_v1('Đóng TIỀN Điện, T10!') a,public.ie_quick_text_v1('Đóng TIỀN Điện, T10!',true) b")).rows[0].b,
      ' dong tien dien t10 ');
  });
});

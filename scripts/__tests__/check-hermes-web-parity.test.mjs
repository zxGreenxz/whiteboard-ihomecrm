// Đột biến cho check-hermes-web-parity (chuông báo Hermes ↔ web, chủ chốt 17/10/2026).
// Mỗi ca dựng một repo giả trong thư mục tạm: src/ có vùng hermes-parity, migrations có
// RPC web, hàm Hermes và nguồn SQL CRM; rồi đổi đúng một thứ và đòi gate đỏ/xanh.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MAP_PATH, buildSqlCatalog, checkParity, extractRegions, main, sqlCalls, sqlStatements, stripSqlComments,
} from '../check-hermes-web-parity.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const HOOK = `import { supabase } from './client';
export async function load(ids: string[]) {
  // hermes-parity:begin web-report — Hermes chép vùng này
  const { data, error } = await supabase.rpc('web_report_v1', {
    p_ids: ids.length ? ids : undefined,
  });
  // hermes-parity:end web-report
  if (error) throw error;
  return data;
}
`;
const FILTER = `export function filter(q) {
  let query = base();
  // hermes-parity:begin web-filter
  if (q.status === 'paid') {
    query = query.eq('status', 'PAID');
  }
  // hermes-parity:end web-filter
  query = query.limit(50);
  // hermes-parity:begin web-filter
  query = query.order('created_at', { ascending: false });
  // hermes-parity:end web-filter
  return query;
}
`;
const MIGRATIONS = {
  '20260101000000_web.sql': `-- RPC web
CREATE OR REPLACE FUNCTION public.web_report_v1(p_ids uuid[] DEFAULT NULL)
RETURNS SETOF record LANGUAGE sql STABLE AS $$ SELECT 1 $$;
CREATE OR REPLACE FUNCTION public.crm_source(p int) RETURNS int LANGUAGE plpgsql AS $fn$
BEGIN
  -- giải thích; có cả 'chuỗi -- không phải chú thích'
  RETURN p + 1;
END $fn$;
CREATE OR REPLACE FUNCTION app_private.authorized_scope_v3(p_key text,p_org uuid) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
CREATE POLICY things_select ON public.things FOR SELECT USING (owner_id = auth.uid());
ALTER POLICY things_select ON public.things USING (owner_id IN (SELECT public.visible_owners()));
`,
  '20260201000000_hermes.sql': `BEGIN;
CREATE OR REPLACE FUNCTION app_private.hermes_report(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE v jsonb;
BEGIN
  -- Như web: gọi thẳng web_report_v1; lọc như filter()
  SELECT jsonb_agg(r) INTO v FROM public.web_report_v1(NULL) r WHERE owner_id = ANY(public.visible_owners());
  PERFORM app_private.authorized_scope_v3('x', NULL);
  RETURN v;
END $fn$;
COMMIT;
`,
};

function fixtureDoc() {
  return {
    schemaVersion: 1,
    entries: [
      {
        id: 'web-report', kind: 'rpc', description: 'Báo cáo web gọi RPC', rpc: ['web_report_v1'],
        web: [{ path: 'src/hooks/useReport.ts', region: 'web-report' }],
        webCalls: [{ path: 'src/hooks/useReport.ts', rpc: 'web_report_v1' }],
        hermes: [{ sql: 'app_private.hermes_report', calls: ['web_report_v1'] }],
      },
      {
        id: 'web-filter', kind: 'mirrored', description: 'Bộ lọc web Hermes chép',
        web: [{ path: 'src/lib/filter.ts', region: 'web-filter' }],
        sql: [{ function: 'public.crm_source' }, { policy: 'things_select', table: 'public.things' }],
        hermes: [{ sql: 'app_private.hermes_report', calls: ['visible_owners'] }, { path: 'infra/hermes-broker/contract.mjs', contains: 'crm.report' }],
      },
      {
        id: 'scope', kind: 'rpc', description: 'Quyền CRM', rpc: ['authorized_scope_v3'],
        successorGuard: ['app_private.authorized_scope_v3'],
        hermes: [{ sql: 'app_private.hermes_report', calls: ['authorized_scope_v3'] }],
      },
    ],
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hermes-web-parity-'));
  roots.push(root);
  const all = {
    'src/hooks/useReport.ts': HOOK,
    'src/lib/filter.ts': FILTER,
    'src/lib/untouched.ts': 'export const x = 1;\n',
    'infra/hermes-broker/contract.mjs': "export const SOURCE = 'crm.report';\n",
    ...Object.fromEntries(Object.entries(MIGRATIONS).map(([name, sql]) => [`supabase/migrations/${name}`, sql])),
  };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const doc = fixtureDoc();
  const written = checkParity({ root, doc, write: true });
  assert.deepEqual(written.errors, [], 'fixture gốc phải ghi được hash');
  mkdirSync(join(root, dirname(MAP_PATH)), { recursive: true });
  writeFileSync(join(root, MAP_PATH), `${JSON.stringify(doc, null, 2)}\n`);
  return { root, doc };
}
const edit = (root, path, change) => writeFileSync(join(root, path), change(readFileSync(join(root, path), 'utf8')));
const check = (root, doc) => checkParity({ root, doc: structuredClone(doc) });
const errorsOf = (root, doc) => check(root, doc).errors;

test('bản gốc: --write ghi đủ hash, kiểm lại xanh', () => {
  const { root, doc } = fixture();
  assert.equal(doc.entries[0].web[0].sha256.length, 64);
  assert.equal(doc.entries[1].sql.length, 2);
  for (const source of doc.entries[1].sql) assert.match(source.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(errorsOf(root, doc), []);
});

test('ĐỘT BIẾN: sửa 1 ký tự trong vùng web ⇒ đỏ, chỉ đúng nơi Hermes chép và lệnh --write', () => {
  const { root, doc } = fixture();
  edit(root, 'src/lib/filter.ts', (text) => text.replace("'PAID'", "'PAYD'"));
  const errors = errorsOf(root, doc);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\[web-filter\] Web đã đổi src\/lib\/filter\.ts#web-filter; cập nhật Hermes ở app_private\.hermes_report \(supabase\/migrations\/20260201000000_hermes\.sql\); infra\/hermes-broker\/contract\.mjs/);
  assert.match(errors[0], /node scripts\/check-hermes-web-parity\.mjs --write/);
});

test('ĐỘT BIẾN: sửa khối thứ hai cùng tên vùng cũng đỏ', () => {
  const { root, doc } = fixture();
  edit(root, 'src/lib/filter.ts', (text) => text.replace('ascending: false', 'ascending: true'));
  assert.match(errorsOf(root, doc).join('\n'), /Web đã đổi src\/lib\/filter\.ts#web-filter/);
});

test('đổi khoảng trắng đầu/cuối dòng, dòng trống, CRLF và mã NGOÀI vùng ⇒ không đỏ', () => {
  const { root, doc } = fixture();
  edit(root, 'src/lib/filter.ts', (text) => text
    .replace("    query = query.eq('status', 'PAID');", "\t\t\tquery = query.eq('status', 'PAID');   \n\n")
    .replace('limit(50)', 'limit(10)')
    .replace(/\n/g, '\r\n'));
  edit(root, 'src/hooks/useReport.ts', (text) => text.replace(/\n/g, '\r\n'));
  assert.deepEqual(errorsOf(root, doc), []);
});

test('ĐỘT BIẾN: xoá marker ⇒ đỏ (thiếu cả cặp hoặc thiếu end)', () => {
  const { root, doc } = fixture();
  edit(root, 'src/hooks/useReport.ts', (text) => text.replace(/^.*hermes-parity:(?:begin|end) web-report.*\n/gm, ''));
  assert.match(errorsOf(root, doc).join('\n'), /\[web-report\] Thiếu marker "hermes-parity:begin web-report"/);

  const second = fixture();
  edit(second.root, 'src/hooks/useReport.ts', (text) => text.replace(/^.*hermes-parity:end web-report.*\n/m, ''));
  const errors = errorsOf(second.root, second.doc).join('\n');
  assert.match(errors, /"hermes-parity:begin web-report" chưa có "hermes-parity:end web-report"/);
});

test('ĐỘT BIẾN: web bỏ gọi RPC (chuyển sang _v2) ⇒ đỏ dù hash vùng đã được ghi lại', () => {
  const { root, doc } = fixture();
  edit(root, 'src/hooks/useReport.ts', (text) => text.replace("rpc('web_report_v1'", "rpc('web_report_v2'"));
  const rewritten = checkParity({ root, doc: structuredClone(doc), write: true });
  assert.match(rewritten.errors.join('\n'), /\[web-report\] Web không còn gọi RPC web_report_v1 trong src\/hooks\/useReport\.ts/);
  // Lời gọi chỉ còn trong chú thích không được tính.
  edit(root, 'src/hooks/useReport.ts', (text) => `// cũ: supabase.rpc('web_report_v1')\n${text}`);
  assert.match(errorsOf(root, doc).join('\n'), /Web không còn gọi RPC web_report_v1/);
});

const migrate = (root, name, sql) => writeFileSync(join(root, 'supabase/migrations', name), sql);

test('ĐỘT BIẾN: bản định nghĩa CUỐI của hàm Hermes không còn gọi RPC web ⇒ đỏ (chú thích không tính)', () => {
  const { root, doc } = fixture();
  migrate(root, '20260301000000_hermes_v2.sql', `CREATE OR REPLACE FUNCTION app_private.hermes_report(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $fn$
BEGIN
  -- trước đây gọi public.web_report_v1(NULL)
  RETURN (SELECT jsonb_agg(r) FROM public.web_report_v1_copy(NULL) r WHERE owner_id = ANY(public.visible_owners()) AND app_private.authorized_scope_v3('x',NULL) = 1);
END $fn$;`);
  const errors = errorsOf(root, doc).join('\n');
  assert.match(errors, /Bản định nghĩa cuối của app_private\.hermes_report \(supabase\/migrations\/20260301000000_hermes_v2\.sql\) không còn gọi web_report_v1/);
  assert.doesNotMatch(errors, /không còn gọi visible_owners/);
  assert.doesNotMatch(errors, /không còn gọi authorized_scope_v3/);
});

test('ĐỘT BIẾN: hàm Hermes bị DROP ⇒ đỏ', () => {
  const { root, doc } = fixture();
  migrate(root, '20260301000000_drop.sql', 'DROP FUNCTION IF EXISTS public.other(int), app_private.hermes_report(jsonb) CASCADE;');
  assert.match(errorsOf(root, doc).join('\n'), /Hàm Hermes app_private\.hermes_report đã bị DROP\/đổi tên ở supabase\/migrations\/20260301000000_drop\.sql/);
});

test('ĐỘT BIẾN: CRM đổi thân hàm SQL mà Hermes chép ⇒ đỏ; chỉ đổi chú thích ⇒ không đỏ', () => {
  const comment = fixture();
  migrate(comment.root, '20260301000000_crm.sql', `CREATE OR REPLACE FUNCTION public.crm_source(p int) RETURNS int LANGUAGE plpgsql AS $fn$
BEGIN
  /* chú thích mới */ -- và dòng này
  RETURN p + 1; -- vẫn vậy
END $fn$;`);
  assert.deepEqual(errorsOf(comment.root, comment.doc), []);

  const changed = fixture();
  migrate(changed.root, '20260301000000_crm.sql',
    'CREATE OR REPLACE FUNCTION public.crm_source(p int) RETURNS int LANGUAGE plpgsql AS $fn$ BEGIN RETURN p + 2; END $fn$;');
  assert.match(errorsOf(changed.root, changed.doc).join('\n'), /\[web-filter\] CRM đã đổi hàm public\.crm_source \(bản cuối supabase\/migrations\/20260301000000_crm\.sql\)/);
});

test('ĐỘT BIẾN: CRM đổi RLS policy Hermes chép ⇒ đỏ; DROP policy ⇒ đỏ', () => {
  const altered = fixture();
  migrate(altered.root, '20260301000000_rls.sql', 'ALTER POLICY things_select ON public.things USING (true);');
  assert.match(errorsOf(altered.root, altered.doc).join('\n'), /CRM đã đổi policy things_select ON public\.things/);

  const dropped = fixture();
  migrate(dropped.root, '20260301000000_rls.sql', 'DROP POLICY IF EXISTS things_select ON public.things;');
  assert.match(errorsOf(dropped.root, dropped.doc).join('\n'), /policy things_select ON public\.things đã bị DROP/);
});

test('ĐỘT BIẾN: CRM có authorized_scope_v4 mà Hermes còn gọi v3 ⇒ đỏ', () => {
  const { root, doc } = fixture();
  migrate(root, '20260301000000_scope.sql',
    'CREATE OR REPLACE FUNCTION app_private.authorized_scope_v4(p_key text,p_org uuid) RETURNS int LANGUAGE sql AS $$ SELECT 2 $$;');
  assert.match(errorsOf(root, doc).join('\n'), /\[scope\] CRM đã có app_private\.authorized_scope_v4 .* mới hơn app_private\.authorized_scope_v3/);
});

test('ĐỘT BIẾN: marker mồ côi hoặc marker chung dòng mã ⇒ đỏ', () => {
  const { root, doc } = fixture();
  edit(root, 'src/lib/untouched.ts', (text) => `// hermes-parity:begin new-thing\n${text}// hermes-parity:end new-thing\n`);
  assert.match(errorsOf(root, doc).join('\n'), /src\/lib\/untouched\.ts: marker hermes-parity "new-thing" không thuộc mục nào/);

  const inline = fixture();
  edit(inline.root, 'src/lib/untouched.ts', (text) => `${text}foo(); // hermes-parity:end web-filter\n`);
  assert.match(errorsOf(inline.root, inline.doc).join('\n'), /phải nằm trên dòng chú thích riêng/);
});

test('--write cập nhật đúng hash vùng đã đổi, giữ hash khác; từ chối ghi khi còn lỗi cấu trúc', () => {
  const { root, doc } = fixture();
  const before = structuredClone(doc);
  edit(root, 'src/lib/filter.ts', (text) => text.replace("'PAID'", "'PAYD'"));
  assert.equal(main(['--write'], root), 0);
  const saved = JSON.parse(readFileSync(join(root, MAP_PATH), 'utf8'));
  assert.notEqual(saved.entries[1].web[0].sha256, before.entries[1].web[0].sha256);
  assert.equal(saved.entries[0].web[0].sha256, before.entries[0].web[0].sha256);
  assert.deepEqual(saved.entries[1].sql, before.entries[1].sql);
  assert.equal(main([], root), 0);

  edit(root, 'src/hooks/useReport.ts', (text) => text.replace(/^.*hermes-parity:end web-report.*\n/m, '').replace("'web_report_v1'", "'web_report_v9'"));
  edit(root, 'src/lib/filter.ts', (text) => text.replace("'PAYD'", "'PAID'"));
  assert.equal(main(['--write'], root), 1);
  assert.deepEqual(JSON.parse(readFileSync(join(root, MAP_PATH), 'utf8')), saved, '--write không được ghi khi còn lỗi cấu trúc');
});

test('main: lệch ⇒ 1, bản đồ hỏng/thiếu ⇒ 3', () => {
  const { root } = fixture();
  edit(root, 'src/lib/filter.ts', (text) => text.replace("'PAID'", "'PAYD'"));
  assert.equal(main([], root), 1);
  writeFileSync(join(root, MAP_PATH), '{ hỏng');
  assert.equal(main([], root), 3);
  writeFileSync(join(root, MAP_PATH), JSON.stringify({ schemaVersion: 1, entries: [] }));
  assert.equal(main([], root), 3);
});

test('bản đồ phải chặt: khoá lạ, rpc không có hàm Hermes gọi, mirrored không nguồn ⇒ lỗi', () => {
  const { root } = fixture();
  const doc = fixtureDoc();
  doc.entries[0].typo = true;
  doc.entries[0].hermes[0].calls = [];
  doc.entries[1].web = [];
  doc.entries[1].sql = [];
  const errors = checkParity({ root, doc }).errors.join('\n');
  assert.match(errors, /khoá lạ "typo"/);
  assert.match(errors, /rpc web_report_v1 không có hàm Hermes nào khai calls/);
  assert.match(errors, /kind mirrored cần web hoặc sql/);
});

test('bộ đọc SQL: chú thích, chuỗi, $tag$ lồng; tách câu đúng', () => {
  const sql = `-- CREATE FUNCTION public.fake() trong chú thích
/* CREATE FUNCTION public.fake2() /* lồng */ */
CREATE FUNCTION public.a() RETURNS text LANGUAGE plpgsql AS $body$
BEGIN
  EXECUTE $q$SELECT ';' -- trong chuỗi động$q$;
  RETURN E'it''s \\' -- ;' || 'x;y'; -- chú thích thật
END $body$;
SELECT 1;`;
  const statements = sqlStatements(sql);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /^CREATE FUNCTION public\.a\(\)/);
  assert.equal(statements[1], 'SELECT 1');
  const deep = stripSqlComments(statements[0], { deep: true });
  assert.doesNotMatch(deep, /chú thích thật/);
  assert.match(deep, /'x;y'/);
  assert.ok(sqlCalls('PERFORM public.fa_monthly_pnl_accrual(a)', 'fa_monthly_pnl_accrual'));
  assert.ok(!sqlCalls('PERFORM public.fa_monthly_pnl_accrual(a)', 'fa_monthly_pnl'), 'tên dài hơn không được tính là gọi tên ngắn');
  assert.ok(!sqlCalls('-- fa_monthly_pnl(a)\nSELECT 1', 'fa_monthly_pnl'));
});

test('extractRegions: vùng lồng khác tên không lẫn marker vào nội dung', () => {
  const { regions, errors } = extractRegions([
    '// hermes-parity:begin outer', 'a();', '  // hermes-parity:begin inner', 'b();', '// hermes-parity:end inner', 'c();', '// hermes-parity:end outer',
  ].join('\n'));
  assert.deepEqual(errors, []);
  assert.equal(regions.get('outer'), 'a();\nb();\nc();');
  assert.equal(regions.get('inner'), 'b();');
});

test('bản đồ thật của repo dựng được: không lỗi cấu trúc, hàm Hermes và nguồn CRM đều tìm thấy', () => {
  const doc = JSON.parse(readFileSync(join(REPO_ROOT, MAP_PATH), 'utf8'));
  const result = checkParity({ root: REPO_ROOT, doc });
  assert.equal(result.structural, false, result.errors.join('\n'));
  const catalog = buildSqlCatalog({ root: REPO_ROOT, functions: ['app_private.hermes_report_read_v2'] });
  assert.equal(catalog.functions.get('app_private.hermes_report_read_v2')?.action, 'create');
});

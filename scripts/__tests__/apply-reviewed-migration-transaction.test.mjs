// Bóc transaction của file migration — chỗ đã gây ra cú đi vòng 07/08/2026.
//
// VÌ SAO FILE NÀY TỒN TẠI
//   Runner quét `END;` đứng một mình trên một dòng và coi đó là lệnh kết thúc
//   transaction. Thân hàm plpgsql cũng kết thúc bằng đúng `END;` — và KHÁC với
//   `BEGIN` (comment cũ đã lường trước vì plpgsql BEGIN không có chấm phẩy),
//   plpgsql `END` thì CÓ.
//
//   Đo được: 3 trên 4 migration sau cutoff bị lane TỪ CHỐI SAI. Nghĩa là đường
//   apply chính thức không nuốt nổi migration nào định nghĩa hàm plpgsql — gần
//   như mọi migration của repo này.
//
//   Đó mới là nguyên nhân gốc của việc POST SQL thẳng qua Management API: không
//   phải cẩu thả, mà là cửa chính không mở được. Một cửa chặn từ chối nhầm việc
//   hợp lệ sẽ luôn bị đi vòng, và mọi luật viết thêm về nó đều vô nghĩa cho tới
//   khi nó mở được.
//
//   Bản vá đã vào; file này giữ cho nó không quay lại. Trước đây
//   apply-reviewed-migration.test.mjs chỉ có ĐÚNG MỘT test và không ca nào chạm
//   tới plpgsql.
//
//   node --test scripts/__tests__/apply-reviewed-migration-transaction.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { buildTransaction } from "../apply-reviewed-migration.mjs";
import { readFileSync } from "node:fs";
import { HERMES_READ_STANDARD_FUNCTIONS } from "../hermes-read-function-specs.mjs";

/** Migration điển hình của repo: BEGIN/COMMIT thật + hàm plpgsql kết thúc `END;`. */
const CO_HAM_PLPGSQL = `BEGIN;

CREATE OR REPLACE FUNCTION public.vi_du(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_x int;
BEGIN
  SELECT 1 INTO v_x;
  RETURN jsonb_build_object('x', v_x);
END;
$$;

COMMIT;`;

test("END; của thân hàm plpgsql KHÔNG bị tính là kết thúc transaction", () => {
  // Trước bản vá, ca này ném "Migration có 2 lệnh kết thúc transaction".
  const sql = buildTransaction(CO_HAM_PLPGSQL, { rollback: true });
  assert.match(sql, /ROLLBACK;\s*$/, "phải đóng bằng ROLLBACK ở dry-run");
  // Thân hàm phải còn NGUYÊN — gỡ nhầm `END;` bên trong sẽ tạo ra SQL không chạy được.
  assert.match(sql, /RETURN jsonb_build_object\('x', v_x\);\s*\nEND;/);
});

test("hai hàm plpgsql trong một file vẫn qua được", () => {
  // DÙNG HÀM THAY THẾ, KHÔNG DÙNG CHUỖI.
  //
  // Trong JS, `$$` nằm trong chuỗi thay thế của String.replace là ESCAPE cho một
  // dấu `$`. Bản đầu của test này truyền chuỗi, nên `AS $$` bị biến thành `AS $`
  // — dollar-quote vỡ, `END;` lộ ra, và test báo lỗi ở bản vá trong khi bản vá
  // đúng. Đúng loại bẫy mà một test sai sẽ đổ tội cho code đúng.
  const hai = CO_HAM_PLPGSQL.replace(
    "COMMIT;",
    () =>
      `CREATE OR REPLACE FUNCTION public.vi_du_2() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1;
END;
$$;

COMMIT;`,
  );
  const sql = buildTransaction(hai, { rollback: true });
  assert.equal((sql.match(/^END;$/gm) ?? []).length, 2, "cả hai END; của hàm phải còn");
});

test("dollar-quote có TÊN ($fn$) cũng được che", () => {
  const coTag = `BEGIN;
CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM 1;
END;
$fn$;
COMMIT;`;
  const sql = buildTransaction(coTag, { rollback: true });
  assert.match(sql, /^END;$/m);
  assert.match(sql, /ROLLBACK;\s*$/);
});

test("COMMIT; THẬT vẫn bị gỡ và thay bằng đúng thứ đã hứa", () => {
  // Đây là tính chất an toàn cốt lõi: dry-run phải đóng bằng ROLLBACK, và không
  // được còn sót COMMIT nào ở mức câu lệnh — nếu sót, "dry-run" sẽ ghi thật.
  const sql = buildTransaction(CO_HAM_PLPGSQL, { rollback: true });
  const dongMucCauLenh = sql.match(/^(COMMIT|ROLLBACK);$/gm) ?? [];
  assert.deepEqual(dongMucCauLenh, ["ROLLBACK;"]);
});

test("apply thật đóng bằng COMMIT, đúng một lần", () => {
  const sql = buildTransaction(CO_HAM_PLPGSQL, { rollback: false });
  const dongMucCauLenh = sql.match(/^(COMMIT|ROLLBACK);$/gm) ?? [];
  assert.deepEqual(dongMucCauLenh, ["COMMIT;"]);
});

test("HAI cặp transaction thật ⇒ vẫn từ chối", () => {
  // Bản vá không được nới chỗ này: hai COMMIT thật là file người viết sai, và
  // runner không gỡ an toàn được.
  const hai = `BEGIN;
SELECT 1;
COMMIT;
BEGIN;
SELECT 2;
COMMIT;`;
  assert.throws(() => buildTransaction(hai), /kết thúc transaction|BEGIN/);
});

test("dollar-quote mở mà không đóng ⇒ không được im lặng nuốt phần còn lại", () => {
  const hong = `BEGIN;
CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1;
COMMIT;`;
  // Không khẳng định ném hay không — khẳng định điều QUAN TRỌNG: kết quả không
  // được là một transaction đóng bằng COMMIT trong khi người gọi xin ROLLBACK.
  let sql = null;
  try {
    sql = buildTransaction(hong, { rollback: true });
  } catch {
    return; // ném cũng là kết cục chấp nhận được
  }
  const dong = sql.match(/^(COMMIT|ROLLBACK);$/gm) ?? [];
  assert.ok(!dong.includes("COMMIT;"), "dry-run không được sót COMMIT ở mức câu lệnh");
});

const SQL_STANDARD = `BEGIN;
CREATE TABLE IF NOT EXISTS public.atomic_wrapper_probe(value text);
CREATE OR REPLACE FUNCTION public.atomic_wrapper_value(p_value text)
RETURNS text LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public
BEGIN ATOMIC
 SELECT p_value || '; END; -- literal';
END;
INSERT INTO public.atomic_wrapper_probe VALUES(public.atomic_wrapper_value('probe'));
COMMIT;`;

test('SQL-standard body keeps its END and the actual one/two-run dry-run rolls every effect back', {timeout:60000}, async t => {
  const db=new PGlite();t.after(()=>db.close());
  for(const newline of ['\n','\r\n'])for(const lanChay of [1,2]) {
    const source=SQL_STANDARD.replaceAll('\n',newline),wrapped=buildTransaction(source,{rollback:true,lanChay});
    assert.equal((wrapped.match(/BEGIN ATOMIC/g)??[]).length,lanChay);
    assert.equal((wrapped.match(/^END;\r?$/gm)??[]).length,lanChay);
    assert.doesNotMatch(wrapped,/^COMMIT;\r?$/m);
    await db.exec(wrapped);
    assert.deepEqual((await db.query("SELECT to_regclass('public.atomic_wrapper_probe') AS relation,to_regprocedure('public.atomic_wrapper_value(text)') AS routine")).rows,[{relation:null,routine:null}]);
  }
});

test('SQL-standard recognition never masks outer transaction escapes or unsupported extra body statements', () => {
  for(const changed of [SQL_STANDARD.replace('COMMIT;','COMMIT;\nCOMMIT;'),
    SQL_STANDARD.replace('CREATE TABLE','COMMIT;\nCREATE TABLE'),
    SQL_STANDARD.replace('END;\nINSERT','END;\nROLLBACK;\nINSERT'),
    SQL_STANDARD.replace('END;\nINSERT','END;\nBEGIN;\nINSERT')])assert.throws(()=>buildTransaction(changed,{rollback:true}),/kết thúc transaction|BEGIN/);
  for(const changed of [SQL_STANDARD.replace('END;\nINSERT','SELECT 2;\nEND;\nINSERT'),
    SQL_STANDARD.replace('END;\nINSERT','COMMIT;\nEND;\nINSERT'),
    SQL_STANDARD.replace('END;\nINSERT','INSERT'),SQL_STANDARD.replace('LANGUAGE sql VOLATILE','LANGUAGE sql STABLE')])
    assert.throws(()=>buildTransaction(changed,{rollback:true}),/Unsupported SQL-standard function boundary/);
});

test('reviewed fast-read STABLE bodies retain END without admitting unknown bodies or transaction escapes', () => {
  for (const spec of HERMES_READ_STANDARD_FUNCTIONS) {
    const source = readFileSync(spec.sourcePath, 'utf8');
    for (const newline of ['\n', '\r\n']) for (const lanChay of [1, 2]) {
      const wrapped = buildTransaction(source.replace(/\r\n?/g, '\n').replaceAll('\n', newline), { rollback: true, lanChay });
      assert.equal((wrapped.match(/BEGIN ATOMIC/g) ?? []).length, lanChay);
      assert.doesNotMatch(wrapped, /^COMMIT;\r?$/m);
      assert.match(wrapped, /END;/);
    }
    for (const changed of [source.replace(spec.name, spec.name + '_unreviewed'),
      source.replace('BEGIN ATOMIC', 'BEGIN ATOMIC SELECT 1;'),
      source.replace('BEGIN ATOMIC', 'BEGIN ATOMIC\n -- changed reviewed source')]) {
      assert.throws(() => buildTransaction(changed, { rollback: true }), /Unsupported SQL-standard function boundary/);
    }
    assert.throws(() => buildTransaction(source + '\nSELECT 1; COMMIT;', { rollback: true }), /kết thúc transaction/);
  }
});

test('write-foundation probe wrapper uses the lane write header; an empty path or STABLE header is refused', () => {
  const source = readFileSync('supabase/migrations/20261021133823_hermes_action_foundation_v1.sql', 'utf8');
  const header = 'VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public\nBEGIN ATOMIC';
  assert.equal(source.split(header).length, 2);
  for (const lanChay of [1, 2]) assert.equal(buildTransaction(source, { rollback: true, lanChay }).split(header).length - 1, lanChay);
  for (const changed of [source.replace(header, "VOLATILE SECURITY INVOKER SET search_path=''\nBEGIN ATOMIC"),
    source.replace(header, header.replace('VOLATILE', 'STABLE'))])
    assert.throws(() => buildTransaction(changed, { rollback: true }), /Unsupported SQL-standard function boundary/);
});

test('commented or inline outer COMMIT cannot escape the SQL-standard dry-run', () => {
  for(const close of ['COMMIT; -- outside body', 'COMMIT; /* outside /* nested */ body */',
    '/* leading */ COMMIT /* before semicolon */;', 'COMMIT -- before semicolon\n;', 'END; -- commit synonym', 'ROLLBACK; -- closes wrapper']) {
    for(const original of [SQL_STANDARD,CO_HAM_PLPGSQL]) {
      const source=original.replace('COMMIT;',()=>`${close}\nCREATE TABLE public.after_escape(value text);\nCOMMIT;`);
      for(const newline of ['\n','\r\n'])assert.throws(()=>buildTransaction(source.replaceAll('\n',newline),{rollback:true}),/kết thúc transaction/);
    }
  }
  assert.throws(()=>buildTransaction(SQL_STANDARD.replace('COMMIT;',"COMMIT; INSERT INTO public.atomic_wrapper_probe VALUES('after'); COMMIT;"),{rollback:true}),/kết thúc transaction/);
});

test('lexical transaction boundaries preserve quotes/comments and actual rollback removes all effects',{timeout:60000},async t=>{
  const db=new PGlite();t.after(()=>db.close());
  const dollarBody=SQL_STANDARD.replace(/BEGIN ATOMIC[\s\S]*?\nEND;/,()=>"AS $fn$ SELECT p_value || '; END; -- literal'; $fn$;");
  for(const original of [SQL_STANDARD,dollarBody])for(const newline of ['\n','\r\n'])for(const lanChay of [1,2]) {
    const source=original.replace('BEGIN;', '/* outer /* nested */ header */ BEGIN /* opening */; -- first statement')
      .replace('CREATE TABLE', () => "SELECT 'COMMIT; /* -- $tag$' AS literal; /* COMMIT; */ CREATE TABLE")
      .replace(/COMMIT;$/, "/* closing */ COMMIT -- inline comment before terminator\n; -- trailing comment\nNOTIFY /* nested /* token */ comment */ pgrst, /* payload */ 'reload schema' -- before semicolon\n;");
    const wrapped=buildTransaction(source.replaceAll('\n',newline),{rollback:true,lanChay});
    assert.ok(wrapped.includes("SELECT 'COMMIT; /* -- $tag$' AS literal;"));
    assert.equal((wrapped.match(/NOTIFY \/\* nested/g)??[]).length,lanChay);
    assert.equal((wrapped.match(/BEGIN ATOMIC/g)??[]).length,original===SQL_STANDARD?lanChay:0);
    await db.exec(wrapped);
    assert.deepEqual((await db.query("SELECT to_regclass('public.atomic_wrapper_probe') relation,to_regprocedure('public.atomic_wrapper_value(text)') routine")).rows,[{relation:null,routine:null}]);
  }
});

test('unsupported transaction commands and a lexically hidden final terminator fail closed',()=>{
  for(const command of ['COMMIT WORK','COMMIT AND CHAIN','COMMIT PREPARED \'x\'','END WORK','ABORT','ROLLBACK TO SAVEPOINT x',
    'START TRANSACTION','BEGIN WORK','PREPARE /* nested /* token */ comment */ TRANSACTION \'x\'','SAVEPOINT x','RELEASE SAVEPOINT x']) {
    assert.throws(()=>buildTransaction(`BEGIN; SELECT 1; ${command}; COMMIT;`,{rollback:true}),/Unsupported transaction command/);
  }
  for(const source of ['SELECT 1; COMMIT; SELECT 2;', 'SELECT 1; BEGIN; SELECT 2;',
    "BEGIN; SELECT 1; COMMIT; NOTIFY pgrst,'reload schema'; SELECT 2;",
    "BEGIN; SELECT 1; COMMIT; NOTIFY pgrst,'reload schema'; -- tail\nCREATE TABLE public.escape(id int);",
    "BEGIN; SELECT 1; COMMIT; NOTIFY other_channel,'reload schema';",
    "BEGIN; SELECT 1; COMMIT; NOTIFY pgrst,'reload schema''; COMMIT; --';",
    "BEGIN; SELECT 1; COMMIT; NOTIFY pgrst,'reload schema/*;COMMIT;*/';"])
    assert.throws(()=>buildTransaction(source,{rollback:true}),/đầu\/cuối migration/);
  // No outer ending can be proved if a malformed quote/comment consumes the
  // generated terminator. This specifically exercises the final safety pass.
  for(const source of ["SELECT 'unclosed",'DO $body$ BEGIN NULL;','SELECT 1; /* unclosed']) {
    assert.throws(()=>buildTransaction(source,{rollback:true}),/Transaction dựng ra|Unclosed SQL block comment/);
  }
});

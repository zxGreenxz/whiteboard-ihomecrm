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
import { buildTransaction } from "../apply-reviewed-migration.mjs";

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

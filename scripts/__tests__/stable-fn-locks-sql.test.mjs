// Câu SQL của chốt "hàm STABLE/IMMUTABLE chạm khoá dòng" (scripts/lib/stable-fn-locks-sql.mjs) được
// viết lại 15/11/2026 cho nhanh: tách lời gọi của mỗi hàm một lần rồi nối bằng phép bằng, thay cho
// regex động chạy trên từng cặp (dòng closure × hàm). Viết lại một BỘ KIỂM thì luật không được xê
// dịch chi tiết nào, nên file này chạy CẢ câu trước 15/11 (đối chứng, chép nguyên văn bên dưới) lẫn
// câu đang dùng trên cùng một bộ hàm giả trong PGlite rồi so:
//   · tập closure từng dòng (oid, schema, tên, depth, via);
//   · danh sách vi phạm cuối (fn_name, volatility, lock_from).
// Kèm một bảng kỳ vọng tuyệt đối để "hai câu cùng rỗng" không thành xanh, và một bảng đột biến để
// biết bộ hàm giả còn cắn: sửa sai câu mới theo từng cách thì phép so phải đỏ — trừ hai cách được
// chứng minh là không đổi kết quả (ghi lý do tại chỗ).
//
// Đổi LUẬT có chủ ý (thêm schema, thêm kiểu khoá, đổi số tầng…) thì sửa cả câu đối chứng theo đúng
// thay đổi đó: thứ file này ghim là CÁCH DÒ LỜI GỌI, không phải nội dung luật ở một thời điểm.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { CTE_STABLE_FN_LOCKS, SQL_STABLE_FN_LOCKS } from '../lib/stable-fn-locks-sql.mjs';

// ── ĐỐI CHỨNG: câu của gate TRƯỚC 15/11/2026 ────────────────────────────────────────────────────
// Nguyên văn scripts/check-stable-fn-locks.mjs ở commit 87bf496a6 (chỉ bỏ chú thích SQL và dấu `;`
// cuối). KHÔNG dùng ở đâu ngoài file này; đừng "dọn" nó cho giống câu mới.
const CTE_TRUOC_15_11 = `
  WITH RECURSIVE fns AS (
    SELECT p.oid, n.nspname AS ns, p.proname AS nm, p.provolatile AS vol,
           regexp_replace(
             regexp_replace(pg_get_functiondef(p.oid), '/\\*.*?\\*/', ' ', 'gs'),
             '--[^' || chr(10) || ']*', ' ', 'g') AS def,
           p.proacl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prokind IN ('f','p') AND n.nspname IN ('public', 'app_private', 'api')
  ),
  seed AS (
    SELECT oid, nm, 0 AS depth, nm AS via FROM fns
    WHERE def ~* '\\mfor\\s+(share|update|no key update|key share)\\M'
       OR def ~* '\\mlock\\s+(table\\s+)?[a-z_.]'
  ),
  closure AS (
    SELECT oid, nm, depth, via FROM seed
    UNION
    SELECT f.oid, f.nm, c.depth + 1, c.via
    FROM fns f JOIN closure c
      ON c.depth < 4 AND f.oid <> c.oid AND f.def ~ ('\\m' || c.nm || '\\s*\\(')
  )`;
const SQL_TRUOC_15_11 = `${CTE_TRUOC_15_11}
  SELECT DISTINCT ON (f.nm)
         f.nm AS fn_name,
         CASE f.vol WHEN 's' THEN 'STABLE' ELSE 'IMMUTABLE' END AS volatility,
         c.via AS lock_from
  FROM closure c JOIN fns f ON f.oid = c.oid
  WHERE f.ns IN ('public', 'api') AND f.vol <> 'v'
  ORDER BY f.nm, c.depth`;

const DOC_CLOSURE = `
  SELECT c.oid::int AS oid, f.ns::text AS ns, c.nm::text AS nm, c.depth, c.via::text AS via
  FROM closure c JOIN fns f ON f.oid = c.oid`;

// ── BỘ HÀM GIẢ ──────────────────────────────────────────────────────────────────────────────────
// Không hàm nào được GỌI: chốt chỉ đọc văn bản định nghĩa (pg_get_functiondef), nên thân hàm chỉ
// cần đúng cú pháp plpgsql. [tên đủ schema, volatility, thân].
const KHOA = 'PERFORM 1 FROM public.t WHERE id = 1';
const HAM = [
  // Năm kiểu khoá ở hàm gốc (VOLATILE — bản thân chúng hợp lệ), mỗi kiểu một hàm đọc gọi tới.
  ['public.khoa_update', 'VOLATILE', `${KHOA} FOR UPDATE;`],
  ['public.khoa_share', 'VOLATILE', `${KHOA} FOR SHARE;`],
  ['public.khoa_nku', 'VOLATILE', `${KHOA} FOR NO KEY UPDATE;`],
  ['public.khoa_ks', 'VOLATILE', `${KHOA} FOR KEY SHARE;`],
  ['public.khoa_bang', 'VOLATILE', 'LOCK TABLE public.t IN SHARE MODE;'],
  ['public.doc_update', 'STABLE', 'PERFORM khoa_update();'],
  // Khoảng trắng trước dấu "(" và tiền tố schema — riêng hoặc cả hai, kể cả xuống dòng.
  ['public.doc_share', 'STABLE', 'PERFORM khoa_share   ();'],
  ['public.doc_nku', 'STABLE', 'PERFORM public.khoa_nku();'],
  ['public.doc_ks', 'STABLE', 'PERFORM public.khoa_ks ();'],
  ['public.doc_bang', 'STABLE', 'PERFORM khoa_bang\n\t  ();'],

  // Chuỗi gọi: tầng 1–4 bị bắt, tầng 5 thì không.
  ['public.tang0', 'VOLATILE', `${KHOA} FOR UPDATE;`],
  ['public.tang1', 'STABLE', 'PERFORM tang0();'],
  ['public.tang2', 'STABLE', 'PERFORM tang1();'],
  ['public.tang3', 'STABLE', 'PERFORM tang2();'],
  ['public.tang4', 'STABLE', 'PERFORM tang3();'],
  ['public.tang5', 'STABLE', 'PERFORM tang4();'],

  // Tên là tiền tố/hậu tố của tên khác không được khớp nhầm.
  ['public.foo', 'VOLATILE', `${KHOA} FOR UPDATE;`],
  ['public.foo_bar', 'STABLE', 'NULL;'],
  ['public.x_foo', 'STABLE', 'NULL;'],
  ['public.doc_foo_gia', 'STABLE', 'PERFORM foo_bar(); PERFORM x_foo(); PERFORM public.x_foo (); PERFORM foofoo();'],
  ['public.doc_foo', 'STABLE', 'PERFORM foo();'],

  // Chữ khoá dòng và lời gọi CHỈ nằm trong chú thích thì không tính.
  ['public.chi_chu_thich', 'STABLE', `-- SELECT 1 FROM public.t FOR UPDATE; LOCK TABLE public.t;
    /* PERFORM foo();
       SELECT 1 FROM public.t FOR SHARE; */
    PERFORM 1; -- foo()
  `],

  // Tự gọi chính mình, và hai hàm gọi vòng nhau.
  ['public.tu_goi', 'STABLE', 'PERFORM tu_goi();'],
  ['public.tu_goi_khoa', 'STABLE', `${KHOA} FOR UPDATE; PERFORM tu_goi_khoa();`],
  ['public.vong_a', 'STABLE', 'PERFORM vong_b();'],
  ['public.vong_b', 'STABLE', 'PERFORM vong_a(); PERFORM foo();'],

  // Hai hàm trùng tên khác schema: chốt dò theo TÊN nên bản public (vô can) vẫn bị chấm — luật cũ.
  ['app_private.trung_ten', 'VOLATILE', `${KHOA} FOR UPDATE;`],
  ['public.trung_ten', 'STABLE', 'NULL;'],
  ['public.doc_trung_ten', 'STABLE', 'PERFORM app_private.trung_ten();'],

  // Volatility × schema: chỉ STABLE/IMMUTABLE ở public/api bị báo; app_private và VOLATILE vẫn
  // nằm trong closure để dò tiếp qua chúng.
  ['public.ghi_goi_khoa', 'VOLATILE', 'PERFORM foo();'],
  ['public.bat_bien_goi_khoa', 'IMMUTABLE', 'PERFORM foo();'],
  ['api.doc_api', 'STABLE', 'PERFORM public.foo();'],
  ['app_private.doc_rieng', 'STABLE', 'PERFORM public.foo();'],
  ['public.doc_qua_rieng', 'STABLE', 'PERFORM app_private.doc_rieng();'],
  ['public.doc_qua_ghi', 'STABLE', 'PERFORM ghi_goi_khoa();'],
  ['public.doc_khoa_truc_tiep', 'STABLE', `${KHOA} FOR SHARE;`],
  ['api.khoa_api', 'IMMUTABLE', 'LOCK TABLE public.t IN SHARE MODE;'],
  // Schema ngoài phạm vi (không phải public/app_private/api): không là gốc, không bị báo.
  ['ngoai.khoa_ngoai', 'VOLATILE', `${KHOA} FOR UPDATE;`],
  ['ngoai.doc_ngoai', 'STABLE', `${KHOA} FOR UPDATE;`],
  ['public.doc_goi_ngoai', 'STABLE', 'PERFORM ngoai.khoa_ngoai();'],
  ['public.doc_goi_thu_tuc', 'STABLE', 'CALL thu_tuc_khoa();'],

  // Chốt đọc VĂN BẢN: lời gọi trong chuỗi động vẫn khớp; viết HOA hoặc trong nháy kép thì không
  // (điểm mù có sẵn của luật cũ — ở đây chỉ ghim rằng câu mới không đổi nó).
  ['public.doc_dong', 'STABLE', `EXECUTE 'SELECT foo( 1 )';`],
  ['public.doc_hoa', 'STABLE', 'PERFORM FOO();'],
  ['public.doc_nhay', 'STABLE', 'PERFORM "foo"();'],

  // Collation: regex cũ chạy theo "C" (ghép từ cột kiểu name), nên chữ có dấu đứng liền trước tên
  // hàm KHÔNG nhập vào tên. Tách lời gọi theo collation mặc định sẽ ra "ềfoo" và bỏ sót.
  ['public.doc_dau', 'STABLE', `PERFORM 1 WHERE 'ềfoo(1)' <> '';`],

  // Tên hàm có ký tự ngoài [A-Za-z0-9_]: regex cũ coi chúng là cú pháp regex.
  //   chữ có dấu → khớp nguyên văn;  "." → khớp MỌI ký tự (ở đây khớp nhầm khoa_cham);
  //   "$" → cuối chuỗi, không bao giờ khớp (điểm mù có sẵn).
  ['public.khoá_dòng', 'VOLATILE', `${KHOA} FOR UPDATE;`],
  ['public.doc_ten_co_dau', 'STABLE', 'PERFORM khoá_dòng();'],
  ['public."khoa.cham"', 'VOLATILE', `${KHOA} FOR UPDATE;`],
  ['public.doc_nham_cham', 'STABLE', 'PERFORM khoa_cham();'],
  ['public.khoa$do', 'VOLATILE', `${KHOA} FOR UPDATE;`],
  ['public.doc_do', 'STABLE', 'PERFORM khoa$do();'],
];

// Kỳ vọng tuyệt đối của danh sách vi phạm: [fn_name, volatility, lock_from], xếp theo fn_name.
const VI_PHAM_KY_VONG = [
  ['bat_bien_goi_khoa', 'IMMUTABLE', 'foo'],
  ['doc_api', 'STABLE', 'foo'],
  ['doc_bang', 'STABLE', 'khoa_bang'],
  ['doc_dau', 'STABLE', 'foo'],
  ['doc_dong', 'STABLE', 'foo'],
  ['doc_foo', 'STABLE', 'foo'],
  ['doc_goi_thu_tuc', 'STABLE', 'thu_tuc_khoa'],
  ['doc_khoa_truc_tiep', 'STABLE', 'doc_khoa_truc_tiep'],
  ['doc_ks', 'STABLE', 'khoa_ks'],
  ['doc_nham_cham', 'STABLE', 'khoa.cham'],
  ['doc_nku', 'STABLE', 'khoa_nku'],
  ['doc_qua_ghi', 'STABLE', 'foo'],
  ['doc_qua_rieng', 'STABLE', 'foo'],
  ['doc_share', 'STABLE', 'khoa_share'],
  ['doc_ten_co_dau', 'STABLE', 'khoá_dòng'],
  ['doc_trung_ten', 'STABLE', 'trung_ten'],
  ['doc_update', 'STABLE', 'khoa_update'],
  ['khoa_api', 'IMMUTABLE', 'khoa_api'],
  ['tang1', 'STABLE', 'tang0'],
  ['tang2', 'STABLE', 'tang0'],
  ['tang3', 'STABLE', 'tang0'],
  ['tang4', 'STABLE', 'tang0'],
  ['trung_ten', 'STABLE', 'trung_ten'],
  ['tu_goi_khoa', 'STABLE', 'tu_goi_khoa'],
  ['vong_a', 'STABLE', 'foo'],
  ['vong_b', 'STABLE', 'foo'],
];

const theoThuTu = (rows) => rows.map((r) => JSON.stringify(r)).sort();

let db;
const docClosure = async (cte) => theoThuTu((await db.query(`${cte} ${DOC_CLOSURE}`)).rows);
const docViPham = async (sql) => (await db.query(sql)).rows.map((r) => [r.fn_name, r.volatility, r.lock_from]);

let closureCu; let closureMoi; let viPhamCu; let viPhamMoi;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA app_private; CREATE SCHEMA api; CREATE SCHEMA ngoai;
    CREATE TABLE public.t(id int PRIMARY KEY);
    CREATE PROCEDURE public.thu_tuc_khoa() LANGUAGE plpgsql AS $fn$ BEGIN ${KHOA} FOR UPDATE; END $fn$;
    -- Hàm gộp: pg_get_functiondef ném lỗi nếu bị gọi trên nó, nên bộ lọc prokind phải chạy trước.
    CREATE AGGREGATE public.tong_gia(int) (SFUNC = int4pl, STYPE = int);
    ${HAM.map(([ten, vol, than]) => `CREATE FUNCTION ${ten}() RETURNS void LANGUAGE plpgsql ${vol} AS $fn$ BEGIN ${than} END $fn$;`).join('\n')}
  `);
  closureCu = await docClosure(CTE_TRUOC_15_11);
  closureMoi = await docClosure(CTE_STABLE_FN_LOCKS);
  viPhamCu = await docViPham(SQL_TRUOC_15_11);
  viPhamMoi = await docViPham(SQL_STABLE_FN_LOCKS);
}, 60_000);
afterAll(async () => { await db?.close(); });

describe('câu mới cho đúng kết quả của câu trước 15/11/2026', () => {
  test('bộ hàm giả đủ lớn và môi trường đủ phân biệt — không so hai tập rỗng', async () => {
    const dem = (await db.query(`${CTE_STABLE_FN_LOCKS}
      SELECT (SELECT count(*)::int FROM fns) AS fns, (SELECT count(*)::int FROM seed) AS seed,
             (SELECT count(*)::int FROM calls) AS calls`)).rows[0];
    // 51 hàm + 1 thủ tục thuộc ba schema trong phạm vi (ngoai.* và hàm gộp không tính).
    expect(dem.fns).toBe(HAM.filter(([ten]) => !ten.startsWith('ngoai.')).length + 1);
    // 5 kiểu khoá + tang0, foo, tu_goi_khoa, app_private.trung_ten, doc_khoa_truc_tiep, khoa_api,
    // thu_tuc_khoa, khoá_dòng, "khoa.cham", khoa$do.
    expect(dem.seed).toBe(15);
    expect(dem.calls).toBeGreaterThan(dem.fns);
    expect(closureCu.length).toBeGreaterThan(40);
    // Ca collation chỉ có nghĩa khi collation mặc định coi chữ có dấu là ký tự từ (PGlite: C.UTF-8,
    // production: en_US.UTF-8). Nếu môi trường test đổi sang "C" thì ca đó hết cắn — phải biết.
    const { rows } = await db.query(`SELECT 'ề' ~ '\\w' AS mac_dinh, 'ề' COLLATE "C" ~ '\\w' AS c`);
    expect(rows[0]).toEqual({ mac_dinh: true, c: false });
  });

  test('tập closure trùng từng dòng (oid, schema, tên, depth, via)', () => {
    expect(closureMoi).toEqual(closureCu);
  });

  test('danh sách vi phạm trùng nhau và trùng bảng kỳ vọng', () => {
    expect(viPhamMoi).toEqual(viPhamCu);
    expect(viPhamMoi).toEqual(VI_PHAM_KY_VONG);
  });
});

describe('từng luật, đọc trên kết quả của câu mới', () => {
  const baoCao = (ten) => viPhamMoi.find(([fn]) => fn === ten);
  const trongClosure = (ns, nm) => closureMoi.map((r) => JSON.parse(r)).filter((r) => r.ns === ns && r.nm === nm);

  test('FOR UPDATE / FOR SHARE / FOR NO KEY UPDATE / FOR KEY SHARE / LOCK TABLE đều là gốc', () => {
    for (const goc of ['khoa_update', 'khoa_share', 'khoa_nku', 'khoa_ks', 'khoa_bang']) {
      expect(trongClosure('public', goc), goc).toEqual([expect.objectContaining({ depth: 0, via: goc })]);
    }
    expect(baoCao('doc_khoa_truc_tiep')).toEqual(['doc_khoa_truc_tiep', 'STABLE', 'doc_khoa_truc_tiep']);
  });

  test('chuỗi gọi 1–4 tầng bị bắt, tầng 5 thì không', () => {
    for (const [ten, tang] of [['tang1', 1], ['tang2', 2], ['tang3', 3], ['tang4', 4]]) {
      expect(trongClosure('public', ten), ten).toEqual([expect.objectContaining({ depth: tang, via: 'tang0' })]);
      expect(baoCao(ten), ten).toEqual([ten, 'STABLE', 'tang0']);
    }
    expect(trongClosure('public', 'tang5')).toEqual([]);
    expect(baoCao('tang5')).toBeUndefined();
  });

  test('tên là tiền tố/hậu tố của tên khác không khớp nhầm', () => {
    for (const ten of ['foo_bar', 'x_foo', 'doc_foo_gia']) expect(trongClosure('public', ten), ten).toEqual([]);
    expect(baoCao('doc_foo')).toEqual(['doc_foo', 'STABLE', 'foo']);
  });

  test('gọi có khoảng trắng trước "(" và có tiền tố schema vẫn bị bắt', () => {
    expect(baoCao('doc_share')).toEqual(['doc_share', 'STABLE', 'khoa_share']);
    expect(baoCao('doc_nku')).toEqual(['doc_nku', 'STABLE', 'khoa_nku']);
    expect(baoCao('doc_ks')).toEqual(['doc_ks', 'STABLE', 'khoa_ks']);
    expect(baoCao('doc_bang')).toEqual(['doc_bang', 'STABLE', 'khoa_bang']);
  });

  test('chữ khoá dòng và lời gọi chỉ nằm trong chú thích -- và /* */ thì không tính', () => {
    expect(trongClosure('public', 'chi_chu_thich')).toEqual([]);
  });

  test('hàm tự gọi chính nó không tự nhân dòng; gọi vòng dừng ở tầng 4', () => {
    expect(trongClosure('public', 'tu_goi')).toEqual([]);
    expect(trongClosure('public', 'tu_goi_khoa')).toEqual([expect.objectContaining({ depth: 0, via: 'tu_goi_khoa' })]);
    expect(trongClosure('public', 'vong_b').map((r) => r.depth)).toEqual([1, 3]);
    expect(trongClosure('public', 'vong_a').map((r) => r.depth)).toEqual([2, 4]);
  });

  test('hai hàm trùng tên khác schema: dò theo tên, bản public bị chấm theo bản app_private', () => {
    expect(trongClosure('app_private', 'trung_ten')[0]).toEqual(expect.objectContaining({ depth: 0 }));
    expect(trongClosure('public', 'trung_ten')[0]).toEqual(expect.objectContaining({ depth: 1, via: 'trung_ten' }));
    expect(baoCao('trung_ten')).toEqual(['trung_ten', 'STABLE', 'trung_ten']);
  });

  test('VOLATILE không bị báo; STABLE/IMMUTABLE ở public/api bị báo; app_private thì không', () => {
    expect(trongClosure('public', 'ghi_goi_khoa')).toHaveLength(1);
    expect(baoCao('ghi_goi_khoa')).toBeUndefined();
    expect(baoCao('bat_bien_goi_khoa')).toEqual(['bat_bien_goi_khoa', 'IMMUTABLE', 'foo']);
    expect(baoCao('doc_api')).toEqual(['doc_api', 'STABLE', 'foo']);
    expect(trongClosure('app_private', 'doc_rieng')).toHaveLength(1);
    expect(baoCao('doc_rieng')).toBeUndefined();
    // …nhưng vẫn dò XUYÊN QUA hàm app_private và hàm VOLATILE.
    expect(baoCao('doc_qua_rieng')).toEqual(['doc_qua_rieng', 'STABLE', 'foo']);
    expect(baoCao('doc_qua_ghi')).toEqual(['doc_qua_ghi', 'STABLE', 'foo']);
    for (const ten of ['doc_ngoai', 'doc_goi_ngoai', 'khoa_ngoai']) expect(baoCao(ten), ten).toBeUndefined();
  });
});

// Mỗi đột biến sửa MỘT chỗ của câu mới. `doi: true` = tập closure phải lệch câu trước 15/11.
// `doi: false` = đã chứng minh không đổi kết quả với mọi đầu vào; ghim để ai đọc bảng này không
// tưởng bộ hàm giả thiếu ca.
const DOT_BIEN = [
  { ten: 'trần 4 tầng thành 3', tim: 'c.depth < 4', thay: 'c.depth < 3', doi: true },
  { ten: 'bỏ điều kiện f.oid <> c.oid', tim: ' AND f.oid <> c.oid', thay: '', doi: true },
  { ten: 'regex tách không cho khoảng trắng trước "("', tim: `'\\m(\\w+)\\s*\\('`, thay: `'\\m(\\w+)\\('`, doi: true },
  { ten: 'regex tách bỏ cả \\m lẫn khoảng trắng', tim: `'\\m(\\w+)\\s*\\('`, thay: `'(\\w+)\\('`, doi: true },
  { ten: 'tách lời gọi theo collation mặc định', tim: 'f.def COLLATE "C"', thay: 'f.def', doi: true },
  { ten: 'bỏ nhánh tên hàm ngoài [A-Za-z0-9_]', tim: /\n\s*UNION ALL[\s\S]*?(?=\n\s*\),\n\s*seed AS)/, thay: '', doi: true },
  {
    ten: 'bỏ DISTINCT khi tách lời gọi', tim: 'SELECT DISTINCT f.oid, m[1]', thay: 'SELECT f.oid, m[1]', doi: false,
    // closure nối bằng UNION nên dòng lặp tự gộp; DISTINCT chỉ giữ cho bảng nối nhỏ.
  },
  {
    ten: 'regex tách bỏ \\m (vẫn cho khoảng trắng)', tim: `'\\m(\\w+)\\s*\\('`, thay: `'(\\w+)\\s*\\('`, doi: false,
    // Quét 'g' luôn dừng sau dấu "(", nên lần khớp trái nhất kế tiếp bao giờ cũng mở đầu ở đầu
    // một từ và \w+ ăn trọn từ đó — có hay không có \m đều ra cùng tên. \m giữ lại cho giống regex cũ.
  },
];

describe('đột biến: sửa sai câu mới thì phép so closure phải đỏ', () => {
  test.each(DOT_BIEN)('$ten', async ({ tim, thay, doi }) => {
    const dotBien = CTE_STABLE_FN_LOCKS.replace(tim, thay);
    expect(dotBien, 'đột biến không áp được — câu SQL đã đổi chữ, sửa lại `tim`').not.toBe(CTE_STABLE_FN_LOCKS);
    const closure = await docClosure(dotBien);
    if (doi) expect(closure).not.toEqual(closureCu);
    else expect(closure).toEqual(closureCu);
  });
});

test('khác biệt DUY NHẤT đã biết: tên hàm làm regex sai cú pháp thì câu mới báo lỗi sớm', async () => {
  // Câu cũ chỉ ghép regex từ tên hàm ĐÃ VÀO closure; câu mới ghép cho mọi tên có ký tự ngoài
  // [A-Za-z0-9_] trong ba schema. Hàm "a(b" vô can nên câu cũ không đụng tới nó, còn câu mới ném
  // lỗi — chốt ĐỎ (không phải xanh nhầm). Ghim để khác biệt này không bị quên.
  await db.exec('BEGIN');
  try {
    await db.exec(`CREATE FUNCTION public."a(b"() RETURNS void LANGUAGE plpgsql STABLE AS $fn$ BEGIN NULL; END $fn$;`);
    await db.exec('SAVEPOINT truoc');
    expect(await docViPham(SQL_TRUOC_15_11)).toEqual(VI_PHAM_KY_VONG);
    await expect(db.query(SQL_STABLE_FN_LOCKS)).rejects.toThrow(/regular expression/i);
    await db.exec('ROLLBACK TO SAVEPOINT truoc');
  } finally {
    await db.exec('ROLLBACK');
  }
});

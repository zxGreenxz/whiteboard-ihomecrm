import { describe, expect, it } from "vitest";

import {
  kiemChotChongAoGiac,
  phanLoaiBangKhongCotOrg,
  phanLoaiDongNull,
  kiemDoOwnerPersonal,
  sqlDoOwnerPersonal,
  xepNhomTheoSoDo,
  MA_THOAT_CHOT_HONG,
  nhanVaiTrenLog,
} from "../measure-org-leak.mjs";

// Repo public: log CI ai cũng đọc, nên email/tên đăng nhập tài khoản thật không
// được in ở đó; local vẫn in để người chạy biết đang đo vai nào.
describe("nhanVaiTrenLog — không lộ tài khoản thật trên log CI", () => {
  const that = { uid: "u1", org: "aaaa-bbbb", email: "fixture-user@example.invalid" };
  const tongHop = { uid: "u0", org: "zzzz", email: "(tổ chức tổng hợp)", tongHop: true };

  it("CI ẩn email tài khoản thật nhưng vẫn có nhãn", () => {
    const nhan = nhanVaiTrenLog(that, { CI: "true" });
    expect(nhan).not.toContain("fixture-user");
    expect(nhan.length).toBeGreaterThan(0);
  });

  it("local in email để người chạy đối chiếu", () => {
    expect(nhanVaiTrenLog(that, {})).toBe("fixture-user@example.invalid");
  });

  it("nhân vật tổng hợp giữ nhãn mô tả ở mọi nơi", () => {
    expect(nhanVaiTrenLog(tongHop, { CI: "true" })).toBe("(tổ chức tổng hợp)");
  });
});

// Bộ đo này chỉ có giá trị nếu nó KHÔNG BAO GIỜ nói dối theo hướng an toàn.
//
// Án lệ trong chính phiên rà soát 07/08/2026: một phép đo cho ra "0 dòng rò" và
// suýt được ghi vào kết luận, hoá ra hàm ghi log của bài đo bị đặt SECURITY
// DEFINER nên mọi truy vấn chạy bằng quyền postgres chứ không phải vai đang giả
// lập. Một bộ đo hỏng theo hướng "mọi thứ đều ổn" còn nguy hiểm hơn không đo,
// vì nó tạo ra bằng chứng giả để người ta dựa vào.
//
// Vì vậy: thiếu bất kỳ chốt nào → THOÁT MÃ 3, tuyệt đối không bao giờ thoát 0.
describe("kiemChotChongAoGiac — bốn chốt bắt buộc", () => {
  const dat = {
    current_user: "authenticated",
    rolbypassrls: false,
    auth_uid: "df8d1df5-1c24-4723-9733-4640c43c382b",
    uid_mong_doi: "df8d1df5-1c24-4723-9733-4640c43c382b",
    doi_chung_duong_tong: 90,
    doi_chung_duong_ngoai: 0,
    doi_chung_am: 0,
  };

  it("qua khi cả bốn chốt đều đạt", () => {
    expect(kiemChotChongAoGiac(dat).dat).toBe(true);
  });

  it("đỏ khi phiên KHÔNG chạy bằng vai authenticated", () => {
    const r = kiemChotChongAoGiac({ ...dat, current_user: "postgres" });
    expect(r.dat).toBe(false);
    expect(r.loi.join(" ")).toMatch(/authenticated/);
  });

  it("đỏ khi vai đang được bỏ qua RLS — đo lúc đó là đo hư không", () => {
    const r = kiemChotChongAoGiac({ ...dat, rolbypassrls: true });
    expect(r.dat).toBe(false);
    expect(r.loi.join(" ")).toMatch(/bypass/i);
  });

  it("đỏ khi auth.uid() không khớp người mình định giả lập", () => {
    const r = kiemChotChongAoGiac({ ...dat, auth_uid: "khac-hoan-toan" });
    expect(r.dat).toBe(false);
    expect(r.loi.join(" ")).toMatch(/auth\.uid/);
  });

  it("đỏ khi đối chứng DƯƠNG không thấy gì — nghĩa là phép đo mù, không phải sạch", () => {
    // income_expense_types đã có biên giới: người này PHẢI thấy vài chục dòng của
    // chính mình và 0 dòng ngoài. Thấy 0/0 nghĩa là bài đo không đọc được gì cả.
    const r = kiemChotChongAoGiac({ ...dat, doi_chung_duong_tong: 0 });
    expect(r.dat).toBe(false);
    expect(r.loi.join(" ")).toMatch(/đối chứng dương/i);
  });

  it("đỏ khi đối chứng dương lại thấy dòng ngoài — bảng mốc phải sạch", () => {
    const r = kiemChotChongAoGiac({ ...dat, doi_chung_duong_ngoai: 5 });
    expect(r.dat).toBe(false);
  });

  it("đỏ khi người mồ côi vẫn thấy dữ liệu — RLS không có hiệu lực", () => {
    const r = kiemChotChongAoGiac({ ...dat, doi_chung_am: 12 });
    expect(r.dat).toBe(false);
    expect(r.loi.join(" ")).toMatch(/mồ côi|đối chứng âm/i);
  });

  it("mã thoát khi chốt hỏng là 3, không phải 1 — phân biệt với 'đo xong, có rò'", () => {
    expect(MA_THOAT_CHOT_HONG).toBe(3);
  });
});

describe("xepNhomTheoSoDo — gán giai đoạn từ số đo, không từ phỏng đoán", () => {
  const nen = { table_name: "x", visible_foreign: 0, ground_truth_total: 0, authenticated_can_select: true };

  it("có dòng của tổ chức khác → GĐ4, vá cẩn thận vì đang có người nhìn nhầm", () => {
    const r = xepNhomTheoSoDo({ ...nen, visible_foreign: 33, ground_truth_total: 63 });
    expect(r.group).toBe("LIVE_LEAK");
    expect(r.assigned_phase).toBe("GĐ4");
  });

  it("bảng rỗng → GĐ3, vá không thể gây hồi quy vì không có gì để mất", () => {
    const r = xepNhomTheoSoDo({ ...nen, ground_truth_total: 0 });
    expect(r.group).toBe("A_RONG");
    expect(r.assigned_phase).toBe("GĐ3");
  });

  it("authenticated không đọc được → GĐ3, RLS đã chặn từ tầng quyền", () => {
    const r = xepNhomTheoSoDo({ ...nen, authenticated_can_select: false, ground_truth_total: 500 });
    expect(r.group).toBe("B_KHONG_CAP_QUYEN");
    expect(r.assigned_phase).toBe("GĐ3");
  });

  it("có dữ liệu, đọc được, nhưng KHÔNG rò → GĐ3", () => {
    // Đã được rào bằng đường khác (theo toà, theo người). Gắn thêm biên giới tổ
    // chức là siết chồng, không lấy mất của ai thứ gì.
    const r = xepNhomTheoSoDo({ ...nen, ground_truth_total: 124, visible_foreign: 0 });
    expect(r.group).toBe("C_DA_KIN");
    expect(r.assigned_phase).toBe("GĐ3");
  });

  it("rò THẮNG mọi nhóm khác — kể cả khi bảng nhỏ", () => {
    const r = xepNhomTheoSoDo({ ...nen, ground_truth_total: 2, visible_foreign: 1 });
    expect(r.assigned_phase).toBe("GĐ4");
  });

  it("chưa đo được thì nói chưa đo, KHÔNG mặc định là an toàn", () => {
    const r = xepNhomTheoSoDo({ ...nen, visible_foreign: null, ground_truth_total: null });
    expect(r.group).toBe("CHUA_DO");
    expect(r.assigned_phase).toBe(null);
  });
});

// ─── Nhân vật TỔNG HỢP ──────────────────────────────────────────────────────
//
// Bộ đo từng đòi HAI tổ chức có người dùng thật, và hai tổ chức đó là Test/Demo
// — dữ liệu rác nằm trong production. Xoá chúng (20260808080000) là bộ đo chết
// ngay với "Cần ít nhất 2 tổ chức". Nó fail-closed đúng, nhưng một gate an ninh
// CHẶN mà đứng được nhờ rác trong prod thì đó là khuyết tật thiết kế.
//
// Nay bộ đo tự dựng tổ chức thứ hai trong chính BEGIN…ROLLBACK của nó. Với nhân
// vật đó, luật đối chứng dương phải LẬT: thấy 0 dòng là ĐÚNG, không phải mù.
// Nhưng lật xong thì mất chốt chống-mù, nên phải có chốt thay thế —
// my_org_ids() phải trả đúng tổ chức vừa dựng.
describe("kiemChotChongAoGiac — nhân vật tổng hợp (tổ chức vừa sinh ra)", () => {
  const ORG_TONG_HOP = "99990000-0000-4000-8000-000000000099";
  const dat = {
    tongHop: true,
    my_orgs: ORG_TONG_HOP,
    current_user: "authenticated",
    rolbypassrls: false,
    auth_uid: "99999999-0000-4000-8000-000000000099",
    uid_mong_doi: "99999999-0000-4000-8000-000000000099",
    doi_chung_duong_tong: 0,
    doi_chung_duong_ngoai: 0,
    doi_chung_am: 0,
  };

  it("qua khi tổ chức vừa sinh ra thấy đúng 0 dòng", () => {
    expect(kiemChotChongAoGiac(dat).dat).toBe(true);
  });

  it("KHÔNG áp luật 'đối chứng dương phải > 0' cho nhân vật tổng hợp", () => {
    // Đây là hồi quy của chính khuyết tật vừa sửa: luật cũ đọc 0 dòng thành
    // 'bài đo đang MÙ' và sẽ giết nhân vật tổng hợp ngay từ lô đầu.
    const r = kiemChotChongAoGiac(dat);
    expect(r.loi.join(" ")).not.toMatch(/MÙ/);
  });

  it("đỏ khi my_org_ids() không trả về tổ chức vừa dựng — số 0 lúc đó là số 0 của sự mù", () => {
    const r = kiemChotChongAoGiac({ ...dat, my_orgs: "" });
    expect(r.dat).toBe(false);
    expect(r.loi.join(" ")).toMatch(/bối cảnh không thành hình/);
  });

  it("đỏ khi tổ chức vừa sinh ra đã thấy dòng ở bảng mốc", () => {
    const r = kiemChotChongAoGiac({ ...dat, doi_chung_duong_tong: 3 });
    expect(r.dat).toBe(false);
    expect(r.loi.join(" ")).toMatch(/VỪA SINH RA đã thấy 3 dòng/);
  });

  it("vẫn giữ nguyên ba chốt kia cho nhân vật tổng hợp", () => {
    expect(kiemChotChongAoGiac({ ...dat, current_user: "postgres" }).dat).toBe(false);
    expect(kiemChotChongAoGiac({ ...dat, rolbypassrls: true }).dat).toBe(false);
    expect(kiemChotChongAoGiac({ ...dat, auth_uid: "khac" }).dat).toBe(false);
    expect(kiemChotChongAoGiac({ ...dat, doi_chung_am: 5 }).dat).toBe(false);
  });

  it("nhân vật THẬT vẫn phải thấy dòng của mình — hai vế không được rút xuống một", () => {
    const that = { ...dat, tongHop: false, my_orgs: "aaaa", doi_chung_duong_tong: 0 };
    const r = kiemChotChongAoGiac(that);
    expect(r.dat).toBe(false);
    expect(r.loi.join(" ")).toMatch(/MÙ/);
  });
});

// ─── Điểm mù: 12 bảng KHÔNG có cột organization_id ──────────────────────────
//
// Bộ đo dò bảng THEO cột organization_id, nên 12 bảng không có cột đó chưa từng
// được quét lần nào. Gate inventory xếp chúng vào NO_ORG_COLUMN và coi là "có
// chỗ đứng" — đúng về sổ sách, nhưng "có chỗ đứng" không phải "đã đo".
//
// Với bảng không có cột org thì không có gì để lọc. Phép thử sạch hơn nhiều, và
// chỉ nhân vật TỔNG HỢP làm được: một tổ chức vừa sinh ra không sở hữu dòng nào,
// nên mọi dòng nó đọc được ở đây đều là của người khác. Ngưỡng đúng là 0.
describe("phanLoaiBangKhongCotOrg — ba lối rẽ, chỉ hai lối là ổn", () => {
  it("không cấp quyền đọc là an toàn NHẤT, không phải lỗi đo", () => {
    const r = phanLoaiBangKhongCotOrg([{ bang: "push_send_log", tong: 0, tu_choi: true }]);
    expect(r.tuChoi).toBe(1);
    expect(r.ro).toHaveLength(0);
    expect(r.chuaDo).toHaveLength(0);
  });

  it("có quyền đọc nhưng RLS chặn sạch là an toàn", () => {
    const r = phanLoaiBangKhongCotOrg([{ bang: "permission_definitions", tong: 0, tu_choi: false }]);
    expect(r.ro).toHaveLength(0);
    expect(r.chuaDo).toHaveLength(0);
  });

  it("tổ chức vừa sinh ra đọc được dòng nào cũng là RÒ", () => {
    const r = phanLoaiBangKhongCotOrg([{ bang: "zz_thu", tong: 2, tu_choi: false }]);
    expect(r.ro.map((b) => b.bang)).toEqual(["zz_thu"]);
  });

  it("CHƯA ĐO ĐƯỢC không được đọc thành SẠCH", () => {
    // Hồi quy của chính lỗi trong bản đầu đoạn mã này: nó viết
    // `Number(b.tong ?? 0) > 0`, biến null thành 0 và nuốt trọn trường hợp đếm
    // hỏng — đúng kiểu nói dối theo hướng an toàn mà cả bộ đo sinh ra để chống.
    const r = phanLoaiBangKhongCotOrg([{ bang: "bang_loi", tong: null, tu_choi: false }]);
    expect(r.ro).toHaveLength(0);
    expect(r.chuaDo.map((b) => b.bang)).toEqual(["bang_loi"]);
  });

  it("đếm đủ cả ba loại trong một lượt", () => {
    const r = phanLoaiBangKhongCotOrg([
      { bang: "a", tong: 0, tu_choi: true },
      { bang: "b", tong: 0, tu_choi: false },
      { bang: "c", tong: 7, tu_choi: false },
      { bang: "d", tong: null, tu_choi: false },
    ]);
    expect({ tong: r.tong, tuChoi: r.tuChoi, ro: r.ro.length, chuaDo: r.chuaDo.length })
      .toEqual({ tong: 4, tuChoi: 1, ro: 1, chuaDo: 1 });
  });

  it("danh sách rỗng hay thiếu không làm nổ", () => {
    expect(phanLoaiBangKhongCotOrg([]).tong).toBe(0);
    expect(phanLoaiBangKhongCotOrg(undefined).tong).toBe(0);
  });
});

// ─── Điểm mù thứ hai: dòng organization_id NULL ─────────────────────────────
//
// Công thức biên giới có nhánh `organization_id IS NULL` ⇒ dòng NULL AI CŨNG
// THẤY. Nhưng bộ đo định nghĩa "dòng của tổ chức khác" là
// `IS NOT NULL AND <> org mình`, nên dòng NULL bị loại khỏi phép đếm THEO ĐÚNG
// ĐỊNH NGHĨA — lộ cho tất cả mà chưa từng bị tính là rò. Đo lần đầu 09/08/2026:
// 3.621 dòng trên 15 bảng, trong đó 345 dòng nhật ký kiểm toán hoá đơn.
//
// Luật KHÔNG phải "cấm NULL" — với dữ liệu toàn hệ thì NULL là nhãn đúng. Luật
// là "NULL phải được KHAI".
describe("phanLoaiDongNull — NULL phải được khai, không phải bị cấm", () => {
  it("bảng đã khai thì không làm đỏ", () => {
    const r = phanLoaiDongNull([{ bang: "ai_providers", so_dong_null: 10, da_khai: true }]);
    expect(r.chuaKhai).toHaveLength(0);
    expect(r.daKhai.map((b) => b.bang)).toEqual(["ai_providers"]);
    expect(r.tongChuaKhai).toBe(0);
  });

  it("bảng CHƯA khai mà có dòng NULL thì phải đỏ", () => {
    const r = phanLoaiDongNull([{ bang: "invoice_audit_log", so_dong_null: 345, da_khai: false }]);
    expect(r.chuaKhai.map((b) => b.bang)).toEqual(["invoice_audit_log"]);
    expect(r.tongChuaKhai).toBe(345);
  });

  it("0 dòng NULL thì không tính, dù đã khai hay chưa", () => {
    const r = phanLoaiDongNull([
      { bang: "a", so_dong_null: 0, da_khai: false },
      { bang: "b", so_dong_null: 0, da_khai: true },
    ]);
    expect(r.chuaKhai).toHaveLength(0);
    expect(r.daKhai).toHaveLength(0);
  });

  it("cộng đúng tổng qua nhiều bảng chưa khai", () => {
    const r = phanLoaiDongNull([
      { bang: "x", so_dong_null: 3084, da_khai: false },
      { bang: "y", so_dong_null: 345, da_khai: false },
      { bang: "z", so_dong_null: 81, da_khai: true },
    ]);
    expect(r.tongChuaKhai).toBe(3429);
    expect(r.daKhai).toHaveLength(1);
  });

  it("danh sách rỗng hợp lệ; thiếu kết quả phải fail closed", () => {
    expect(phanLoaiDongNull([]).tongChuaKhai).toBe(0);
    expect(phanLoaiDongNull(undefined).chuaDo).not.toHaveLength(0);
  });
});

const a = '00000000-0000-4000-8000-000000000001';
const b = '00000000-0000-4000-8000-000000000002';
const orphan = '11111111-2222-4333-8444-555555555555';
const actor = (uid, own_total, own_null) => ({ uid, auth_uid: uid, current_user: 'authenticated', rolbypassrls: false, rolsuper: false, table_owner_member: false, row_security: 'on', read_only: 'on', visible_total: own_total, own_total, own_null, foreign_total: 0, foreign_null: 0 });
const proof = () => ({ truth: { table_name: 'personal_transactions', exemption_valid: true, owner_column: true, owner_policy: true, rls_enabled: true, not_global: true, orphan_absent: true, total: 3, null_total: 2, owners: [{ uid: a, own_total: 2, own_null: 1 }, { uid: b, own_total: 1, own_null: 1 }] }, actors: [actor(a, 2, 1), actor(b, 1, 1), actor(orphan, 0, 0)], elapsed_ms: 3 });
describe('personal NULL owner proof — data measurement, never a global exemption', () => {
 it('accepts measured own NULL rows while unrelated undeclared NULL stays red', () => {
  expect(kiemDoOwnerPersonal(proof()).dat).toBe(true);
  const result = phanLoaiDongNull([{ bang: 'personal_transactions', so_dong_null: 2, da_khai: false }, { bang: 'unrelated', so_dong_null: 1, da_khai: false }], proof());
  expect(result.actorOwned).toHaveLength(1); expect(result.daKhai).toHaveLength(0); expect(result.tongChuaKhai).toBe(1);
 });
 it('catches foreign rows including NULL for an ordinary actor and orphan/admin-like bypass', () => {
  for (const index of [0, 2]) {
   const p = proof(); p.actors[index].foreign_total = 1; p.actors[index].foreign_null = 1; p.actors[index].visible_total++;
   expect(kiemDoOwnerPersonal(p).ro).toBe(true);
   expect(phanLoaiDongNull([{ bang: 'personal_transactions', so_dong_null: 2, da_khai: false }], p).roOwner).toHaveLength(1);
  }
 });
 it.each(['exemption_valid','owner_column','owner_policy','rls_enabled','not_global','orphan_absent'])('fails closed on missing/expired metadata %s', key => {
  const p = proof(); p.truth[key] = false; expect(kiemDoOwnerPersonal(p).dat).toBe(false);
 });
 it.each(['current_user','auth_uid','rolbypassrls','rolsuper','table_owner_member','row_security','read_only'])('fails closed on absent runtime guard %s', key => {
  const p = proof(); delete p.actors[0][key]; expect(kiemDoOwnerPersonal(p).dat).toBe(false);
 });
 it.each([null,undefined,'oops',{},[],NaN,-1,1.1,Number.MAX_SAFE_INTEGER + 1])('rejects invalid count %s instead of coalescing to zero', count => {
  const p = proof(); p.actors[0].foreign_total = count; expect(kiemDoOwnerPersonal(p).dat).toBe(false);
  expect(phanLoaiDongNull([{bang:'personal_transactions',so_dong_null:count,da_khai:false}],p).chuaDo.length).toBeGreaterThan(0);
 });
 it('rejects missing/empty/duplicate actor coverage and a zeroed positive control', () => {
  for (const actors of [[],proof().actors.slice(1),[...proof().actors,proof().actors[0]]]) expect(kiemDoOwnerPersonal({...proof(),actors}).dat).toBe(false);
  const p=proof(); p.actors[0]=actor(a,0,0); expect(kiemDoOwnerPersonal(p).dat).toBe(false);
 });
 it('never accepts a declared personal global NULL or a missing/stale proof', () => {
  const rows=[{bang:'personal_transactions',so_dong_null:2,da_khai:true}];
  expect(phanLoaiDongNull(rows).chuaDo.length).toBeGreaterThan(0);
  expect(phanLoaiDongNull(rows,proof()).chuaDo.length).toBeGreaterThan(0);
  expect(phanLoaiDongNull([],proof()).chuaDo.length).toBeGreaterThan(0);
  expect(phanLoaiDongNull([{...rows[0],da_khai:false,so_dong_null:3}],proof()).chuaDo.length).toBeGreaterThan(0);
 });
 it('uses read-only invoker SQL, validates UUIDs and bounds actor count', () => {
  const sql=sqlDoOwnerPersonal([a,b]);
  expect(sql).toContain('REPEATABLE READ READ ONLY'); expect(sql).toContain('SET LOCAL ROLE authenticated');
  expect(sql).toContain('user_id IS DISTINCT FROM auth.uid()'); expect(sql).not.toMatch(/CREATE |INSERT |UPDATE |DELETE |COMMIT;/);
  expect(() => sqlDoOwnerPersonal(["x';--"])).toThrow(); expect(() => sqlDoOwnerPersonal([])).toThrow();
  expect(() => sqlDoOwnerPersonal(Array(201).fill(a))).toThrow();
 });
});

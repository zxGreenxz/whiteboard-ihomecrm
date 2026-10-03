// Lớp LUẬT chọn hạng mục chi cho "Báo chi nhanh" — chạy TRƯỚC AI, chỉ chốt khi chắc.
//
// Đo trên 414 câu chi thật (fixture __tests__/fixtures/cau-chi-that-2026-10.json, 03/10/2026):
// chốt 296 câu (71%), sai 0; phần còn lại mới gọi AI.
// Ưu tiên ĐÚNG hơn PHỦ: không chắc ⇒ trả null để AI (hoặc người dùng) chọn.
//   1. Luật chủ công ty đặt (03/10/2026), neo theo `rule_key` của hạng mục (migration
//      20261003151608_danh_muc_chi_du_lieu) — tên hạng mục đổi được mà luật không gãy.
//      Luật về dòng tiền (hoàn cọc, trả khách, nội bộ) xét trước luật vệ sinh.
//   2. Cụm "hay nói" lấy từ cột `keywords` (chủ công ty sửa ở trang cài đặt hạng mục). Chỉ dùng cụm
//      ≥ 2 chữ hoặc từ riêng không thể nhầm (bTaskee, PCCC, camera…) và chỉ chốt khi đúng MỘT hạng
//      mục khớp.
// So CÓ DẤU: bỏ dấu làm "tủ" thành "tu" khớp nhầm "vật tư", "nệm" thành "nem" khớp "nem nướng".
// Bản không dấu chỉ dùng cho cụm ≥ 2 chữ (người dùng gõ không dấu "tien nha").

import type { CategoryRef } from "./categorySuggest";

/** Chữ thường, NFC, bỏ dấu câu, bọc khoảng trắng hai đầu để so " cụm " theo ranh giới từ. */
export const accentedText = (s: string): string =>
  ` ${s.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}/ ]+/gu, " ").replace(/\s+/g, " ").trim()} `;

/** Như trên nhưng bỏ dấu (đ ⇒ d). */
export const bareText = (s: string): string =>
  accentedText(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");

/** Từ đơn đủ riêng để tự chốt (so không dấu, chữ thường). */
const DISTINCT = new Set([
  "btaskee", "pccc", "camera", "wifi", "modem", "decor", "internet", "evn", "fpt", "viettel", "grab", "lalamove",
  "ship", "remote", "silicon", "hhmg", "cakv", "pql",
]);

interface OwnerRule {
  ruleKey: string;
  /** Mẫu trên câu CÓ dấu (accentedText). */
  accented: RegExp;
  /** Mẫu trên câu KHÔNG dấu (bareText) — cho người gõ không dấu. */
  bare?: RegExp;
  /** Loại trừ (trên câu có dấu). */
  not?: RegExp;
}

// Thứ tự = ưu tiên. Dòng tiền trước, vệ sinh sau cùng (câu hoàn cọc có chữ "vệ sinh phòng").
const OWNER_RULES: readonly OwnerRule[] = [
  { ruleKey: "bo_sung_hoan_coc", accented: / (hoàn|trả|trả lại) cọc | bổ sung hoàn cọc /, bare: / (hoan|tra|tra lai) coc / },
  {
    ruleKey: "tra_tien_thua_khach",
    accented: / thối tiền | đóng dư | tiền phòng \d+ ngày | hoàn (lại )?(\d+ ngày )?tiền phòng | tiền phòng thừa /,
    bare: / thoi tien | dong du /,
  },
  {
    ruleKey: "noi_bo",
    accented: / kết tiền | kết sổ | bàn giao | (chuyển|chi|đóng) (tiền \S+ )?(dùm|giùm|hộ) | ứng (tiền )?cho (a|anh|chị|c) /,
    bare: / ket tien | ket so | ban giao /,
  },
  {
    ruleKey: "camera_wifi_van_tay",
    accented: / camera | wifi | wi fi | modem | cục phát | vân tay | lưu điện | thẻ từ | thẻ nhớ /,
    bare: / camera | wifi | modem | van tay | luu dien | the tu /,
    not: / tiền wifi | tiền mạng | cước /,
  },
  { ruleKey: "pccc", accented: / pccc | chữa cháy | thoát hiểm /, bare: / pccc / },
  { ruleKey: "cong_an", accented: / công an | cakv | cap ?\d+ |^ ca /, bare: / cong an | cakv / },
  { ruleKey: "tam_tru_giay_to", accented: / tạm trú | tiếp dân | người nước ngoài | gpkd /, bare: / tam tru | tiep dan | nguoi nuoc ngoai / },
  {
    ruleKey: "don_ve_sinh",
    accented: / vệ sinh | btaskee | dọn phòng | dọn dẹp | lau hành lang /,
    bare: / btaskee /,
    not: / máy lạnh | máy giặt | bồn nước | ống nước | ống đồng /,
  },
];

/** Cụm "hay nói" khớp nhầm hay gặp ⇒ không tính cho hạng mục đó (so trên câu có dấu). */
const PHRASE_NOT: Readonly<Record<string, RegExp>> = {
  dien: / điện lạnh /,
  tien_nha: / hợp đồng thuê nhà | dùm | giùm | hộ /,
  noi_that_decor: / rác /,
  dien_lanh: / mua (máy|tủ) /,
};

interface Phrase {
  ref: CategoryRef;
  accented: string;
  bare: string | null;
}

function phrasesOf(rows: readonly CategoryRef[]): Phrase[] {
  const out: Phrase[] = [];
  for (const ref of rows) {
    for (const kw of ref.keywords ?? []) {
      const a = accentedText(kw);
      const words = a.trim().split(" ").filter(Boolean);
      if (words.length === 0) continue;
      const b = bareText(kw);
      if (words.length >= 2) out.push({ ref, accented: a, bare: b });
      else if (DISTINCT.has(b.trim())) out.push({ ref, accented: a, bare: null });
    }
  }
  return out;
}

/**
 * Hạng mục chốt bằng luật, hoặc null khi không chắc. `rows` phải là danh sách đã lọc dùng được
 * (usableExpenseCategories) — luật trỏ tới mục không có trong danh sách thì bỏ qua.
 */
export function ruleCategory(rows: readonly CategoryRef[], text: string): CategoryRef | null {
  if (!text.trim()) return null;
  const a = accentedText(text);
  const b = bareText(text);
  const byKey = new Map(rows.filter((r) => r.rule_key).map((r) => [r.rule_key as string, r]));

  for (const rule of OWNER_RULES) {
    const hit = rule.accented.test(a) || (rule.bare ? rule.bare.test(b) : false);
    if (!hit || (rule.not && rule.not.test(a))) continue;
    const ref = byKey.get(rule.ruleKey);
    if (ref) return ref;
  }

  const matched = new Map<string, CategoryRef>();
  for (const p of phrasesOf(rows)) {
    const hit = a.includes(p.accented) || (p.bare !== null && b.includes(p.bare));
    if (!hit) continue;
    const not = p.ref.rule_key ? PHRASE_NOT[p.ref.rule_key] : undefined;
    if (not && not.test(a)) continue;
    matched.set(p.ref.id, p.ref);
  }
  return matched.size === 1 ? [...matched.values()][0] : null;
}

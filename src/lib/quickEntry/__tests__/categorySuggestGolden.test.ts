import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { suggestCategory, usableExpenseCategories, type CategoryRef } from "../categorySuggest";
import cauThat from "./fixtures/cau-chi-that-2026-10.json";

// Bộ vector VÀNG của gợi ý hạng mục chi (luật 17/10: Hermes là nơi dùng thứ hai ⇒ công thức thành hàm SQL dùng chung
// public.ie_category_suggest_v1, docs/plans/hermes-crm/THU-CHI-THAO-TAC-GHI.md mục 4.2). File vàng do CHÍNH suggestCategory
// (TypeScript) sinh: test này khoá TS == vàng, infra/hermes-broker/ie-quick-entry-rules-sql.test.mjs khoá SQL == vàng trên
// PostgreSQL 17 ⇒ TS và SQL cho cùng {hạng mục, lý do} trên mọi câu. Câu: 414 câu chi thật + mọi chuỗi có khoảng trắng trong
// categoryRules.test.ts (ca dễ nhầm, câu phủ định) + vài ca mã khách hàng phí. Sinh lại: UPDATE_QE_GOLDEN=1 npx vitest run <file>.
const ROOT = resolve(__dirname, "../../../..");
const GOLDEN = resolve(__dirname, "fixtures/goi-y-hang-muc-vang.json");
interface SpecItem { k: string; g: string | null; n: string; d: string; kw?: string[]; hid?: boolean; qeh?: boolean }
const spec = JSON.parse(readFileSync(resolve(ROOT, "supabase/migrations/20261003151608_danh_muc_chi_du_lieu.sql"), "utf8").split("$spec$")[1]) as SpecItem[];
const ORG = "org-ihome";
const rows = usableExpenseCategories(spec.map((s, i) => ({
  id: s.k, name: s.n, category: s.g, type: "expense", organization_id: ORG, description: s.d, keywords: s.kw ?? [], rule_key: s.k,
  manual_hidden: s.hid ?? false, quick_entry_hidden: s.qeh ?? false, sort_order: (i + 1) * 10,
}) as CategoryRef), { organizationId: ORG, canUseRestricted: false });

const tricky = [...readFileSync(resolve(__dirname, "categoryRules.test.ts"), "utf8").matchAll(/"([^"\\\n]{4,120})"/g)]
  .map((m) => m[1]).filter((text) => text.includes(" ") && !text.includes("../"));
// Câu chỉ tới được đường "cụm phí cố định" (luật và cụm hay nói không bắt: dấu đặt khác "hóa", cụm một chữ không riêng).
const FEE_ONLY = ["hóa đơn điện tháng 9 toà 44TL", "điện tháng 10 512TT", "nước kỳ 9 15KV", "thu gom rác tháng 10", "phí quản lý tháng 9 102LVT",
  "bảo trì thang máy tháng 10", "cước mạng tháng 10", "tiền công an tháng 9 158PVC", "hóa đơn nước tháng 8", "thuê nhà tháng 11 cọc"];
// Mỗi nhánh của luật chủ đặt, neo khoá cứng và loại trừ có ít nhất một câu (kiểm đột biến SQL 22/10: thiếu câu ⇒ nhánh lọt).
const BRANCHES = ["lắp wi fi tầng 3 512TT", "thay cục phát wifi phòng 302", "mua lưu điện cửa cuốn", "làm thẻ từ thang máy", "mua thẻ nhớ camera tầng 2",
  "nạp bình chữa cháy 44TL", "đèn thoát hiểm hành lang", "tiếp dân phường X", "làm gpkd", "lau hành lang tầng 4", "dọn dẹp phòng 302 sau khách đi",
  "kết tiền resident tháng 9", "kết quỹ tuần này", "đóng dư tiền phòng 3 ngày", "hoàn lại 3 ngày tiền phòng cho khách", "tiền phòng thừa tháng 9",
  "khách đóng dư 200k", "hoàn tiền phòng khách 512", "bổ sung hoàn cọc phòng 302", "trả cọc khách thanh lý hđ 512", "trả lại cọc khách 1392 qt",
  "mua thùng rác decor sảnh", "mua rèm cửa phòng 201", "mua máy lạnh mới phòng 305", "mua keo dán thang máy", "sửa máy lạnh thợ điện lạnh",
  "thuê nhà tháng 11 cóc 2 tháng", "tien thue nha thang 11 coc", "tien nha thang 11 512TT", "ban giao tien ve so quy", "chi tiền nhà hộ anh Tuấn",
  "chuyển tiền nhà dùm chị Lan", "ca 1392 tiền công an T9", "CAP12 T8", "tiền ca t10", "nguoi nuoc ngoai tam tru", "ve sinh ban cong", "btaskee don phong",
  // Gõ lẫn dấu: cụm "hay nói" không bắt, cụm phí bắt "thue nha" nhưng phải bỏ vì có "coc" (nhánh riêng của tiền nhà).
  "thue nhà tháng 11 cóc"];
const texts = [...new Set([...(cauThat as Array<{ text: string }>).map((c) => c.text), ...tricky, ...FEE_ONLY, ...BRANCHES])];
const PROVIDER = [["hoá đơn tháng 10 PE0400012345", "dien"], ["tiền nước kỳ 9", "nuoc"], ["cước tháng 9", "internet"], ["phí tháng 10", "quan_ly"]];

export interface GoldenCase { text: string; fee: string | null; expect: { key: string; reason: string } | null }
function compute(): GoldenCase[] {
  const one = (text: string, fee: string | null): GoldenCase => {
    const s = suggestCategory(rows, text, { feeCategory: fee });
    return { text, fee, expect: s ? { key: s.id, reason: s.reason } : null };
  };
  return [...texts.map((text) => one(text, null)), ...PROVIDER.map(([text, fee]) => one(text, fee))];
}

describe("gợi ý hạng mục — vector vàng (TS == vàng; SQL == vàng ở test PG17)", () => {
  it("suggestCategory cho đúng từng ca của file vàng", () => {
    const now = compute();
    // Mỗi ca một dòng: diff gọn khi luật đổi.
    if (process.env.UPDATE_QE_GOLDEN === "1") writeFileSync(GOLDEN, `[\n${now.map((c) => JSON.stringify(c)).join(",\n")}\n]\n`);
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as GoldenCase[];
    expect(now).toEqual(golden);
    expect(golden.length).toBeGreaterThan(450);
    // Đủ mọi đường của suggestCategory, để SQL bị buộc phủ hết.
    const reasons = new Set(golden.map((c) => c.expect?.reason ?? "null"));
    for (const reason of ["rule", "rule_weak", "fee_phrase", "provider_code", "name_overlap", "null"]) expect(reasons.has(reason), reason).toBe(true);
  });
});

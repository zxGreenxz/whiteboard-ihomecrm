// Khuôn JSON AI phải trả cho trang "Báo chi nhanh" + bóc JSON khỏi câu trả lời.
//
// Chặt có chủ đích: khoá lạ, chỉ số hạng mục ngoài danh sách, số tiền lẻ, TỔNG âm ⇒ `invalid`,
// client thử mô hình kế một lần rồi mới bảo người dùng nhập tay. Riêng tiền TỪNG DÒNG được âm:
// bill có dòng "Giảm giá -5.000" / voucher Shopee là chuyện thường, và AI đọc đúng thì không được
// làm hỏng cả kết quả (đo 01/10/2026 — bill mẫu có giảm giá bị từ chối ở cả gpt-6-luna lẫn Gemini).
// Bộ dựng thẻ bỏ dòng ≤ 0 và ghi số thực trả. Khoá VẮNG thì mặc định null — mô hình hay bỏ trường
// rỗng, coi đó là lỗi chỉ làm tốn lượt gọi. AI không trả ID nào: hạng mục là chỉ số "cN" trong danh
// sách đã gửi, toà/phòng là chuỗi nhắc để bộ dò cục bộ tra.

import { z } from "zod";
import { MAX_AMOUNT_VND } from "./amount";

export const AI_MAX_ITEMS = 20;

const money = z.number().int().positive().max(MAX_AMOUNT_VND);
/** Tiền một dòng: được âm (giảm giá, voucher). Tổng thì không. */
const lineMoney = z.number().int().min(-MAX_AMOUNT_VND).max(MAX_AMOUNT_VND);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const cut = (max: number) => z.string().transform((s) => s.slice(0, max));
// Optional evidence must never void a reading: an unexpected model value ("Grab", "card") becomes null.
const evidence = <T extends string>(known: Record<string, T>) =>
  z.unknown().transform((value): T | null => typeof value === 'string' ? known[value.trim().toLowerCase().replace(/[\s_-]+/g, '')] ?? null : null).optional();
const paymentEvidence = {
  payment_method: evidence({ cash: 'cash', banktransfer: 'bank_transfer', transfer: 'bank_transfer' }),
  platform: evidence({ shopee: 'shopee', shopeefood: 'shopee', shopeepay: 'shopee', grab: 'grab', grabfood: 'grab', grabexpress: 'grab', grabbike: 'grab', grabcar: 'grab', grabmart: 'grab', grabtaxi: 'grab', grabrent: 'grab', grabdelivery: 'grab' }),
};

const itemSchema = z
  .object({
    ...paymentEvidence,
    transactionType: z.enum(['INCOME','EXPENSE']).optional(),
    desc: cut(120).default(""),
    amount_vnd: lineMoney.nullable().default(null),
    category: z.string().regex(/^c\d{1,3}$/).nullable().default(null),
    confidence: z.number().min(0).max(1).default(0.5),
  })
  .strict();

const resultSchema = z
  .object({
    ...paymentEvidence,
    items: z.array(itemSchema).max(AI_MAX_ITEMS).default([]),
    total_vnd: money.nullable().default(null),
    date: isoDate.nullable().default(null),
    vendor: cut(200).nullable().default(null),
    building_mention: cut(120).nullable().default(null),
    room_mention: cut(40).nullable().default(null),
    customer_code: cut(40).nullable().default(null),
    period_start: isoDate.nullable().default(null),
    period_end: isoDate.nullable().default(null),
  })
  .strict();

export type AiResult = z.infer<typeof resultSchema>;
export type AiItem = AiResult["items"][number];

export type AiParse = { ok: true; value: AiResult } | { ok: false; reason: "no_json" | "invalid" };

/**
 * Object JSON đầu tiên trong câu trả lời (bỏ qua ```json …``` và chữ thừa hai đầu). Đếm ngoặc có
 * biết chuỗi nên "{size}" trong mô tả không làm lệch ranh giới. Không có / hỏng ⇒ null.
 */
export function extractJson(text: string): unknown {
  for (let from = text.indexOf("{"); from >= 0; from = text.indexOf("{", from + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = from; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(from, i + 1)) as unknown;
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

const categoryCode = z.string().regex(/^c\d{1,3}$/);
const inRange = (code: string | null, categoryCount: number): boolean => {
  if (code === null) return true;
  const n = Number(code.slice(1));
  return n >= 1 && n <= categoryCount;
};

/** Kiểm câu trả lời AI; `categoryCount` = số hạng mục đã gửi (c1…cN). */
export function parseAiResult(text: string, categoryCount: number): AiParse {
  const raw = extractJson(text);
  if (raw === null) return { ok: false, reason: "no_json" };
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  if (!parsed.data.items.every((item) => inRange(item.category, categoryCount))) return { ok: false, reason: "invalid" };
  return { ok: true, value: parsed.data };
}

// Câu lệnh rút gọn (buildCategoryOnlyMessages): {"categories":["cN"|null,…]}, đúng một phần tử mỗi dòng.
// Một dòng mà mô hình trả {"category":"cN"} (khuôn đã dùng lúc đo 02/10) cũng nhận.
const categoryOnlySchema = z.union([
  z.object({ categories: z.array(categoryCode.nullable()).max(AI_MAX_ITEMS) }).strict(),
  z.object({ category: categoryCode.nullable() }).strict(),
]);

export type CategoryOnlyParse = { ok: true; value: Array<string | null> } | { ok: false; reason: "no_json" | "invalid" };

/** Kiểm câu trả lời "chỉ hạng mục": sai số phần tử hoặc mã ngoài danh sách ⇒ `invalid` (thử mô hình kế). */
export function parseCategoryOnlyResult(text: string, categoryCount: number, lineCount: number): CategoryOnlyParse {
  const raw = extractJson(text);
  if (raw === null) return { ok: false, reason: "no_json" };
  const parsed = categoryOnlySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  // Không thu hẹp bằng `in`: tsconfig.app.json không bật strictNullChecks nên nhánh còn lại không thu hẹp được.
  const data: { categories?: Array<string | null>; category?: string | null } = parsed.data;
  const codes = data.categories ?? [data.category ?? null];
  if (codes.length !== lineCount || !codes.every((c) => inRange(c, categoryCount))) return { ok: false, reason: "invalid" };
  return { ok: true, value: codes };
}

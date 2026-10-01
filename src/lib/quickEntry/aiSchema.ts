// Khuôn JSON AI phải trả cho trang "Báo chi nhanh" + bóc JSON khỏi câu trả lời.
//
// Chặt có chủ đích: khoá lạ, chỉ số hạng mục ngoài danh sách, số tiền lẻ/âm ⇒ `invalid`, client
// thử mô hình kế một lần rồi mới bảo người dùng nhập tay. Khoá VẮNG thì mặc định null — mô
// hình hay bỏ trường rỗng, coi đó là lỗi chỉ làm tốn lượt gọi. AI không trả ID nào: hạng mục là
// chỉ số "cN" trong danh sách đã gửi, toà/phòng là chuỗi nhắc để bộ dò cục bộ tra.

import { z } from "zod";
import { MAX_AMOUNT_VND } from "./amount";

export const AI_MAX_ITEMS = 20;

const money = z.number().int().positive().max(MAX_AMOUNT_VND);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const cut = (max: number) => z.string().transform((s) => s.slice(0, max));

const itemSchema = z
  .object({
    desc: cut(120).default(""),
    amount_vnd: money.nullable().default(null),
    category: z.string().regex(/^c\d{1,3}$/).nullable().default(null),
    confidence: z.number().min(0).max(1).default(0.5),
  })
  .strict();

const resultSchema = z
  .object({
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

/** Kiểm câu trả lời AI; `categoryCount` = số hạng mục đã gửi (c1…cN). */
export function parseAiResult(text: string, categoryCount: number): AiParse {
  const raw = extractJson(text);
  if (raw === null) return { ok: false, reason: "no_json" };
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  for (const item of parsed.data.items) {
    if (item.category === null) continue;
    const n = Number(item.category.slice(1));
    if (n < 1 || n > categoryCount) return { ok: false, reason: "invalid" };
  }
  return { ok: true, value: parsed.data };
}

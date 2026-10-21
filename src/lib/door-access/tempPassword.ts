import { z } from "zod";

import { PURPOSES, type DoorActionLog } from "./dto";
import { formatTimeDay, parseVnDateTimeLocal, vnDateTimeLocal, vnEndOfTodaySec } from "./format";

/**
 * Mật khẩu tạm (chủ chốt 21/10 điểm 5): CRM tự sinh số; mặc định 2 giờ; chọn nhanh 1 giờ, 2 giờ,
 * hết hôm nay, hoặc tự đặt tối đa 7 ngày; dùng nhiều lần trong hạn; mã chỉ hiện một lần.
 */

export const TEMP_PASSWORD_NAME_MAX = 20;
export const TEMP_PASSWORD_MAX_DAYS = 7;
export const VALIDITY_PRESETS = ["1h", "2h", "today", "custom"] as const;
export type ValidityPreset = (typeof VALIDITY_PRESETS)[number];

export const VALIDITY_PRESET_LABEL: Record<ValidityPreset, string> = {
  "1h": "1 giờ",
  "2h": "2 giờ",
  today: "Hết hôm nay",
  custom: "Tuỳ chọn",
};

export interface ValidityInput {
  preset: ValidityPreset;
  /** Ô datetime-local, đọc theo giờ Việt Nam (chỉ dùng khi `custom`). */
  from: string;
  to: string;
}

/**
 * Mỗi nhánh khai rõ trường của nhánh kia là `undefined`: tsconfig.app.json (không strict) không thu
 * hẹp union theo `ok`, nên thiếu dòng này thì đọc `field`/`effectiveSec` đỏ ở typecheck:baseline.
 */
export type ValidityResult =
  | { ok: true; effectiveSec: number; invalidSec: number; field?: undefined; message?: undefined }
  | { ok: false; field: "preset" | "from" | "to"; message: string; effectiveSec?: undefined; invalidSec?: undefined };

export function computeValidity(input: ValidityInput, nowMs: number): ValidityResult {
  const nowSec = Math.floor(nowMs / 1000);
  switch (input.preset) {
    case "1h":
      return { ok: true, effectiveSec: nowSec, invalidSec: nowSec + 3600 };
    case "2h":
      return { ok: true, effectiveSec: nowSec, invalidSec: nowSec + 7200 };
    case "today": {
      const invalidSec = vnEndOfTodaySec(nowMs);
      if (invalidSec <= nowSec + 60) {
        return { ok: false, field: "preset", message: "Đã gần hết ngày — chọn 1 giờ hoặc 2 giờ." };
      }
      return { ok: true, effectiveSec: nowSec, invalidSec };
    }
    case "custom": {
      const from = parseVnDateTimeLocal(input.from);
      if (from === null) return { ok: false, field: "from", message: "Chọn thời điểm bắt đầu." };
      const to = parseVnDateTimeLocal(input.to);
      if (to === null) return { ok: false, field: "to", message: "Chọn thời điểm kết thúc." };
      const effectiveSec = Math.floor(from / 1000);
      const invalidSec = Math.floor(to / 1000);
      if (invalidSec <= effectiveSec) return { ok: false, field: "to", message: "Kết thúc phải sau bắt đầu." };
      if (invalidSec <= nowSec) return { ok: false, field: "to", message: "Kết thúc phải sau hiện tại." };
      if (invalidSec - effectiveSec > TEMP_PASSWORD_MAX_DAYS * 86_400) {
        return { ok: false, field: "to", message: `Hiệu lực tối đa ${TEMP_PASSWORD_MAX_DAYS} ngày.` };
      }
      return { ok: true, effectiveSec, invalidSec };
    }
  }
}

/** Tên 1–20 ký tự (đếm theo ký tự thật, kể cả chữ có dấu), không ký tự điều khiển. */
export function tempPasswordNameProblem(raw: string): string | null {
  const name = raw.trim();
  const chars = [...name];
  if (chars.length === 0) return "Nhập tên mật khẩu.";
  if (chars.length > TEMP_PASSWORD_NAME_MAX) return `Tên tối đa ${TEMP_PASSWORD_NAME_MAX} ký tự.`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return "Tên có ký tự không hợp lệ.";
  return null;
}

export function tempPasswordFormSchema(now: () => number) {
  return z
    .object({
      name: z.string(),
      purpose: z.enum(PURPOSES),
      preset: z.enum(VALIDITY_PRESETS),
      from: z.string(),
      to: z.string(),
    })
    .superRefine((values, ctx) => {
      const nameProblem = tempPasswordNameProblem(values.name);
      if (nameProblem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["name"], message: nameProblem });
      // Chép từng trường: không strict thì zod suy mọi khoá là tuỳ chọn, không gán thẳng được.
      const validity = computeValidity({ preset: values.preset, from: values.from, to: values.to }, now());
      if (!validity.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [validity.field], message: validity.message });
    });
}

export type TempPasswordFormValues = z.infer<ReturnType<typeof tempPasswordFormSchema>>;

export function defaultTempPasswordValues(nowMs: number): TempPasswordFormValues {
  return {
    name: "",
    purpose: "XEM_PHONG",
    preset: "2h",
    from: vnDateTimeLocal(nowMs),
    to: vnDateTimeLocal(nowMs + 2 * 3600 * 1000),
  };
}

/** "từ 14:05 21/10 đến 16:05 21/10" */
export function validityText(effectiveSec: number, invalidSec: number): string {
  return `từ ${formatTimeDay(effectiveSec * 1000)} đến ${formatTimeDay(invalidSec * 1000)}`;
}

/** Tin nhắn gửi khách/thợ — chép một lần, không lưu. */
export function tempPasswordMessage(deviceName: string, code: string, effectiveSec: number, invalidSec: number): string {
  return `Mật khẩu cửa ${deviceName}: ${code}. Hiệu lực ${validityText(effectiveSec, invalidSec)}.`;
}

/** Nhật ký TEMP_PASSWORD_CREATE theo id mật khẩu Tuya — biết ai tạo, mục đích gì. */
export function indexTempPasswordLogs(logs: readonly DoorActionLog[]): Map<string, DoorActionLog> {
  const index = new Map<string, DoorActionLog>();
  for (const log of logs) {
    if (log.action !== "TEMP_PASSWORD_CREATE" || log.tuya_password_id === null) continue;
    // Danh sách về theo thứ tự mới ⇒ cũ: giữ bản đầu tiên gặp.
    if (!index.has(log.tuya_password_id)) index.set(log.tuya_password_id, log);
  }
  return index;
}

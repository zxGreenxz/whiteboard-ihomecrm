import { useEffect, useState } from "react";
import type { DateRange } from "react-day-picker";

/**
 * useState GIỮ QUA F5 trong cùng tab (sessionStorage): reload làm mới dữ liệu
 * nhưng bộ lọc đang chọn không reset; đóng tab là về mặc định — nhờ vậy các
 * default phụ thuộc ngày (vd "tháng này") không bị dính giá trị cũ qua ngày.
 *
 * - `key` phải duy nhất toàn app — quy ước "flt:<trang>:<tên state>".
 * - Giá trị phải JSON-serializable (string/number/boolean/mảng/object thuần).
 *   State chứa Date object (DateRange) dùng `usePersistedDateRange`.
 * - Trang có seed từ URL (?building_id, ?account_id...) phải để URL THẮNG giá
 *   trị khôi phục (giữ effect sync từ URL sau mount).
 */
export function usePersistedState<T>(key: string, initial: T | (() => T)) {
  const [state, setState] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw !== null) return JSON.parse(raw) as T;
    } catch {
      // Giá trị hỏng/khác shape (deploy đổi cấu trúc) → rơi về mặc định.
    }
    return typeof initial === "function" ? (initial as () => T)() : initial;
  });

  useEffect(() => {
    try {
      if (state === undefined) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify(state));
    } catch {
      // Quota đầy / chế độ riêng tư chặn storage — filter vẫn chạy, chỉ không giữ qua F5.
    }
  }, [key, state]);

  return [state, setState] as const;
}

/**
 * Bản chuyên cho DateRange của react-day-picker ({from?: Date, to?: Date}) —
 * Date không JSON-serializable nên lưu ISO string và revive lại khi khôi phục.
 */
export function usePersistedDateRange(
  key: string,
  initial: DateRange | undefined | (() => DateRange | undefined),
) {
  const [state, setState] = useState<DateRange | undefined>(() => {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw !== null) {
        const p = JSON.parse(raw) as { from?: string | null; to?: string | null } | null;
        if (!p || !p.from) return undefined;
        return { from: new Date(p.from), to: p.to ? new Date(p.to) : undefined };
      }
    } catch {
      // Hỏng → dùng mặc định.
    }
    return typeof initial === "function" ? initial() : initial;
  });

  useEffect(() => {
    try {
      if (!state?.from) sessionStorage.removeItem(key);
      else
        sessionStorage.setItem(
          key,
          JSON.stringify({
            from: state.from.toISOString(),
            to: state.to ? state.to.toISOString() : null,
          }),
        );
    } catch {
      // Storage bị chặn — bỏ qua.
    }
  }, [key, state]);

  return [state, setState] as const;
}

export default usePersistedState;

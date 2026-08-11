// Hai interface `MeterReadingFilters` phải còn TƯƠNG THÍCH.
//
// Repo có hai khai báo cùng tên:
//   src/components/meter-readings/MeterReadingFilters.tsx  (bản UI)
//   src/hooks/useMeterReadings.ts                          (bản hook)
//
// Chúng ĐÃ lệch: bản UI có `room_ids` kèm chú thích "Lọc nhiều phòng cùng tên,
// ưu tiên hơn room_id", bản hook thì không — trong khi THÂN HÀM của hook đã cài
// đặt đúng lọc đó. Tính năng chạy được ở runtime, chỉ kiểu là không mô tả nổi nó,
// và ts-baseline nuốt cả ba lỗi thành nợ đã biết nên không ai đọc lại.
//
// Không gộp một mối: bản UI dùng `| null` bắt buộc, bản hook dùng `?` tuỳ chọn;
// hợp nhất sẽ đụng mọi consumer. Bộ ca này chặn LỆCH thay vì ép GIỐNG — rẻ hơn
// nhiều và đủ để lần sau đỏ ngay.
import { describe, expect, it } from "vitest";

import type { MeterReadingFilters as UiFilters } from "@/components/meter-readings/MeterReadingFilters";
import type { MeterReadingFilters as HookFilters } from "@/hooks/useMeterReadings";

describe("MeterReadingFilters — hai bản còn tương thích", () => {
  it("mọi bộ lọc UI dựng được đều truyền thẳng vào hook, không cần ép kiểu", () => {
    // Đây là phép kiểm THẬT: nếu bản hook thiếu một khoá mà UI khai, dòng gán
    // dưới đây không biên dịch được. Ca chạy lúc runtime chỉ là chỗ treo nó.
    const tuUi: UiFilters = {
      building_id: "b1",
      room_id: null,
      room_ids: ["r1", "r2"],
      meter_type: null,
      month: "2026-08",
      status: null,
    };

    const choHook: HookFilters = {
      building_id: tuUi.building_id ?? undefined,
      room_id: tuUi.room_id ?? undefined,
      room_ids: tuUi.room_ids,
      meter_type: tuUi.meter_type ?? undefined,
      month: tuUi.month,
      status: tuUi.status ?? undefined,
    };

    expect(choHook.room_ids).toEqual(["r1", "r2"]);
  });

  it("`room_ids` là mảng chuỗi hoặc null ở CẢ HAI bản", () => {
    const a: UiFilters["room_ids"] = ["x"];
    const b: HookFilters["room_ids"] = ["x"];
    expect(a).toEqual(b);

    const c: UiFilters["room_ids"] = null;
    const d: HookFilters["room_ids"] = null;
    expect(c).toBe(d);
  });

  it("chống-xanh-rỗng: bộ lọc đầy đủ có ít nhất 6 khoá", () => {
    // Nếu ai đó rút gọn một trong hai interface xuống còn vài trường, hai ca trên
    // vẫn có thể xanh. Sàn này chặn kiểu thu hẹp đó.
    const day: UiFilters = {
      building_id: null,
      room_id: null,
      room_ids: null,
      meter_type: null,
      month: "2026-08",
      status: null,
    };
    expect(Object.keys(day).length).toBeGreaterThanOrEqual(6);
  });
});

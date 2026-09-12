import { describe, expect, it } from "vitest";

import type { ContractHistoryItem } from "@/components/contracts/detail/types";
import { dungDongLichSu } from "../contractHistoryLines";

const HD = {
  id: "hd-1",
  contract_number: "HD-2026-00358",
  created_at: "2025-09-05T08:00:00Z",
  signed_date: "2025-09-05",
  start_date: "2025-09-05",
  end_date: "2026-09-05",
};

const muc = (
  over: Partial<ContractHistoryItem> & Pick<ContractHistoryItem, "id" | "type">,
): ContractHistoryItem => ({
  created_at: "2026-01-01T00:00:00Z",
  status: "COMPLETED",
  details: {},
  ...over,
});

describe("dungDongLichSu", () => {
  it("luôn khép lại bằng dòng 'Tạo hợp đồng' suy ra từ chính HĐ", () => {
    // Không bảng nào ghi sự kiện tạo HĐ — nếu không tự dựng thì lịch sử của một
    // HĐ chưa từng gia hạn/chuyển/thanh lý sẽ rỗng trơn.
    const dong = dungDongLichSu({ contract: HD, history: [] });
    expect(dong).toHaveLength(1);
    expect(dong[0]?.tieuDe).toBe("Tạo hợp đồng");
    expect(dong[0]?.nhan).toBe("TẠO MỚI");
    expect(dong[0]?.moTa).toContain("HD-2026-00358");
    expect(dong[0]?.moTa).toContain("05/09/2025");
    expect(dong[0]?.moTa).toContain("05/09/2026");
  });

  it("mô tả gia hạn: khoảng ngày, số tháng, và giá khi có đổi", () => {
    const dong = dungDongLichSu({
      contract: HD,
      history: [
        muc({
          id: "ext-1",
          type: "extension",
          created_at: "2026-09-06T00:00:00Z",
          details: {
            old_end_date: "2026-09-05",
            new_end_date: "2027-08-30",
            extension_months: 12,
            rent_price_changed: false,
            new_rent_price: 3_900_000,
          },
        }),
      ],
    });
    expect(dong[0]?.tieuDe).toBe("Gia hạn hợp đồng");
    expect(dong[0]?.nhan).toBe("GIA HẠN");
    expect(dong[0]?.moTa).toContain("05/09/2026 → 30/08/2027");
    expect(dong[0]?.moTa).toContain("12 tháng");
    expect(dong[0]?.moTa).toContain("giá giữ nguyên 3.900.000");
  });

  it("gia hạn có đổi giá thì nói rõ giá cũ → giá mới", () => {
    const dong = dungDongLichSu({
      contract: HD,
      history: [
        muc({
          id: "ext-2",
          type: "extension",
          details: {
            old_end_date: "2026-09-05",
            new_end_date: "2027-08-30",
            extension_months: 12,
            rent_price_changed: true,
            new_rent_price: 4_200_000,
          },
        }),
      ],
    });
    expect(dong[0]?.moTa).toContain("giá 4.200.000");
  });

  it("ROOM_CHANGE là chuyển phòng, dùng nhãn phòng hook nhét sẵn", () => {
    const dong = dungDongLichSu({
      contract: HD,
      history: [
        muc({
          id: "tr-1",
          type: "transfer",
          details: {
            transfer_type: "ROOM_CHANGE",
            old_room_label: "201 — 405PVB",
            new_room_label: "303 — 405PVB",
            new_rent_price: 3_900_000,
          },
        }),
      ],
    });
    expect(dong[0]?.tieuDe).toBe("Chuyển phòng");
    expect(dong[0]?.nhan).toBe("CHUYỂN PHÒNG");
    expect(dong[0]?.moTa).toContain("201 — 405PVB → 303 — 405PVB");
  });

  it("thiếu nhãn phòng thì nói 'phòng khác', không để trống một vế", () => {
    const dong = dungDongLichSu({
      contract: HD,
      history: [
        muc({
          id: "tr-2",
          type: "transfer",
          details: { transfer_type: "ROOM_CHANGE", new_room_label: "303 — 405PVB" },
        }),
      ],
    });
    expect(dong[0]?.moTa).toContain("phòng khác → 303 — 405PVB");
  });

  it("TENANT_CHANGE / BOTH_CHANGE là nhượng hợp đồng", () => {
    const dong = dungDongLichSu({
      contract: HD,
      history: [
        muc({
          id: "tr-3",
          type: "transfer",
          details: {
            transfer_type: "TENANT_CHANGE",
            old_tenant_name: "Phạm Văn Tú",
            new_tenant_name: "Trần Hữu Khánh",
          },
        }),
      ],
    });
    expect(dong[0]?.tieuDe).toBe("Nhượng hợp đồng");
    expect(dong[0]?.nhan).toBe("NHƯỢNG HĐ");
    expect(dong[0]?.moTa).toContain("Phạm Văn Tú → Trần Hữu Khánh");
  });

  it("thanh lý NORMAL là khách rời phòng, kèm net quyết toán", () => {
    const dong = dungDongLichSu({
      contract: HD,
      history: [
        muc({
          id: "ter-1",
          type: "termination",
          details: {
            termination_type: "NORMAL",
            actual_move_out_date: "2026-09-12",
            refund_amount: 2_828_500,
          },
        }),
      ],
    });
    expect(dong[0]?.tieuDe).toBe("Thanh lý hợp đồng");
    expect(dong[0]?.nhan).toBe("THANH LÝ");
    expect(dong[0]?.moTa).toContain("khách rời phòng");
    expect(dong[0]?.moTa).toContain("2.828.500");
  });

  it("thanh lý FORFEIT là khách bỏ cọc", () => {
    const dong = dungDongLichSu({
      contract: HD,
      history: [
        muc({
          id: "ter-2",
          type: "termination",
          details: { termination_type: "FORFEIT", early_termination_fee: 3_900_000 },
        }),
      ],
    });
    expect(dong[0]?.moTa).toContain("khách bỏ cọc");
    expect(dong[0]?.moTa).toContain("3.900.000");
  });

  it("sắp mới → cũ, dòng 'Tạo hợp đồng' luôn chốt đáy", () => {
    const dong = dungDongLichSu({
      contract: HD,
      history: [
        muc({ id: "cu", type: "transfer", created_at: "2025-12-18T00:00:00Z" }),
        muc({ id: "moi", type: "extension", created_at: "2026-09-06T00:00:00Z" }),
      ],
    });
    expect(dong.map((d) => d.id)).toEqual(["moi", "cu", "hd-1-tao-moi"]);
  });

  it("thiếu ngày tạo HĐ thì dùng ngày ký làm mốc", () => {
    const dong = dungDongLichSu({
      contract: { ...HD, created_at: null },
      history: [],
    });
    expect(dong[0]?.ngay).toBe("05/09/2025");
  });
});

// Slice −1 · §−1.7 — "Đã hoàn" phải nghĩa là TIỀN ĐÃ RA KHỎI KÉT.
//
// Test LOGIC THUẦN (không render, không mạng): ba mốc số thật đo trên production
// 30/07/2026 được đóng đinh ở đây để không ai lặng lẽ quay về luật cũ
// (`!!refund_date || status === 'COMPLETED'`).
import { describe, expect, it, vi } from "vitest";

// Mock hạ tầng: các helper cần test là hàm thuần, nhưng module chứa chúng import
// supabase client (cần env Vite) và react-query.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: unknown) => options,
}));

import {
  indexPostedRefunds,
  summarizeRefundForfeit,
  type RefundForfeitRow,
} from "@/hooks/useDepositDashboard";
import { classifyPendingTerminationVouchers } from "@/hooks/contracts/useContractDetailData";

function row(over: Partial<RefundForfeitRow>): RefundForfeitRow {
  const settlementNet = over.settlement_net ?? 0;
  const postedRefund = over.posted_refund ?? 0;
  return {
    id: over.id ?? "t1",
    contract_id: over.contract_id ?? "c1",
    contract_number: null,
    building_id: over.building_id ?? "b1",
    building_name: "Toà 1",
    room_name: "P1",
    customer_name: "Khách",
    termination_date: "2026-07-01",
    termination_type: over.termination_type ?? "MOVE_OUT",
    kind: over.kind ?? "REFUND",
    total_deposit: over.total_deposit ?? 0,
    total_deductions: over.total_deductions ?? 0,
    settlement_net: settlementNet,
    status: over.status ?? "COMPLETED",
    posted_refund: postedRefund,
    posted_refund_count: over.posted_refund_count ?? (postedRefund ? 1 : 0),
    posted_refund_codes: over.posted_refund_codes ?? [],
    refund_done: over.refund_done ?? (over.posted_refund_count ?? (postedRefund ? 1 : 0)) > 0,
    refund_drift:
      over.refund_drift ?? (settlementNet > 0 ? settlementNet - postedRefund : 0),
  };
}

describe("indexPostedRefunds", () => {
  it("gộp theo contract_id — hợp đồng có HAI phiếu hoàn vẫn ra MỘT dòng", () => {
    // Án lệ prod: 2 phiếu hoàn CÙNG số tiền trên một hợp đồng khiến mọi reader
    // correlate kiểu 1-phiếu-1-dòng trả 2 dòng cho 1 termination.
    const idx = indexPostedRefunds([
      { contract_id: "c1", code: "PC001", amount: 2797000 },
      { contract_id: "c1", code: "PC002", amount: 2797000 },
      { contract_id: "c2", code: "PC003", amount: 1450000 },
    ]);
    expect(idx.size).toBe(2);
    expect(idx.get("c1")).toEqual({
      total: 5594000,
      count: 2,
      codes: ["PC001", "PC002"],
    });
    expect(idx.get("c2")?.total).toBe(1450000);
  });

  it("bỏ qua phiếu không gắn hợp đồng và chịu được total_amount kiểu chuỗi", () => {
    const idx = indexPostedRefunds([
      { contract_id: "", code: "PC004", amount: 999 },
      { contract_id: "c1", code: null, amount: "1450000" as unknown as number },
    ]);
    expect(idx.size).toBe(1);
    expect(idx.get("c1")).toEqual({ total: 1450000, count: 1, codes: [] });
  });
});

describe("summarizeRefundForfeit — tổng cột của BẢNG (không phải ô KPI)", () => {
  it("tái lập đúng ba ca hoàn cọc thật của org thật: 4.302.000đ / 2 dòng", () => {
    // Số cũ của get_refund_forfeit_summary là 8.290.000đ / 3 lần
    // (Σ GREATEST(0, refund_amount) trên mọi hồ sơ non-FORFEIT) — thổi phồng
    // 3.988.000đ vì cộng cả hồ sơ chưa có phiếu nào vào sổ.
    const rows = [
      // 69cdb5dc · 417LVT/L04 — hồ sơ 2.428.500, phiếu POSTED PC2607119 1.450.000
      row({ id: "ec0e00e7", contract_id: "69cdb5dc", settlement_net: 2428500, posted_refund: 1450000, posted_refund_codes: ["PC2607119"] }),
      // 06440526 · 481NVK/09 — hồ sơ 2.352.000, phiếu POSTED PC2607104 2.852.000
      row({ id: "a1ee1eb7", contract_id: "06440526", settlement_net: 2352000, posted_refund: 2852000, posted_refund_codes: ["PC2607104"] }),
      // 5f8b433f · 102LVT/103 — hồ sơ 3.509.500, phiếu PC2607153 UNAPPROVED/UNPOSTED
      row({ id: "c4c69c17", contract_id: "5f8b433f", settlement_net: 3509500, posted_refund: 0 }),
    ];
    expect(summarizeRefundForfeit(rows)).toEqual({
      refundTotal: 4302000,
      refundCount: 2,
      forfeitTotal: 0,
      forfeitCount: 0,
    });
    // Lệch hai chiều phải giữ nguyên dấu, không được clamp về 0.
    expect(rows[0].refund_drift).toBe(978500);
    expect(rows[1].refund_drift).toBe(-500000);
  });

  it("4.302.000đ là phần NỐI ĐƯỢC hồ sơ; ô KPI phải là 28.039.100đ (D2)", () => {
    // Quyết định của chủ 30/07 (§1ter.1): ô KPI "Đã hoàn cọc" = TIỀN ĐÃ RA KHỎI
    // KÉT = MỌI phiếu termination.refund đã duyệt & vào sổ, kể cả 8 phiếu KHÔNG
    // có dòng contract_terminations nào. Bảng bên dưới KPI chỉ liệt kê được phần
    // nối được hồ sơ, nên hai số phải đối chiếu được bằng đẳng thức dưới đây —
    // đó là lý do UI bắt buộc hiện dòng cảnh báo phần mồ côi.
    // linkedTotal phải LẤY TỪ HÀM, không gõ tay. Bản trước khai cả ba số là hằng
    // rồi `expect(linkedTotal + orphanTotal).toBe(refundTotal)` — tức chỉ kiểm ba
    // con số tác giả tự gõ có cộng đúng không, KHÔNG chạm vào code sản xuất lần
    // nào. Comment thậm chí ghi "= summarizeRefundForfeit(bảng)" nhưng nó là hằng.
    // Đẳng thức đó không bao giờ đỏ được, kể cả khi summarizeRefundForfeit hỏng.
    const bang = [
      row({ id: "t1", contract_id: "c1", settlement_net: 2797000, posted_refund: 2797000 }),
      row({ id: "t2", contract_id: "c2", settlement_net: 1505000, posted_refund: 1505000 }),
    ];
    const linkedTotal = summarizeRefundForfeit(bang).refundTotal; // ← từ CODE
    const orphanTotal = 23737100;     // refund_posted_orphan_total (8 phiếu, từ DB)
    const refundTotal = 28039100;     // refund_total (10 phiếu) ← ô KPI

    expect(linkedTotal).toBe(4302000);
    expect(linkedTotal + orphanTotal).toBe(refundTotal);
    // Lấy tổng bảng làm KPI là khai THIẾU đúng phần mồ côi — phương án đã bị bác.
    expect(refundTotal - linkedTotal).toBe(orphanTotal);
  });

  it("đối chiếu SỐ LƯỢNG phải tính bằng PHIẾU, không bằng HỒ SƠ", () => {
    // Hôm nay org thật có 2 hồ sơ mang đúng 2 phiếu, nên "2 + 8 = 10" vẫn ra đúng
    // dù trộn hai đơn vị (`refund_linked_count` đếm HỒ SƠ, `refund_count` và
    // `refund_posted_orphan_count` đếm PHIẾU). Fixture dưới đây là hình thái CÓ
    // THẬT trên prod (một HĐ hai phiếu hoàn — án lệ PC2606049/PC2606050 cùng
    // 2.797.000đ) và nó TÁCH hai đơn vị ra: 1 hồ sơ ↔ 2 phiếu.
    const rows = [
      row({
        id: "t1", contract_id: "c1",
        settlement_net: 5594000, posted_refund: 5594000,
        posted_refund_count: 2, posted_refund_codes: ["PC2606049", "PC2606050"],
      }),
    ];
    const table = summarizeRefundForfeit(rows);
    const termCount = table.refundCount;                                    // HỒ SƠ
    const voucherCount = rows.reduce((s, r) => s + r.posted_refund_count, 0); // PHIẾU
    expect(termCount).toBe(1);
    expect(voucherCount).toBe(2);

    const orphanCount = 8;             // refund_posted_orphan_count (PHIẾU)
    // Viết đẳng thức bằng HỒ SƠ là thiếu đúng số phiếu dư của hồ sơ nhiều phiếu…
    expect(termCount + orphanCount).toBe(9);
    // …còn viết bằng PHIẾU (refund_voucher_count / hook: linkedVoucherCount) mới
    // khớp refund_count. Đây là lý do khoá refund_voucher_count phải được expose.
    expect(voucherCount + orphanCount).toBe(10);
  });

  it("hồ sơ COMPLETED + refund_date mà không có phiếu vào sổ ⇒ KHÔNG tính là đã hoàn", () => {
    const rows = [
      row({ id: "d1", contract_id: "cd1", status: "COMPLETED", settlement_net: 50000, posted_refund: 0 }),
      row({ id: "d2", contract_id: "cd2", status: "COMPLETED", settlement_net: 40000, posted_refund: 0 }),
      row({ id: "d3", contract_id: "cd3", status: "COMPLETED", settlement_net: 30000, posted_refund: 0 }),
    ];
    expect(rows.every((r) => r.refund_done === false)).toBe(true);
    expect(summarizeRefundForfeit(rows)).toMatchObject({ refundTotal: 0, refundCount: 0 });
  });

  it("net âm (khách còn nợ) không thành 'Đã hoàn 0đ' và không cộng vào KPI", () => {
    // HĐ DEMO HD-2026-00015/00016: refund_amount = −2.241.000.
    const r = row({ contract_id: "ba7e21ea", settlement_net: -2241000, posted_refund: 0 });
    expect(r.refund_done).toBe(false);
    expect(r.refund_drift).toBe(0); // chỉ đo lệch khi hồ sơ nói PHẢI hoàn
    expect(Math.max(0, -r.settlement_net)).toBe(2241000); // nhãn "Khách còn nợ"
    expect(summarizeRefundForfeit([r]).refundTotal).toBe(0);
  });

  it("bỏ cọc cộng theo cọc gốc, không lẫn vào tiền hoàn", () => {
    const rows = [
      row({ id: "f1", kind: "FORFEIT", termination_type: "FORFEIT", total_deposit: 3000000, settlement_net: -500000 }),
      row({ id: "r1", kind: "REFUND", settlement_net: 1000000, posted_refund: 1000000 }),
    ];
    expect(summarizeRefundForfeit(rows)).toEqual({
      refundTotal: 1000000,
      refundCount: 1,
      forfeitTotal: 3000000,
      forfeitCount: 1,
    });
  });
});

describe("classifyPendingTerminationVouchers", () => {
  it("nhận cả marker system_source lẫn tiền tố notes cũ, không đếm hai lần", () => {
    const out = classifyPendingTerminationVouchers([
      { system_source: "termination.refund", notes: null },
      { system_source: "termination.refund", notes: "[HOÀN KHÁCH THANH LÝ] abc" },
      { system_source: null, notes: "[HOÀN KHÁCH THANH LÝ] phiếu legacy" },
      { system_source: "termination.offset", notes: null },
      { system_source: null, notes: "[CẤN CỌC BỎ CỌC] legacy" },
      { system_source: "invoice.payment", notes: "phiếu thu tiền phòng" },
      { system_source: null, notes: null },
    ]);
    expect(out).toEqual({ refund: 3, forfeit: 2 });
  });

  it("danh sách rỗng ⇒ không có cảnh báo", () => {
    expect(classifyPendingTerminationVouchers([])).toEqual({ refund: 0, forfeit: 0 });
  });

  // Audit 27/08 F4: prod có 3 phiếu hoàn APPROVED + NOT_APPLICABLE (9.515.634đ)
  // mà không màn nào nhắc — /deposits (đúng) không tính "đã hoàn", còn cảnh báo
  // này thì chỉ bắt UNAPPROVED. Phiếu hoàn là TIỀN THẬT: đã duyệt mà chưa
  // POSTED + posting sống thì vẫn phải cảnh báo.
  it("phiếu hoàn APPROVED chưa ra két vẫn là chờ xử lý; cấn cọc APPROVED thì không", () => {
    const out = classifyPendingTerminationVouchers([
      // đã duyệt, tiền CHƯA ra két (đúng ca 3 phiếu prod) ⇒ đếm
      {
        system_source: "termination.refund",
        approval_status: "APPROVED",
        posting_status: "NOT_APPLICABLE",
        active_posting_id_v2: null,
      },
      // đã duyệt + POSTED + posting sống ⇒ tiền đã ra két, KHÔNG đếm
      {
        system_source: "termination.refund",
        approval_status: "APPROVED",
        posting_status: "POSTED",
        active_posting_id_v2: "p1",
      },
      // POSTED nhưng bút toán đã bị reversal (posting sống = null) ⇒ đếm lại
      {
        system_source: "termination.refund",
        approval_status: "APPROVED",
        posting_status: "POSTED",
        active_posting_id_v2: null,
      },
      // cấn cọc là bút toán nội bộ: APPROVED + NOT_APPLICABLE là trạng thái
      // XONG của nó ⇒ KHÔNG đếm (22 phiếu prod ở đúng trạng thái này)
      {
        system_source: "termination.offset",
        approval_status: "APPROVED",
        posting_status: "NOT_APPLICABLE",
        active_posting_id_v2: null,
      },
      // cấn cọc chưa duyệt ⇒ đếm
      { system_source: "termination.offset", approval_status: "UNAPPROVED" },
    ]);
    expect(out).toEqual({ refund: 2, forfeit: 1 });
  });

  it("row không mang approval_status (caller cũ chỉ fetch UNAPPROVED) vẫn được đếm như trước", () => {
    const out = classifyPendingTerminationVouchers([
      { system_source: "termination.refund", notes: null },
      { system_source: null, notes: "[CẤN CỌC BỎ CỌC] legacy" },
    ]);
    expect(out).toEqual({ refund: 1, forfeit: 1 });
  });
});

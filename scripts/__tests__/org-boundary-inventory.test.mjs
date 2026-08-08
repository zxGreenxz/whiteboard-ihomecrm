import { describe, expect, it } from "vitest";

import {
  docTenBangTrongPlan,
  phanLoaiBang,
  kiemInventory,
} from "../build-org-boundary-inventory.mjs";

// Inventory này tồn tại để trả lời đúng MỘT câu: có bảng nào chưa ai nhận không?
//
// Khuyết tật gốc của toàn bộ chuyện tách dữ liệu là Sprint 3b gắn biên giới theo
// một DANH SÁCH VIẾT TAY 28 bảng — nên mọi bảng ra đời sau đó đều thiếu, âm thầm,
// suốt hơn một năm. Nếu inventory này cũng gõ tay danh sách giai đoạn thì nó tái
// tạo y nguyên khuyết tật đó ở một tầng cao hơn. Vì vậy nhóm và giai đoạn phải
// SINH TỪ VIỆC ĐỌC CHÍNH FILE PLAN, và bảng nào không được plan nhắc tới phải rơi
// vào UNASSIGNED để gate hét lên.
describe("docTenBangTrongPlan — rút tên bảng từ chính văn bản kế hoạch", () => {
  const plan = [
    "# Kế hoạch",
    "",
    "### GĐ3 — Vá nơi không thể hồi quy",
    "",
    "Các bảng `materials`, `material_categories` và job_types đều rỗng.",
    "",
    "### GĐ4 — Vá bảng đang rò sống",
    "",
    "Nặng nhất là `public_room_events`, rồi tới `document_templates`.",
  ].join("\n");

  it("gán mỗi bảng về đúng giai đoạn nơi nó được nhắc, kèm số dòng", () => {
    const kq = docTenBangTrongPlan(plan, ["materials", "material_categories", "public_room_events"]);

    expect(kq.get("materials")).toEqual({ phase: "GĐ3", line: 5 });
    expect(kq.get("material_categories")).toEqual({ phase: "GĐ3", line: 5 });
    expect(kq.get("public_room_events")).toEqual({ phase: "GĐ4", line: 9 });
  });

  it("nhận cả tên KHÔNG bọc backtick — plan viết trộn hai kiểu", () => {
    const kq = docTenBangTrongPlan(plan, ["job_types"]);
    expect(kq.get("job_types")?.phase).toBe("GĐ3");
  });

  it("KHÔNG khớp khi tên bảng chỉ là một phần của từ dài hơn", () => {
    // 'material' không được ăn theo 'materials', kẻo mọi bảng có tiền tố chung
    // đều bị gán bừa vào cùng một giai đoạn.
    const kq = docTenBangTrongPlan(plan, ["material"]);
    expect(kq.has("material")).toBe(false);
  });

  it("bảng không được plan nhắc tới thì không có trong kết quả", () => {
    const kq = docTenBangTrongPlan(plan, ["bang_chua_ai_nhac"]);
    expect(kq.has("bang_chua_ai_nhac")).toBe(false);
  });

  it("lấy lần nhắc ĐẦU TIÊN khi một bảng xuất hiện ở nhiều giai đoạn", () => {
    const p2 = `${plan}\n\n### GĐ7 — vùng mù\n\nNhắc lại \`materials\` lần nữa.`;
    const kq = docTenBangTrongPlan(p2, ["materials"]);
    expect(kq.get("materials")?.phase).toBe("GĐ3");
  });
});

describe("phanLoaiBang — mỗi bảng đúng một nhóm", () => {
  const nen = {
    table_name: "vi_du",
    relkind: "r",
    is_partition: false,
    has_organization_id: true,
    org_column_names: ["organization_id"],
    boundary_policy_name: null,
    authenticated_can_select: true,
    in_realtime_publication: false,
    visible_foreign: 0,
  };

  it("bảng đã có biên giới đúng tên → DA_CO_BOUNDARY, không cần giai đoạn", () => {
    const r = phanLoaiBang(
      { ...nen, boundary_policy_name: "vi_du_org_boundary" },
      { nhacTrongPlan: null, mienTru: null },
    );
    expect(r.group).toBe("DA_CO_BOUNDARY");
    expect(r.assigned_phase).toBe(null);
  });

  it("bảng nằm trong sổ miễn trừ → EXEMPT, mang theo lý do và hạn", () => {
    const r = phanLoaiBang(nen, {
      nhacTrongPlan: { phase: "GĐ3", line: 10 },
      mienTru: { reason: "đo: 10 → 0", decided_by: "ai đó", expires_at: "2026-11-30" },
    });
    expect(r.group).toBe("EXEMPT");
    expect(r.exemption_reason).toBe("đo: 10 → 0");
    expect(r.expires_at).toBe("2026-11-30");
  });

  it("miễn trừ THẮNG cả khi plan có nhắc — sổ là quyết định cứng", () => {
    const r = phanLoaiBang(nen, {
      nhacTrongPlan: { phase: "GĐ4", line: 3 },
      mienTru: { reason: "đo: 1 → 0", decided_by: "x", expires_at: "2026-12-01" },
    });
    expect(r.group).toBe("EXEMPT");
  });

  it("bảng không có cột organization_id → NO_ORG_COLUMN", () => {
    const r = phanLoaiBang(
      { ...nen, has_organization_id: false, org_column_names: [] },
      { nhacTrongPlan: null, mienTru: null },
    );
    expect(r.group).toBe("NO_ORG_COLUMN");
  });

  it("đang rò thật (visible_foreign > 0) → LIVE_LEAK, bất kể plan xếp đâu", () => {
    const r = phanLoaiBang(
      { ...nen, visible_foreign: 33 },
      { nhacTrongPlan: { phase: "GĐ3", line: 4 }, mienTru: null },
    );
    expect(r.group).toBe("LIVE_LEAK");
  });

  it("thiếu biên giới mà KHÔNG bảng nào nhắc tới → UNASSIGNED", () => {
    const r = phanLoaiBang(nen, { nhacTrongPlan: null, mienTru: null });
    expect(r.group).toBe("UNASSIGNED");
    expect(r.assigned_phase).toBe(null);
  });

  it("thiếu biên giới nhưng plan có nhắc → theo đúng giai đoạn plan nói", () => {
    const r = phanLoaiBang(nen, { nhacTrongPlan: { phase: "GĐ3", line: 12 }, mienTru: null });
    expect(r.group).toBe("CHO_VA");
    expect(r.assigned_phase).toBe("GĐ3");
    expect(r.source_line).toBe(12);
  });

  it("bảng phân mảnh cha vẫn được xét như bảng thường", () => {
    // Đo được: network_device_samples và network_interface_samples là relkind='p',
    // CÓ organization_id, CHƯA có boundary. Generator cũ lọc relkind='r' nên bỏ sót.
    const r = phanLoaiBang(
      { ...nen, relkind: "p", table_name: "network_device_samples" },
      { nhacTrongPlan: null, mienTru: null },
    );
    expect(r.group).toBe("UNASSIGNED");
  });
});

describe("kiemInventory — luật của gate", () => {
  const oDat = {
    table_name: "a",
    group: "CHO_VA",
    assigned_phase: "GĐ3",
    exemption_reason: null,
    decided_by: null,
    expires_at: null,
  };

  it("đỏ khi còn bảng UNASSIGNED", () => {
    const r = kiemInventory({ rows: [{ ...oDat, group: "UNASSIGNED", assigned_phase: null }], homNay: "2026-08-07" });
    expect(r.dat).toBe(false);
    expect(r.loi.join(" ")).toMatch(/UNASSIGNED/);
  });

  it("đỏ khi có miễn trừ quá hạn", () => {
    const r = kiemInventory({
      rows: [{ ...oDat, group: "EXEMPT", assigned_phase: null, exemption_reason: "đo 1", decided_by: "x", expires_at: "2026-01-01" }],
      homNay: "2026-08-07",
    });
    expect(r.dat).toBe(false);
    expect(r.loi.join(" ")).toMatch(/quá hạn/i);
  });

  it("đỏ khi miễn trừ thiếu lý do hoặc người quyết định", () => {
    const r = kiemInventory({
      rows: [{ ...oDat, group: "EXEMPT", assigned_phase: null, exemption_reason: null, decided_by: null, expires_at: "2026-12-01" }],
      homNay: "2026-08-07",
    });
    expect(r.dat).toBe(false);
  });

  it("đỏ khi bảng CHO_VA mà không có giai đoạn", () => {
    const r = kiemInventory({ rows: [{ ...oDat, assigned_phase: null }], homNay: "2026-08-07" });
    expect(r.dat).toBe(false);
  });

  it("xanh khi mọi bảng đều có chỗ đứng", () => {
    const r = kiemInventory({
      rows: [
        oDat,
        { ...oDat, table_name: "b", group: "EXEMPT", assigned_phase: null, exemption_reason: "đo 7 → 0", decided_by: "y", expires_at: "2026-11-30" },
        { ...oDat, table_name: "c", group: "DA_CO_BOUNDARY", assigned_phase: null },
        { ...oDat, table_name: "d", group: "NO_ORG_COLUMN", assigned_phase: null },
      ],
      homNay: "2026-08-07",
    });
    expect(r.loi).toEqual([]);
    expect(r.dat).toBe(true);
  });
});

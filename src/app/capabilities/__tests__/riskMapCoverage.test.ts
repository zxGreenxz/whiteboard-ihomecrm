// Nơi khai route/capability phải nằm TRONG một tier của risk-map.
//
// VÌ SAO
//   `capability.risk` và tier của risk-map đo hai thứ khác nhau (xem chú thích ở
//   types.ts), nên so trực tiếp là vô nghĩa. Nhưng có một khẳng định VỪA đo được
//   VỪA đáng giá: sửa nơi khai route/nav/capability phải kích hoạt đúng bộ gate.
//
//   Đo 11/08/2026: tier `product-surface` trỏ `src/App.tsx` vì đó TỪNG là nơi khai
//   route. App.tsx nay có 0 dòng `path=` — route đã dời sang `src/app/routes/**`.
//   Tức tier canh một chỗ trống, và mọi thay đổi route rơi vào "không tier nào".
//   Đó là kiểu hỏng im lặng: bảng luật vẫn có mục, mục vẫn có đường dẫn, đường dẫn
//   vẫn tồn tại — chỉ là thứ cần canh đã đi nơi khác.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { globSangRegex, xepTier } from "../../../../scripts/check-risk-classifier.mjs";

const { tiers } = JSON.parse(
  readFileSync(new URL("../../../../tooling/risk-map.json", import.meta.url), "utf8"),
);

describe("risk-map phủ nơi khai bề mặt sản phẩm", () => {
  it("file route thuộc tier product-surface", () => {
    expect(xepTier("src/app/routes/financeReportRoutes.tsx", tiers)).toBe("product-surface");
    expect(xepTier("src/app/routes/index.tsx", tiers)).toBe("product-surface");
  });

  it("registry và adapter capability thuộc tier product-surface", () => {
    expect(xepTier("src/app/capabilities/registry.ts", tiers)).toBe("product-surface");
    expect(xepTier("src/app/capabilities/surfaceAdapters.ts", tiers)).toBe("product-surface");
  });

  it("App.tsx VẪN ở lại tier — nó còn là chỗ dựng cây provider", () => {
    // Giữ chứ không thay: nó không còn khai route, nhưng vẫn là bề mặt.
    expect(xepTier("src/App.tsx", tiers)).toBe("product-surface");
  });

  it("Sidebar và launcher vẫn được phủ", () => {
    expect(xepTier("src/components/layout/Sidebar.tsx", tiers)).toBe("product-surface");
    expect(xepTier("src/pages/home/launcherTiles.ts", tiers)).toBe("product-surface");
  });

  it("chống-xanh-rỗng: tier product-surface có ít nhất 5 đường dẫn", () => {
    // Nếu ai đó rút danh sách xuống còn một mục thì bốn ca trên vẫn có thể xanh
    // nhờ glob rộng; sàn này chặn kiểu thu hẹp đó.
    expect(tiers["product-surface"].paths.length).toBeGreaterThanOrEqual(5);
  });

  it("glob `src/app/routes/**` KHÔNG vô tình phủ cả src/app/", () => {
    // Lọc quá rộng cũng sai: nó sẽ kéo mọi thứ dưới src/app/ vào cùng một tier và
    // làm bộ phân loại mất khả năng phân biệt.
    expect(globSangRegex("src/app/routes/**").test("src/app/providers/Query.tsx")).toBe(false);
  });
});

// Ô "Đặt cọc" ở Home launcher — màn chính của web-app trên điện thoại.
//
// VÌ SAO CẦN TEST RIÊNG, KHI capabilityContract.test.ts ĐÃ SO registry ↔ launcher
//   Phép so ở đó là hai chiều theo CỜ: `Boolean(tile) === surfaces.mobileLauncher`.
//   Nó xanh cả khi cờ TẮT và tile vắng mặt — đúng trạng thái đã làm người dùng
//   không tìm thấy Sổ cọc trên điện thoại. Nói cách khác nó chốt "hai nơi khớp
//   nhau", không chốt "bề mặt này phải tồn tại".
//
//   Test dưới đây chốt quyết định sản phẩm: /deposits là đường vào DUY NHẤT của
//   màn Sổ cọc trên điện thoại (DepositsPage rẽ sang DepositsMobilePage khi
//   `usePhoneViewport`), nên nó phải có ô ở launcher — không có ô thì màn đó
//   không đến được từ trang chủ.
import { describe, expect, it } from "vitest";
import { LAUNCHER_SECTIONS } from "../launcherTiles";
import { capabilityById } from "@/app/capabilities/registry";

const tiles = LAUNCHER_SECTIONS.flatMap((s) => s.items);
const tile = tiles.find((t) => t.href === "/deposits");

describe("Home launcher · ô Đặt cọc", () => {
  it("registry khai capability deposits có mặt ở launcher mobile", () => {
    expect(capabilityById("deposits")?.surfaces.mobileLauncher).toBe(true);
  });

  it("có đúng một ô trỏ /deposits, id khớp id capability", () => {
    expect(tiles.filter((t) => t.href === "/deposits")).toHaveLength(1);
    expect(tile?.id).toBe("deposits");
  });

  it("ô gác đúng (module, action) như route guard /deposits", () => {
    const cap = capabilityById("deposits")!;
    expect(tile?.module).toBe(cap.permission.module);
    expect(tile?.action ?? "view").toBe(cap.permission.action);
  });
});

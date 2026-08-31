import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseNetworkCenterBuilding } from "@/lib/network-center/dto";
import { validateNetworkSettings } from "@/lib/network-center/model";

/**
 * Cận của giao diện phải BẰNG cận của cơ sở dữ liệu, không được chặt hơn.
 *
 * Sự cố 31/08/2026: `network_site_settings_poll_check` cho 30..3600, nhưng zod ở
 * tầng đọc chặn ở 300. Ngày 30/08 ai đó đặt cả 22 toà thành 1800 — hợp lệ với cơ
 * sở dữ liệu, và Network Center **chết toàn bộ**: không toà nào mở được, mọi toà
 * đều báo "Dữ liệu Network Center không đúng hợp đồng".
 *
 * Bài học không phải "1800 là sai". Nó hợp lệ. Bài học là một ràng buộc ở TẦNG
 * ĐỌC chặt hơn cơ sở dữ liệu thì biến dữ liệu hợp lệ thành sập giao diện, và
 * bán kính là toàn hệ thống chứ không phải một bản ghi. Test này đọc con số
 * thẳng từ file migration nên hai bên không thể trôi khỏi nhau lần nữa.
 */
const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260729010000_network_center_permissions_inventory.sql",
);
const sql = readFileSync(migrationPath, "utf8").replace(/\r\n/g, "\n");

function canTuCoSoDuLieu(constraint: string, column: string): [number, number] {
  const khop = sql.match(
    new RegExp(
      `CONSTRAINT ${constraint}\\s*\\n?\\s*CHECK \\(${column} BETWEEN (\\d+) AND (\\d+)\\)`,
    ),
  );
  if (!khop) throw new Error(`Không đọc được ràng buộc ${constraint} trong migration`);
  return [Number(khop[1]), Number(khop[2])];
}

describe("cận cài đặt Network Center phải khớp cơ sở dữ liệu", () => {
  const [duoi, tren] = canTuCoSoDuLieu(
    "network_site_settings_poll_check",
    "poll_interval_seconds",
  );

  it("đọc được cận thật từ migration", () => {
    expect(duoi).toBe(30);
    expect(tren).toBe(3600);
  });

  const dungDto = (giay: number) =>
    parseNetworkCenterBuilding({
      buildingId: "3cc42f97-49e3-4efd-b07b-11bf4e754d34",
      buildingName: "Toà thử",
      roomsCount: 1,
      rolloutState: "READ_ONLY",
      router: null,
      interfaces: [],
      incidents: [],
      revisions: [],
      maintenance: null,
      settings: {
        version: 1,
        pollingSeconds: giay,
        backupHour: "03:00",
        alertSensitivity: "standard",
        dependencyGrouping: true,
        changesPaused: false,
      },
    });

  it("tầng ĐỌC nhận mọi giá trị cơ sở dữ liệu cho phép", () => {
    // Đây là ca đã làm sập production: 1800 hợp lệ dưới cơ sở dữ liệu.
    for (const giay of [duoi, 60, 300, 301, 1800, tren]) {
      expect(() => dungDto(giay), `pollingSeconds=${giay} phải đọc được`).not.toThrow();
    }
  });

  it("tầng ĐỌC vẫn bác giá trị cơ sở dữ liệu KHÔNG cho phép", () => {
    for (const giay of [duoi - 1, tren + 1, 0, -5]) {
      expect(() => dungDto(giay), `pollingSeconds=${giay} phải bị bác`).toThrow();
    }
  });

  const dungGhi = (giay: number) =>
    validateNetworkSettings({
      pollingSeconds: giay,
      backupHour: "03:00",
      alertSensitivity: "standard",
      dependencyGrouping: true,
      changesPaused: false,
    });

  it("tầng GHI dùng đúng cặp cận đó, không rộng hơn cũng không hẹp hơn", () => {
    expect(() => dungGhi(duoi)).not.toThrow();
    expect(() => dungGhi(tren)).not.toThrow();
    expect(() => dungGhi(1800)).not.toThrow();
    expect(() => dungGhi(duoi - 1)).toThrow();
    expect(() => dungGhi(tren + 1)).toThrow();
  });

  it("ô nhập trên màn hình cài đặt cũng mang đúng cận đó", () => {
    // Ô nhập rộng hơn cơ sở dữ liệu thì người dùng gõ xong mới bị từ chối;
    // hẹp hơn thì không sửa lại được giá trị đang có. Cả hai đều tệ.
    const tab = readFileSync(
      resolve(process.cwd(), "src/components/network-center/tabs/SettingsTab.tsx"),
      "utf8",
    );
    expect(tab).toContain(`min={${duoi}} max={${tren}}`);
  });
});

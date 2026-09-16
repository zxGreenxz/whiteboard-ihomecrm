// DIALOG MOUNT SẴN KHÔNG ĐƯỢC ĐỌC DỮ LIỆU KHI ĐANG ĐÓNG.
//
// Mẫu khắp app: trang render `<XDialog open={...} />` ở cuối JSX nên dialog
// LUÔN mounted, chỉ `open` đổi. Hook đọc dữ liệu trong thân dialog vì thế chạy
// ngay lúc vào trang — người dùng chưa bấm gì đã tốn một loạt request, và
// những request đó lại là loại nặng nhất (toàn bộ phòng, toàn bộ khách thuê,
// toàn bộ toà nhà).
//
// Bài này đọc THẲNG mã nguồn thay vì render 11 dialog: render chúng đòi dựng cả
// cây provider + chục hook mock cho mỗi cái, và thứ cần chốt ở đây là một giao
// kèo cú pháp — hook nào cũng phải nhận `enabled` theo `open`. Mất giao kèo đó
// là lặng lẽ quay về hành vi cũ, không test nào khác bắt được.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** file → các mảnh BẮT BUỘC có mặt sau khi gate. */
const GIAO_KEO: Record<string, string[]> = {
  'src/components/areas/ManageAreasDialog.tsx': [
    'useBuildings({ enabled: open })',
  ],
  'src/components/assets/AssetMaintenanceDialog.tsx': [
    'enabled: open',
  ],
  'src/components/assets/AssetMovementDialog.tsx': [
    'useRooms(undefined, { enabled: open })',
  ],
  'src/components/assets/CreateAssetDialog.tsx': [
    'useBuildings({ enabled: open })',
    'useRooms(undefined, { enabled: open })',
    'enabled: open',
  ],
  'src/components/assets/EditAssetDialog.tsx': [
    'useBuildings({ enabled: open })',
    'useRooms(buildingId, { enabled: open })',
    'enabled: open',
  ],
  'src/components/buildings/BuildingFormDialog.tsx': [
    'useServices(undefined, { enabled: open })',
    "useBuildingServices(open ? building?.id || '' : '')",
  ],
  'src/components/contracts/ContractImportExportDialog.tsx': [
    'useBuildings({ enabled: open })',
  ],
  'src/components/contracts/TransferRoomDialog.tsx': [
    'useBuildings({ enabled: open })',
    'useRooms(undefined, { enabled: open })',
  ],
  'src/components/deposits/CreateDepositDialog.tsx': [
    'useTenantsLegacy({ enabled: open })',
    'useRooms(undefined, { enabled: open })',
    'useAccounts({ enabled: open })',
  ],
  'src/components/income-expenses/IncomeExpenseImportDialog.tsx': [
    'useBuildings({ includeVirtual: true, enabled: open })',
    "useIncomeExpenseTypes('income', { enabled: open })",
    "useIncomeExpenseTypes('expense', { enabled: open })",
  ],
  'src/components/invoices/ExcelInvoiceDialog.tsx': [
    'useBuildings({ enabled: open })',
  ],
};

describe('11 dialog mount sẵn phải gate fetch theo `open`', () => {
  for (const [file, manh] of Object.entries(GIAO_KEO)) {
    it(`${file} gate đủ hook đọc`, () => {
      const nguon = readFileSync(file, 'utf8');
      for (const m of manh) expect(nguon).toContain(m);
    });
  }

  it('không dialog nào còn gọi useRooms()/useBuildings() trần', () => {
    for (const file of Object.keys(GIAO_KEO)) {
      const nguon = readFileSync(file, 'utf8');
      expect(nguon, `${file} còn useRooms() trần`).not.toMatch(/useRooms\(\s*\)/);
      expect(nguon, `${file} còn useBuildings() trần`).not.toMatch(/useBuildings\(\s*\)/);
    }
  });
});

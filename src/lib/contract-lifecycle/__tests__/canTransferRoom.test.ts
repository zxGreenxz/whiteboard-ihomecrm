import { expect, it } from 'vitest';
import { canTransferRoom } from '../canTransferRoom';

const building = 'toa-A';
const here = { org_wide: false, building_ids: [building] };
const elsewhere = { org_wide: false, building_ids: ['toa-B'] };
const orgWide = { org_wide: true, building_ids: [] as string[] };

it.each([
  [here, here, true],
  [here, elsewhere, false],
  [elsewhere, here, false],
  [elsewhere, elsewhere, false],
  [here, false, false],
  [false, here, false],
  [orgWide, here, true],
] as const)('kiểm cả quyền sửa và chuyển ở tòa của hợp đồng (%#)', (edit, transfer, allowed) => {
  expect(canTransferRoom({ contracts: { edit, transfer } }, building)).toBe(allowed);
});

it('đợi xác định được tòa và quyền của người dùng', () => {
  expect(canTransferRoom({ contracts: { edit: true, transfer: true } }, undefined)).toBe(false);
  expect(canTransferRoom(undefined, building)).toBe(false);
});

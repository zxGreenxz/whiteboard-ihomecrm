// @vitest-environment jsdom
// Đợt 8 (luật 5, cách A): lưu vật tư của công việc và SỬA phiếu nhập vật tư không giữ dấu «chờ đối chiếu» nữa. Đường TẠO
// phiếu nhập (đợt 9) không ghi dấu: mã do trình duyệt sinh, xem thêm materialCreateRecovery.test.tsx.
//
// Đợt 10b: ba khối «vật tư của công việc: sửa vật tư đã có», «vật tư của công việc: công việc chưa có phiếu xuất» và «sửa phiếu
// nhập vật tư (đường sửa)» chuyển sang xoaChenMotGiaoDichWriters.test.tsx. Hai nơi đó nay gọi MỘT hàm máy chủ thay nguyên tử
// đầu phiếu + cả bộ dòng (save_job_material_usage_v1, replace_material_purchase_v1): các ca «chèn hỏng SAU khi đã xoá», «biên
// nhận xoá sai dạng», «gỡ phiếu rỗng khớp 0 dòng» của cơ chế nhiều lệnh không còn; ba kịch bản rớt mạng, dấu bản trước, từ chối
// rõ, bộ rỗng gỡ phiếu, không quyền xoá phiếu và hàng rào biên nhận được viết lại ở tệp mới theo hàm nguyên tử.
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, pendingKeys, type FakeRecordServer } from './fakeRecordServer';

type Row = Record<string, unknown>;
const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer }));
vi.mock('@tanstack/react-query', () => ({ useMutation: (config: unknown) => config, useQuery: (config: unknown) => config, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table) } }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: 'org-a' }) }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { RepeatableWriteUnknownError } from '@/lib/financialWorkflow';
import { recordWriteBlocked } from '@/lib/recordWriteOutcome';
import { materialVoucherRetryBlocked } from '@/lib/materialVoucherOutcome';
import { useCreateMaterialPurchase } from '../useMaterialPurchases';

const rows = (table: string): Row[] => io.server.rows[table] ?? [];
const purchaseLines = (purchaseId: string) => rows('material_purchase_items').filter(row => row.purchase_id === purchaseId);

interface PurchaseInput { purchase_date: string; supplier_id: string | null; notes: string | null; items: Array<{ material_id: string; quantity: number; unit_price: number }> }
type CreatePurchase = (input: PurchaseInput) => Promise<unknown>;
const createPurchase = (): CreatePurchase => {
  const { result } = renderHook(() => useCreateMaterialPurchase());
  return (result.current as unknown as { mutationFn: CreatePurchase }).mutationFn;
};
const purchaseInput: PurchaseInput = { purchase_date: '2026-09-30', supplier_id: null, notes: 'sửa', items: [{ material_id: 'm-1', quantity: 4, unit_price: 120 }, { material_id: 'm-2', quantity: 2, unit_price: 50 }] };

/** Lỗi chưa rõ của thao tác lặp lại được: không khoá form, không để dấu. */
function expectRepeatable(error: unknown) {
  expect(error).toBeInstanceOf(RepeatableWriteUnknownError);
  expect(recordWriteBlocked(error)).toBe(false);
  expect(materialVoucherRetryBlocked(error)).toBe(false);
  expect(pendingKeys()).toEqual([]);
}

beforeEach(() => {
  io.server = fakeRecordServer();
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a');
  io.server.rows.material_purchases = [{ id: 'p-1', organization_id: 'org-a', purchase_date: '2026-09-01', supplier_id: null, notes: null }];
  io.server.rows.material_purchase_items = [
    { id: 'stock-1', purchase_id: 'p-0', material_id: 'm-1', quantity: 10, unit_price: 100, organization_id: 'org-a' },
    { id: 'stock-2', purchase_id: 'p-0', material_id: 'm-2', quantity: 10, unit_price: 50, organization_id: 'org-a' },
    { id: 'pl-old', purchase_id: 'p-1', material_id: 'm-1', quantity: 10, unit_price: 100, organization_id: 'org-a' },
  ];
});

describe('đường TẠO phiếu nhập vật tư (material-purchase, khoá create)', () => {
  // Đợt 9: trước đợt 9 test này tên «đường TẠO phiếu nhập vẫn giữ dấu (đợt 9): mất phản hồi thì lần tạo sau bị chặn, không
  // tạo phiếu thứ hai». Nay đường tạo không ghi dấu (mã do trình duyệt sinh); hàng rào «không tạo phiếu thứ hai» giữ nguyên.
  it('đường TẠO phiếu nhập (đợt 9) không ghi dấu: mất phản hồi thì lần tạo sau dùng đúng phiếu đó, không tạo phiếu thứ hai', async () => {
    io.server.failNext('material_purchases', 'insert', 'drop-after');
    io.server.failNext('material_purchases', 'read', 'drop-before');
    const lost = await createPurchase()(purchaseInput).catch(failure => failure);
    expectRepeatable(lost);
    expect(rows('material_purchases')).toHaveLength(2);
    await createPurchase()(purchaseInput);
    expect(rows('material_purchases')).toHaveLength(2);
    const sent = io.server.inserts.filter(item => item.table === 'material_purchases').map(item => (item.payload as Row).id);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect(purchaseLines(String(sent[0]))).toHaveLength(2);
    expect(pendingKeys()).toEqual([]);
  });
});

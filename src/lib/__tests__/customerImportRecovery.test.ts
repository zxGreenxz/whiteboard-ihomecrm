// @vitest-environment jsdom
// Đợt 4: nhập khách Excel không còn dấu chung cho cả lượt. Mỗi dòng mang một mã khách riêng; dòng chưa rõ kết quả
// được gửi lại đúng mã đó. Mọi dòng đều có kết quả báo theo dòng, không dòng nào khoá lượt nhập sau.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordServer, pendingKeys, seedLegacyPending, type FakeRecordServer } from '@/hooks/__tests__/fakeRecordServer';

const io = vi.hoisted(() => ({ server: undefined as unknown as FakeRecordServer }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => io.server.from(table) } }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor' }) }));

import { importCustomerBatch } from '../customerImportOutcome';
import { FinancialWorkflowError } from '../financialWorkflow';

type Row = { full_name: string; phone: string; client_id?: string; id_image_urls?: string[] };
type Report = { successRows: { id: string }[]; partialRows: unknown[]; unknownRows: { name: string; reason: string }[]; failRows: { name: string; reason: string }[]; skippedRows?: { name: string; id: string }[]; retryRows?: Row[] };

const rowsAB = (): Row[] => [{ full_name: 'Khách A', phone: '0900000021', client_id: 'id-a' }, { full_name: 'Khách B', phone: '0900000022', client_id: 'id-b' }];
const unknown = () => new FinancialWorkflowError('Chưa xác nhận được kết quả tạo khách hàng.', 'unknown', []);

async function runImport(rows: Row[], create: (row: Row) => Promise<unknown>) {
  const reports: Report[] = [];
  let thrown: unknown;
  try {
    await importCustomerBatch(rows as never, { create: create as never, uploadImages: vi.fn().mockResolvedValue({}) }, report => reports.push(report as Report));
  } catch (error) { thrown = error; }
  return { report: reports.at(-1), thrown };
}

beforeEach(() => {
  io.server = fakeRecordServer();
  localStorage.clear();
  localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a');
});

describe('nhập khách Excel', () => {
  it('dòng chưa rõ kết quả: không giữ dấu; nhập lại các dòng chưa xong dùng đúng mã của từng dòng', async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(unknown())
      .mockImplementation(async (row: Row) => ({ id: row.client_id }));
    const rows = rowsAB();
    const first = await runImport(rows, create);
    expect(first.report?.unknownRows.map(row => row.name)).toEqual(['Khách A', 'Khách B']);
    expect(pendingKeys()).toEqual([]);
    expect(first.report?.retryRows?.map(row => row.client_id)).toEqual(['id-a', 'id-b']);
    const second = await runImport(first.report?.retryRows ?? rows, create);
    expect(second.thrown).toBeUndefined();
    expect(second.report?.successRows.map(row => row.id)).toEqual(['id-a', 'id-b']);
    expect(create.mock.calls.map(([row]) => (row as Row).client_id)).toEqual(['id-a', 'id-a', 'id-b']);
    expect(pendingKeys()).toEqual([]);
  });

  // Review lượt 2 (N2): dòng chưa rõ thật ra đã ghi ⇒ lần nhập lại máy chủ báo trùng mã, đọc lại thấy khách (replayed).
  // Lần trước chưa tới bước ảnh, nên lần này phải tải ảnh và tính thành công, không xếp vào «bỏ qua».
  it('nhập lại dòng chưa rõ mà khách đã có: vẫn tải ảnh CCCD và tính thành công', async () => {
    io.server.rows.customers = [{ id: 'id-a', full_name: 'Khách A' }];
    const create = vi.fn()
      .mockRejectedValueOnce(unknown())
      .mockImplementation(async (row: Row) => ({ id: row.client_id, replayed: row.client_id === 'id-a' }));
    const uploadImages = vi.fn().mockResolvedValue({ front: 'stored/a-front.jpg' });
    const rows: Row[] = [{ full_name: 'Khách A', phone: '0900000021', client_id: 'id-a', id_image_urls: ['https://example.com/a.jpg'] }];
    const reports: Report[] = [];
    await importCustomerBatch(rows as never, { create: create as never, uploadImages }, report => reports.push(report as Report));
    expect(uploadImages).not.toHaveBeenCalled();
    await importCustomerBatch((reports.at(-1)?.retryRows ?? rows) as never, { create: create as never, uploadImages }, report => reports.push(report as Report));
    expect(uploadImages).toHaveBeenCalledTimes(1);
    expect(reports.at(-1)?.successRows.map(row => row.id)).toEqual(['id-a']);
    expect(reports.at(-1)?.skippedRows ?? []).toEqual([]);
    expect(io.server.rows.customers[0].id_images).toEqual({ front: 'stored/a-front.jpg' });
  });

  it('dòng chưa rõ mang mã đang chờ khác mã của dòng (khách cũ đã xoá, tạo lại bằng mã mới): nhập lại dùng đúng mã đang chờ', async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(new FinancialWorkflowError('Chưa xác nhận được kết quả tạo khách hàng.', 'unknown', [{ id: 'id-moi', label: 'Mã bản ghi đang chờ xác nhận' }]))
      .mockImplementation(async (row: Row) => ({ id: row.client_id }));
    const first = await runImport([{ full_name: 'Khách A', phone: '0900000021', client_id: 'id-cu' }], create);
    expect(first.report?.retryRows?.[0].client_id).toBe('id-moi');
    await runImport(first.report?.retryRows ?? [], create);
    expect(create.mock.calls[1][0]).toMatchObject({ client_id: 'id-moi' });
  });

  it('mọi dòng có kết quả rõ (kể cả ảnh chưa xong): không giữ dấu, lượt nhập sau không bị chặn', async () => {
    const create = vi.fn(async (row: Row) => ({ id: row.client_id }));
    const rows: Row[] = [{ full_name: 'Khách A', phone: '0900000021', client_id: 'id-a', id_image_urls: ['https://example.com/a.jpg'] }];
    const uploadImages = vi.fn().mockRejectedValue(new Error('ảnh lỗi'));
    const reports: Report[] = [];
    await importCustomerBatch(rows as never, { create: create as never, uploadImages }, report => reports.push(report as Report));
    expect(reports.at(-1)?.partialRows).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
    await importCustomerBatch([{ full_name: 'Khách C', phone: '0900000023', client_id: 'id-c' }] as never, { create: create as never, uploadImages }, report => reports.push(report as Report));
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('dòng bị máy chủ từ chối rõ: báo theo dòng, không dấu, các dòng sau vẫn gửi', async () => {
    const create = vi.fn()
      .mockRejectedValueOnce({ code: '23514', message: 'raw SQL' })
      .mockImplementation(async (row: Row) => ({ id: row.client_id }));
    const { report } = await runImport(rowsAB(), create);
    expect(report?.failRows.map(row => row.name)).toEqual(['Khách A']);
    expect(report?.successRows.map(row => row.id)).toEqual(['id-b']);
    expect(report?.retryRows ?? []).toEqual([]);
    expect(pendingKeys()).toEqual([]);
  });

  it('dấu khoá chung của lượt nhập bản trước: không chặn; dòng giống khách đã tạo ở lượt kẹt được bỏ qua kèm mã', async () => {
    const stuckAt = new Date(Date.now() - 30 * 60_000);
    io.server.rows.customers = [{ id: 'c-old', user_id: 'actor', organization_id: 'org-a', full_name: 'Khách A', phone: '0900000021', created_at: stuckAt.toISOString() }];
    const key = seedLegacyPending({ namespace: 'customer-import', userId: 'actor', organizationId: 'org-a', businessKey: 'batch' }, stuckAt, ['c-old']);
    const create = vi.fn(async (row: Row) => ({ id: row.client_id }));
    const { report, thrown } = await runImport(rowsAB(), create);
    expect(thrown).toBeUndefined();
    expect(create.mock.calls.map(([row]) => (row as Row).full_name)).toEqual(['Khách B']);
    expect(report?.skippedRows?.map(row => row.id)).toEqual(['c-old']);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('dòng mà khách mang mã của nó đã có (nhập lại cùng file): báo riêng «đã có từ lượt trước», không tính là tạo mới', async () => {
    const create = vi.fn(async (row: Row) => ({ id: row.client_id, replayed: row.client_id === 'id-a' }));
    const { report } = await runImport(rowsAB(), create);
    expect(report?.skippedRows?.map(row => row.id)).toEqual(['id-a']);
    expect(report?.successRows.map(row => row.id)).toEqual(['id-b']);
  });

  it('một dòng kẹt không chặn lượt nhập khác', async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(unknown())
      .mockImplementation(async (row: Row) => ({ id: row.client_id }));
    await runImport([{ full_name: 'Khách A', phone: '0900000021', client_id: 'id-a' }], create);
    const other = await runImport([{ full_name: 'Khách D', phone: '0900000024', client_id: 'id-d' }], create);
    expect(other.report?.successRows.map(row => row.id)).toEqual(['id-d']);
  });
});

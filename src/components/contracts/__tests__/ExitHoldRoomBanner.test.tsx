// @vitest-environment jsdom
// Băng báo phòng đang chờ khách sang nhượng (trả phòng trước hạn: nhờ sale / tự tìm) ở form hợp đồng và hộp cọc.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useForm } from 'react-hook-form';
import { Form } from '@/components/ui/form';
import { earlyTermsSchema } from '@/lib/contractExitEarlyTerms';
import type { ContractFormData } from '@/lib/contractValidation';
import type { ContractFormState } from '../contract-form/useContractFormState';
import { EXIT_FIXTURE_IDS, exitTermsRow } from './exitEarlyTermsFixture';

const h = vi.hoisted(() => ({
  result: {} as { data?: unknown; isError?: boolean; error?: unknown; refetch?: () => unknown },
  calls: [] as [unknown, boolean | undefined][],
}));
vi.mock('@/hooks/contracts/useContractExitEarlyTerms', () => ({
  useContractExitEarlyTerms: (filter: unknown, enabled?: boolean) => { h.calls.push([filter, enabled]); return h.result; },
}));

import { ExitHoldRoomBanner } from '../ExitHoldRoomBanner';
import { GeneralSection } from '../contract-form/GeneralSection';

const roomId = EXIT_FIXTURE_IDS.room;
const ok = (rows: unknown[]) => ({ data: rows, isError: false, error: null, refetch: vi.fn() });

beforeEach(() => { h.calls = []; h.result = ok([]); });
afterEach(cleanup);

it('fixture khớp schema đọc của máy chủ', () => {
  expect(earlyTermsSchema.parse(exitTermsRow())).toBeTruthy();
});

it('ca nhờ sale ở form hợp đồng: ngày, khách cũ, HĐ, trường hợp, sale và đường hoa hồng', () => {
  h.result = ok([exitTermsRow()]);
  render(<ExitHoldRoomBanner variant="contract" roomId={roomId} startDate="2026-12-01" />);
  const banner = screen.getByRole('status', { name: 'Phòng đang chờ khách sang nhượng' });
  expect(banner.textContent).toContain('Phòng đang chờ khách sang nhượng từ 01/12/2026 (khách cũ Nguyễn Văn A, HD-0101, Nhờ sale tìm khách sang phòng — sale Minh).');
  expect(banner.textContent).toContain('Hợp đồng này sẽ tự nối với hồ sơ cũ.');
  expect(banner.textContent).toContain('Hoa hồng môi giới cho sale lập sau khi quyết toán khách cũ.');
  expect(h.calls.at(-1)).toEqual([{ roomId }, true]);
});

it('ca tự tìm ở form hợp đồng: không ghi tên sale, báo không có hoa hồng hay thưởng sale', () => {
  h.result = ok([exitTermsRow({ early_reason: 'SELF_FOUND', sale_name: 'Không hiện' })]);
  render(<ExitHoldRoomBanner variant="contract" roomId={roomId} />);
  const text = screen.getByRole('status').textContent ?? '';
  expect(text).toContain('(khách cũ Nguyễn Văn A, HD-0101, Tự tìm khách sang phòng).');
  expect(text).not.toContain('Không hiện');
  expect(text).toContain('Hợp đồng nối với ca khách tự tìm: không có hoa hồng môi giới hay thưởng sale.');
  expect(text).not.toContain('Hoa hồng môi giới cho sale');
});

it('hộp cọc: khách cọc là khách nhận, hợp đồng tạo sau sẽ tự nối', () => {
  h.result = ok([exitTermsRow()]);
  render(<ExitHoldRoomBanner variant="deposit" roomId={roomId} />);
  const text = screen.getByRole('status').textContent ?? '';
  expect(text).toContain('Phòng đang chờ khách sang nhượng từ 01/12/2026');
  expect(text).toContain('Khách cọc phòng này là khách nhận; hợp đồng tạo sau sẽ tự nối với hồ sơ cũ.');
  expect(text).not.toContain('Hợp đồng này sẽ tự nối');
});

it('ngày bắt đầu trước ngày trả phòng: không hứa tự nối', () => {
  h.result = ok([exitTermsRow()]);
  render(<ExitHoldRoomBanner variant="contract" roomId={roomId} startDate="2026-11-30" />);
  const text = screen.getByRole('status').textContent ?? '';
  expect(text).toContain('Ngày bắt đầu đang trước 01/12/2026: hợp đồng chỉ tự nối với hồ sơ cũ khi bắt đầu từ ngày này.');
  expect(text).not.toContain('Hợp đồng này sẽ tự nối');
});

it('đang đọc: không vẽ gì, không có chữ Đang tải', () => {
  h.result = { data: undefined, isError: false, error: null, refetch: vi.fn() };
  const { container } = render(<ExitHoldRoomBanner variant="contract" roomId={roomId} />);
  expect(container.textContent).toBe('');
});

it('không có quyền đọc hồ sơ trả phòng (42501): không vẽ băng', () => {
  h.result = { data: undefined, isError: true, error: { code: '42501', message: 'Không có quyền đọc hồ sơ trả phòng' }, refetch: vi.fn() };
  const { container } = render(<ExitHoldRoomBanner variant="deposit" roomId={roomId} />);
  expect(container.textContent).toBe('');
});

it('lỗi khác: một dòng nhỏ kèm Thử lại', () => {
  const refetch = vi.fn();
  h.result = { data: undefined, isError: true, error: new TypeError('Failed to fetch'), refetch };
  render(<ExitHoldRoomBanner variant="contract" roomId={roomId} />);
  expect(screen.getByRole('status').textContent).toContain('Chưa kiểm được phòng có đang chờ khách sang nhượng không.');
  fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
  expect(refetch).toHaveBeenCalledOnce();
});

it.each([
  ['không có hồ sơ', []],
  ['hồ sơ đã nối', [exitTermsRow({ pending_link: false, new_contract_id: EXIT_FIXTURE_IDS.newContract })]],
  ['chủ nhà hỗ trợ thanh lý sớm', [exitTermsRow({ early_reason: 'LANDLORD_AGREEMENT' })]],
])('%s: không vẽ băng', (_name, rows) => {
  h.result = ok(rows);
  const { container } = render(<ExitHoldRoomBanner variant="contract" roomId={roomId} />);
  expect(container.textContent).toBe('');
});

it('chưa chọn phòng hoặc hộp đang đóng: không đọc', () => {
  const { container, rerender } = render(<ExitHoldRoomBanner variant="deposit" roomId="" />);
  expect(h.calls.at(-1)).toEqual([null, false]);
  rerender(<ExitHoldRoomBanner variant="deposit" roomId={roomId} enabled={false} />);
  expect(h.calls.at(-1)).toEqual([{ roomId }, false]);
  expect(container.textContent).toBe('');
});

function GeneralHarness({ exitHoldNotice }: { exitHoldNotice: boolean }) {
  const form = useForm<ContractFormData>({ defaultValues: { room_id: roomId, start_date: '2026-12-01' } });
  return <Form {...form}><GeneralSection form={form} buildings={[]} selectedBuildingId={EXIT_FIXTURE_IDS.building}
    filteredRooms={[{ id: roomId, name: 'P101', status: 'AVAILABLE' }] as ContractFormState['filteredRooms']}
    handleBuildingChange={vi.fn()} handleRoomChange={vi.fn()} exitHoldNotice={exitHoldNotice} /></Form>;
}

it('form hợp đồng mới đọc theo phòng đang chọn; form sửa hợp đồng không đọc', () => {
  h.result = ok([exitTermsRow()]);
  render(<GeneralHarness exitHoldNotice />);
  expect(screen.getByRole('status', { name: 'Phòng đang chờ khách sang nhượng' }).textContent).toContain('Hợp đồng này sẽ tự nối với hồ sơ cũ.');
  expect(h.calls.at(-1)).toEqual([{ roomId }, true]);
  cleanup(); h.calls = [];
  render(<GeneralHarness exitHoldNotice={false} />);
  expect(screen.queryByRole('status', { name: 'Phòng đang chờ khách sang nhượng' })).toBeNull();
  expect(h.calls).toEqual([]);
});

// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminationRefundNote } from '../TerminationRefundNote';
import { parseTerminationRefundFacts } from '@/lib/terminationRefundNote';

const state = vi.hoisted(() => ({ data: null as unknown, isLoading: false, isError: false }));
vi.mock('@/hooks/useTerminationRefundFacts', () => ({ useTerminationRefundFacts: () => state }));
const voucher = { id: 'refund', system_source: 'termination.refund', contract_id: 'contract' };
const note = 'Khách chuyển công tác.\nBàn giao đủ chìa khóa.';
const original = 'Ghi chú gốc của phiếu vẫn còn.';
const facts = (returnNote: unknown = null) => parseTerminationRefundFacts({
  voucher: { id: 'refund', notes: original }, return_note: returnNote as string | null,
});

beforeEach(() => { state.data = facts(); state.isLoading = false; state.isError = false; });
afterEach(cleanup);

describe('nội dung thanh lý của phiếu trả khách', () => {
  it('hiện nội dung lưu trong facts cùng ghi chú cũ, giữ xuống dòng', () => {
    state.data = facts(note);
    render(<TerminationRefundNote voucher={voucher} fallbackNotes={original} />);
    const saved = within(screen.getByRole('region', { name: 'Nội dung thanh lý' })).getByText(/Khách chuyển công tác/);
    expect(saved.textContent).toBe(note);
    expect(saved.className).toContain('whitespace-pre-wrap');
    expect(screen.getByText(original)).toBeTruthy();
    expect(screen.getByTestId('termination-refund-note').textContent).toContain('QUYẾT TOÁN THANH LÝ');
  });

  it('không suy diễn nội dung hồ sơ cũ từ ghi chú của phiếu', () => {
    render(<TerminationRefundNote voucher={voucher} fallbackNotes={original} />);
    const section = within(screen.getByRole('region', { name: 'Nội dung thanh lý' }));
    expect(section.getByText('Chưa có nội dung thanh lý')).toBeTruthy();
    expect(section.queryByText(original)).toBeNull();
    expect(screen.getByText(original)).toBeTruthy();
  });

  it.each(['isLoading', 'isError'] as const)('không báo thiếu nội dung khi facts %s', key => {
    state.data = null;
    state[key] = true;
    render(<TerminationRefundNote voucher={voucher} />);
    expect(screen.queryByRole('region', { name: 'Nội dung thanh lý' })).toBeNull();
  });

  it('không thêm nội dung thanh lý vào phiếu chi thông thường', () => {
    state.data = facts(note);
    render(<TerminationRefundNote voucher={{ ...voucher, system_source: null }} fallbackNotes={original} />);
    expect(screen.queryByRole('region', { name: 'Nội dung thanh lý' })).toBeNull();
    expect(screen.getByText(original)).toBeTruthy();
  });
});

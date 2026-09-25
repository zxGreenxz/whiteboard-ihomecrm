// @vitest-environment jsdom
// Sổ nhận theo hình thức trong form thu tiền (đợt 1 sửa phiếu, 25/09/2026):
// TM = sổ tiền mặt riêng (hiện, không chọn); TK/TT = chọn trong danh sách của
// toà; hình thức chưa có sổ ⇒ câu hướng dẫn + KHÔNG cho thu.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollectPayForm, type PayFormState } from '../CollectPayForm';
import type { CollectMethod } from '@/lib/collectPlan';

afterEach(cleanup);

const BOOKS = {
  TM: [{ id: 'hiep-thu', name: 'Hiệp Thu' }],
  TK: [
    { id: 'mbhiep', name: 'MBHIEP', isDefault: true },
    { id: 'tkhiep', name: 'TKHIEP' },
  ],
  TT: [],
};
const thieu = (m: CollectMethod) => `THIẾU SỔ ${m}`;

const lastState = (spy: ReturnType<typeof vi.fn>) => spy.mock.lastCall?.[0] as PayFormState;

describe('CollectPayForm — sổ nhận theo hình thức', () => {
  it('dòng tiền mặt đi vào sổ tiền mặt riêng, ô sổ bị khoá', async () => {
    const onChange = vi.fn();
    render(<CollectPayForm remaining={1_000_000} books={BOOKS} missingBookMessage={thieu} canCredit onChange={onChange} />);
    const book = screen.getByRole('combobox', { name: 'Sổ nhận TM' }) as HTMLSelectElement;
    expect(book.disabled).toBe(true);
    expect(book.value).toBe('hiep-thu');
    await waitFor(() => expect(lastState(onChange).payload?.lines).toEqual([
      { method: 'TM', amount: 1_000_000, accountId: 'hiep-thu' },
    ]));
  });

  it('chuyển khoản: mặc định sổ đầu danh sách, chọn được sổ phụ', async () => {
    const onChange = vi.fn();
    render(<CollectPayForm remaining={1_000_000} books={BOOKS} missingBookMessage={thieu} canCredit onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Hình thức dòng 1' }), { target: { value: 'TK' } });
    const book = screen.getByRole('combobox', { name: 'Sổ nhận TK' }) as HTMLSelectElement;
    expect(book.disabled).toBe(false);
    expect(book.value).toBe('mbhiep');
    fireEvent.change(book, { target: { value: 'tkhiep' } });
    await waitFor(() => expect(lastState(onChange).payload?.lines).toEqual([
      { method: 'TK', amount: 1_000_000, accountId: 'tkhiep' },
    ]));
  });

  it('hình thức chưa có sổ: hiện câu hướng dẫn và chặn nút thu', async () => {
    const onChange = vi.fn();
    render(<CollectPayForm remaining={1_000_000} books={BOOKS} missingBookMessage={thieu} canCredit onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Hình thức dòng 1' }), { target: { value: 'TT' } });
    expect(screen.getByRole('alert').textContent).toBe('THIẾU SỔ TT');
    await waitFor(() => expect(lastState(onChange).canSubmit).toBe(false));
    expect(lastState(onChange).payload).toBeNull();
  });

  it('người thu chưa có sổ tiền mặt riêng: dòng đầu vẫn là TM và bị chặn (không tự nhảy sang TK)', async () => {
    const onChange = vi.fn();
    render(
      <CollectPayForm
        remaining={500_000}
        books={{ ...BOOKS, TM: [] }}
        missingBookMessage={thieu}
        canCredit
        onChange={onChange}
      />,
    );
    expect((screen.getByRole('combobox', { name: 'Hình thức dòng 1' }) as HTMLSelectElement).value).toBe('TM');
    expect(screen.queryByRole('combobox', { name: 'Sổ nhận TM' })).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('THIẾU SỔ TM');
    await waitFor(() => expect(lastState(onChange).canSubmit).toBe(false));
  });

  it('thêm dòng ưu tiên hình thức đã có sổ', async () => {
    const onChange = vi.fn();
    render(<CollectPayForm remaining={1_000_000} books={BOOKS} missingBookMessage={thieu} canCredit onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Thêm phương thức/ }));
    expect((screen.getByRole('combobox', { name: 'Hình thức dòng 2' }) as HTMLSelectElement).value).toBe('TK');
    expect((screen.getByRole('combobox', { name: 'Sổ nhận TK' }) as HTMLSelectElement).value).toBe('mbhiep');
  });
});

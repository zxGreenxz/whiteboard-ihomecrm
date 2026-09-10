// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import IncomeExpensePrintPage from '@/pages/payments/IncomeExpensePrintPage';

const state = vi.hoisted(() => ({ voucher: { id: 'voucher', code: 'PT-DEMO', type: 'INCOME', total_amount: 100,
  voucher_date: null, created_at: null, notes: 'Gốc', attachments: ['old.png'], items: [],
  supplements: [{ id: 'supp', note: 'Bổ sung', actor_name: 'Admin DEMO', created_at: '2026-09-10T05:00:00Z', attachments: ['new.png'] }] } }));
vi.mock('react-router-dom', () => ({ useParams: () => ({ id: 'voucher' }) }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: state.voucher, isLoading: false }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/hooks/income-expenses/supplements', () => ({ hydrateIncomeExpenseSupplements: vi.fn() }));
vi.mock('@/components/ui/storage-image', () => ({ StorageImage: ({ value, ...props }: { value: string }) => <img src={value} {...props} /> }));
vi.mock('@/components/income-expenses/VoucherNote', () => ({ coGhiChuHeThong: () => true, VoucherNote: () => <div>Gốc / Bổ sung / Admin DEMO</div> }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('waits for original and supplemental private photos before printing and does not reprint on refresh', async () => {
  vi.useFakeTimers();
  const print = vi.spyOn(window, 'print').mockImplementation(() => {});
  const view = render(<IncomeExpensePrintPage />);
  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(print).not.toHaveBeenCalled();
  const images = screen.getAllByRole('img');
  expect(images).toHaveLength(2);
  expect(images.every(img => img.getAttribute('loading') === 'eager')).toBe(true);
  fireEvent.load(images[0]);
  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(print).not.toHaveBeenCalled();
  fireEvent.load(images[1]);
  await act(async () => { vi.advanceTimersByTime(500); });
  expect(print).toHaveBeenCalledTimes(1);
  state.voucher = { ...state.voucher };
  view.rerender(<IncomeExpensePrintPage />);
  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(print).toHaveBeenCalledTimes(1);
});

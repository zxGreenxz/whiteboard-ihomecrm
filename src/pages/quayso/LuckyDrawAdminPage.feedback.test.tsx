// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/components/layout/MainLayout', () => ({ default: () => null }));
import { EventForm, RoundsCard } from './LuckyDrawAdminPage';
import type { LuckyEventAdmin } from '@/lib/luckyDrawApi';
const event = { id: 'e', title: 'Sự kiện A', slug: 'a', prizeLabel: 'Quà', prizeAmount: 10, drawAt: null, game: 'wheel', rounds: [{ amount: 20, winnersCount: 1, status: 'pending' }] } as unknown as LuckyEventAdmin;
beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(cleanup);
describe('lucky admin field feedback', () => {
  it('focuses missing title and never sends a blank event', async () => {
    const save = vi.fn();
    render(<EventForm event={event} saving={false} onSave={save} />);
    const title = screen.getByLabelText('Tiêu đề');
    fireEvent.change(title, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    await waitFor(() => expect(document.activeElement).toBe(title));
    expect(title.getAttribute('aria-invalid')).toBe('true');
    expect(save).not.toHaveBeenCalled();
  });
  it('keeps the edited event and inline safe error after rejection', async () => {
    const save = vi.fn().mockRejectedValue(new Error('SQL secret'));
    render(<EventForm event={event} saving={false} onSave={save} />);
    fireEvent.change(screen.getByLabelText('Tiêu đề'), { target: { value: 'Sự kiện B' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Sự kiện B');
    expect(screen.getByRole('alert').textContent).not.toContain('SQL');
    expect((screen.getByLabelText('Tiêu đề') as HTMLInputElement).value).toBe('Sự kiện B');
  });
  it('marks invalid round count and focuses that row', async () => {
    const save = vi.fn();
    render(<RoundsCard event={event} saving={false} onSave={save} />);
    const input = screen.getByLabelText('Số suất');
    fireEvent.change(input, { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: /Lưu thể lệ/ }));
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(save).not.toHaveBeenCalled();
  });
});

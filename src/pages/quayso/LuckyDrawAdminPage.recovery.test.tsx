// @vitest-environment jsdom
// Đợt 9: trang quản trị Quay số với API thật trên máy chủ giả. Điểm danh / sửa đội chưa rõ kết quả không còn khoá nút quay;
// dấu chung bản trước không bật cảnh báo; quay chưa rõ thì cảnh báo hiện và «Tải lại trạng thái» luôn kết luận được.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import * as ReactQuery from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedLegacyPending, pendingKeys } from '@/hooks/__tests__/fakeRecordServer';
import { luckyWorld, TEN_MINUTES_AGO, type LuckyWorld } from '@/lib/__tests__/helpers/luckyFakeServer';

const h = vi.hoisted(() => ({ world: null as unknown as LuckyWorld }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (name: string, args?: Record<string, unknown>) => h.world.server.rpc(name, args ?? {}) },
}));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor-1' }) }));
vi.mock('@/components/layout/MainLayout', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));

let world: LuckyWorld;
beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); window.confirm = () => true; });
beforeEach(() => { localStorage.clear(); world = luckyWorld(); h.world = world; });
afterEach(() => { cleanup(); });

async function mount() {
  vi.resetModules();
  const { default: Page } = await import('./LuckyDrawAdminPage');
  const queries = new ReactQuery.QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<ReactQuery.QueryClientProvider client={queries}><MemoryRouter><Page /></MemoryRouter></ReactQuery.QueryClientProvider>);
  await screen.findByRole('button', { name: '▶ Mở lượt 1' });
  return view;
}
function roundsEvent() {
  const event = world.addEvent({ slug: 'tiec' });
  world.addTeam(event, { name: 'Đội A' }); world.addTeam(event, { name: 'Đội B', checkedInAt: null });
  world.addRounds(event, { amount: 100, winnersCount: 1 }, { amount: 200, winnersCount: 1 });
  return event;
}
const openRound = () => screen.getByRole('button', { name: '▶ Mở lượt 1' }) as HTMLButtonElement;

describe('trang quản trị Quay số sau kết quả chưa rõ', () => {
  it('điểm danh chưa rõ kết quả không khoá nút mở lượt, kể cả sau khi tải lại trang', async () => {
    const event = roundsEvent();
    world.server.failNext('lucky_admin_update_team_v1', 'rpc', 'drop-after');
    const first = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Chưa' }));
    await waitFor(() => expect(world.calls('lucky_admin_update_team_v1')).toBe(1));
    await waitFor(() => expect(openRound().disabled).toBe(false));
    expect(pendingKeys()).toEqual([]);
    first.unmount();
    await mount();
    expect(screen.queryByRole('button', { name: 'Tải lại trạng thái' })).toBeNull();
    fireEvent.click(openRound());
    await waitFor(() => expect(event.rounds[0]!.status).toBe('drawn'));
    expect(world.realDraws).toBe(1);
  });

  it('dấu chung bản trước gieo sẵn: không hiện cảnh báo, nút quay bật, quay được đúng một lần', async () => {
    const event = roundsEvent();
    seedLegacyPending({ namespace: 'lucky-admin', userId: 'actor-1', organizationId: 'actor-scope', businessKey: event.id }, TEN_MINUTES_AGO());
    await mount();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.queryByRole('button', { name: 'Tải lại trạng thái' })).toBeNull();
    expect(openRound().disabled).toBe(false);
    fireEvent.click(openRound());
    await waitFor(() => expect(event.rounds[0]!.status).toBe('drawn'));
    expect(world.realDraws).toBe(1);
    await waitFor(() => expect(pendingKeys()).toEqual([]));
  });

  it('quay không tới máy chủ: cảnh báo hiện; «Tải lại trạng thái» kết luận được, mở lại nút và bấm lại quay đúng một lần', async () => {
    const event = roundsEvent();
    world.server.failNext('lucky_draw_round_v1', 'rpc', 'drop-before');
    await mount();
    fireEvent.click(openRound());
    const reload = await screen.findByRole('button', { name: 'Tải lại trạng thái' });
    expect(openRound().disabled).toBe(true);
    fireEvent.click(reload);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Tải lại trạng thái' })).toBeNull());
    expect(pendingKeys()).toEqual([]);
    await waitFor(() => expect(openRound().disabled).toBe(false));
    fireEvent.click(openRound());
    await waitFor(() => expect(event.rounds[0]!.status).toBe('drawn'));
    expect(world.realDraws).toBe(1);
  });

  it('quay mất phản hồi: «Tải lại trạng thái» nhận kết quả đã quay, không gửi lệnh quay thứ hai', async () => {
    const event = roundsEvent();
    world.server.failNext('lucky_draw_round_v1', 'rpc', 'drop-after');
    await mount();
    fireEvent.click(openRound());
    fireEvent.click(await screen.findByRole('button', { name: 'Tải lại trạng thái' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Tải lại trạng thái' })).toBeNull());
    await screen.findByText('✓ Đã quay');
    expect(event.rounds[0]!.status).toBe('drawn');
    expect(world.calls('lucky_draw_round_v1')).toBe(1);
    expect(world.realDraws).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });
});

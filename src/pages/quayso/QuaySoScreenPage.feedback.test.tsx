// @vitest-environment jsdom
// Màn chiếu quay số (RT-CLIENT-2, 22/10/2026): bấm "Quay lại" khi cache đang
// 'drawn' phải HỎI SERVER trước. Quản trị đã "Huỷ kết quả và mở lại" thì không
// được diễn lại người trúng cũ.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LuckyPublicState } from '@/lib/luckyDrawApi';

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  draw: vi.fn(),
  spinTokens: [] as Array<string | null>,
}));

vi.mock('@/lib/luckyDrawApi', () => ({
  fetchLuckyPublicState: h.fetch,
  luckyDraw: h.draw,
  formatVnd: (n: number) => `${n} đ`,
  luckyGameOf: () => 'wheel',
  totalRoundsPrize: () => 0,
}));
vi.mock('./LuckyWheelCanvas', () => ({
  default: (props: { spinToken: string | null }) => {
    h.spinTokens.push(props.spinToken);
    return null;
  },
  fireConfetti: vi.fn(),
}));
vi.mock('./AnimalRaceTrack', () => ({ default: () => null }));
vi.mock('./MultiRoundStage', () => ({ default: () => null }));

import QuaySoScreenPage from './QuaySoScreenPage';

const team = { id: 't1', name: 'Vé A', inWheel: true, checkedIn: true };
const state = (status: 'open' | 'drawn', drawnAt: string | null): LuckyPublicState =>
  ({
    ok: true,
    event: {
      id: 'e1', slug: 'tiec', title: 'Tiệc cuối năm', prizeLabel: 'Giải nhất', prizeAmount: 1000,
      drawAt: null, status, drawnAt, winnerTeamId: drawnAt ? 't1' : null, game: 'wheel', raceSeconds: null,
      serverNow: '2026-10-21T08:00:00Z',
    },
    teams: [team],
    rounds: [],
  }) as unknown as LuckyPublicState;

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/quayso/tiec/quay']}>
        <Routes>
          <Route path="/quayso/:slug/quay" element={<QuaySoScreenPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.spinTokens.length = 0;
});

describe('QuaySoScreenPage — nút Quay lại hỏi server trước khi diễn lại (RT-CLIENT-2)', () => {
  it('server đã đặt lại (open): KHÔNG diễn lại người trúng cũ, màn chuyển về nút Quay số', async () => {
    h.fetch.mockResolvedValueOnce(state('drawn', '2026-10-21T07:59:00Z'));
    renderScreen();
    const quayLai = await screen.findByRole('button', { name: '▶ Quay lại' });

    h.fetch.mockResolvedValueOnce(state('open', null));
    fireEvent.click(quayLai);

    await screen.findByRole('button', { name: '▶ Quay số' });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.spinTokens.every((token) => token === null)).toBe(true);
    expect(screen.getByRole('status').textContent).toMatch(/Kết quả trên máy chủ đã thay đổi/);
    expect(h.draw).not.toHaveBeenCalled();
  });

  it('server quay lại với drawnAt KHÁC: không diễn lại cache cũ ngay trong lượt bấm', async () => {
    h.fetch.mockResolvedValueOnce(state('drawn', '2026-10-21T07:59:00Z'));
    renderScreen();
    const quayLai = await screen.findByRole('button', { name: '▶ Quay lại' });

    h.fetch.mockResolvedValueOnce(state('drawn', '2026-10-21T08:05:00Z'));
    fireEvent.click(quayLai);

    await screen.findByText(/Kết quả trên máy chủ đã thay đổi/);
    expect(h.spinTokens.every((token) => token === null)).toBe(true);
  });

  it('server vẫn đúng kết quả đang hiện: diễn lại (spinToken theo drawnAt đã kiểm)', async () => {
    h.fetch.mockResolvedValueOnce(state('drawn', '2026-10-21T07:59:00Z'));
    renderScreen();
    const quayLai = await screen.findByRole('button', { name: '▶ Quay lại' });

    h.fetch.mockResolvedValueOnce(state('drawn', '2026-10-21T07:59:00Z'));
    fireEvent.click(quayLai);

    await waitFor(() => expect(h.spinTokens.at(-1)).toBe('2026-10-21T07:59:00Z#1'));
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it('không hỏi được server: không diễn lại cache, báo lỗi để tải lại', async () => {
    h.fetch.mockResolvedValueOnce(state('drawn', '2026-10-21T07:59:00Z'));
    renderScreen();
    const quayLai = await screen.findByRole('button', { name: '▶ Quay lại' });

    h.fetch.mockRejectedValueOnce(new Error('Failed to fetch'));
    fireEvent.click(quayLai);

    await waitFor(() =>
      expect(screen.getAllByRole('alert').some((el) => /Chưa kiểm tra được kết quả mới nhất/.test(el.textContent ?? ''))).toBe(true),
    );
    expect(h.spinTokens.every((token) => token === null)).toBe(true);
  });
});

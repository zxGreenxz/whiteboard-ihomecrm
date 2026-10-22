// @vitest-environment jsdom
// Dải "Mất kết nối cập nhật tự động" (A6, 21/10/2026): phản hồi phải TRUNG THỰC
// — không hiện vì một lần chập 2 giây, tự hiện khi gián đoạn đủ 10 s mà không cần
// event nào khác, tự ẩn khi nối lại, và nút "Tải lại dữ liệu" không hứa "đã cập
// nhật" (nó chỉ gửi lượt làm tươi; kết quả hiện ở từng màn).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RealtimeSyncBanner, { KHOA_NUT_SAU_BAM_MS, NGUONG_HIEN_DAI_MS } from './RealtimeSyncBanner';
import {
  __resetChannelHealthForTest,
  forgetChannel,
  onResyncAll,
  reportChannelState,
} from '@/lib/realtime/channelHealth';

const NOI_DUNG = /Mất kết nối cập nhật tự động — đang nối lại…/;

describe('RealtimeSyncBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T08:00:00Z'));
    __resetChannelHealthForTest();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('kết nối bình thường hoặc mới rớt dưới 10 s: không hiện gì', () => {
    reportChannelState('hub', 'connected');
    render(<RealtimeSyncBanner />);
    expect(screen.queryByRole('status')).toBeNull();

    act(() => reportChannelState('hub', 'interrupted'));
    act(() => { vi.advanceTimersByTime(NGUONG_HIEN_DAI_MS - 1); });
    expect(screen.queryByText(NOI_DUNG)).toBeNull();
  });

  it('gián đoạn đủ 10 s thì TỰ hiện (timer), có role=status và nút tải lại', () => {
    render(<RealtimeSyncBanner />);
    act(() => reportChannelState('hub', 'interrupted'));
    act(() => { vi.advanceTimersByTime(NGUONG_HIEN_DAI_MS); });

    const banner = screen.getByRole('status');
    expect(banner.textContent).toMatch(NOI_DUNG);
    expect(screen.getByRole('button', { name: 'Tải lại dữ liệu' })).toBeTruthy();
  });

  it('dải NỔI (fixed), không chiếm luồng layout — không đẩy khối fullBleed khỏi viewport (RT-CLIENT-8)', () => {
    const { container } = render(
      <div>
        <RealtimeSyncBanner />
        <div data-testid="full-bleed" className="h-[calc(100vh-4rem)] lg:h-screen" />
      </div>,
    );
    act(() => reportChannelState('hub', 'interrupted'));
    act(() => { vi.advanceTimersByTime(NGUONG_HIEN_DAI_MS); });

    const lop = screen.getByTestId('realtime-sync-banner');
    const classes = lop.className.split(/\s+/);
    // Lớp ngoài: fixed ở trên, trên header (z-50)/sidebar (z-40), không bắt con trỏ.
    expect(classes).toEqual(expect.arrayContaining(['fixed', 'inset-x-0', 'z-[60]', 'pointer-events-none']));
    // Mobile nằm dưới header 4rem, desktop sát mép trên; cả hai cộng safe-area.
    expect(classes).toContain('top-[calc(env(safe-area-inset-top)+4.5rem)]');
    expect(classes).toContain('lg:top-[calc(env(safe-area-inset-top)+0.75rem)]');
    // Viên bên trong nhận bấm; gọn ở 375 px (rộng theo khung, có lề 16 px của lớp ngoài).
    const vien = screen.getByRole('status');
    expect(vien.className.split(/\s+/)).toEqual(expect.arrayContaining(['pointer-events-auto', 'w-full', 'max-w-xl']));
    expect(classes).toContain('px-4');
    // Khối nội dung vẫn là anh em đứng ngay sau, không bị bọc hay đổi chiều cao.
    expect(lop.nextElementSibling).toBe(container.querySelector('[data-testid="full-bleed"]'));
  });

  it('mount khi gián đoạn đã kéo dài quá ngưỡng: hiện ngay nhịp kế tiếp', () => {
    reportChannelState('notif', 'interrupted', Date.now() - 60_000);
    render(<RealtimeSyncBanner />);
    act(() => { vi.advanceTimersByTime(0); });
    expect(screen.getByText(NOI_DUNG)).toBeTruthy();
  });

  it('kênh nối lại (hoặc được dọn) thì dải tự ẩn', () => {
    render(<RealtimeSyncBanner />);
    act(() => reportChannelState('hub', 'interrupted'));
    act(() => { vi.advanceTimersByTime(NGUONG_HIEN_DAI_MS); });
    expect(screen.getByText(NOI_DUNG)).toBeTruthy();

    act(() => reportChannelState('hub', 'connected'));
    expect(screen.queryByText(NOI_DUNG)).toBeNull();

    act(() => reportChannelState('zalo-msg', 'interrupted'));
    act(() => { vi.advanceTimersByTime(NGUONG_HIEN_DAI_MS); });
    expect(screen.getByText(NOI_DUNG)).toBeTruthy();
    act(() => forgetChannel('zalo-msg'));
    expect(screen.queryByText(NOI_DUNG)).toBeNull();
  });

  it('lần gián đoạn MỚI phải đợi đủ 10 s của riêng nó', () => {
    render(<RealtimeSyncBanner />);
    act(() => reportChannelState('hub', 'interrupted'));
    act(() => { vi.advanceTimersByTime(NGUONG_HIEN_DAI_MS); });
    act(() => reportChannelState('hub', 'connected'));
    act(() => reportChannelState('hub', 'interrupted'));
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(screen.queryByText(NOI_DUNG)).toBeNull();
  });

  it('bấm "Tải lại dữ liệu": gọi bắt kịp mọi kênh một lần, khoá nút và không báo "đã cập nhật"', () => {
    const resync = vi.fn();
    const stop = onResyncAll(resync);
    render(<RealtimeSyncBanner />);
    act(() => reportChannelState('hub', 'interrupted'));
    act(() => { vi.advanceTimersByTime(NGUONG_HIEN_DAI_MS); });

    fireEvent.click(screen.getByRole('button', { name: 'Tải lại dữ liệu' }));
    expect(resync).toHaveBeenCalledTimes(1);
    const dang = screen.getByRole('button', { name: 'Đang tải lại…' }) as HTMLButtonElement;
    expect(dang.disabled).toBe(true);
    expect(screen.getByRole('status').textContent).not.toMatch(/đã cập nhật|thành công/i);

    act(() => { vi.advanceTimersByTime(KHOA_NUT_SAU_BAM_MS); });
    expect((screen.getByRole('button', { name: 'Tải lại dữ liệu' }) as HTMLButtonElement).disabled).toBe(false);
    stop();
  });
});

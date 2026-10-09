// @vitest-environment jsdom
// Băng cảnh báo kết nối và thẻ link trên trang Chat Zalo (10/2026).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import ZaloWorkerBanner from '../ZaloWorkerBanner';
import ZaloCardView from '../ZaloCardView';
import type { ZaloAccount } from '../types';

afterEach(cleanup);

const acc = (id: string, status: ZaloAccount['status']): ZaloAccount => ({ id, name: `Nick ${id}`, kind: 'personal', status });

describe('ZaloWorkerBanner', () => {
  it('worker im lặng: báo mất kết nối, tin mới chưa về CRM', () => {
    render(<ZaloWorkerBanner status={{ online: false, heartbeatAt: '2026-09-05T07:56:26Z' }} accounts={[acc('a', 'connected')]} onReconnect={() => {}} />);
    expect(screen.getByRole('alert').textContent).toMatch(/Zalo đang mất kết nối từ \d{2}:\d{2} \d{2}\/\d{2}\./);
    expect(screen.getByRole('alert').textContent).toContain('Tin mới chưa về CRM');
  });

  it('phiên lỗi: nút Kết nối lại gọi đúng tài khoản', () => {
    const onReconnect = vi.fn();
    render(<ZaloWorkerBanner status={{ online: true, heartbeatAt: '2026-10-10T01:00:00Z' }} accounts={[acc('a', 'connected'), acc('b', 'error')]} onReconnect={onReconnect} />);
    expect(screen.getByRole('alert').textContent).toContain('Phiên Zalo của Nick b cần quét QR lại');
    fireEvent.click(screen.getByRole('button', { name: /Kết nối lại/ }));
    expect(onReconnect).toHaveBeenCalledWith('b');
  });

  it('bình thường thì không vẽ gì', () => {
    const { container } = render(<ZaloWorkerBanner status={{ online: true, heartbeatAt: '2026-10-10T01:00:00Z' }} accounts={[acc('a', 'connected')]} onReconnect={() => {}} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('ZaloCardView', () => {
  it('thẻ link: tiêu đề, mô tả, tên trang, mở tab mới an toàn', () => {
    render(<ZaloCardView card={{ kind: 'link', title: 'Phòng Q7', description: 'Còn 2 phòng', href: 'https://www.example.com/p', thumb: null }} />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('https://www.example.com/p');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.textContent).toContain('Phòng Q7');
    expect(link.textContent).toContain('Còn 2 phòng');
    expect(link.textContent).toContain('example.com');
  });

  it('danh thiếp không có link thì không bọc thẻ a', () => {
    render(<ZaloCardView card={{ kind: 'contact', title: 'Anh Minh', description: null, href: null, thumb: null }} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Anh Minh')).toBeTruthy();
    expect(screen.getByText('Danh thiếp Zalo')).toBeTruthy();
  });

  it('ảnh nhỏ hết hạn thì gỡ ảnh, không để ảnh vỡ', () => {
    const { container } = render(<ZaloCardView card={{ kind: 'link', title: 'x', description: null, href: 'https://a.vn/', thumb: 'https://photo-stal-1.zdn.vn/t.jpg' }} />);
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    fireEvent.error(img!);
    expect(container.querySelector('img')).toBeNull();
  });
});

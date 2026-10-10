// @vitest-environment jsdom
// Ảnh Zalo lỗi tải nhất thời: thử lại một lần trước khi hiện nhãn lỗi (10/10/2026).
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useMediaThuLai } from '../useMediaThuLai';

describe('useMediaThuLai', () => {
  it('lỗi lần đầu thì thử lại bằng fragment, lỗi lần hai mới báo lỗi', () => {
    const { result } = renderHook(() => useMediaThuLai('https://photo-stal-1.zdn.vn/a.jpg'));
    expect(result.current).toMatchObject({ src: 'https://photo-stal-1.zdn.vn/a.jpg', loi: false });
    act(() => result.current.onError());
    expect(result.current).toMatchObject({ src: 'https://photo-stal-1.zdn.vn/a.jpg#thu-lai', loi: false });
    act(() => result.current.onError());
    expect(result.current.loi).toBe(true);
  });

  it('link đã có fragment thì không thử lại được: lỗi đầu là lỗi luôn', () => {
    const { result } = renderHook(() => useMediaThuLai('blob:x#a'));
    act(() => result.current.onError());
    expect(result.current.loi).toBe(true);
  });

  it('đổi link thì đếm lại từ đầu', () => {
    const { result, rerender } = renderHook(({ u }) => useMediaThuLai(u), { initialProps: { u: 'https://a.zdn.vn/1.jpg' } });
    act(() => result.current.onError());
    act(() => result.current.onError());
    expect(result.current.loi).toBe(true);
    rerender({ u: 'https://a.zdn.vn/2.jpg' });
    expect(result.current).toMatchObject({ src: 'https://a.zdn.vn/2.jpg', loi: false });
    // Lỗi của link mới đếm từ 0, không cộng dồn lượt của link cũ.
    act(() => result.current.onError());
    expect(result.current).toMatchObject({ src: 'https://a.zdn.vn/2.jpg#thu-lai', loi: false });
  });

  it('không có link thì không có src', () => {
    const { result } = renderHook(() => useMediaThuLai(null));
    expect(result.current).toMatchObject({ src: undefined, loi: false });
  });
});

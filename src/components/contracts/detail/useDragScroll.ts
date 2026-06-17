import { useEffect } from 'react';

/**
 * Kéo-để-cuộn hàng ngang bằng chuột (mobile vẫn vuốt chạm bình thường), và
 * CHẶN click nút nếu con trỏ đã kéo > ~4px — để khi kéo hàng nút không vô tình
 * bấm phải nút. Pattern lấy từ BuildingPills (thu-tien). Con trỏ grab đặt bằng
 * Tailwind ở container; không cần file CSS.
 */
export function useDragScroll<T extends HTMLElement>(ref: React.RefObject<T>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let down = false;
    let startX = 0;
    let startScroll = 0;
    let moved = false;

    const onDown = (e: MouseEvent) => {
      down = true;
      moved = false;
      startX = e.pageX;
      startScroll = el.scrollLeft;
    };
    const onMove = (e: MouseEvent) => {
      if (!down) return;
      const dx = e.pageX - startX;
      if (Math.abs(dx) > 4) moved = true;
      el.scrollLeft = startScroll - dx;
    };
    const onUp = () => {
      down = false;
    };
    // Capture phase: chặn click đã "bong bóng" lên khi vừa kéo.
    const onClick = (e: MouseEvent) => {
      if (moved) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    el.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    el.addEventListener('click', onClick, true);
    return () => {
      el.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      el.removeEventListener('click', onClick, true);
    };
  }, [ref]);
}

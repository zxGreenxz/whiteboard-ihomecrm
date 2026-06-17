import { useEffect } from 'react';

/**
 * Kéo-để-cuộn hàng ngang bằng chuột (mobile vẫn vuốt chạm bình thường), và
 * CHẶN click nút khi đã kéo > 3px (để khi rê hàng nút không vô tình bấm nút).
 * Trong lúc kéo gắn class `drag` lên container (CSS đổi con trỏ + tắt
 * pointer-events của nút con). Pattern từ ContractDetailScreen của design.
 */
export function useDragScroll<T extends HTMLElement>(ref: React.RefObject<T>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let down = false;
    let startX = 0;
    let startLeft = 0;
    let moved = false;

    const onDown = (e: MouseEvent) => {
      down = true;
      moved = false;
      startX = e.clientX;
      startLeft = el.scrollLeft;
    };
    const onMove = (e: MouseEvent) => {
      if (!down) return;
      const dx = e.clientX - startX;
      // Chỉ bật class `drag` (con trỏ grabbing + tắt pointer-events nút con) KHI
      // thực sự kéo > 3px. Nếu add ngay ở mousedown thì cú bấm thường cũng bị
      // pointer-events:none nuốt mất → không bấm được nút.
      if (Math.abs(dx) > 3 && !moved) {
        moved = true;
        el.classList.add('drag');
      }
      if (moved) el.scrollLeft = startLeft - dx;
    };
    const onUp = () => {
      down = false;
      el.classList.remove('drag');
    };
    const onClickCapture = (e: MouseEvent) => {
      if (moved) {
        e.preventDefault();
        e.stopPropagation();
        moved = false;
      }
    };

    el.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    el.addEventListener('click', onClickCapture, true);
    return () => {
      el.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      el.removeEventListener('click', onClickCapture, true);
    };
  }, [ref]);
}

import { useEffect, useRef } from 'react';

interface BuildingLite {
  id: string;
  name: string;
}

interface Props {
  buildings: BuildingLite[];
  value: string;
  onChange: (id: string) => void;
}

/** Kéo-để-cuộn hàng ngang bằng chuột (mobile vẫn cuộn chạm bình thường). */
function useDragScroll(ref: React.RefObject<HTMLElement>) {
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
      el.classList.add('dragging');
    };
    const onMove = (e: MouseEvent) => {
      if (!down) return;
      const dx = e.pageX - startX;
      if (Math.abs(dx) > 4) moved = true;
      el.scrollLeft = startScroll - dx;
    };
    const onUp = () => {
      down = false;
      el.classList.remove('dragging');
    };
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

export function BuildingPills({ buildings, value, onChange }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useDragScroll(ref);

  return (
    <div className="bld-row" ref={ref}>
      {buildings.map((b) => (
        <button
          key={b.id}
          type="button"
          className={'bld-chip' + (b.id === value ? ' on' : '')}
          onClick={() => onChange(b.id)}
        >
          <span className="bc-code">{b.name}</span>
        </button>
      ))}
    </div>
  );
}

export default BuildingPills;

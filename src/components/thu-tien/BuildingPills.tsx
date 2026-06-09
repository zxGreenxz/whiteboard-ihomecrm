import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

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
    // Chặn click khi vừa kéo (tránh chọn nhầm pill).
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
    <div
      ref={ref}
      className="flex gap-2 overflow-x-auto px-4 py-3 cursor-grab active:cursor-grabbing [&::-webkit-scrollbar]:hidden"
      style={{ scrollbarWidth: 'none' }}
    >
      {buildings.map((b) => (
        <button
          key={b.id}
          type="button"
          onClick={() => onChange(b.id)}
          className={cn(
            'shrink-0 select-none rounded-full border px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors',
            b.id === value
              ? 'bg-emerald-600 text-white border-emerald-600'
              : 'bg-white text-zinc-700 border-zinc-200',
          )}
        >
          {b.name}
        </button>
      ))}
    </div>
  );
}

export default BuildingPills;

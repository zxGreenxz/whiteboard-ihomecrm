import { useEffect, useState } from 'react';

/** Giá trị chỉ đổi sau khi ngừng thay đổi `delayMs` (vd số tiền đang gõ trước khi hỏi máy chủ xem trước). */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

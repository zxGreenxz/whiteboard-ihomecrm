import { useEffect, useState, useCallback } from 'react';

interface Options {
  onFiles: (files: File[]) => void;
  enabled?: boolean;
  multiple?: boolean;
}

/**
 * Khi user hover chuột vào vùng upload và bấm Ctrl+V (hoặc Cmd+V), ảnh trong
 * clipboard sẽ được lấy ra và truyền vào onFiles. Hỗ trợ cả ảnh chụp màn hình
 * (clipboardData.items) lẫn file ảnh copy từ filesystem (clipboardData.files).
 *
 * Trả về { onMouseEnter, onMouseLeave } để spread vào div drop zone — chỉ vùng
 * đang hover mới nhận paste, tránh chồng chéo khi có nhiều ô upload cạnh nhau.
 */
export function useClipboardImagePaste({ onFiles, enabled = true, multiple = false }: Options) {
  const [isHover, setIsHover] = useState(false);

  const onMouseEnter = useCallback(() => setIsHover(true), []);
  const onMouseLeave = useCallback(() => setIsHover(false), []);

  useEffect(() => {
    if (!enabled || !isHover) return;

    const handlePaste = (e: ClipboardEvent) => {
      if (!e.clipboardData) return;

      const files: File[] = [];
      const seen = new Set<string>();
      const push = (f: File | null) => {
        if (!f || !f.type.startsWith('image/')) return;
        const key = `${f.name}|${f.size}|${f.type}|${f.lastModified}`;
        if (seen.has(key)) return;
        seen.add(key);
        files.push(f);
      };

      for (let i = 0; i < e.clipboardData.items.length; i++) {
        const item = e.clipboardData.items[i];
        if (item.kind === 'file') push(item.getAsFile());
      }
      for (let i = 0; i < e.clipboardData.files.length; i++) {
        push(e.clipboardData.files[i]);
      }

      if (files.length === 0) return;
      e.preventDefault();
      onFiles(multiple ? files : files.slice(0, 1));
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [isHover, enabled, multiple, onFiles]);

  return { onMouseEnter, onMouseLeave };
}

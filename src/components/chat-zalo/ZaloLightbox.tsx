import { useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';

export interface LightboxImage { id: string; url: string; label?: string }

interface Props {
  images: LightboxImage[];
  /** index đang mở; null = đóng */
  index: number | null;
  onIndexChange: (i: number | null) => void;
}

/**
 * Lightbox xem ảnh full-screen cho thread Zalo — gom MỌI ảnh trong thread,
 * điều hướng ←/→, Esc đóng. Không tái dùng attachment-lightbox (nó ép signed
 * URL qua StorageImage — ảnh Zalo là CDN ngoài cần no-referrer).
 */
export default function ZaloLightbox({ images, index, onIndexChange }: Props) {
  const open = index !== null && index >= 0 && index < images.length;

  const step = useCallback((d: number) => {
    if (index === null) return;
    const n = index + d;
    if (n >= 0 && n < images.length) onIndexChange(n);
  }, [index, images.length, onIndexChange]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onIndexChange(null);
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, step, onIndexChange]);

  if (!open) return null;
  const img = index !== null ? images[index] : undefined;
  if (!img) return null;

  const navBtn: React.CSSProperties = {
    position: 'fixed', top: '50%', transform: 'translateY(-50%)', width: 44, height: 44,
    borderRadius: '50%', border: 'none', background: 'rgba(255,255,255,.14)', color: '#fff',
    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 2100,
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      onClick={() => onIndexChange(null)}
      style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(10,14,12,.92)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <button onClick={(e) => { e.stopPropagation(); onIndexChange(null); }} title="Đóng (Esc)" style={{ ...navBtn, top: 18, right: 18, transform: 'none' }}>
        <X size={20} />
      </button>
      {index! > 0 && (
        <button onClick={(e) => { e.stopPropagation(); step(-1); }} title="Ảnh trước (←)" style={{ ...navBtn, left: 16 }}>
          <ChevronLeft size={24} />
        </button>
      )}
      {index! < images.length - 1 && (
        <button onClick={(e) => { e.stopPropagation(); step(1); }} title="Ảnh sau (→)" style={{ ...navBtn, right: 16 }}>
          <ChevronRight size={24} />
        </button>
      )}
      <figure onClick={(e) => e.stopPropagation()} style={{ margin: 0, maxWidth: '92vw', maxHeight: '90vh', textAlign: 'center' }}>
        <img
          src={img.url}
          alt={img.label || 'Ảnh'}
          referrerPolicy="no-referrer"
          style={{ maxWidth: '92vw', maxHeight: '84vh', objectFit: 'contain', borderRadius: 8 }}
        />
        <figcaption style={{ color: 'rgba(255,255,255,.75)', fontSize: 12.5, marginTop: 10 }}>
          {img.label ? `${img.label} · ` : ''}{index! + 1}/{images.length}
        </figcaption>
      </figure>
    </div>,
    document.body,
  );
}

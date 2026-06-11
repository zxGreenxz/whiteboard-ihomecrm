// =============================================================================
// StorageImage — <img> cho file trong bucket private.
// Nhận `value` là giá trị đã lưu (URL public cũ / path / blob / URL ngoài),
// tự đổi sang signed URL để hiển thị. Trong lúc đang ký hiển thị placeholder.
// Dùng thay cho <img src={...}> ở mọi nơi hiển thị ảnh từ Storage.
// =============================================================================

import { ImageIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSignedUrl } from '@/hooks/useSignedUrl';

type StorageImageProps = Omit<
  React.ImgHTMLAttributes<HTMLImageElement>,
  'src'
> & {
  /** Giá trị đã lưu (URL public cũ / path / blob / URL ngoài). */
  value?: string | null;
  /** Nội dung hiển thị khi không có ảnh / đang tải (mặc định: icon ảnh). */
  fallback?: React.ReactNode;
  /** TTL signed URL (giây). */
  ttl?: number;
};

export function StorageImage({
  value,
  fallback,
  ttl,
  className,
  alt = '',
  ...imgProps
}: StorageImageProps) {
  const src = useSignedUrl(value, ttl);

  if (!src) {
    if (fallback !== undefined) return <>{fallback}</>;
    return (
      <div
        className={cn(
          'flex items-center justify-center bg-muted text-muted-foreground',
          className
        )}
        aria-busy={!!value}
      >
        <ImageIcon className="h-4 w-4 opacity-50" />
      </div>
    );
  }

  // loading/decoding đặt TRƯỚC {...imgProps} để call site override được khi cần
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      className={className}
      {...imgProps}
    />
  );
}

export default StorageImage;

// =============================================================================
// StorageImage — <img> cho file trong bucket private.
// Nhận `value` là giá trị đã lưu (URL public cũ / path / blob / URL ngoài),
// tự đổi sang signed URL để hiển thị. Trong lúc đang ký hiển thị placeholder.
// Dùng thay cho <img src={...}> ở mọi nơi hiển thị ảnh từ Storage.
// =============================================================================

import { ImageIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useSignedUrlState } from '@/hooks/useSignedUrl';

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
  onError,
  ...imgProps
}: StorageImageProps) {
  const { url: src, isError, isFetching, isStorage, refetch } = useSignedUrlState(value, ttl);
  const [failedSource, setFailedSource] = useState<string>();
  const retriedValue = useRef<string | null | undefined>(null);
  const failed = isError || (!!src && failedSource === src);

  if (!src || failed) {
    if (fallback !== undefined) return <>{fallback}</>;
    return (
      <div
        className={cn(
          'flex items-center justify-center bg-muted text-muted-foreground',
          className
        )}
        aria-busy={isFetching}
        role={failed ? 'img' : undefined}
        aria-label={failed ? `Không tải được ảnh${alt ? `: ${alt}` : ''}` : undefined}
        title={failed ? 'Không tải được ảnh. Vui lòng thử mở lại sau.' : undefined}
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
      onError={(event) => {
        setFailedSource(src);
        // Refresh a possibly expired URL once; never loop on missing/denied files.
        if (isStorage && retriedValue.current !== value) {
          retriedValue.current = value;
          void refetch().then((result) => {
            // Signing within the same second can return the same URL. Remount
            // the image once so transient download failures can still recover.
            if (result.isSuccess) setFailedSource(undefined);
          });
        }
        onError?.(event);
      }}
    />
  );
}

export default StorageImage;

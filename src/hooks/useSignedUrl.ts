// =============================================================================
// useSignedUrl — đổi giá trị ảnh đã lưu (URL public cũ / path) thành signed URL
// để hiển thị file trong bucket private. Cache theo giá trị qua React Query và
// tự làm mới trước khi signed URL hết hạn.
// =============================================================================

import { useQuery } from '@tanstack/react-query';
import {
  parseStorageRef,
  createSignedUrlFromStored,
  SIGNED_URL_TTL,
} from '@/lib/storage';

/**
 * Trả về URL hiển thị được:
 *  - rỗng/undefined  → undefined
 *  - blob:/data:/URL ngoài → trả nguyên (không cần ký)
 *  - file Storage    → undefined khi đang ký, signed URL khi xong
 */
export function useSignedUrl(
  value?: string | null,
  expiresIn: number = SIGNED_URL_TTL
): string | undefined {
  return useSignedUrlState(value, expiresIn).url;
}

export function useSignedUrlState(
  value?: string | null,
  expiresIn: number = SIGNED_URL_TTL
) {
  const v = value || '';
  const isStorage = !!parseStorageRef(v);

  const refreshAfter = Math.max(1000, (expiresIn - Math.min(300, expiresIn / 2)) * 1000);
  const query = useQuery({
    queryKey: ['signed-url', v, expiresIn],
    enabled: !!v && isStorage,
    // Do not cache the original private URL as a successful signing result.
    queryFn: () => createSignedUrlFromStored(v, expiresIn, { throwOnError: true }),
    staleTime: refreshAfter,
    refetchInterval: refreshAfter,
    gcTime: expiresIn * 1000,
    retry: 1,
  });

  return { ...query, url: !v ? undefined : !isStorage ? v : query.data, isStorage };
}

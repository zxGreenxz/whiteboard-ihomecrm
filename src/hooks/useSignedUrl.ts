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
  const v = value || '';
  const isStorage = !!parseStorageRef(v);

  const { data } = useQuery({
    queryKey: ['signed-url', v, expiresIn],
    enabled: !!v && isStorage,
    queryFn: () => createSignedUrlFromStored(v, expiresIn),
    staleTime: Math.max(0, (expiresIn - 300) * 1000), // làm mới trước khi hết hạn 5'
    gcTime: expiresIn * 1000,
    retry: 1,
  });

  if (!v) return undefined;
  if (!isStorage) return v;
  return data;
}

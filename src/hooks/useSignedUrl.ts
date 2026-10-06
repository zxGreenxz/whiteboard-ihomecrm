// =============================================================================
// useSignedUrl — đổi giá trị ảnh đã lưu (URL public cũ / path) thành signed URL
// để hiển thị file trong bucket private. Cache theo giá trị qua React Query và
// tự làm mới trước khi signed URL hết hạn.
// =============================================================================

import { useQuery } from '@tanstack/react-query';
import { isUnavailableTestMedia, TEST_MEDIA_PLACEHOLDER } from '@/lib/storage/testMedia';
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
export function useSignedUrlQuery(
  value?: string | null,
  expiresIn: number = SIGNED_URL_TTL,
  options: {errorDisplay?: "inline"} = {},
) {
  const v = value || '';
  const isStorage = !!parseStorageRef(v);
  const unavailableInTest = isUnavailableTestMedia(v);

  const query = useQuery({
    meta:{label:"ảnh hoặc tệp đính kèm",...options},
    queryKey: ['signed-url', v, expiresIn],
    enabled: !!v && isStorage && !unavailableInTest,
    queryFn: () => createSignedUrlFromStored(v, expiresIn),
    staleTime: Math.max(0, (expiresIn - 300) * 1000), // làm mới trước khi hết hạn 5'
    gcTime: expiresIn * 1000,
    retry: 1,
  });

  return {...query,data:unavailableInTest ? TEST_MEDIA_PLACEHOLDER : !v ? undefined : !isStorage ? v : query.data};
}

/** Compatibility for image-only callers; error-aware views use useSignedUrlQuery. */
export function useSignedUrl(value?: string | null,expiresIn: number = SIGNED_URL_TTL): string | undefined {
  return useSignedUrlQuery(value,expiresIn).data;
}

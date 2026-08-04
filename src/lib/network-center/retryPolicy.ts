/**
 * Trần thử lại cho mọi query Network Center.
 *
 * Án lệ production 04/08/2026: `/network-center` bắn 144 POST
 * `network_center_get_building_v1` trong 25 giây trong khi MỌI response là HTTP
 * 200. Máy chủ trả lời bình thường; client tự nhân bản request vì mặc định toàn
 * cục `retry: 1` cộng với `retryOnMount: true` của TanStack Query — mỗi lần
 * observer mount lại một query đang ở trạng thái lỗi là một lượt fan-out N+1 nữa.
 *
 * Luật: lỗi do CHÍNH dịch vụ Network Center trả về (RPC đã trả lời: từ chối
 * quyền, sai hợp đồng, dữ liệu rỗng) KHÔNG bao giờ được thử lại — thử lại không
 * đổi được kết quả, chỉ nhân số request. Lỗi hạ tầng (mất mạng, DNS) được thử
 * lại đúng một lần.
 *
 * Nhận diện lỗi dịch vụ bằng `name` thay vì `instanceof` để module này không kéo
 * theo supabase client vào mọi nơi dùng chính sách thử lại.
 */
export const NETWORK_CENTER_MAX_QUERY_RETRIES = 1;

export function isNetworkCenterServiceError(error: unknown): boolean {
  return error instanceof Error && error.name === "NetworkCenterRepositoryError";
}

export function shouldRetryNetworkCenterQuery(failureCount: number, error: unknown): boolean {
  if (isNetworkCenterServiceError(error)) return false;
  return failureCount < NETWORK_CENTER_MAX_QUERY_RETRIES;
}

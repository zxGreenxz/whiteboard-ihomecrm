// =============================================================================
// Chia sẻ camera có thời hạn — hook cho màn nhân viên (tab Camera) và trang khách (/xem-camera).
// Gói đi qua zod ở src/lib/network-center/cameraShare.ts; lỗi THROW (CameraShareError) để màn phân biệt quyền /
// dữ liệu / mạng. Mutation tự báo lỗi tại chỗ (handlesFeedback), không để toast chung nuốt mất câu của server.
// =============================================================================
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  authorizeCameraShare, createCameraShare, listCameraShares, loginCameraShare, logoutCameraShare, revokeCameraShare,
  shouldRetryCameraShare, type CameraShareCreateInput,
} from "@/lib/network-center/cameraShare";

export interface CameraShareScope { actorId: string; organizationId: string; buildingId: string }

/** Cùng tiền tố "network-center" với các query khác của trung tâm: đổi tài khoản thì bộ cách ly xoá sạch. */
export const cameraSharesQueryKey = (scope: CameraShareScope) =>
  ["network-center", scope.actorId, scope.organizationId, "building", scope.buildingId, "camera-shares"] as const;

export function useCameraShares(scope: CameraShareScope, enabled = true) {
  return useQuery({
    queryKey: cameraSharesQueryKey(scope),
    queryFn: () => listCameraShares(scope.buildingId),
    enabled: enabled && Boolean(scope.actorId && scope.organizationId && scope.buildingId),
    // Trạng thái hết hạn và lần khách vào thay đổi theo thời gian.
    refetchInterval: 60_000,
    // Panel tự hiện lỗi tại chỗ (phân biệt lỗi quyền / mạng); không để toast chung báo trùng.
    meta: { errorDisplay: "inline" },
    retry: shouldRetryCameraShare, retryOnMount: false,
  });
}

export function useCreateCameraShare(scope: CameraShareScope) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: (input: CameraShareCreateInput) => createCameraShare(input),
    // Lỗi mạng vẫn có thể đã tạo xong ở server ⇒ luôn tải lại danh sách.
    onSettled: () => queryClient.invalidateQueries({ queryKey: cameraSharesQueryKey(scope) }),
  });
}

export function useRevokeCameraShare(scope: CameraShareScope) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { handlesFeedback: true },
    mutationFn: (shareId: string) => revokeCameraShare(shareId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: cameraSharesQueryKey(scope) }),
  });
}

// ─────────────────────────────── trang khách ───────────────────────────────

/** Dấu vân tay ngắn (FNV-1a) của chuỗi phiên: khoá truy vấn có thể đi vào nhật ký lỗi, nên không mang chuỗi phiên thô. */
function sessionFingerprint(token: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < token.length; index++) { hash ^= token.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
export const cameraShareSessionQueryKey = (token: string | null) => ["camera-share", "session", token ? sessionFingerprint(token) : null] as const;

export const useCameraShareLogin = () =>
  useMutation({
    meta: { handlesFeedback: true },
    mutationFn: (input: { code: string; password: string }) => loginCameraShare(input.code, input.password),
  });

/** Khôi phục phiên đã lưu trong tab. `null` = phiên hoặc lượt chia sẻ đã hết hiệu lực. */
export function useCameraShareSession(token: string | null) {
  return useQuery({
    queryKey: cameraShareSessionQueryKey(token),
    queryFn: () => authorizeCameraShare(token ?? ""),
    enabled: Boolean(token),
    // Trang khách tự hiện lỗi tại chỗ; không để toast chung báo trùng.
    meta: { errorDisplay: "inline" },
    retry: shouldRetryCameraShare, retryOnMount: false,
    staleTime: 60_000, refetchOnWindowFocus: true,
  });
}

export const useCameraShareLogout = () =>
  useMutation({
    meta: { handlesFeedback: true },
    mutationFn: (token: string) => logoutCameraShare(token),
  });

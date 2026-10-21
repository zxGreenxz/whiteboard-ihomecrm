import { useMutation, useQueryClient } from "@tanstack/react-query";

import { doorAccessEdge, type CreateTempPasswordInput, type DeleteKeyInput, type DoorAccessCaller } from "@/lib/door-access/edge";
import { doorAccessRepository, type LinkKeyInput, type SaveDeviceInput } from "@/lib/door-access/repository";

import { doorKeys } from "./useDoorAccessQueries";

/**
 * Thao tác ghi của trang Cửa vân tay.
 *
 * - `retry: false` (mặc định của app) và KHÔNG có đường tự gửi lại: lệnh xuống máy (mở cửa, xoá…)
 *   gửi đúng một lần; lỗi `outcomeUnknown` để người dùng tự xem Nhật ký/Lịch sử rồi quyết.
 * - `meta.handlesFeedback`: màn hình tự hiện kết quả tại chỗ, không toast chung.
 * - Xong (kể cả lỗi) ⇒ làm mới đúng phần liên quan + nhật ký thao tác.
 * - Mật khẩu tạm vừa tạo chỉ đi qua kết quả trả về; `gcTime: 0` để bộ đệm mutation không giữ mã.
 */

function need(caller: DoorAccessCaller | null): DoorAccessCaller {
  if (!caller) throw new Error("Chưa chốt người dùng hoặc công ty.");
  return caller;
}

const feedback = { meta: { handlesFeedback: true }, retry: false } as const;

export function useRemoteUnlock(caller: DoorAccessCaller | null) {
  const client = useQueryClient();
  return useMutation({
    ...feedback,
    mutationFn: (deviceId: string) => doorAccessEdge(need(caller)).remoteUnlock(deviceId),
    onSettled: (_data, _error, deviceId) => {
      void client.invalidateQueries({ queryKey: doorKeys.logs(caller, deviceId) });
      void client.invalidateQueries({ queryKey: doorKeys.allRecords(caller, deviceId) });
    },
  });
}

export function useCreateTempPassword(caller: DoorAccessCaller | null) {
  const client = useQueryClient();
  return useMutation({
    ...feedback,
    gcTime: 0,
    mutationFn: (input: CreateTempPasswordInput) => doorAccessEdge(need(caller)).createTempPassword(input),
    onSettled: (_data, _error, input) => {
      void client.invalidateQueries({ queryKey: doorKeys.tempPasswords(caller, input.deviceId) });
      void client.invalidateQueries({ queryKey: doorKeys.logs(caller, input.deviceId) });
    },
  });
}

export function useDeleteTempPassword(caller: DoorAccessCaller | null) {
  const client = useQueryClient();
  return useMutation({
    ...feedback,
    mutationFn: (input: { deviceId: string; passwordId: number }) =>
      doorAccessEdge(need(caller)).deleteTempPassword(input.deviceId, input.passwordId),
    onSettled: (_data, _error, input) => {
      void client.invalidateQueries({ queryKey: doorKeys.tempPasswords(caller, input.deviceId) });
      void client.invalidateQueries({ queryKey: doorKeys.logs(caller, input.deviceId) });
    },
  });
}

export function useDeleteKey(caller: DoorAccessCaller | null) {
  const client = useQueryClient();
  return useMutation({
    ...feedback,
    mutationFn: (input: DeleteKeyInput) => doorAccessEdge(need(caller)).deleteKey(input),
    onSettled: (_data, _error, input) => {
      void client.invalidateQueries({ queryKey: doorKeys.keys(caller, input.deviceId) });
      void client.invalidateQueries({ queryKey: doorKeys.links(caller, input.deviceId) });
      void client.invalidateQueries({ queryKey: doorKeys.logs(caller, input.deviceId) });
    },
  });
}

export function useLinkKey(caller: DoorAccessCaller | null) {
  const client = useQueryClient();
  return useMutation({
    ...feedback,
    mutationFn: (input: LinkKeyInput) => doorAccessRepository.linkKey(need(caller).organizationId, input),
    onSettled: (_data, _error, input) => {
      void client.invalidateQueries({ queryKey: doorKeys.links(caller, input.deviceId) });
      void client.invalidateQueries({ queryKey: doorKeys.logs(caller, input.deviceId) });
    },
  });
}

export function useUnlinkKey(caller: DoorAccessCaller | null) {
  const client = useQueryClient();
  return useMutation({
    ...feedback,
    mutationFn: (input: { deviceId: string; linkId: string }) =>
      doorAccessRepository.unlinkKey(need(caller).organizationId, input.linkId),
    onSettled: (_data, _error, input) => {
      void client.invalidateQueries({ queryKey: doorKeys.links(caller, input.deviceId) });
      void client.invalidateQueries({ queryKey: doorKeys.logs(caller, input.deviceId) });
    },
  });
}

export function useSaveDevice(caller: DoorAccessCaller | null) {
  const client = useQueryClient();
  return useMutation({
    ...feedback,
    mutationFn: (input: SaveDeviceInput) => doorAccessRepository.saveDevice(need(caller).organizationId, input),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: doorKeys.allDevices(caller) });
      void client.invalidateQueries({ queryKey: doorKeys.discover(caller) });
    },
  });
}

export function useDisableDevice(caller: DoorAccessCaller | null) {
  const client = useQueryClient();
  return useMutation({
    ...feedback,
    mutationFn: (deviceId: string) => doorAccessRepository.disableDevice(need(caller).organizationId, deviceId),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: doorKeys.allDevices(caller) });
      void client.invalidateQueries({ queryKey: doorKeys.discover(caller) });
    },
  });
}

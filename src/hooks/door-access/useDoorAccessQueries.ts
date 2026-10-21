import { useEffect, useMemo } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";

import { useOrganization } from "@/contexts/OrganizationContext";
import { useAuth } from "@/hooks/useAuth";
import { doorAccessEdge, type DoorAccessCaller } from "@/lib/door-access/edge";
import {
  ACTION_LOG_PAGE_SIZE,
  doorAccessRepository,
  nextActionLogCursor,
  type ActionLogCursor,
} from "@/lib/door-access/repository";

/**
 * Đọc dữ liệu trang Cửa vân tay. Khoá query luôn mang công ty + người đang đăng nhập, để dữ liệu
 * cửa của người/công ty khác không bao giờ hiện nhầm; đổi công ty/người thì dọn bản cũ.
 *
 * - `retry: false`: mỗi lần đọc là một lượt gọi SmartLife (có trần tần suất) — thử lại do người
 *   dùng bấm, không tự động.
 * - `meta.errorDisplay: 'inline'`: lỗi hiện tại chỗ (phân biệt quyền / mạng / dữ liệu), không toast.
 */

export const DOOR_ROOT = "door-access";

export interface DoorScope {
  actorId: string | null;
  organizationId: string | null;
  caller: DoorAccessCaller | null;
}

export function useDoorScope(): DoorScope {
  const auth = useAuth();
  const { selectedOrganizationId } = useOrganization();
  const actorId = auth.data?.id ?? null;
  const caller = useMemo<DoorAccessCaller | null>(
    () => (actorId && selectedOrganizationId ? { actorId, organizationId: selectedOrganizationId } : null),
    [actorId, selectedOrganizationId],
  );
  const client = useQueryClient();
  useEffect(() => {
    client.removeQueries({
      predicate: (query) =>
        query.queryKey[0] === DOOR_ROOT && (query.queryKey[1] !== selectedOrganizationId || query.queryKey[2] !== actorId),
    });
  }, [client, actorId, selectedOrganizationId]);
  return { actorId, organizationId: selectedOrganizationId, caller };
}

const root = (caller: DoorAccessCaller | null) => [DOOR_ROOT, caller?.organizationId ?? null, caller?.actorId ?? null] as const;

export const doorKeys = {
  root,
  status: (caller: DoorAccessCaller | null) => [...root(caller), "status"] as const,
  devices: (caller: DoorAccessCaller | null, includeInactive: boolean) => [...root(caller), "devices", includeInactive] as const,
  allDevices: (caller: DoorAccessCaller | null) => [...root(caller), "devices"] as const,
  discover: (caller: DoorAccessCaller | null) => [...root(caller), "discover"] as const,
  records: (caller: DoorAccessCaller | null, deviceId: string | null, startMs: number, endMs: number) =>
    [...root(caller), "records", deviceId, startMs, endMs] as const,
  allRecords: (caller: DoorAccessCaller | null, deviceId: string | null) => [...root(caller), "records", deviceId] as const,
  keys: (caller: DoorAccessCaller | null, deviceId: string | null) => [...root(caller), "keys", deviceId] as const,
  links: (caller: DoorAccessCaller | null, deviceId: string | null) => [...root(caller), "links", deviceId] as const,
  tenants: (caller: DoorAccessCaller | null, deviceId: string | null) => [...root(caller), "tenants", deviceId] as const,
  tempPasswords: (caller: DoorAccessCaller | null, deviceId: string | null) => [...root(caller), "temp-passwords", deviceId] as const,
  logs: (caller: DoorAccessCaller | null, deviceId: string | null) => [...root(caller), "logs", deviceId] as const,
  tempPasswordLogs: (caller: DoorAccessCaller | null, deviceId: string | null) =>
    [...root(caller), "logs", deviceId, "TEMP_PASSWORD_CREATE"] as const,
};

const common = { retry: false, meta: { errorDisplay: "inline" } } as const;

function need(caller: DoorAccessCaller | null): DoorAccessCaller {
  // `enabled` đã chặn khi thiếu; tới đây mà thiếu là lỗi lập trình, không phải "rỗng".
  if (!caller) throw new Error("Chưa chốt người dùng hoặc công ty.");
  return caller;
}

function needId(deviceId: string | null): string {
  if (!deviceId) throw new Error("Chưa chọn máy.");
  return deviceId;
}

export function useDoorStatus(caller: DoorAccessCaller | null) {
  return useQuery({
    ...common,
    queryKey: doorKeys.status(caller),
    enabled: caller !== null,
    staleTime: 5 * 60_000,
    queryFn: () => doorAccessEdge(need(caller)).status(),
  });
}

export function useDoorDevices(caller: DoorAccessCaller | null, options: { includeInactive?: boolean; enabled?: boolean } = {}) {
  const includeInactive = options.includeInactive ?? false;
  return useQuery({
    ...common,
    queryKey: doorKeys.devices(caller, includeInactive),
    enabled: caller !== null && (options.enabled ?? true),
    staleTime: 60_000,
    queryFn: () => doorAccessRepository.listDevices(need(caller).organizationId, includeInactive),
  });
}

export function useDoorDiscover(caller: DoorAccessCaller | null, enabled: boolean) {
  return useQuery({
    ...common,
    queryKey: doorKeys.discover(caller),
    enabled: caller !== null && enabled,
    staleTime: 60_000,
    queryFn: () => doorAccessEdge(need(caller)).discover(),
  });
}

export function useDoorRecords(
  caller: DoorAccessCaller | null,
  deviceId: string | null,
  range: { startMs: number; endMs: number } | null,
) {
  return useInfiniteQuery({
    ...common,
    queryKey: doorKeys.records(caller, deviceId, range?.startMs ?? 0, range?.endMs ?? 0),
    enabled: caller !== null && deviceId !== null && range !== null,
    staleTime: 30_000,
    initialPageParam: 1,
    queryFn: ({ pageParam }) => {
      if (!range) throw new Error("Chưa chọn khoảng ngày.");
      return doorAccessEdge(need(caller)).records({
        deviceId: needId(deviceId),
        startMs: range.startMs,
        endMs: range.endMs,
        pageNo: pageParam,
      });
    },
    getNextPageParam: (last, pages) => (last.hasMore ? pages.length + 1 : undefined),
  });
}

export function useDoorKeys(caller: DoorAccessCaller | null, deviceId: string | null) {
  return useQuery({
    ...common,
    queryKey: doorKeys.keys(caller, deviceId),
    enabled: caller !== null && deviceId !== null,
    staleTime: 30_000,
    queryFn: () => doorAccessEdge(need(caller)).keys(needId(deviceId)),
  });
}

export function useDoorKeyLinks(caller: DoorAccessCaller | null, deviceId: string | null) {
  return useQuery({
    ...common,
    queryKey: doorKeys.links(caller, deviceId),
    enabled: caller !== null && deviceId !== null,
    staleTime: 30_000,
    queryFn: () => doorAccessRepository.listKeyLinks(need(caller).organizationId, needId(deviceId)),
  });
}

export function useDoorTenants(caller: DoorAccessCaller | null, deviceId: string | null, enabled: boolean) {
  return useQuery({
    ...common,
    queryKey: doorKeys.tenants(caller, deviceId),
    enabled: caller !== null && deviceId !== null && enabled,
    staleTime: 60_000,
    queryFn: () => doorAccessRepository.listBuildingTenants(need(caller).organizationId, needId(deviceId)),
  });
}

export function useDoorTempPasswords(caller: DoorAccessCaller | null, deviceId: string | null) {
  return useQuery({
    ...common,
    queryKey: doorKeys.tempPasswords(caller, deviceId),
    enabled: caller !== null && deviceId !== null,
    staleTime: 30_000,
    queryFn: () => doorAccessEdge(need(caller)).tempPasswords(needId(deviceId)),
  });
}

/** Ai tạo mật khẩu tạm nào, mục đích gì — nhật ký TEMP_PASSWORD_CREATE của máy. */
export function useDoorTempPasswordLogs(caller: DoorAccessCaller | null, deviceId: string | null) {
  return useQuery({
    ...common,
    queryKey: doorKeys.tempPasswordLogs(caller, deviceId),
    enabled: caller !== null && deviceId !== null,
    staleTime: 30_000,
    queryFn: () =>
      doorAccessRepository.listActionLogs(need(caller).organizationId, {
        deviceId: needId(deviceId),
        actions: ["TEMP_PASSWORD_CREATE"],
        limit: 100,
      }),
  });
}

export function useDoorActionLogs(caller: DoorAccessCaller | null, deviceId: string | null) {
  return useInfiniteQuery({
    ...common,
    queryKey: doorKeys.logs(caller, deviceId),
    enabled: caller !== null && deviceId !== null,
    staleTime: 15_000,
    initialPageParam: null as ActionLogCursor | null,
    queryFn: ({ pageParam }) =>
      doorAccessRepository.listActionLogs(need(caller).organizationId, {
        deviceId: needId(deviceId),
        limit: ACTION_LOG_PAGE_SIZE,
        cursor: pageParam,
      }),
    // Khoá ghép (created_at, id) của dòng cuối trang trước — không bỏ sót dòng trùng giờ.
    getNextPageParam: (last) => nextActionLogCursor(last),
  });
}

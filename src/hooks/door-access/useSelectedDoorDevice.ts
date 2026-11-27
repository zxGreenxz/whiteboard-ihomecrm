import { useState } from "react";

import type { DoorDevice } from "@/lib/door-access/dto";
import type { DoorAccessCaller } from "@/lib/door-access/edge";

/**
 * Máy cửa đang chọn trên trang /cua-van-tay (máy tính lẫn điện thoại): nhớ lần chọn trước theo
 * công ty + người, chỉ là tiện ích trên máy người xem. Khoá gắn người dùng nên không sang tài khoản
 * khác (xem src/lib/__tests__/accountBrowserState.test.ts).
 */
const STORAGE_PREFIX = "door-access.last-device.v1";

function readRemembered(key: string): string | null {
  let remembered: string | null = null;
  try {
    remembered = window.localStorage.getItem(key);
  } catch {
    /* Trình duyệt chặn bộ nhớ (chế độ riêng tư…): coi như chưa nhớ máy nào — chọn máy đầu danh sách. */
  }
  return remembered;
}

function writeRemembered(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Trình duyệt chặn bộ nhớ (chế độ riêng tư…): chỉ mất phần ghi nhớ, không ảnh hưởng thao tác.
  }
}

export function useSelectedDoorDevice(caller: DoorAccessCaller, devices: readonly DoorDevice[]) {
  const storageKey = `${STORAGE_PREFIX}:${caller.organizationId}:${caller.actorId}`;
  const [selected, setSelected] = useState<{ key: string; id: string | null }>(() => ({ key: storageKey, id: readRemembered(storageKey) }));
  const wanted = selected.key === storageKey ? selected.id : readRemembered(storageKey);
  const device = devices.find((item) => item.id === wanted) ?? devices[0] ?? null;
  const select = (id: string) => {
    setSelected({ key: storageKey, id });
    writeRemembered(storageKey, id);
  };
  return { device, select };
}

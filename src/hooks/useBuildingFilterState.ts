// Trạng thái bộ lọc nhà của bảng "LN được chia Nhà × Tháng", lưu trên trình duyệt theo khoá
// công ty + cổ đông (cổ đông gắn một tài khoản đăng nhập ⇒ không sang tài khoản khác).

import { useEffect, useState } from 'react';
import { emptyBuildingFilterState, parseBuildingFilterState, type BuildingFilterState } from '@/lib/profitLedger/buildingFilters';

function readState(storageKey: string): BuildingFilterState {
  try {
    return parseBuildingFilterState(window.localStorage.getItem(storageKey));
  } catch {
    return emptyBuildingFilterState();
  }
}

/** Trình duyệt chặn lưu (chế độ riêng tư / hết chỗ) ⇒ bộ lọc vẫn dùng được trong phiên. */
export function useBuildingFilterState(storageKey: string): [BuildingFilterState, (next: BuildingFilterState) => void] {
  const [entry, setEntry] = useState(() => ({ storageKey, state: readState(storageKey) }));

  useEffect(() => {
    setEntry((previous) => (previous.storageKey === storageKey ? previous : { storageKey, state: readState(storageKey) }));
    // Tab khác vừa tạo / sửa bộ lọc của cùng khoá ⇒ nạp lại, tránh tab này ghi đè mất.
    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey) setEntry({ storageKey, state: readState(storageKey) });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [storageKey]);

  const update = (next: BuildingFilterState) => {
    setEntry({ storageKey, state: next });
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Không lưu được: giữ trong phiên, không chặn người dùng.
    }
  };

  // Đổi công ty/cổ đông mà effect chưa kịp chạy: không bày bộ lọc của khoá cũ.
  return [entry.storageKey === storageKey ? entry.state : emptyBuildingFilterState(), update];
}
